/**
 * Decoding photos to raw pixels, in whichever context we're running in.
 *
 * Works in both a Worker (OffscreenCanvas) and on the main thread (a DOM
 * canvas), because OffscreenCanvas only reached Safari in 16.4 and this app is
 * aimed at iPhones.
 */

import type { Pixels } from "./metrics";

/**
 * Longest edge the metrics run at. Big enough that blur is still measurable —
 * downscaling is itself a blur, so too small and everything looks equally soft
 * — and small enough that 500 photos is not an afternoon. A 12 MP photo comes
 * down to this in one draw call.
 */
export const ANALYSIS_SIZE = 512;

type Canvas2D = {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
};

function createCanvas(width: number, height: number): Canvas2D | null {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    return context ? { canvas, context } : null;
  }

  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    return context ? { canvas, context } : null;
  }

  return null;
}

export function canDecodeHere(): boolean {
  return typeof createImageBitmap === "function" && createCanvas(1, 1) !== null;
}

/** Scales `width`×`height` down so the longest edge is at most `maxSize`. */
export function fitWithin(
  width: number,
  height: number,
  maxSize: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxSize) return { width, height };
  const scale = maxSize / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Previews are the analysis canvas re-encoded, so their longest edge is
 * ANALYSIS_SIZE. Deliberately no separate size constant: it would either be
 * ignored or force a second redraw for no benefit. At 512px a preview is tens
 * of kilobytes and still fills a grid tile on a dense phone screen.
 *
 * The quality is set by what the *embedding* stage needs, not by what looks
 * acceptable in a grid tile — since that stage now reads previews rather than
 * re-decoding originals. Measured over 40 full-resolution photos, embedding a
 * preview instead of the original agrees with it 0.9899 at quality 0.72 and
 * 0.9976 at 0.90, which sounds like a rounding difference and is not: the
 * content score drifts 0.196 AVA points at 0.72 against a real batch's total
 * spread of 0.8, and two of five picks changed. At 0.90 the selection is
 * identical to the full-resolution one. Previews roughly double, from 11 KB to
 * 22 KB, which buys back a 48 MB decode per shortlisted photo.
 */
const PREVIEW_QUALITY = 0.9;

/**
 * Encodes what is already on the canvas, so a preview costs one JPEG encode
 * rather than a second decode of the original.
 */
async function encode(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<Blob | null> {
  try {
    if ("convertToBlob" in canvas) {
      return await canvas.convertToBlob({ type: "image/jpeg", quality: PREVIEW_QUALITY });
    }
    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", PREVIEW_QUALITY);
    });
  } catch {
    return null;
  }
}

export type Decoded = { pixels: Pixels; preview: Blob | null };

/**
 * Decodes once and returns both the pixels the metrics need and a small JPEG
 * for storage.
 *
 * The preview exists because the originals cannot be stored: a 500-photo batch
 * off a phone is well over a gigabyte, far past what iOS grants a website, and
 * exceeding that quota does not surface as an error — the photo picker simply
 * stops closing. Originals stay in memory for the session instead.
 */
export async function decodeWithPreview(
  blob: Blob,
  maxSize: number = ANALYSIS_SIZE,
): Promise<Decoded> {
  const bitmap = await createImageBitmap(blob);

  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, maxSize);
    const surface = createCanvas(width, height);
    if (!surface) throw new Error("No 2D canvas available for decoding");

    surface.context.drawImage(bitmap, 0, 0, width, height);
    const imageData = surface.context.getImageData(0, 0, width, height);
    const pixels = { data: imageData.data, width, height };

    // Same canvas, re-encoded: a preview costs one JPEG encode, no redraw.
    const preview = await encode(surface.canvas);
    return { pixels, preview };
  } finally {
    bitmap.close();
  }
}

export async function decodeToPixels(
  blob: Blob,
  maxSize: number = ANALYSIS_SIZE,
): Promise<Pixels> {
  // Note: not passing resizeWidth/resizeHeight to createImageBitmap — Safari's
  // support for those options has been unreliable, so scale in the draw call.
  const bitmap = await createImageBitmap(blob);

  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, maxSize);
    const surface = createCanvas(width, height);
    if (!surface) throw new Error("No 2D canvas available for decoding");

    surface.context.drawImage(bitmap, 0, 0, width, height);
    const imageData = surface.context.getImageData(0, 0, width, height);
    return { data: imageData.data, width, height };
  } finally {
    // Decoded bitmaps are large; on a 500-photo run, leaking them is fatal.
    bitmap.close();
  }
}
