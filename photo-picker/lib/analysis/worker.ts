/**
 * Analysis worker: decode one photo, measure it, hand back the numbers.
 *
 * Runs off the main thread so a 500-photo batch doesn't freeze the UI — the
 * decode alone is ~100 ms per photo on a phone.
 */

import { decodeToPixels } from "./decode";
import { computeMetrics, type ImageMetrics } from "./metrics";

export type WorkerRequest = { id: string; blob: Blob; maxSize?: number };
export type WorkerResponse =
  | { id: string; ok: true; metrics: ImageMetrics }
  | { id: string; ok: false; error: string };

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id, blob, maxSize } = event.data;

  try {
    const pixels = await decodeToPixels(blob, maxSize);
    const response: WorkerResponse = { id, ok: true, metrics: computeMetrics(pixels) };
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
