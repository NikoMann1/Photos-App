/**
 * Image metrics — pure functions over raw RGBA pixels.
 *
 * Deliberately free of any browser API so they can be unit-tested in Node
 * against real decoded photos. Decoding and downscaling live in `decode.ts`.
 *
 * Everything here is measured, not learned: sharpness, exposure, contrast,
 * colorfulness, and a perceptual hash for finding near-duplicates. Learned
 * aesthetic scoring (is this a *good photo*, not merely a well-exposed one) is
 * a separate problem — see the note in `scoring.ts`.
 */

export type Pixels = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
};

export type ImageMetrics = {
  width: number;
  height: number;
  /** Variance of the Laplacian. Higher is sharper; scale is image-dependent. */
  sharpness: number;
  /** Same, over the central region — a deliberately shallow depth of field
   *  blurs the edges of the frame without making the photo a bad one. */
  centerSharpness: number;
  /** Standard deviation of luma, 0–127ish. */
  contrast: number;
  /** Mean luma, 0–255. */
  brightness: number;
  /** Fraction of pixels crushed to black / blown to white. */
  clippedShadows: number;
  clippedHighlights: number;
  /** 5th-to-95th percentile luma spread, 0–255. */
  dynamicRange: number;
  /**
   * Sharpness normalised by contrast, so it does not move with exposure.
   * A raw Laplacian scales with pixel magnitude: brightening a photo makes it
   * look "sharper" by a factor of two or more, which would rank an
   * overexposed frame above the correctly exposed one it was derived from.
   * Dividing by contrast squared cancels that. This is the number to compare
   * across photos; `sharpness` is kept for debugging.
   */
  focus: number;
  /**
   * How much of the high-frequency energy survives halving the resolution.
   * Real detail persists when downsampled; sensor noise averages away. A high
   * ratio means the "sharpness" above is grain, not structure — which matters
   * because a noisy night shot otherwise measures sharper than a good photo.
   */
  noiseRatio: number;
  /** Hasler-Süsstrunk colourfulness. Grey ≈ 0, vivid ≈ 100+. */
  colorfulness: number;
  /**
   * 256-bit difference hash (16×16) as 64 hex chars.
   *
   * The usual 8×8 hash is too coarse here: a photo with a smooth dominant
   * gradient — a sky, a sunset, a wall — makes every "is this pixel brighter
   * than its right-hand neighbour" answer the same, so the hash degenerates
   * towards all-ones and unrelated photos land a bit or two apart. More bits
   * keeps real structure in the signature.
   */
  hash: string;
  /**
   * 4×4 grid of chromaticity, 32 bytes. Deliberately brightness-invariant
   * (each cell is r/(r+g+b), g/(r+g+b)), so the same scene at two exposures
   * still matches, while two differently-coloured scenes do not — which is
   * what stops a shared gradient shape from merging unrelated photos.
   */
  colorSignature: number[];
};

/** Rec. 601 luma, which is what the eye weights brightness by. */
function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function toGrayscale({ data, width, height }: Pixels): Float32Array {
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = luma(data[i], data[i + 1], data[i + 2]);
  }
  return gray;
}

/**
 * Variance of the Laplacian — the standard cheap focus measure. A blurred
 * image has little high-frequency content, so its second derivative is small
 * and its variance collapses.
 */
export function laplacianVariance(
  gray: Float32Array,
  width: number,
  height: number,
  region?: { x0: number; y0: number; x1: number; y1: number },
): number {
  const x0 = Math.max(1, region?.x0 ?? 1);
  const y0 = Math.max(1, region?.y0 ?? 1);
  const x1 = Math.min(width - 1, region?.x1 ?? width - 1);
  const y1 = Math.min(height - 1, region?.y1 ?? height - 1);
  if (x1 <= x0 || y1 <= y0) return 0;

  let sum = 0;
  let sumSquares = 0;
  let count = 0;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * width + x;
      // 4-neighbour Laplacian kernel.
      const value =
        gray[i - width] + gray[i + width] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
      sum += value;
      sumSquares += value * value;
      count++;
    }
  }

  if (count === 0) return 0;
  const mean = sum / count;
  return sumSquares / count - mean * mean;
}

export function lumaStats(gray: Float32Array): {
  brightness: number;
  contrast: number;
  clippedShadows: number;
  clippedHighlights: number;
  dynamicRange: number;
} {
  const histogram = new Uint32Array(256);
  let sum = 0;

  for (let i = 0; i < gray.length; i++) {
    const value = gray[i];
    sum += value;
    histogram[Math.max(0, Math.min(255, Math.round(value)))]++;
  }

  const total = gray.length;
  const brightness = sum / total;

  let variance = 0;
  for (let i = 0; i < gray.length; i++) {
    const delta = gray[i] - brightness;
    variance += delta * delta;
  }
  variance /= total;

  // "Clipped" means genuinely crushed or blown, not merely dark or bright.
  let shadows = 0;
  for (let v = 0; v <= 2; v++) shadows += histogram[v];
  let highlights = 0;
  for (let v = 253; v <= 255; v++) highlights += histogram[v];

  return {
    brightness,
    contrast: Math.sqrt(variance),
    clippedShadows: shadows / total,
    clippedHighlights: highlights / total,
    dynamicRange: percentile(histogram, total, 0.95) - percentile(histogram, total, 0.05),
  };
}

function percentile(histogram: Uint32Array, total: number, fraction: number): number {
  const target = total * fraction;
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += histogram[v];
    if (seen >= target) return v;
  }
  return 255;
}

/**
 * Hasler & Süsstrunk's colourfulness metric — a cheap stand-in for "vivid".
 * Not an aesthetic judgement on its own, but a flat grey frame scores near
 * zero, which is a useful signal.
 */
export function colorfulness({ data }: Pixels): number {
  let sumRg = 0;
  let sumYb = 0;
  let sumRgSq = 0;
  let sumYbSq = 0;
  let count = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const rg = r - g;
    const yb = 0.5 * (r + g) - b;
    sumRg += rg;
    sumYb += yb;
    sumRgSq += rg * rg;
    sumYbSq += yb * yb;
    count++;
  }

  if (count === 0) return 0;
  const meanRg = sumRg / count;
  const meanYb = sumYb / count;
  const stdRg = Math.sqrt(Math.max(0, sumRgSq / count - meanRg * meanRg));
  const stdYb = Math.sqrt(Math.max(0, sumYbSq / count - meanYb * meanYb));

  return (
    Math.sqrt(stdRg * stdRg + stdYb * stdYb) +
    0.3 * Math.sqrt(meanRg * meanRg + meanYb * meanYb)
  );
}

/**
 * Difference hash: downsample to 9×8 luma, then record whether each pixel is
 * brighter than the one to its right. 64 bits that survive re-encoding,
 * resizing, and small exposure shifts — which is what makes two frames of the
 * same moment collide.
 */
export const HASH_SIDE = 16;
export const HASH_BITS = HASH_SIDE * HASH_SIDE;

export function differenceHash(pixels: Pixels): string {
  const width = HASH_SIDE + 1;
  const small = resampleGray(pixels, width, HASH_SIDE);
  let hash = "";

  for (let y = 0; y < HASH_SIDE; y++) {
    let nibble = 0;
    let bits = 0;
    for (let x = 0; x < HASH_SIDE; x++) {
      const left = small[y * width + x];
      const right = small[y * width + x + 1];
      nibble = (nibble << 1) | (left > right ? 1 : 0);
      bits++;
      if (bits === 4) {
        hash += nibble.toString(16);
        nibble = 0;
        bits = 0;
      }
    }
  }

  return hash;
}

/**
 * 4×4 grid of chromaticity, quantised to bytes. Two values per cell (red and
 * green fractions of total intensity); blue is implied by the other two.
 *
 * Near-black cells carry no reliable hue, so they report neutral rather than
 * amplifying sensor noise into a colour.
 */
export function chromaSignature(pixels: Pixels, side = 4): number[] {
  const { data, width, height } = pixels;
  const signature: number[] = [];
  const NEUTRAL = Math.round((1 / 3) * 255);

  for (let cy = 0; cy < side; cy++) {
    const y0 = Math.floor((cy * height) / side);
    const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * height) / side));

    for (let cx = 0; cx < side; cx++) {
      const x0 = Math.floor((cx * width) / side);
      const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * width) / side));

      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
        }
      }

      const total = r + g + b;
      if (total < (x1 - x0) * (y1 - y0) * 12) {
        signature.push(NEUTRAL, NEUTRAL);
      } else {
        signature.push(Math.round((r / total) * 255), Math.round((g / total) * 255));
      }
    }
  }

  return signature;
}

/** Mean absolute difference between two signatures, 0 (identical) to 255. */
export function colorDistance(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 255;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/** Half-resolution luma, by 2×2 box average. */
function halveGray(gray: Float32Array, width: number, height: number): {
  gray: Float32Array;
  width: number;
  height: number;
} {
  const w = Math.max(1, width >> 1);
  const h = Math.max(1, height >> 1);
  const out = new Float32Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * 2) * width + x * 2;
      out[y * w + x] =
        (gray[i] + gray[i + 1] + gray[i + width] + gray[i + width + 1]) / 4;
    }
  }

  return { gray: out, width: w, height: h };
}

/** Box-filter resample to an exact target size, averaging over source cells. */
function resampleGray(pixels: Pixels, targetWidth: number, targetHeight: number): Float32Array {
  const { data, width, height } = pixels;
  const out = new Float32Array(targetWidth * targetHeight);

  for (let ty = 0; ty < targetHeight; ty++) {
    const sy0 = Math.floor((ty * height) / targetHeight);
    const sy1 = Math.max(sy0 + 1, Math.floor(((ty + 1) * height) / targetHeight));

    for (let tx = 0; tx < targetWidth; tx++) {
      const sx0 = Math.floor((tx * width) / targetWidth);
      const sx1 = Math.max(sx0 + 1, Math.floor(((tx + 1) * width) / targetWidth));

      let sum = 0;
      let count = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * width + sx) * 4;
          sum += luma(data[i], data[i + 1], data[i + 2]);
          count++;
        }
      }
      out[ty * targetWidth + tx] = count > 0 ? sum / count : 0;
    }
  }

  return out;
}

/** Set bits in a hex-encoded hash. */
export function popcount(hash: string): number {
  let bits = 0;
  for (let i = 0; i < hash.length; i++) {
    let nibble = parseInt(hash[i], 16);
    while (nibble) {
      bits += nibble & 1;
      nibble >>= 1;
    }
  }
  return bits;
}

/**
 * True when a hash carries almost no information: nearly all bits the same.
 *
 * This happens whenever one smooth gradient dominates the frame — a sky, a
 * sunset, a plain wall — because then every "brighter than the pixel to the
 * right" comparison answers the same way. Such hashes sit a bit or two apart
 * from each other regardless of what the photos actually show, so hash
 * distance alone must not be trusted to call them duplicates.
 */
export function isDegenerateHash(hash: string): boolean {
  const ones = popcount(hash);
  const bits = hash.length * 4;
  return ones < bits * 0.1 || ones > bits * 0.9;
}

/** Number of differing bits between two hashes. 0 = identical framing. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    let xor = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (xor) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return distance;
}

/** Everything above, in one pass over a decoded, downscaled image. */
export function computeMetrics(pixels: Pixels): ImageMetrics {
  const { width, height } = pixels;
  const gray = toGrayscale(pixels);

  const inset = { x0: Math.floor(width * 0.25), y0: Math.floor(height * 0.25), x1: Math.floor(width * 0.75), y1: Math.floor(height * 0.75) };

  const sharpness = laplacianVariance(gray, width, height);
  const centerSharpness = laplacianVariance(gray, width, height, inset);
  const stats = lumaStats(gray);

  // A frame with no contrast at all has no focus to measure; the epsilon keeps
  // a flat image at 0 rather than dividing by zero.
  const contrastFloor = Math.max(1, stats.contrast * stats.contrast);
  const focus = Math.max(sharpness, centerSharpness) / contrastFloor;

  const half = halveGray(gray, width, height);
  const halfFocus =
    laplacianVariance(half.gray, half.width, half.height) / contrastFloor;

  return {
    width,
    height,
    sharpness,
    centerSharpness,
    focus,
    noiseRatio: focus / Math.max(halfFocus, 1e-6),
    ...stats,
    colorfulness: colorfulness(pixels),
    hash: differenceHash(pixels),
    colorSignature: chromaSignature(pixels),
  };
}
