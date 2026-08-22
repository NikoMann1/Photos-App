import test from "node:test";
import assert from "node:assert/strict";
import type { ImageMetrics } from "./analysis/metrics";
import {
  MAX_SELECTION,
  MIN_SELECTION,
  isNearDuplicate,
  scorePhoto,
  selectBestPhotos,
  selectionSize,
  selectWithSteering,
  shortlistForEmbedding,
  similarity,
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
