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
  type AnalyzedPhoto,
} from "./scoring";

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
