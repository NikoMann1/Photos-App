/**
 * Orchestration: take the picked files, hand back metrics for each.
 *
 * Uses a small pool of workers when the browser allows it, and falls back to
 * decoding on the main thread when it doesn't (or when starting a worker
 * fails, which bundlers and strict CSPs both manage to cause).
 */

import { canDecodeHere, decodeToPixels, ANALYSIS_SIZE } from "./decode";
import { readCaptureTime } from "./exif";
import { computeMetrics, type ImageMetrics } from "./metrics";
import type { WorkerRequest, WorkerResponse } from "./worker";
import type { EmbedRequest, EmbedResponse } from "./embed-worker";

export type AnalysisInput = { id: string; file: File };

export type AnalysisResult = {
  id: string;
  metrics: ImageMetrics | null;
  takenAt: number | null;
  error?: string;
};

export type ProgressHandler = (done: number, total: number) => void;

/**
 * Workers are a win up to a point; beyond it they contend for memory, and a
 * 12 MP decode in flight is ~48 MB apiece — enough for iOS to kill the tab.
 *
 * All cores rather than cores-1: during analysis the main thread only receives
 * messages, so holding a core back just leaves it idle. Safari reports 4 here
 * even on phones with more, which is the real ceiling in practice.
 */
const MAX_WORKERS = 6;

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
      error: result?.error,
    };
  });
}

type MetricsResult = {
  metrics: ImageMetrics | null;
  takenAt?: number | null;
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
          ? { metrics: event.data.metrics, takenAt: event.data.takenAt }
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
    return { metrics: computeMetrics(await decodeToPixels(file)), takenAt };
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
 * Fewer workers than stage one: each holds its own copy of the model, and
 * memory is the binding constraint on a phone, not cores. Inference is also
 * single-threaded per session by design (measured thread scaling was nil).
 */
const MAX_EMBED_WORKERS = 2;

export type EmbeddingResult = { id: string; embedding: Float32Array | null; error?: string };

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
  inputs: AnalysisInput[],
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

function runEmbedWorker(worker: Worker, input: AnalysisInput): Promise<EmbeddingResult> {
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

    const request: EmbedRequest = { id: input.id, blob: input.file };
    worker.postMessage(request);
  });
}
