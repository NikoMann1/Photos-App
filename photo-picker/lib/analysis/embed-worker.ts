/**
 * Second-stage worker: decode a photo and produce a content embedding.
 *
 * Re-decodes rather than reusing stage one's pixels. Decode costs the same
 * (~80 ms) whatever size it targets, so passing 100 pixel buffers back and
 * forth to save it would trade ~25% of this stage's time for tens of megabytes
 * held in memory — a bad trade on a phone.
 */

import { decodeToPixels, ANALYSIS_SIZE } from "./decode";
import { embedPixels } from "./embedding";

/**
 * `self` is typed as Window by the DOM lib, so postMessage's transfer-list
 * overload is not visible. The webworker lib is not in tsconfig because the
 * rest of the app is DOM code, so narrow it here instead.
 */
const worker = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

export type EmbedRequest = { id: string; blob: Blob };
export type EmbedResponse =
  | { id: string; ok: true; embedding: Float32Array }
  | { id: string; ok: false; error: string };

self.onmessage = async (event: MessageEvent<EmbedRequest>) => {
  const { id, blob } = event.data;

  try {
    const pixels = await decodeToPixels(blob, ANALYSIS_SIZE);
    const embedding = await embedPixels(pixels);
    const response: EmbedResponse = { id, ok: true, embedding };
    // Transfer rather than copy: 2 KB each, but it also frees the sender's copy.
    worker.postMessage(response, [embedding.buffer]);
  } catch (error) {
    const response: EmbedResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : "Embedding failed",
    };
    worker.postMessage(response);
  }
};
