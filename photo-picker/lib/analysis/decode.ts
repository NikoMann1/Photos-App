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
