/**
 * Photo scoring and selection.
 *
 * Scoring is *measured*, not learned: focus, exposure, tonal range and colour,
 * computed from the pixels in `lib/analysis/metrics.ts`. That reliably answers
 * "is this photo technically botched?" — blurred, out of focus, badly clipped.
 * It does not answer "is this a good photograph?", which needs a learned
 * aesthetic model; see NOT-YET-SOLVED at the bottom of this file.
 *
 * Selection therefore has three stages, in this order:
 *   1. collapse near-duplicates, keeping the best frame of each burst
 *   2. drop anything below an absolute quality bar
 *   3. rank what survives and take the top N
 *
 * The order matters: dedup first, so a burst of ten near-identical shots
 * spends one slot rather than ten.
 */

import {
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

export type AnalyzedPhoto = PhotoMeta & { metrics: ImageMetrics };

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
  const selected = candidates.slice(0, target);

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
 * NOT-YET-SOLVED: aesthetic quality.
 *
 * Everything above measures whether a photo is technically sound. None of it
 * can tell a striking composition from a well-exposed photo of nothing, so a
 * boring-but-sharp frame outranks an interesting one with motion blur.
 *
 * That is also why the count is still governed by a ratio rather than falling
 * out of the quality bar: on technical merit alone, most of a decent batch
 * passes, and "keep everything above the bar" would return nearly everything.
 * Selecting by an absolute bar becomes the right policy once the score
 * captures interestingness — a small on-device aesthetic model (NIMA-style, a
 * few MB via ONNX Runtime Web or TFJS) is the natural next step, at which
 * point MIN/MAX_SELECTION become guardrails rather than the deciding factor.
 */
