import test from "node:test";
import assert from "node:assert/strict";
import {
  chromaSignature,
  colorDistance,
  computeMetrics,
  differenceHash,
  hammingDistance,
  isDegenerateHash,
  type Pixels,
} from "./metrics";
import { toEpochMs } from "./exif";

/** Builds an RGBA buffer from a per-pixel colour function. */
function makePixels(
  width: number,
  height: number,
  color: (x: number, y: number) => [number, number, number],
): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = color(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

/**
 * A deterministic pseudo-random block pattern with fine detail on top.
 *
 * Irregular on purpose: a regular checkerboard averages out to a flat field
 * when downsampled, which makes its hash degenerate and its structure vanish —
 * the opposite of the photographic texture these tests need to stand in for.
 */
function texturedScene(size = 128, seed = 1): Pixels {
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return (state >>> 8) / 0x7fffff;
  };

  const blockSize = 8;
  const blocks = Math.ceil(size / blockSize);
  const tone: number[] = [];
  for (let i = 0; i < blocks * blocks; i++) tone.push(30 + random() * 200);

  return makePixels(size, size, (x, y) => {
    const block = Math.floor(y / blockSize) * blocks + Math.floor(x / blockSize);
    // The +/- term is fine detail within each block, which is what a blur
    // destroys and a focus measure should notice.
    const value = tone[block] + ((x * 7 + y * 13) % 2 === 0 ? 26 : -26);
    return [value, value * 0.9, value * 0.8];
  });
}

/** Box blur — the stand-in for an out-of-focus frame. */
function blurOf(pixels: Pixels, radius: number): Pixels {
  const { width, height, data } = pixels;
  const out = new Uint8ClampedArray(data.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0;
        let count = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            sum += data[(ny * width + nx) * 4 + channel];
            count++;
          }
        }
        out[(y * width + x) * 4 + channel] = sum / count;
      }
      out[(y * width + x) * 4 + 3] = 255;
    }
  }

  return { data: out, width, height };
}

const gradient = (size = 128) =>
  makePixels(size, size, (x, y) => {
    const v = Math.round(((x + y) / (2 * size)) * 255);
    return [v, v, v];
  });

test("a blurred frame measures far less sharp than the frame it came from", () => {
  const scene = texturedScene();
  const sharp = computeMetrics(scene);
  const soft = computeMetrics(blurOf(scene, 4));
  assert.ok(
    sharp.focus > soft.focus * 10,
    `expected a large focus gap, got ${sharp.focus} vs ${soft.focus}`,
  );
  assert.ok(sharp.sharpness > soft.sharpness);
});

test("focus does not move with exposure", () => {
  // Regression: a raw Laplacian scales with pixel magnitude, so brightening a
  // photo made it measure sharper and outrank the original.
  const scene = texturedScene();
  const normal = computeMetrics(scene);

  const brightened = { ...scene, data: new Uint8ClampedArray(scene.data) };
  for (let i = 0; i < brightened.data.length; i += 4) {
    for (let channel = 0; channel < 3; channel++) {
      brightened.data[i + channel] = scene.data[i + channel] * 1.6;
    }
  }

  const ratio = computeMetrics(brightened).focus / normal.focus;
  assert.ok(ratio > 0.5 && ratio < 2, `focus moved with exposure: ratio ${ratio}`);
});

test("a flat gradient produces a degenerate hash, a textured frame does not", () => {
  // Regression: an all-ones hash put unrelated photos a bit or two apart and
  // merged them as duplicates.
  assert.equal(isDegenerateHash(differenceHash(gradient())), true);
  assert.equal(isDegenerateHash(differenceHash(texturedScene())), false);
});

test("chroma signature ignores brightness but not hue", () => {
  const red = makePixels(64, 64, () => [200, 40, 40]);
  const dimRed = makePixels(64, 64, () => [50, 10, 10]);
  const blue = makePixels(64, 64, () => [40, 40, 200]);

  assert.ok(colorDistance(chromaSignature(red), chromaSignature(dimRed)) < 4);
  assert.ok(colorDistance(chromaSignature(red), chromaSignature(blue)) > 20);
});

test("hamming distance counts differing bits", () => {
  assert.equal(hammingDistance("ff", "ff"), 0);
  assert.equal(hammingDistance("ff", "fe"), 1);
  assert.equal(hammingDistance("00", "ff"), 8);
});

test("EXIF timestamps parse, honour their zone, and reject junk", () => {
  assert.equal(
    toEpochMs("2026:08:22 17:33:41", "-07:00"),
    Date.parse("2026-08-23T00:33:41Z"),
  );
  assert.equal(toEpochMs("2026:08:22 17:33:41", null), Date.parse("2026-08-22T17:33:41Z"));
  assert.equal(toEpochMs("not a date", null), null);
});
