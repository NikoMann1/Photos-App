import test from "node:test";
import assert from "node:assert/strict";
import type { ImageMetrics } from "./analysis/metrics";
import { contentScore } from "./analysis/aesthetic";
import {
  MAX_SELECTION,
  MIN_SELECTION,
  isNearDuplicate,
  scorePhoto,
  selectBestPhotos,
  selectionSize,
  NO_TASTE,
  explainPicks,
  reasonLabel,
  selectWithSteering,
  shortlistForEmbedding,
  similarity,
  contentBaseline,
  contentBias,
  steeredTaste,
  tasteBias,
  tasteDirection,
  type AnalyzedPhoto,
  type ScoredPhoto,
} from "./scoring";

/** A unit vector pointing `angle` radians from the first axis. */
function embeddingAt(angle: number, dims = 512): Float32Array {
  const v = new Float32Array(dims);
  v[0] = Math.cos(angle);
  v[1] = Math.sin(angle);
  return v;
}

/** A well-exposed, sharp, textured photo — the baseline every case varies from. */
function metrics(overrides: Partial<ImageMetrics> = {}): ImageMetrics {
  return {
    width: 512,
    height: 384,
    sharpness: 540,
    centerSharpness: 140,
    focus: 0.25,
    noiseRatio: 0.65,
    contrast: 46,
    brightness: 118,
    clippedShadows: 0.004,
    clippedHighlights: 0.001,
    dynamicRange: 180,
    colorfulness: 40,
    // Deliberately not degenerate: half the bits set.
    hash: "0f".repeat(32),
    colorSignature: Array.from({ length: 32 }, (_, i) => 80 + (i % 5)),
    ...overrides,
  };
}

const NO_STEERING_IDS = { liked: [], rejected: [] };

let nextId = 0;
function photo(overrides: Partial<ImageMetrics> = {}, extra: Partial<AnalyzedPhoto> = {}): AnalyzedPhoto {
  nextId += 1;
  return {
    id: `p${nextId}`,
    name: `p${nextId}.jpg`,
    type: "image/jpeg",
    size: 2_000_000,
    takenAt: null,
    metrics: metrics(overrides),
    ...extra,
  };
}

test("selection count is clamped between the floor and the cap", () => {
  assert.equal(selectionSize(0), 0);
  assert.equal(selectionSize(3), 3, "a batch smaller than the floor returns all of it");
  assert.equal(selectionSize(20), MIN_SELECTION, "10% of 20 would be 2, which is too thin");
  assert.equal(selectionSize(100), 10);
  assert.equal(selectionSize(500), MAX_SELECTION);
  assert.equal(selectionSize(5000), MAX_SELECTION);
});

test("a blurred photo scores below a sharp one and is rejected", () => {
  const sharp = scorePhoto(photo());
  const soft = scorePhoto(photo({ focus: 0.002, sharpness: 4 }));

  assert.ok(sharp.score > soft.score);
  assert.equal(sharp.rejectedFor, null);
  assert.equal(soft.rejectedFor, "out of focus");
});

test("a nearly flat frame cannot pass as sharp", () => {
  // Regression: focus is sharpness/contrast², so a low-contrast frame divided
  // by a tiny number scored as sharp despite carrying no detail at all.
  const flatAndSoft = scorePhoto(photo({ focus: 0.09, sharpness: 0.6, contrast: 2.5 }));
  assert.equal(flatAndSoft.rejectedFor, "out of focus");
});

test("grain is not mistaken for detail", () => {
  const clean = scorePhoto(photo());
  const grainy = scorePhoto(photo({ focus: 2.8, sharpness: 6000, noiseRatio: 2.9 }));
  assert.ok(grainy.score < clean.score, "a noisy frame should not outrank a clean one");
});

test("blown highlights and crushed shadows are rejected", () => {
  assert.equal(scorePhoto(photo({ clippedHighlights: 0.34 })).rejectedFor, "blown highlights");
  assert.equal(scorePhoto(photo({ clippedShadows: 0.4 })).rejectedFor, "crushed shadows");
});

test("duplicates need agreement on structure and colour, not just one of them", () => {
  const base = scorePhoto(photo());
  const identical = scorePhoto(photo());
  assert.equal(isNearDuplicate(base, identical), true);

  // Same layout, different colours: two photos of different subjects that
  // happen to share a composition must not be merged.
  const differentColour = scorePhoto(
    photo({ colorSignature: Array.from({ length: 32 }, (_, i) => 10 + (i % 3)) }),
  );
  assert.equal(isNearDuplicate(base, differentColour), false);

  // Same colours, unrelated structure.
  const differentStructure = scorePhoto(photo({ hash: "a5".repeat(32) }));
  assert.equal(isNearDuplicate(base, differentStructure), false);
});

test("a degenerate hash never merges photos on its own", () => {
  // Regression: photos dominated by one gradient all hash to nearly all-ones,
  // so hash distance alone merged unrelated shots and silently lost them.
  const flatHash = "ff".repeat(32);
  const a = scorePhoto(photo({ hash: flatHash }, ));
  const b = scorePhoto(photo({ hash: flatHash }));
  assert.equal(isNearDuplicate(a, b), false, "no timestamps, so there is nothing to trust");

  const t = Date.parse("2026-08-20T10:00:00Z");
  const burstA = scorePhoto(photo({ hash: flatHash }, { takenAt: t }));
  const burstB = scorePhoto(photo({ hash: flatHash }, { takenAt: t + 2000 }));
  assert.equal(isNearDuplicate(burstA, burstB), true, "seconds apart: a burst");

  const laterA = scorePhoto(photo({ hash: flatHash }, { takenAt: t }));
  const laterB = scorePhoto(photo({ hash: flatHash }, { takenAt: t + 3_600_000 }));
  assert.equal(isNearDuplicate(laterA, laterB), false, "an hour apart: deliberate");
});

test("a burst collapses to one photo, and the best frame survives", () => {
  const t = Date.parse("2026-08-20T10:00:00Z");
  const good = photo({}, { takenAt: t, id: "good", name: "good.jpg" });
  const soft = photo({ focus: 0.02, sharpness: 20 }, { takenAt: t + 1500, id: "soft", name: "soft.jpg" });

  const result = selectBestPhotos([soft, good]);
  assert.equal(result.duplicateGroups.length, 1);
  assert.equal(result.duplicateGroups[0].best.id, "good");
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].id, "good");
});

test("between two copies of one frame, the less-compressed file wins", () => {
  // Regression: JPEG artefacts raise measured sharpness, so a low-quality copy
  // outscored the original by a hair and was the one kept.
  const t = Date.parse("2026-08-20T10:00:00Z");
  const big = photo({}, { id: "big", size: 4_000_000, takenAt: t });
  const small = photo({ sharpness: 560 }, { id: "small", size: 400_000, takenAt: t });

  const result = selectBestPhotos([small, big]);
  assert.equal(result.duplicateGroups.length, 1);
  assert.equal(result.selected[0].id, "big");
});

test("the floor never pads the selection with rejected photos", () => {
  // Regression: topping up to the floor pulled in photos the quality bar had
  // just rejected, so a blown-out frame was presented as a "best" photo.
  const keepers = Array.from({ length: 2 }, (_, i) =>
    photo({ colorSignature: Array.from({ length: 32 }, () => i * 60 + 10) }, { id: `keep${i}` }),
  );
  const rejects = Array.from({ length: 8 }, (_, i) =>
    photo(
      { focus: 0.001, sharpness: 2, colorSignature: Array.from({ length: 32 }, () => 130 + i * 12) },
      { id: `bad${i}` },
    ),
  );

  const result = selectBestPhotos([...keepers, ...rejects]);
  assert.equal(result.selected.length, 2, "only two photos passed the bar");
  assert.ok(result.selected.every((p) => p.rejectedFor === null));
  assert.equal(result.rejectedCount, 8);
});

test("when nothing passes the bar, show the best of a bad batch rather than nothing", () => {
  const rejects = Array.from({ length: 6 }, (_, i) =>
    photo(
      { focus: 0.001, sharpness: 2, colorSignature: Array.from({ length: 32 }, () => 20 + i * 30) },
      { id: `bad${i}` },
    ),
  );

  const result = selectBestPhotos(rejects);
  assert.ok(result.selected.length > 0, "an empty review screen is not a useful answer");
  assert.ok(result.selected.every((p) => p.rejectedFor !== null));
});

test("selection spreads across subjects instead of stacking one of them", () => {
  // Regression: on a real 100-photo batch every photo scored 0.92-0.96, so
  // ranking by score alone returned several shots of the same subject.
  // Eight near-identical photos of one scene, marginally the best-scoring,
  // plus two of a clearly different one.
  const sameSubject = Array.from({ length: 8 }, (_, i) =>
    photo(
      { colorfulness: 44, colorSignature: Array.from({ length: 32 }, () => 90) },
      { id: `same${i}`, takenAt: Date.parse("2026-08-20T10:00:00Z") + i * 600_000 },
    ),
  );
  const otherSubject = Array.from({ length: 2 }, (_, i) =>
    photo(
      { colorfulness: 30, colorSignature: Array.from({ length: 32 }, () => 15) },
      { id: `other${i}`, takenAt: Date.parse("2026-08-20T14:00:00Z") + i * 600_000 },
    ),
  );

  const result = selectBestPhotos([...sameSubject, ...otherSubject]);
  const picked = result.selected.map((p) => p.id);
  assert.ok(
    picked.some((id) => id.startsWith("other")),
    `the second subject was never picked: ${picked.join(", ")}`,
  );
});

test("diversity never overrides a real quality gap", () => {
  // A genuinely better photo must still win, however similar it is to the
  // rest — diversity breaks ties, it does not outrank quality.
  const good = photo({}, { id: "good" });
  const mediocre = Array.from({ length: 6 }, (_, i) =>
    photo(
      { focus: 0.03, sharpness: 30, colorSignature: Array.from({ length: 32 }, () => 20 + i * 30) },
      { id: `meh${i}` },
    ),
  );

  const result = selectBestPhotos([...mediocre, good]);
  assert.ok(result.selected.some((p) => p.id === "good"));
});

test("selection is returned in upload order, not score order", () => {
  const photos = Array.from({ length: 6 }, (_, i) =>
    photo(
      { colorfulness: 10 + i * 8, colorSignature: Array.from({ length: 32 }, () => 15 + i * 35) },
      { id: `p-${i}` },
    ),
  );

  const result = selectBestPhotos(photos);
  const order = result.selected.map((p) => photos.findIndex((q) => q.id === p.id));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("content embeddings override the colour signals when both photos have them", () => {
  // The case colour gets wrong: one photo and a hue-shifted copy of it. The
  // colour signatures disagree completely; the embeddings agree.
  const shared = embeddingAt(0);
  const a = scorePhoto(
    photo({ colorSignature: Array.from({ length: 32 }, () => 20) }, { embedding: shared }),
  );
  const b = scorePhoto(
    photo({ colorSignature: Array.from({ length: 32 }, () => 200) }, { embedding: shared }),
  );

  assert.ok(similarity(a, b) > 0.9, "identical content should read as near-identical");
  assert.equal(isNearDuplicate(a, b), true);
});

test("content embeddings keep different subjects apart despite matching pixels", () => {
  // The case a hash gets wrong: same layout and colours, different subjects.
  const flatHash = "ff".repeat(32);
  const t = Date.parse("2026-08-20T10:00:00Z");
  const a = scorePhoto(photo({ hash: flatHash }, { takenAt: t, embedding: embeddingAt(0) }));
  const b = scorePhoto(
    photo({ hash: flatHash }, { takenAt: t + 2000, embedding: embeddingAt(Math.PI / 2) }),
  );

  assert.ok(similarity(a, b) < 0.2);
  assert.equal(
    isNearDuplicate(a, b),
    false,
    "a shared layout and a shared moment must not merge different subjects",
  );
});

test("photos without embeddings still fall back to the cheap signals", () => {
  // The model may fail to load; the app must not depend on it.
  const a = scorePhoto(photo({}, { embedding: null }));
  const b = scorePhoto(photo({}, { embedding: null }));
  assert.equal(isNearDuplicate(a, b), true, "identical metrics still merge without a model");

  // 0.8, not 1: colour and structure agree completely, but with no capture
  // times the time term contributes nothing.
  assert.ok(similarity(a, b) > 0.75, `expected the cheap signals to agree, got ${similarity(a, b)}`);

  const t = Date.parse("2026-08-20T10:00:00Z");
  const withTimes = [
    scorePhoto(photo({}, { embedding: null, takenAt: t })),
    scorePhoto(photo({}, { embedding: null, takenAt: t + 1000 })),
  ];
  assert.ok(similarity(withTimes[0], withTimes[1]) > 0.95, "with times, all three signals agree");
});

test("the embedding shortlist covers the contenders, not the whole batch", () => {
  const good = Array.from({ length: 40 }, (_, i) =>
    photo(
      { colorSignature: Array.from({ length: 32 }, () => (i * 7) % 250) },
      { id: `ok${i}` },
    ),
  );
  const blurry = Array.from({ length: 20 }, (_, i) =>
    photo(
      { focus: 0.001, sharpness: 2, colorSignature: Array.from({ length: 32 }, () => (i * 11) % 250) },
      { id: `bad${i}` },
    ),
  );

  const shortlist = shortlistForEmbedding(selectBestPhotos([...good, ...blurry]));
  assert.ok(shortlist.length < good.length + blurry.length, "must not embed everything");
  assert.ok(shortlist.length >= selectionSize(good.length), "must leave room to choose");
  assert.ok(
    shortlist.every((p) => p.rejectedFor === null),
    "no point embedding photos the quality bar already rejected",
  );
});

/** Scored photos in one of three content directions, for steering tests. */
function subject(direction: number, count: number, prefix: string): ScoredPhoto[] {
  return Array.from({ length: count }, (_, i) =>
    scorePhoto(
      photo(
        { colorSignature: Array.from({ length: 32 }, () => (direction * 60 + i * 3) % 250) },
        { id: `${prefix}${i}`, embedding: embeddingAt((direction * Math.PI) / 3) },
      ),
    ),
  );
}

test("liking a photo keeps it and pulls in more of the same subject", () => {
  const boats = subject(0, 6, "boat");
  const rooms = subject(1, 6, "room");
  const signs = subject(2, 6, "sign");
  const all = [...boats, ...rooms, ...signs];

  const neutral = selectWithSteering(all, { liked: [], rejected: [] });
  const steered = selectWithSteering(all, { liked: ["boat0"], rejected: [] });

  assert.ok(steered.some((p) => p.id === "boat0"), "a liked photo must always survive");

  const boatsBefore = neutral.filter((p) => p.id.startsWith("boat")).length;
  const boatsAfter = steered.filter((p) => p.id.startsWith("boat")).length;
  assert.ok(
    boatsAfter > boatsBefore,
    `liking a boat should surface more boats, got ${boatsBefore} → ${boatsAfter}`,
  );
});

test("rejecting a photo removes it and pushes down its whole subject", () => {
  const boats = subject(0, 6, "boat");
  const rooms = subject(1, 6, "room");
  const all = [...boats, ...rooms];

  const neutral = selectWithSteering(all, { liked: [], rejected: [] });
  assert.ok(neutral.some((p) => p.id.startsWith("boat")), "boats start out represented");

  const steered = selectWithSteering(all, { liked: [], rejected: ["boat0"] });
  assert.ok(!steered.some((p) => p.id === "boat0"), "a rejected photo must not come back");

  const boatsBefore = neutral.filter((p) => p.id.startsWith("boat")).length;
  const boatsAfter = steered.filter((p) => p.id.startsWith("boat")).length;
  assert.ok(
    boatsAfter < boatsBefore,
    `rejecting a boat should surface fewer boats, got ${boatsBefore} → ${boatsAfter}`,
  );
});

test("steering still spreads across subjects rather than returning copies", () => {
  // The failure this guards against: liking one photo floods the results with
  // near-identical versions of it, undoing diverse selection.
  const boats = subject(0, 10, "boat");
  const rooms = subject(1, 5, "room");

  const steered = selectWithSteering([...boats, ...rooms], { liked: ["boat0"], rejected: [] });
  assert.ok(
    steered.some((p) => p.id.startsWith("room")),
    "diversity must survive a like: results should not be all one subject",
  );
});

test("liked photos are kept even when the batch is smaller than the floor", () => {
  const photos = subject(0, 3, "p");
  const steered = selectWithSteering(photos, { liked: ["p2"], rejected: [] });
  assert.ok(steered.some((p) => p.id === "p2"));
  assert.ok(steered.length <= photos.length);
});

test("steering is inert without embeddings rather than destructive", () => {
  // No model: a tap can still pin and drop, but must not reorder by guesswork.
  const plain = Array.from({ length: 8 }, (_, i) =>
    scorePhoto(
      photo(
        { colorSignature: Array.from({ length: 32 }, () => (i * 30) % 250) },
        { id: `p${i}`, embedding: null },
      ),
    ),
  );

  const steered = selectWithSteering(plain, { liked: ["p3"], rejected: ["p0"] });
  assert.ok(steered.some((p) => p.id === "p3"), "pinning works without a model");
  assert.ok(!steered.some((p) => p.id === "p0"), "dropping works without a model");
});

test("a remembered dislike demotes a subject but never removes it", () => {
  // The failure this guards against: dropping one bathroom photo permanently
  // hiding the one with something worth keeping on the wall.
  const disliked = subject(0, 4, "bath");
  const neutral = subject(1, 4, "other");
  const all = [...disliked, ...neutral];
  const remembered = { liked: [], rejected: [disliked[0].embedding!] };

  const withMemory = selectWithSteering(all, { liked: [], rejected: [] }, undefined, remembered);
  const without = selectWithSteering(all, { liked: [], rejected: [] }, undefined, NO_TASTE);

  const count = (list: typeof all) => list.filter((p) => p.id.startsWith("bath")).length;
  assert.ok(
    count(withMemory) <= count(without),
    "a remembered dislike should not increase its subject's representation",
  );
  assert.ok(
    withMemory.length === without.length,
    "demotion must not shrink the selection — only an explicit drop removes photos",
  );
});

test("an explicit drop still removes outright, unlike a remembered one", () => {
  const photos = subject(0, 4, "a").concat(subject(1, 4, "b"));
  const dropped = selectWithSteering(photos, { liked: [], rejected: ["a0"] });
  assert.ok(!dropped.some((p) => p.id === "a0"));
});

test("remembered tastes do not average into something meaning neither", () => {
  // Liking two unrelated subjects must favour both, not their midpoint.
  const engines = subject(0, 4, "engine");
  const views = subject(3, 4, "view");
  const filler = subject(1, 6, "filler");
  const remembered = {
    liked: [engines[0].embedding!, views[0].embedding!],
    rejected: [],
  };

  const steered = selectWithSteering(
    [...engines, ...views, ...filler],
    { liked: [], rejected: [] },
    undefined,
    remembered,
  );

  assert.ok(steered.some((p) => p.id.startsWith("engine")), "first remembered taste is served");
  assert.ok(steered.some((p) => p.id.startsWith("view")), "second remembered taste is served");
});

test("remembered taste never outweighs a tap in the current batch", () => {
  const wanted = subject(0, 5, "wanted");
  const remembered = { liked: [subject(2, 1, "old")[0].embedding!], rejected: [] };

  const steered = selectWithSteering(
    [...wanted, ...subject(2, 5, "old")],
    { liked: ["wanted0"], rejected: [] },
    undefined,
    remembered,
  );
  assert.ok(steered.some((p) => p.id === "wanted0"), "the tap is still honoured");
});

test("a pick explains itself by the reason a person would care about", () => {
  const base = subject(0, 1, "plain")[0];
  const liked = subject(1, 1, "liked")[0];
  const deduped = subject(2, 1, "group")[0];

  const reasons = explainPicks([liked, deduped, base], {
    steering: { liked: ["liked0"], rejected: [] },
    remembered: NO_TASTE,
    alternates: new Map([["group0", 3]]),
  });

  assert.equal(reasons.get("liked0"), "kept", "an explicit tap outranks every other reason");
  assert.equal(reasons.get("group0"), "best-of-similar");
  assert.equal(reasonLabel("best-of-similar", 3), "best of 4", "counts the photo it stood in for");
});

test("remembered taste is named when it is what put a photo here", () => {
  const engine = subject(0, 1, "engine")[0];
  const reasons = explainPicks([engine], {
    steering: { liked: [], rejected: [] },
    remembered: { liked: [engine.embedding!], rejected: [] },
    alternates: new Map(),
  });
  assert.equal(reasons.get("engine0"), "like-your-picks");
});

test("later picks are distinguished by whether they cover new ground", () => {
  const first = subject(0, 1, "a")[0];
  const nearlyTheSame = subject(0, 2, "a2")[1];
  const unrelated = subject(3, 1, "b")[0];

  const reasons = explainPicks([first, nearlyTheSame, unrelated], {
    steering: { liked: [], rejected: [] },
    remembered: NO_TASTE,
    alternates: new Map(),
  });

  assert.equal(reasons.get("a0"), "top-quality", "the first pick is not about coverage");
  assert.equal(reasons.get("a21"), "top-quality", "a near-copy is here on merit, not novelty");
  assert.equal(reasons.get("b0"), "different-subject");
});

// ---------------------------------------------------------------------------
// Judgement
// ---------------------------------------------------------------------------

/** A unit vector with the given weights on the given axes. */
function vector(weights: Record<number, number>, dims = 512): Float32Array {
  const v = new Float32Array(dims);
  for (const [axis, weight] of Object.entries(weights)) v[Number(axis)] = weight;
  const norm = Math.hypot(...v);
  for (let i = 0; i < dims; i++) v[i] /= norm;
  return v;
}

/** Axis 0 is what kept and dropped photos share; 1 and 2 are what separates them. */
const SHARED = vector({ 0: 1 });
const KEPT_SIDE = vector({ 0: 1, 1: 1 });
const DROPPED_SIDE = vector({ 0: 1, 2: 1 });

function scoredWith(embedding: Float32Array, id: string): ScoredPhoto {
  return scorePhoto(photo({}, { id, embedding }));
}

test("judgement waits for both sides before it decides anything", () => {
  const kept = [KEPT_SIDE, KEPT_SIDE, KEPT_SIDE];
  const dropped = [DROPPED_SIDE, DROPPED_SIDE, DROPPED_SIDE];

  assert.equal(tasteDirection(kept, []), null, "keeps alone say what you like, not what you don't");
  assert.equal(tasteDirection([], dropped), null);
  assert.equal(tasteDirection(kept.slice(0, 2), dropped), null, "two taps is a quirk, not a taste");

  const taste = tasteDirection(kept, dropped);
  assert.ok(taste, "three of each is enough to learn from");
  assert.ok(taste!.confidence > 0 && taste!.confidence < 1, "little evidence pulls gently");
  assert.equal(tasteDirection(
    Array.from({ length: 20 }, () => KEPT_SIDE),
    Array.from({ length: 20 }, () => DROPPED_SIDE),
  )!.confidence, 1, "plenty of evidence pulls at full strength");
});

test("judgement learns what separates keeps from drops, not what they have in common", () => {
  const taste = tasteDirection(
    Array.from({ length: 10 }, () => KEPT_SIDE),
    Array.from({ length: 10 }, () => DROPPED_SIDE),
  );

  const likeKeeps = tasteBias(scoredWith(KEPT_SIDE, "keep"), taste);
  const likeDrops = tasteBias(scoredWith(DROPPED_SIDE, "drop"), taste);
  const shared = tasteBias(scoredWith(SHARED, "shared"), taste);

  assert.ok(likeKeeps > 0, "a photo on the kept side is promoted");
  assert.ok(likeDrops < 0, "and one on the dropped side is demoted, not merely ignored");
  assert.ok(Math.abs(shared) < 1e-6, "what both sides share is no evidence either way");

  // The rule this replaces cannot make that distinction: measured only by
  // resemblance to a kept photo, the shared subject looks like a keeper.
  const reasons = explainPicks([scoredWith(SHARED, "shared")], {
    steering: NO_STEERING_IDS,
    remembered: { liked: [KEPT_SIDE], rejected: [] },
    alternates: new Map(),
  });
  assert.equal(reasons.get("shared"), "like-your-picks");
});

test("judgement is inert on photos it cannot see the content of", () => {
  const taste = tasteDirection(
    Array.from({ length: 10 }, () => KEPT_SIDE),
    Array.from({ length: 10 }, () => DROPPED_SIDE),
  );
  const blind = scorePhoto(photo({}, { id: "blind", embedding: null }));
  assert.equal(tasteBias(blind, taste), 0, "not knowing is not evidence against");
  assert.equal(tasteBias(scoredWith(KEPT_SIDE, "sighted"), null), 0);
});

test("this batch's taps sharpen judgement on this batch, not only the next one", () => {
  const candidates = [
    ...Array.from({ length: 3 }, (_, i) => scoredWith(KEPT_SIDE, `keep${i}`)),
    ...Array.from({ length: 3 }, (_, i) => scoredWith(DROPPED_SIDE, `drop${i}`)),
    scoredWith(SHARED, "other"),
  ];
  const steering = {
    liked: ["keep0", "keep1", "keep2"],
    rejected: ["drop0", "drop1", "drop2"],
  };

  assert.equal(steeredTaste(candidates, NO_STEERING_IDS), null, "nothing said, nothing learned");
  assert.ok(steeredTaste(candidates, steering), "taps in the current batch count as evidence");
});

test("a strong opinion still leaves room for other subjects", () => {
  // The failure this guards against: a learned preference that wins
  // photo-for-photo against novelty returns a screenful of the same thing.
  const favourite = Array.from({ length: 8 }, (_, i) => scoredWith(KEPT_SIDE, `fav${i}`));
  const others = [
    ...Array.from({ length: 4 }, (_, i) => scoredWith(vector({ 3: 1 }), `x${i}`)),
    ...Array.from({ length: 4 }, (_, i) => scoredWith(vector({ 4: 1 }), `y${i}`)),
  ];
  const remembered = {
    liked: Array.from({ length: 20 }, () => KEPT_SIDE),
    rejected: Array.from({ length: 20 }, () => DROPPED_SIDE),
  };

  const picked = selectWithSteering([...favourite, ...others], NO_STEERING_IDS, undefined, remembered);
  const favourites = picked.filter((p) => p.id.startsWith("fav")).length;

  assert.ok(favourites >= 1, "the subject the user keeps must be represented");
  assert.ok(
    favourites < picked.length,
    `judgement crowded out every other subject: ${picked.map((p) => p.id).join(", ")}`,
  );
});

test("judgement can say why, once it has learned enough to be worth saying", () => {
  const taste = tasteDirection(
    Array.from({ length: 10 }, () => KEPT_SIDE),
    Array.from({ length: 10 }, () => DROPPED_SIDE),
  );
  const reasons = explainPicks([scoredWith(KEPT_SIDE, "yours"), scoredWith(DROPPED_SIDE, "not")], {
    steering: NO_STEERING_IDS,
    remembered: NO_TASTE,
    alternates: new Map(),
    taste,
  });

  assert.equal(reasons.get("yours"), "like-your-picks");
  assert.notEqual(reasons.get("not"), "like-your-picks", "the other side is never claimed as taste");
});

// ---------------------------------------------------------------------------
// Judgement with nothing taught: the general prior
// ---------------------------------------------------------------------------

/**
 * Basis vectors the content head rates highest and lowest, found by asking it
 * rather than by hard-coding numbers that a retrained head would invalidate.
 */
function contentExtremes(): { best: Float32Array; worst: Float32Array } {
  let best = 0;
  let worst = 0;
  for (let axis = 0; axis < 512; axis++) {
    const here = contentScore(vector({ [axis]: 1 }))!;
    if (here > contentScore(vector({ [best]: 1 }))!) best = axis;
    if (here < contentScore(vector({ [worst]: 1 }))!) worst = axis;
  }
  return { best: vector({ [best]: 1 }), worst: vector({ [worst]: 1 }) };
}

test("the content head judges a photograph without being taught anything", () => {
  const { best, worst } = contentExtremes();
  assert.ok(
    contentScore(best)! > contentScore(worst)!,
    "the head has to separate something, or it is 2 KB of nothing",
  );
  assert.equal(contentScore(null), null, "no embedding is no opinion, not a low score");
  assert.equal(contentScore(new Float32Array(64)), null, "a wrong-sized vector is refused");
});

test("content is judged against the batch, never against a fixed bar", () => {
  // The head is trained on contest photographs and a real phone batch scores
  // far below its median; an absolute threshold would reject the whole roll.
  const { best, worst } = contentExtremes();
  const batch = [
    ...Array.from({ length: 4 }, (_, i) => scoredWith(worst, `dull${i}`)),
    ...Array.from({ length: 4 }, (_, i) => scoredWith(best, `good${i}`)),
  ];

  const baseline = contentBaseline(batch);
  assert.ok(baseline, "a batch of eight has a distribution to sit in");
  assert.ok(
    contentBias(batch.at(-1)!, baseline) > 0 && contentBias(batch[0], baseline) < 0,
    "the batch's own median is the zero point",
  );

  // A batch that is uniformly poor by the head's absolute scale still has a
  // best photo, and it is the one that gets promoted.
  const allDull = Array.from({ length: 6 }, (_, i) => scoredWith(worst, `d${i}`));
  assert.equal(
    contentBias(allDull[0], contentBaseline(allDull)),
    0,
    "with nothing to choose between, content says nothing",
  );

  assert.equal(contentBaseline(batch.slice(0, 3)), null, "three photos are not a distribution");
});

test("with nothing taught, the better photograph wins between equal-quality shots", () => {
  const { best, worst } = contentExtremes();
  const batch = [
    ...Array.from({ length: 6 }, (_, i) => scoredWith(worst, `dull${i}`)),
    ...Array.from({ length: 6 }, (_, i) => scoredWith(best, `good${i}`)),
  ];

  // No taps at all — the cold start this exists for.
  const picked = selectWithSteering(batch, NO_STEERING_IDS);
  assert.ok(
    picked.filter((p) => p.id.startsWith("good")).length >
      picked.filter((p) => p.id.startsWith("dull")).length,
    `content judgement did nothing: ${picked.map((p) => p.id).join(", ")}`,
  );
});

test("the general prior gets out of the way where the user has spoken", () => {
  const { worst } = contentExtremes();
  const dull = scoredWith(worst, "dull0");
  const baseline = contentBaseline([
    ...Array.from({ length: 4 }, (_, i) => scoredWith(worst, `d${i}`)),
    ...Array.from({ length: 4 }, (_, i) => scoredWith(vector({ 7: 1 }), `o${i}`)),
  ]);

  const unopposed = contentBias(dull, baseline);
  assert.ok(unopposed < 0, "on its own the head demotes it");

  // Same photo, but the user kept one like it in an earlier batch.
  const steered = selectWithSteering(
    [dull, ...Array.from({ length: 6 }, (_, i) => scoredWith(vector({ 7: 1 }), `other${i}`))],
    NO_STEERING_IDS,
    undefined,
    { liked: [worst], rejected: [] },
  );
  assert.ok(
    steered.some((p) => p.id === "dull0"),
    "a model trained on contest photography does not overrule the user",
  );
});

/**
 * A basis vector the head scores near `target`. Basis vectors are orthogonal,
 * so this varies content judgement while holding subject similarity at zero —
 * which blending toward the head's own extremes cannot do, since that makes
 * every photo resemble every other.
 */
function axisNear(target: number): Float32Array {
  let best = 0;
  for (let axis = 0; axis < 512; axis++) {
    const here = Math.abs(contentScore(vector({ [axis]: 1 }))! - target);
    if (here < Math.abs(contentScore(vector({ [best]: 1 }))! - target)) best = axis;
  }
  return vector({ [best]: 1 });
}

test("across the spread a real batch has, coverage still beats the general prior", () => {
  // The user's own batch spanned 3.97 to 4.77 on this head — 0.8 points. Over
  // a gap that size, a subject the head likes must not take every slot, even
  // when every photo of it is a near-copy of the last.
  const cluster = Array.from({ length: 8 }, (_, i) => scoredWith(axisNear(4.8), `same${i}`));
  const others = [
    ...Array.from({ length: 4 }, (_, i) => scoredWith(axisNear(4.0), `x${i}`)),
    ...Array.from({ length: 4 }, (_, i) => scoredWith(axisNear(4.05), `y${i}`)),
  ];

  const picked = selectWithSteering([...cluster, ...others], NO_STEERING_IDS);
  const fromCluster = picked.filter((p) => p.id.startsWith("same")).length;

  assert.ok(fromCluster >= 1, "the best-judged subject must be represented");
  assert.ok(
    fromCluster < picked.length,
    `content judgement crowded out every other subject: ${picked.map((p) => p.id).join(", ")}`,
  );
});
