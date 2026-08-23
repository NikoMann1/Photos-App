/**
 * Photo scoring and selection.
 *
 * The score is *measured*, not learned: focus, exposure, tonal range and colour,
 * computed from the pixels in `lib/analysis/metrics.ts`. That reliably answers
 * "is this photo technically botched?" — blurred, out of focus, badly clipped.
 * It does not answer "was this photo worth taking?". Two things do, both under
 * "Judgement" below: a 2 KB head trained on human-rated photographs, which
 * needs nothing from the user, and a taste direction learned from their own ♥
 * and ✕ taps, which displaces the general one as it grows. See NOT-YET-SOLVED
 * at the bottom of this file for what none of them covers.
 *
 * Selection therefore has three stages, in this order:
 *   1. collapse near-duplicates, keeping the best frame of each burst
 *   2. drop anything below an absolute quality bar
 *   3. rank what survives and take the top N
 *
 * The order matters: dedup first, so a burst of ten near-identical shots
 * spends one slot rather than ten.
 */

import { CONTENT_SPREAD, contentScore } from "./analysis/aesthetic";
import { embeddingSimilarity } from "./analysis/embedding";
import {
  HASH_BITS,
  colorDistance,
  hammingDistance,
  isDegenerateHash,
  type ImageMetrics,
} from "./analysis/metrics";

export type PhotoMeta = {
  /** Stable id, also the filename on disk when stored server-side. */
  id: string;
  /** Original filename from the user's device. */
  name: string;
  /** MIME type as reported by the browser. */
  type: string;
  /** Bytes. */
  size: number;
  /** Capture time in ms, from EXIF where available. Used for burst detection. */
  takenAt?: number | null;
};

export type AnalyzedPhoto = PhotoMeta & {
  metrics: ImageMetrics;
  /**
   * Unit-length content embedding, when the second analysis stage ran for this
   * photo. Absent for photos outside the shortlist, or when the model could
   * not be loaded — everything below degrades to the cheap signals.
   */
  embedding?: Float32Array | null;
};

/** Why a photo scored the way it did — surfaced in the UI for calibration. */
export type ScoreBreakdown = {
  focus: number;
  exposure: number;
  tone: number;
  color: number;
};

export type ScoredPhoto = AnalyzedPhoto & {
  /** 0..1, higher is better. */
  score: number;
  breakdown: ScoreBreakdown;
  /** Set when the photo failed the absolute quality bar. */
  rejectedFor: string | null;
};

export type PhotoGroup = {
  /** The best-scoring photo of the group. */
  best: ScoredPhoto;
  /** Near-duplicates that lost to it, best-first. */
  alternates: ScoredPhoto[];
};

export type Selection = {
  selected: ScoredPhoto[];
  /** Every photo, scored, best-first — for debugging and "show more". */
  ranked: ScoredPhoto[];
  /** Groups with more than one member, i.e. detected bursts. */
  duplicateGroups: PhotoGroup[];
  /** How many photos the quality bar rejected outright. */
  rejectedCount: number;
};

// ---------------------------------------------------------------------------
// Count policy
// ---------------------------------------------------------------------------

/** Fraction of (deduplicated) photos to keep, before the floor and cap. */
export const SELECTION_RATIO = 0.1;

/**
 * A bare ratio assumes the fraction of good photos is constant, which is not
 * how batches work: 20 careful shots might be mostly keepers, while 500 with
 * burst sequences might be 5%. 10% of 20 is 2, which is too thin to judge a
 * selection by. So clamp the count — never fewer than MIN (or the whole batch,
 * if it is smaller), never more than MAX.
 */
export const MIN_SELECTION = 5;
export const MAX_SELECTION = 50;

/** How many photos to keep from a batch of `total`. */
export function selectionSize(total: number, ratio: number = SELECTION_RATIO): number {
  if (total <= 0) return 0;
  const target = Math.round(total * ratio);
  const clamped = Math.max(MIN_SELECTION, Math.min(MAX_SELECTION, target));
  return Math.min(total, clamped);
}

// ---------------------------------------------------------------------------
// Thresholds — calibrated against real photos, see README
// ---------------------------------------------------------------------------

/**
 * `focus` is contrast-normalised Laplacian variance. Measured on real photos:
 * a sharp frame lands around 0.20–0.26, a slight blur (sigma 1) around 0.03,
 * and anything visibly soft below 0.01. These bounds put the interesting range
 * where the decisions actually happen.
 */
const FOCUS_SHARP = 0.12;
const FOCUS_BLURRED = 0.01;

/**
 * Absolute sharpness bounds, on the raw (un-normalised) Laplacian variance.
 *
 * Normalising by contrast cancels exposure, but it divides by a number that
 * can approach zero: a nearly flat frame has almost no contrast, so a
 * negligible amount of high-frequency energy still comes out as a high ratio.
 * A visibly blurred low-contrast photo measured 0.091 that way — better than a
 * real photo blurred beyond recognition — and was selected.
 *
 * So the two measures are combined by taking the worse of them. A photo has to
 * be sharp *relative to its own contrast* and carry a real amount of detail in
 * absolute terms.
 */
const SHARPNESS_FLOOR = 2;
const SHARPNESS_CEILING = 40;

/** Below this focus score a photo is rejected outright, however pretty. */
const FOCUS_REJECT = 0.3;

/**
 * Above this, the high-frequency energy the focus measure is reading is grain
 * rather than detail — measured at 0.5–0.8 for real photos, 2.9 for a grainy
 * one, 4.0 for pure noise. Without this discount a noisy night shot measures
 * sharper than a good photo and ranks top of the batch.
 */
const NOISE_CLEAN = 1.2;
const NOISE_HEAVY = 3.5;
const NOISE_MAX_PENALTY = 0.6;

/** Clipping is normal in small amounts; a third of the frame blown is not. */
const CLIP_TOLERANCE = 0.02;
const CLIP_REJECT = 0.25;

/**
 * Near-duplicate thresholds, over a 256-bit hash and a chromaticity signature.
 *
 * Measured on real photos: the same frame re-encoded at a different JPEG
 * quality differs by 5 bits and 0.3 colour, a blurred copy by 7 and 0.2, while
 * two genuinely different shots of the same subject differ by 96 and 5.8.
 *
 * Both signals are required, because either one alone has a failure mode.
 * Hash alone merges any two photos dominated by the same gradient (see
 * `isDegenerateHash`); colour alone merges any two photos of, say, the same
 * beach. Requiring both, plus a timestamp for the looser rule, means the ways
 * they fail have to coincide before a photo is wrongly discarded.
 *
 * Erring towards keeping photos apart is deliberate: an uncollapsed burst
 * costs a slot in the results, while a wrong merge silently destroys a photo
 * the user never sees.
 */
const DUPLICATE_STRICT = 10;
const DUPLICATE_LOOSE = 48;
const COLOR_TIGHT = 4;
const COLOR_LOOSE = 10;
const BURST_WINDOW_MS = 30_000;

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Maps a value in [min, max] onto 0..1, clamped at both ends. */
function ramp(value: number, min: number, max: number): number {
  if (max === min) return 0;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

/**
 * Focus, on a log scale: the difference between 0.002 and 0.02 matters far
 * more than the difference between 0.2 and 0.22, and a linear ramp would
 * flatten exactly the region where blurred and sharp separate.
 */
export function focusScore(metrics: ImageMetrics): number {
  const relative = ramp(
    Math.log10(Math.max(metrics.focus, 1e-6)),
    Math.log10(FOCUS_BLURRED),
    Math.log10(FOCUS_SHARP),
  );

  const absolute = ramp(
    Math.log10(Math.max(metrics.sharpness, 1e-6)),
    Math.log10(SHARPNESS_FLOOR),
    Math.log10(SHARPNESS_CEILING),
  );

  // Discount sharpness that is really grain. Grainy photos are still usable,
  // so this caps the penalty rather than zeroing the score.
  const noisiness = ramp(metrics.noiseRatio, NOISE_CLEAN, NOISE_HEAVY);
  return Math.min(relative, absolute) * (1 - NOISE_MAX_PENALTY * noisiness);
}

/** Penalises clipped highlights and shadows, and frames that are simply too
 *  dark or too bright to be worth keeping. */
export function exposureScore(metrics: ImageMetrics): number {
  const clipping =
    1 - ramp(Math.max(metrics.clippedHighlights, metrics.clippedShadows), CLIP_TOLERANCE, 0.15);

  // 110–150 is a comfortable mid-tone; fall off either side of it.
  const brightness =
    metrics.brightness < 110
      ? ramp(metrics.brightness, 35, 110)
      : 1 - ramp(metrics.brightness, 150, 235);

  return 0.6 * clipping + 0.4 * Math.max(0, brightness);
}

/** Tonal range: a flat, hazy frame has little of it. */
export function toneScore(metrics: ImageMetrics): number {
  return 0.6 * ramp(metrics.dynamicRange, 40, 170) + 0.4 * ramp(metrics.contrast, 12, 55);
}

/** Colour, weighted lightly — vivid is not the same as good. */
export function colorScore(metrics: ImageMetrics): number {
  return ramp(metrics.colorfulness, 8, 55);
}

/**
 * Weights. Focus dominates because it is the one signal here that maps
 * directly onto "this photo is unusable", and the one users notice instantly.
 */
const WEIGHTS = { focus: 0.5, exposure: 0.3, tone: 0.1, color: 0.1 } as const;

export function scorePhoto(photo: AnalyzedPhoto): ScoredPhoto {
  const breakdown: ScoreBreakdown = {
    focus: focusScore(photo.metrics),
    exposure: exposureScore(photo.metrics),
    tone: toneScore(photo.metrics),
    color: colorScore(photo.metrics),
  };

  const score =
    WEIGHTS.focus * breakdown.focus +
    WEIGHTS.exposure * breakdown.exposure +
    WEIGHTS.tone * breakdown.tone +
    WEIGHTS.color * breakdown.color;

  let rejectedFor: string | null = null;
  if (breakdown.focus < FOCUS_REJECT) {
    rejectedFor = "out of focus";
  } else if (photo.metrics.clippedHighlights > CLIP_REJECT) {
    rejectedFor = "blown highlights";
  } else if (photo.metrics.clippedShadows > CLIP_REJECT) {
    rejectedFor = "crushed shadows";
  }

  return { ...photo, score, breakdown, rejectedFor };
}

/**
 * Scores within a percentage point of each other are not meaningfully
 * different, so fall back to file size — for two copies of the same frame,
 * the bigger file is the less-compressed one. Without this, JPEG artefacts in
 * a low-quality copy raise its measured sharpness just enough to beat the
 * original it was made from.
 *
 * Comparing rounded ranks rather than applying a tolerance to raw scores keeps
 * the ordering transitive, so the sort stays well-defined.
 */
export function compareForRanking(a: ScoredPhoto, b: ScoredPhoto): number {
  const rank = (photo: ScoredPhoto) => Math.round(photo.score * 100);
  return rank(b) - rank(a) || b.size - a.size;
}

// ---------------------------------------------------------------------------
// Near-duplicate grouping
// ---------------------------------------------------------------------------

export function isNearDuplicate(a: ScoredPhoto, b: ScoredPhoto): boolean {
  // Content beats pixels when it is available: it recognises the same subject
  // through a re-crop or an exposure change, and — more importantly — refuses
  // to merge two photos that merely share a layout.
  if (a.embedding && b.embedding) {
    return embeddingSimilarity(a.embedding, b.embedding) >= CONTENT_SAME_SUBJECT;
  }

  const distance = hammingDistance(a.metrics.hash, b.metrics.hash);
  if (distance > DUPLICATE_LOOSE) return false;

  const colour = colorDistance(a.metrics.colorSignature, b.metrics.colorSignature);

  // Near-identical in both structure and colour: the same photo twice.
  // Skipped when either hash is uninformative, since then a tiny hash distance
  // means nothing and only the timestamp rule below is safe.
  const informative =
    !isDegenerateHash(a.metrics.hash) && !isDegenerateHash(b.metrics.hash);
  if (informative && distance <= DUPLICATE_STRICT && colour <= COLOR_TIGHT) {
    return true;
  }

  // Otherwise: similar-looking, so only a burst if the camera says they were
  // taken moments apart. Without timestamps we decline to guess.
  if (a.takenAt == null || b.takenAt == null) return false;
  if (Math.abs(a.takenAt - b.takenAt) > BURST_WINDOW_MS) return false;
  return colour <= COLOR_LOOSE;
}

/**
 * Greedy single-link grouping against each group's best frame. O(n·groups),
 * which for a few hundred photos is nothing, and avoids the chaining that
 * full single-link clustering suffers from (where A~B and B~C silently drags
 * in a C that looks nothing like A).
 */
export function groupNearDuplicates(photos: ScoredPhoto[]): PhotoGroup[] {
  const groups: PhotoGroup[] = [];

  for (const photo of [...photos].sort(compareForRanking)) {
    const existing = groups.find((group) => isNearDuplicate(group.best, photo));
    if (existing) {
      existing.alternates.push(photo);
    } else {
      groups.push({ best: photo, alternates: [] });
    }
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Diversity
// ---------------------------------------------------------------------------

/**
 * How much similarity to what is already chosen counts against a photo.
 *
 * Measured on a real 100-photo batch, every surviving photo scored between
 * 0.92 and 0.96 — technical quality simply does not separate photos from a
 * modern phone, so ranking by it alone returns an essentially arbitrary ten,
 * often several of the same subject. This weight is deliberately larger than
 * that spread: when quality cannot tell two photos apart, how different they
 * are from what is already picked should decide.
 *
 * It is not a substitute for knowing what a photo is *of* — see NOT-YET-SOLVED.
 */
const DIVERSITY_WEIGHT = 0.15;

/** Colour distance at which two photos count as completely unalike. */
const COLOR_SPREAD = 40;

/** Photos further apart in time than this are treated as separate moments. */
const TIME_SPREAD_MS = 20 * 60 * 1000;

/**
 * Cosine similarity above which two embeddings describe the same subject.
 * Measured with this model: a mirrored copy of a photo scores 0.99, a
 * hue-shifted copy 0.88, a different shot of the same scene 0.86, and
 * unrelated content 0.19.
 */
const CONTENT_SAME_SUBJECT = 0.9;

/** 0 (nothing in common) to 1 (the same photo). */
export function similarity(a: ScoredPhoto, b: ScoredPhoto): number {
  // When both photos were embedded, ask the model instead of guessing from
  // colour: a hue-shifted copy of one photo is the same subject, which colour
  // and hash signals both read as a different one.
  if (a.embedding && b.embedding) {
    const content = embeddingSimilarity(a.embedding, b.embedding);
    // Map 0.19 (unrelated) to 0 and 1.0 (identical) to 1, so it spans the same
    // range as the cheap signals it replaces.
    return Math.max(0, Math.min(1, (content - 0.19) / 0.81));
  }

  const colour =
    1 - Math.min(1, colorDistance(a.metrics.colorSignature, b.metrics.colorSignature) / COLOR_SPREAD);

  // Half the bits differing is what two unrelated images average.
  const structure =
    1 - Math.min(1, hammingDistance(a.metrics.hash, b.metrics.hash) / (HASH_BITS / 2));

  const time =
    a.takenAt == null || b.takenAt == null
      ? 0
      : 1 - Math.min(1, Math.abs(a.takenAt - b.takenAt) / TIME_SPREAD_MS);

  return 0.5 * colour + 0.3 * structure + 0.2 * time;
}

/**
 * Greedy diverse selection: take the best photo, then repeatedly take whichever
 * remaining photo has the best score once penalised by how much it resembles
 * something already taken.
 *
 * The cost is O(count × pool × chosen), which for a few hundred photos and ten
 * slots is a few thousand cheap comparisons.
 */
export function selectDiverse(
  candidates: ScoredPhoto[],
  count: number,
  /** Already-chosen photos: kept, and counted against everything else's novelty. */
  seeds: ScoredPhoto[] = [],
  /** Ranking value, so steering can bias without mutating the stored score. */
  valueOf: (photo: ScoredPhoto) => number = (photo) => photo.score,
  /** Scales the novelty penalty, so steering can make repetition cheaper. */
  noveltyDiscount: (photo: ScoredPhoto) => number = () => 1,
): ScoredPhoto[] {
  const seedIds = new Set(seeds.map((photo) => photo.id));
  const pool = candidates.filter((photo) => !seedIds.has(photo.id));
  const chosen: ScoredPhoto[] = [...seeds];

  while (chosen.length < count && pool.length > 0) {
    let bestIndex = 0;
    let bestValue = -Infinity;

    for (let i = 0; i < pool.length; i++) {
      let penalty = 0;
      for (const already of chosen) {
        penalty = Math.max(penalty, similarity(pool[i], already));
      }
      const value = valueOf(pool[i]) - DIVERSITY_WEIGHT * penalty * noveltyDiscount(pool[i]);
      if (value > bestValue) {
        bestValue = value;
        bestIndex = i;
      }
    }

    chosen.push(pool[bestIndex]);
    pool.splice(bestIndex, 1);
  }

  return chosen;
}

// ---------------------------------------------------------------------------
// Steering
// ---------------------------------------------------------------------------

/**
 * What the user said about the last selection. Ids, so it survives a reload.
 */
export type Steering = { liked: string[]; rejected: string[] };

/**
 * What earlier batches taught the app, as embeddings rather than ids — the
 * photos themselves are long gone.
 */
export type RememberedTaste = { liked: Float32Array[]; rejected: Float32Array[] };

export const NO_TASTE: RememberedTaste = { liked: [], rejected: [] };

export const NO_STEERING: Steering = { liked: [], rejected: [] };

/**
 * A rejection is unambiguous, so it subtracts directly and hard — far harder
 * than the ~0.04 spread of the technical score across a real batch.
 */
const REJECT_WEIGHT = 0.5;

/**
 * Remembered taste pulls more gently than a tap in the current batch, and a
 * remembered dislike *demotes* rather than excludes.
 *
 * Dropping one photo of a bathroom must not permanently hide the one with the
 * plaque on the wall: only an explicit ✕ on the photo in front of the user
 * removes anything. Weaker weights also keep an old batch from overwhelming
 * what the user is saying about this one.
 */
const REMEMBERED_LIKE_RELIEF = 0.3;
const REMEMBERED_REJECT_WEIGHT = 0.2;

/**
 * A like is *not* modelled as a bonus, because a bonus fights the novelty
 * penalty photo-for-photo and simply beats it: with a large enough bonus,
 * liking one photo returns five near-copies of it, which is the redundancy
 * diverse selection exists to prevent. A smaller bonus instead inverts the
 * intent, ranking unrelated subjects above the liked one, since they are
 * penalised least.
 *
 * So a like discounts the novelty penalty rather than opposing it. Coverage
 * still decides the early picks, and photos resembling something the user
 * liked become progressively cheaper to repeat — meaning surplus slots go to
 * what they asked for, without collapsing the spread.
 *
 * The value matters: above roughly 0.72, repeating the liked subject becomes
 * cheaper than covering a new one and the results collapse into near-copies
 * again. 0.5 leaves real headroom under that cliff rather than sitting on it.
 */
const LIKE_RELIEF = 0.5;

/** Cosine, remapped so 0.19 (unrelated) is 0 and 1.0 (identical) is 1. */
function contentAffinity(photo: ScoredPhoto, reference: Float32Array | null): number {
  if (!photo.embedding || !reference) return 0;
  return Math.max(0, Math.min(1, (embeddingSimilarity(photo.embedding, reference) - 0.19) / 0.81));
}

/**
 * Closeness to the nearest of several references. Max rather than mean: liking
 * engine rooms and harbour views averages to a direction meaning neither, so
 * unrelated tastes have to be kept apart.
 */
function nearestAffinity(photo: ScoredPhoto, references: Float32Array[]): number {
  let best = 0;
  for (const reference of references) {
    best = Math.max(best, contentAffinity(photo, reference));
  }
  return best;
}

/** Mean direction of a set of embeddings, renormalised to unit length. */
function meanOf(vectors: Float32Array[]): Float32Array | null {
  const usable = vectors.filter((vector) => vector.length === vectors[0]?.length);
  if (usable.length === 0) return null;

  const dims = usable[0].length;
  const sum = new Float32Array(dims);
  for (const vector of usable) {
    for (let i = 0; i < dims; i++) sum[i] += vector[i];
  }
  return normalized(sum);
}

/** The same vector scaled to unit length, or null if it has no direction. */
function normalized(vector: Float32Array): Float32Array | null {
  let norm = 0;
  for (const v of vector) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return null;

  const unit = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) unit[i] = vector[i] / norm;
  return unit;
}

function meanEmbedding(photos: ScoredPhoto[]): Float32Array | null {
  return meanOf(embeddingsOf(photos));
}

function embeddingsOf(photos: ScoredPhoto[]): Float32Array[] {
  return photos.flatMap((photo) => (photo.embedding ? [photo.embedding] : []));
}

// ---------------------------------------------------------------------------
// Judgement: was this photo worth taking?
// ---------------------------------------------------------------------------

/**
 * The axis separating photos the user keeps from photos they drop.
 *
 * Everything else in this file answers "is this photo botched?" or "have I
 * already got one like it?". Neither answers whether the photo was worth
 * taking, and a universal answer is not affordable here: the aesthetic models
 * that do it well want a CLIP ViT-L/14 tower (~300 MB) against our 21 MB
 * MobileCLIP, on a phone where memory pressure already costs us batches, and
 * zero-shot prompting for it was measured and rejected — "a beautiful
 * photograph" ranked floor grating above a harbour view.
 *
 * So judgement here is *personal*, learned from the ♥ and ✕ taps the app
 * already collects. `mean(kept) - mean(dropped)` is the direction along which
 * those two sets differ; a photo's projection onto it is how much it looks
 * like the ones kept rather than the ones dropped.
 *
 * This is a genuinely different question from `nearestAffinity`, which asks
 * only "does this resemble something you kept". That cannot learn a
 * *distinction*: a bunkroom shot resembles both a kept bunk photo and a
 * dropped one, so it scores high either way. On the user's own photos, trained
 * on two kept and two dropped and evaluated on six held out, the direction
 * ordered them +0.384 to -0.105 while nearest-exemplar ranked a near-miss
 * third; the two rankings disagree, and only this one has a sign.
 */
export type TasteDirection = {
  /** Unit-length; project an embedding onto it to judge that photo. */
  vector: Float32Array;
  /** 0..1, how much evidence it was learned from. Scales its influence. */
  confidence: number;
};

/**
 * Both sides are required, and at fewer than this many of either the direction
 * is one photo's quirks rather than a taste. Two-vs-two already produced a
 * sensible held-out ordering, so three is not a high bar — it is a guard
 * against learning a whole trip's ranking from a single stray tap.
 */
const TASTE_MIN_LABELS = 3;

/** Where the evidence stops growing the direction's influence. */
const TASTE_CONFIDENT = 10;

/**
 * The projection magnitude that counts as a full-strength opinion. Measured:
 * across the user's own photos, projections onto a direction trained on four
 * of them spanned -0.486 to +0.425, so ~0.45 is the edge of the range rather
 * than a round number.
 */
const TASTE_SCALE = 0.45;

/**
 * How much a full-strength opinion moves a photo's ranking value.
 *
 * Sized against the two things it competes with. Against the technical score,
 * whose spread across a real batch is about 0.04, a full swing of 0.24 means
 * judgement decides the order among photos that are all technically fine —
 * which is the point. Against the diversity penalty (at most 0.15), a photo
 * has to beat another by 0.63 of the entire observed taste range before it
 * displaces a subject not yet covered. Taste can override coverage, but only
 * on a strong opinion, never on a marginal one.
 *
 * That asymmetry is deliberate. The last time a learned preference was allowed
 * to win photo-for-photo against novelty it collapsed the selection into five
 * near-copies; the ceiling here is what stops that repeating.
 */
const TASTE_WEIGHT = 0.12;

/**
 * Learns the direction, or returns null when there is not enough to learn from.
 */
export function tasteDirection(
  kept: Float32Array[],
  dropped: Float32Array[],
): TasteDirection | null {
  const labels = Math.min(kept.length, dropped.length);
  if (labels < TASTE_MIN_LABELS) return null;

  const keptMean = meanOf(kept);
  const droppedMean = meanOf(dropped);
  if (!keptMean || !droppedMean || keptMean.length !== droppedMean.length) return null;

  const difference = new Float32Array(keptMean.length);
  for (let i = 0; i < difference.length; i++) difference[i] = keptMean[i] - droppedMean[i];

  const vector = normalized(difference);
  if (!vector) return null;

  return { vector, confidence: Math.min(1, labels / TASTE_CONFIDENT) };
}

/**
 * What the current batch and every remembered one together say about taste.
 *
 * The current batch's taps count, so tapping through a few photos sharpens
 * judgement on the batch in front of the user rather than only on the next one.
 */
export function steeredTaste(
  candidates: ScoredPhoto[],
  steering: Steering,
  remembered: RememberedTaste = NO_TASTE,
): TasteDirection | null {
  const liked = new Set(steering.liked);
  const rejected = new Set(steering.rejected);
  return tasteDirection(
    [...remembered.liked, ...embeddingsOf(candidates.filter((p) => liked.has(p.id)))],
    [...remembered.rejected, ...embeddingsOf(candidates.filter((p) => rejected.has(p.id)))],
  );
}

/**
 * How far a photo sits along the taste direction, as a ranking adjustment.
 *
 * Signed: a photo like the ones dropped is pushed down, not merely left alone.
 * A photo with no embedding gets zero — the neutral middle — because not
 * knowing what a photo shows is not evidence against it.
 */
export function tasteBias(
  photo: ScoredPhoto,
  taste: TasteDirection | null | undefined,
): number {
  if (!taste || !photo.embedding || photo.embedding.length !== taste.vector.length) {
    return 0;
  }

  let projection = 0;
  for (let i = 0; i < taste.vector.length; i++) {
    projection += photo.embedding[i] * taste.vector[i];
  }

  const strength = Math.max(-1, Math.min(1, projection / TASTE_SCALE));
  return TASTE_WEIGHT * taste.confidence * strength;
}

/**
 * How much a photo's own merit as a photograph moves its ranking.
 *
 * Same size as a full-strength personal opinion, for the same reasons, and
 * checked against the spread a real batch actually has: the user's own photos
 * span 0.8 points on this head, which at this weight is a gap of 0.117 between
 * the best-judged and worst-judged photo in the batch — under the 0.15 the
 * diversity penalty can impose. So across the range a real batch produces,
 * covering a new subject still beats repeating a well-judged one. There is a
 * test that fails if this is raised past that.
 */
const CONTENT_WEIGHT = 0.12;

/**
 * How much of the general prior a fully-trained taste direction displaces.
 * Half, not all: what photographers rate highly stays informative even after
 * the app knows this user, and a direction is learned from at most a few dozen
 * taps.
 *
 * A photo the user has spoken about *directly* is a different matter — see
 * `personalDamping`. There the prior gets out of the way entirely.
 */
const PERSONAL_DISPLACES = 0.5;

/**
 * Where a batch sits on the content head's scale, so photos are compared with
 * each other rather than with a fixed bar.
 *
 * This indirection is not optional. The head is trained on contest
 * photographs and the user's own batch scored 3.97 to 4.77 against AVA's
 * median of 5.42 — an absolute threshold would reject every photo they own.
 */
export type ContentBaseline = {
  /** Median of the batch: the zero point a photo is judged against. */
  median: number;
  /** Upper quartile: above this a photo stands out within its own batch. */
  standout: number;
};

export function contentBaseline(photos: ScoredPhoto[]): ContentBaseline | null {
  const scores = photos
    .flatMap((photo) => {
      const score = contentScore(photo.embedding);
      return score === null ? [] : [score];
    })
    .sort((a, b) => a - b);

  // Below a handful of photos there is no distribution to sit in, and the
  // "median" would just be one arbitrary photo.
  if (scores.length < 4) return null;

  // The median is interpolated rather than picked: on an even-sized batch
  // split between good and dull, taking one side's value as the zero point
  // would leave that whole half judged as merely average.
  const mid = scores.length >> 1;
  const median = scores.length % 2 === 1 ? scores[mid] : (scores[mid - 1] + scores[mid]) / 2;
  const standout = scores[Math.min(scores.length - 1, Math.floor(scores.length * 0.75))];
  return { median, standout };
}

/**
 * How far the general prior should stand back on this particular photo.
 *
 * A general prior is what you use in the absence of knowing the person, not
 * instead of it. So it fades by half as a taste direction is learned, and
 * fades away completely on a photo that resembles one the user has already
 * kept or dropped — there, they have answered the question themselves, and a
 * model trained on contest photography does not get to overrule them.
 */
function personalDamping(
  photo: ScoredPhoto,
  taste: TasteDirection | null,
  remembered: RememberedTaste,
): number {
  const spokenAbout = Math.max(
    nearestAffinity(photo, remembered.liked),
    nearestAffinity(photo, remembered.rejected),
  );
  return Math.min(1, Math.max(PERSONAL_DISPLACES * (taste?.confidence ?? 0), spokenAbout));
}

/**
 * How this photo compares with the rest of its batch as a photograph, as a
 * ranking adjustment.
 */
export function contentBias(
  photo: ScoredPhoto,
  baseline: ContentBaseline | null,
  damping = 0,
): number {
  if (!baseline) return 0;
  const score = contentScore(photo.embedding);
  if (score === null) return 0;

  const relative = Math.max(-1, Math.min(1, (score - baseline.median) / (CONTENT_SPREAD / 2)));
  return CONTENT_WEIGHT * (1 - damping) * relative;
}

/** Projecting this strongly is worth telling the user about. */
const CLEARLY_TO_TASTE = 0.5;

/** In the top quarter of its own batch as a photograph. */
function standsOut(photo: ScoredPhoto, baseline: ContentBaseline | null | undefined): boolean {
  const score = contentScore(photo.embedding);
  return Boolean(baseline) && score !== null && score >= baseline!.standout;
}

/** Whether the taste direction is what put this photo up the list. */
function matchesTaste(photo: ScoredPhoto, taste: TasteDirection | null | undefined): boolean {
  if (!taste) return false;
  return tasteBias(photo, taste) >= TASTE_WEIGHT * taste.confidence * CLEARLY_TO_TASTE;
}

/**
 * Re-chooses a selection given what the user liked and rejected.
 *
 * Liked photos are pinned — a tap should never be undone by the next
 * recalculation — and also pull similar photos up. Rejected photos are dropped
 * and push similar photos down. Everything else is the usual diverse selection,
 * so the remaining slots still spread across subjects rather than filling up
 * with near-copies of whatever was liked.
 *
 * Photos with no embedding are unaffected by steering rather than penalised by
 * it: not knowing what a photo shows is not evidence against it.
 */
export function selectWithSteering(
  candidates: ScoredPhoto[],
  steering: Steering,
  ratio: number = SELECTION_RATIO,
  remembered: RememberedTaste = NO_TASTE,
): ScoredPhoto[] {
  const liked = new Set(steering.liked);
  const rejected = new Set(steering.rejected);

  const pool = candidates.filter((photo) => !rejected.has(photo.id));
  const seeds = candidates.filter((photo) => liked.has(photo.id));
  const wanted = Math.max(selectionSize(pool.length, ratio), seeds.length);

  const likedDirection = meanEmbedding(seeds);
  const rejectedPhotos = candidates.filter((photo) => rejected.has(photo.id));
  const taste = steeredTaste(candidates, steering, remembered);
  const content = contentBaseline(pool);

  const valueOf = (photo: ScoredPhoto) => {
    let unwanted = 0;
    for (const reject of rejectedPhotos) {
      unwanted = Math.max(unwanted, contentAffinity(photo, reject.embedding ?? null));
    }
    const remembersDislike = nearestAffinity(photo, remembered.rejected);
    return (
      photo.score -
      REJECT_WEIGHT * unwanted -
      REMEMBERED_REJECT_WEIGHT * remembersDislike +
      tasteBias(photo, taste) +
      contentBias(photo, content, personalDamping(photo, taste, remembered))
    );
  };

  const noveltyDiscount = (photo: ScoredPhoto) => {
    const asked = contentAffinity(photo, likedDirection);
    const remembers = nearestAffinity(photo, remembered.liked);
    // Whichever relief is larger applies; they do not stack, so remembered
    // taste can never make repetition cheaper than an explicit tap does.
    return 1 - Math.max(LIKE_RELIEF * asked, REMEMBERED_LIKE_RELIEF * remembers);
  };

  return selectDiverse(pool, wanted, seeds, valueOf, noveltyDiscount);
}

// ---------------------------------------------------------------------------
// Explaining a pick
// ---------------------------------------------------------------------------

/**
 * Why a photo ended up in the selection.
 *
 * The score alone stopped explaining anything several changes ago: on a real
 * batch every surviving photo lands between 0.85 and 0.96, and the actual
 * decision is made by duplicate collapsing, subject diversity and the user's
 * own taps. Showing the number implies a ranking that is not the one doing the
 * choosing.
 */
export type PickReason =
  | "kept"
  | "best-of-similar"
  | "like-your-picks"
  | "well-composed"
  | "top-quality"
  | "different-subject";

export const REASON_LABELS: Record<PickReason, string> = {
  kept: "you kept this",
  "best-of-similar": "best of similar",
  "like-your-picks": "like your picks",
  "well-composed": "well composed",
  "top-quality": "top quality",
  "different-subject": "different subject",
};

/** Above this, a photo is close enough to something already chosen that its
 *  place is owed to quality rather than to covering new ground. */
const NOVEL_ENOUGH = 0.45;

/** Matching remembered taste this closely is worth saying out loud. */
const CLEARLY_REMEMBERED = 0.55;

export type ExplainContext = {
  steering: Steering;
  remembered: RememberedTaste;
  /** Photo id to how many near-duplicates it beat. */
  alternates: Map<string, number>;
  /** What the taps have taught, when there is enough of it to have learned. */
  taste?: TasteDirection | null;
  /** Where this batch sits on the content head's scale. */
  content?: ContentBaseline | null;
};

/**
 * Reasons for each pick, in the order they were chosen.
 *
 * Ordered by what a person would find most informative, not by what the
 * algorithm weighted most: an explicit tap first, then that this photo stood in
 * for several near-identical ones, then remembered taste, then whether it is
 * here for quality or for coverage.
 */
export function explainPicks(
  picks: ScoredPhoto[],
  context: ExplainContext,
): Map<string, PickReason> {
  const liked = new Set(context.steering.liked);
  const reasons = new Map<string, PickReason>();
  const chosen: ScoredPhoto[] = [];

  picks.forEach((photo, index) => {
    const alternates = context.alternates.get(photo.id) ?? 0;
    let novelty = 1;
    for (const already of chosen) {
      novelty = Math.min(novelty, 1 - similarity(photo, already));
    }

    let reason: PickReason;
    if (liked.has(photo.id)) {
      reason = "kept";
    } else if (alternates > 0) {
      reason = "best-of-similar";
    } else if (
      matchesTaste(photo, context.taste) ||
      nearestAffinity(photo, context.remembered.liked) >= CLEARLY_REMEMBERED
    ) {
      // Two different claims, one honest label: it resembles a photo you kept,
      // or it sits on the side of the taste direction your keeps are on.
      reason = "like-your-picks";
    } else if (standsOut(photo, context.content)) {
      reason = "well-composed";
    } else if (index === 0 || novelty < NOVEL_ENOUGH) {
      reason = "top-quality";
    } else {
      reason = "different-subject";
    }

    reasons.set(photo.id, reason);
    chosen.push(photo);
  });

  return reasons;
}

/** The label as shown, with the count folded in where there is one. */
export function reasonLabel(reason: PickReason, alternates: number): string {
  if (reason === "best-of-similar" && alternates > 0) {
    return `best of ${alternates + 1}`;
  }
  return REASON_LABELS[reason];
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function selectBestPhotos(
  photos: AnalyzedPhoto[],
  ratio: number = SELECTION_RATIO,
): Selection {
  if (photos.length === 0) {
    return { selected: [], ranked: [], duplicateGroups: [], rejectedCount: 0 };
  }

  const scored = photos.map(scorePhoto);
  const groups = groupNearDuplicates(scored);
  const representatives = groups.map((group) => group.best);

  const passing = representatives.filter((photo) => photo.rejectedFor === null);
  const rejectedCount = scored.filter((photo) => photo.rejectedFor !== null).length;

  // Target is based on distinct photos, not the raw count, so a batch padded
  // with bursts doesn't inflate how many slots we hand out.
  const target = selectionSize(representatives.length, ratio);

  const byScore = compareForRanking;
  const candidates = [...passing].sort(byScore);

  // The floor exists to stop the *ratio* returning a pointlessly thin
  // selection; it is not a licence to pad with photos the quality bar just
  // rejected. If only four photos are any good, four is the honest answer.
  const content = contentBaseline(candidates);
  const selected = selectDiverse(candidates, target, [], (photo) =>
    photo.score + contentBias(photo, content),
  );

  // Unless nothing passed at all — then show the best of a bad batch rather
  // than an empty screen. These keep their `rejectedFor`, so the UI can say why.
  if (selected.length === 0) {
    selected.push(
      ...[...representatives].sort(byScore).slice(0, Math.min(target, MIN_SELECTION)),
    );
  }

  const selectedIds = new Set(selected.map((photo) => photo.id));

  return {
    // Upload order, so the review grid reads chronologically.
    selected: scored.filter((photo) => selectedIds.has(photo.id)),
    ranked: [...scored].sort(byScore),
    duplicateGroups: groups.filter((group) => group.alternates.length > 0),
    rejectedCount,
  };
}

/**
 * Photos worth spending the expensive second stage on.
 *
 * Embedding costs roughly 300 ms a photo against stage one's ~50 ms, so it
 * runs only on photos that could plausibly be selected: the deduplicated,
 * quality-passing candidates, a few times over the number of slots so there is
 * real competition to resolve.
 */
export function shortlistForEmbedding(
  selection: Selection,
  ratio: number = SELECTION_RATIO,
): ScoredPhoto[] {
  const candidates = selection.ranked.filter((photo) => photo.rejectedFor === null);
  const target = selectionSize(candidates.length, ratio);
  // Twice the slots rather than three times: enough competition to make the
  // choice meaningful, while cutting a third off the app's most expensive and
  // most memory-hungry stage.
  return candidates.slice(0, Math.max(target * 2, Math.min(candidates.length, 16)));
}

/**
 * NOT-YET-SOLVED: what the photo is actually of.
 *
 * Everything above measures whether a photo is technically sound. None of it
 * can tell a striking composition from a well-exposed photo of nothing, so a
 * boring-but-sharp frame outranks an interesting one with motion blur.
 *
 * Content embeddings (`analysis/embedding.ts`) close part of this: diversity
 * and duplicate detection now spread by subject rather than by colour. The
 * taste direction closes another part: once the user has kept and dropped a
 * few photos, judgement is learned from those taps and applies to everything
 * that follows.
 *
 * A user who has said nothing yet is covered by the content head in
 * `analysis/aesthetic.ts`, trained on 20,437 human-rated photographs, which
 * answers "is this a good photograph?" at Spearman 0.645 on held-out data.
 *
 * What none of it answers is "was this worth remembering?" — which for a trip
 * is the question that matters most, and is not the same question. The head is
 * trained on contest photography, so it rewards composition and light; on the
 * user's own batch it ranked a torpedo room last, and a torpedo room is
 * exactly the sort of thing someone photographs a submarine tour for. Personal
 * taste corrects that once there are taps, but nothing corrects it before.
 *
 * The signal we have and do not use is what the camera already recorded about
 * the user's attention: how many times they photographed a thing, and how long
 * they stayed with it. `groupNearDuplicates` counts the retakes and throws the
 * number away after picking the best frame, and `takenAt` gives the dwell.
 * Eight attempts at one subject is eight decisions that it mattered — evidence
 * about what the user cared about that needs no model and no taps.
 *
 * That is also why the count is still governed by a ratio rather than falling
 * out of the quality bar: on technical merit alone, most of a decent batch
 * passes, and "keep everything above the bar" would return nearly everything.
 * Selecting by an absolute bar becomes the right policy once the score
 * captures worth rather than execution, at which point MIN/MAX_SELECTION
 * become guardrails rather than the deciding factor.
 */
