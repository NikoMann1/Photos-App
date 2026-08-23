/**
 * Second-stage worker: decode a photo and produce a content embedding.
 *
 * The blob it is handed is stage one's 512px preview, not the original photo.
 * That matters more than it sounds: decoding a 12 MP original allocates a
 * ~48 MB bitmap, and this stage — which already holds the model and the
 * runtime's WASM heap — is where iOS was discarding the tab. The preview is
 * already in memory for the grid, so reading it costs nothing new, and it is
 * the same 512px canvas the metrics ran on, so the geometry is unchanged.
 *
 * Passing stage one's raw pixel buffers instead would avoid the decode
 * entirely, but they are ~1 MB each and the shortlist is not known until every
 * photo has been measured — so they would all have to be kept.
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
