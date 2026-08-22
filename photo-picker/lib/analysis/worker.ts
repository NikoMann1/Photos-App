/**
 * Analysis worker: decode one photo, measure it, hand back the numbers.
 *
 * Runs off the main thread so a 500-photo batch doesn't freeze the UI — the
 * decode alone is ~100 ms per photo on a phone.
 */

import { decodeToPixels } from "./decode";
import { parseCaptureTime } from "./exif";
import { computeMetrics, type ImageMetrics } from "./metrics";

/** EXIF lives at the head of the file; no need to read a whole photo for it. */
const HEADER_BYTES = 256 * 1024;

export type WorkerRequest = { id: string; blob: Blob; maxSize?: number };
export type WorkerResponse =
  | { id: string; ok: true; metrics: ImageMetrics; takenAt: number | null }
  | { id: string; ok: false; error: string };

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id, blob, maxSize } = event.data;

  try {
    // Capture time is read here rather than on the main thread so it overlaps
    // the decode instead of blocking it: reading headers for every photo up
    // front is dead time before any progress can be shown.
    let takenAt: number | null = null;
    try {
      const header = await blob.slice(0, HEADER_BYTES).arrayBuffer();
      takenAt = parseCaptureTime(new DataView(header));
    } catch {
      takenAt = null;
    }

    const pixels = await decodeToPixels(blob, maxSize);
    const response: WorkerResponse = {
      id,
      ok: true,
      metrics: computeMetrics(pixels),
      takenAt,
    };
    self.postMessage(response);
  } catch (error) {
    const response: WorkerResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : "Analysis failed",
    };
    self.postMessage(response);
  }
};
