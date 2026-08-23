/**
 * Orchestration: take the picked files, hand back metrics for each.
 *
 * Uses a small pool of workers when the browser allows it, and falls back to
 * decoding on the main thread when it doesn't (or when starting a worker
 * fails, which bundlers and strict CSPs both manage to cause).
 */

import { canDecodeHere, decodeToPixels, decodeWithPreview, ANALYSIS_SIZE } from "./decode";
import { readCaptureTime } from "./exif";
import { computeMetrics, type ImageMetrics } from "./metrics";
import type { WorkerRequest, WorkerResponse } from "./worker";
import type { EmbedRequest, EmbedResponse } from "./embed-worker";

export type AnalysisInput = { id: string; file: File };

export type AnalysisResult = {
  id: string;
  metrics: ImageMetrics | null;
  takenAt: number | null;
  /** Small JPEG for storage; originals are kept in memory, never persisted. */
  preview: Blob | null;
  error?: string;
};

export type ProgressHandler = (done: number, total: number) => void;

/**
 * Concurrency is bounded by memory, not by cores.
 *
 * Every worker decoding a photo holds a full-resolution bitmap — ~48 MB for a
 * 12 MP iPhone photo — so four in flight is nearly 200 MB of transient image
 * data on top of everything else. iOS answers that by killing the tab, and the
 * user sees the upload reset to "Choose photos" halfway through with no
 * explanation.
 *
 * Measured earlier, the fourth worker bought about 1% (1312ms against 1296ms
 * over a batch), so the parallelism being given up here is worth very little
 * and the memory it costs is worth a great deal.
 */
const MAX_WORKERS = 3;

function workerCount(taskCount: number): number {
  const cores =
    typeof navigator !== "undefined" && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 2;
  return Math.max(1, Math.min(MAX_WORKERS, cores, taskCount));
}

function createWorker(): Worker | null {
  try {
    return new Worker(new URL("./worker.ts", import.meta.url));
  } catch {
    return null;
  }
}

export async function analyzePhotos(
  inputs: AnalysisInput[],
  onProgress?: ProgressHandler,
): Promise<AnalysisResult[]> {
  if (inputs.length === 0) return [];

  const metrics = await computeAllMetrics(inputs, onProgress);

  return inputs.map(({ id }) => {
    const result = metrics.get(id);
    return {
      id,
      metrics: result?.metrics ?? null,
      takenAt: result?.takenAt ?? null,
      preview: result?.preview ?? null,
      error: result?.error,
    };
  });
}

type MetricsResult = {
  metrics: ImageMetrics | null;
  takenAt?: number | null;
  preview?: Blob | null;
  error?: string;
};

async function computeAllMetrics(
  inputs: AnalysisInput[],
  onProgress?: ProgressHandler,
): Promise<Map<string, MetricsResult>> {
  const results = new Map<string, MetricsResult>();
  let done = 0;

  const report = () => onProgress?.(done, inputs.length);
  report();

  const workers = Array.from({ length: workerCount(inputs.length) }, createWorker).filter(
    (worker): worker is Worker => worker !== null,
  );

  // No workers available — decode on the main thread. Slower and it blocks,
  // but it is the difference between a working app and a broken one.
  if (workers.length === 0) {
    for (const { id, file } of inputs) {
      results.set(id, await analyzeOnMainThread(file));
      done++;
      report();
    }
    return results;
  }

  try {
    const queue = [...inputs];
    await Promise.all(
      workers.map(async (worker) => {
        for (;;) {
          const next = queue.shift();
          if (!next) return;

          const result = await runInWorker(worker, next);
          // A worker that cannot decode (no OffscreenCanvas, say) should not
          // take the whole batch down with it.
          results.set(
            next.id,
            result.metrics ? result : await analyzeOnMainThread(next.file),
          );
          done++;
          report();
        }
      }),
    );
  } finally {
    for (const worker of workers) worker.terminate();
  }

  return results;
}

function runInWorker(worker: Worker, input: AnalysisInput): Promise<MetricsResult> {
  return new Promise((resolve) => {
    const cleanup = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };

    const onMessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.id !== input.id) return;
      cleanup();
      resolve(
        event.data.ok
          ? {
              metrics: event.data.metrics,
              takenAt: event.data.takenAt,
              preview: event.data.preview,
            }
          : { metrics: null, error: event.data.error },
      );
    };

    const onError = () => {
      cleanup();
      resolve({ metrics: null, error: "Worker failed" });
    };

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);

    const request: WorkerRequest = {
      id: input.id,
      blob: input.file,
      maxSize: ANALYSIS_SIZE,
    };
    worker.postMessage(request);
  });
}

async function analyzeOnMainThread(file: File): Promise<MetricsResult> {
  if (!canDecodeHere()) {
    return { metrics: null, error: "This browser cannot decode images for analysis" };
  }
  try {
    const takenAt = await readCaptureTime(file);
    const { pixels, preview } = await decodeWithPreview(file);
    return { metrics: computeMetrics(pixels), takenAt, preview };
  } catch (error) {
    return {
      metrics: null,
      error: error instanceof Error ? error.message : "Analysis failed",
    };
  }
}


// ---------------------------------------------------------------------------
// Second stage: content embeddings
// ---------------------------------------------------------------------------

/**
 * One worker, deliberately.
 *
 * This stage is the memory peak of the whole app: each worker holds its own
 * copy of the model plus the runtime's WASM heap, *and* a full-resolution
 * decode while it works. Two of those was enough for iOS to discard the tab
 * mid-batch. Inference is single-threaded per session anyway (measured thread
 * scaling was nil), so the second worker only ever bought overlap, and it
 * bought it at the price of the batch surviving at all.
 */
const MAX_EMBED_WORKERS = 1;

export type EmbeddingResult = { id: string; embedding: Float32Array | null; error?: string };

/**
 * What the embedding stage reads: stage one's preview, not the original photo.
 * See `embed-worker.ts` for why.
 */
export type EmbedInput = { id: string; source: Blob };

function createEmbedWorker(): Worker | null {
  try {
    return new Worker(new URL("./embed-worker.ts", import.meta.url));
  } catch {
    return null;
  }
}

/**
 * Embeds a shortlist of photos. Deliberately not the whole batch: this stage
 * costs roughly 300 ms per photo against stage one's ~50 ms, so it only runs
 * on photos that could plausibly be selected.
 *
 * Failure is not fatal — a photo without an embedding simply falls back to the
 * cheap similarity signals.
 */
export async function embedPhotos(
  inputs: EmbedInput[],
  onProgress?: ProgressHandler,
): Promise<EmbeddingResult[]> {
  if (inputs.length === 0) return [];

  const results = new Map<string, EmbeddingResult>();
  let done = 0;
  const report = () => onProgress?.(done, inputs.length);
  report();

  const workers = Array.from(
    { length: Math.min(MAX_EMBED_WORKERS, inputs.length) },
    createEmbedWorker,
  ).filter((worker): worker is Worker => worker !== null);

  if (workers.length === 0) {
    return inputs.map(({ id }) => ({ id, embedding: null, error: "Workers unavailable" }));
  }

  try {
    const queue = [...inputs];
    await Promise.all(
      workers.map(async (worker) => {
        for (;;) {
          const next = queue.shift();
          if (!next) return;
          results.set(next.id, await runEmbedWorker(worker, next));
          done++;
          report();
        }
      }),
    );
  } finally {
    for (const worker of workers) worker.terminate();
  }

  return inputs.map(
    ({ id }) => results.get(id) ?? { id, embedding: null, error: "Not embedded" },
  );
}

function runEmbedWorker(worker: Worker, input: EmbedInput): Promise<EmbeddingResult> {
  return new Promise((resolve) => {
    const cleanup = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };

    const onMessage = (event: MessageEvent<EmbedResponse>) => {
      if (event.data.id !== input.id) return;
      cleanup();
      resolve(
        event.data.ok
          ? { id: input.id, embedding: event.data.embedding }
          : { id: input.id, embedding: null, error: event.data.error },
      );
    };

    const onError = () => {
      cleanup();
      resolve({ id: input.id, embedding: null, error: "Embedding worker failed" });
    };

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);

    const request: EmbedRequest = { id: input.id, blob: input.source };
    worker.postMessage(request);
  });
}
