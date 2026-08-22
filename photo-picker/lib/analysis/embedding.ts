/**
 * Content embeddings — the second, expensive analysis stage.
 *
 * Runs MobileCLIP S0's vision tower to turn a photo into a 512-dimension
 * vector whose direction encodes what the photo is *of*. Two photos of the
 * same thing point the same way even if their colour and framing differ, which
 * is what the cheap signals in `metrics.ts` cannot do: a hash and a colour
 * histogram see a hue-shifted copy as a different subject.
 *
 * Measured on real photos with this model:
 *   mirrored copy 0.991 · hue-shifted 0.878 · same scene 0.857 · unrelated 0.190
 *
 * Two things this deliberately does NOT do:
 *
 * - fp16, not the quantized build. The uint8 model is a quarter the size and
 *   its output is noise: a mirrored copy of a photo scored 0.349 against it
 *   while a flat blue rectangle scored 0.368. fp16 matches fp32 exactly.
 * - No aesthetic scoring. Zero-shot prompts for it ("a beautiful photograph"
 *   vs "a boring snapshot") were tested and are worse than nothing — they
 *   ranked a photo of floor grating above a harbour view.
 */

import type { Pixels } from "./metrics";

/** The model's expected input, from its preprocessor config. */
export const EMBED_SIDE = 256;
export const EMBED_DIMS = 512;

/**
 * Weights and runtime are fetched from a CDN rather than committed: together
 * they are ~36 MB unpacked, which does not belong in a git repository. Both
 * are cached by the browser after the first visit. Override them to self-host.
 */
const MODEL_URL =
  process.env.NEXT_PUBLIC_EMBED_MODEL_URL ??
  "https://huggingface.co/Xenova/mobileclip_s0/resolve/main/onnx/vision_model_fp16.onnx";

const WASM_BASE =
  process.env.NEXT_PUBLIC_ORT_WASM_URL ??
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";

type Ort = typeof import("onnxruntime-web");
type Session = Awaited<ReturnType<Ort["InferenceSession"]["create"]>>;

let sessionPromise: Promise<Session> | null = null;

/**
 * Loads the model once per worker. Concurrent callers share the same promise,
 * so a pool never downloads or compiles it twice.
 */
export function loadEmbedder(): Promise<Session> {
  sessionPromise ??= (async () => {
    const ort = await import("onnxruntime-web");
    ort.env.wasm.wasmPaths = WASM_BASE;
    // One thread per session: parallelism comes from running several photos at
    // once, and measured thread scaling within a session was nil (299ms vs
    // 298ms for 4 threads against 1).
    ort.env.wasm.numThreads = 1;
    return ort.InferenceSession.create(MODEL_URL);
  })();
  return sessionPromise;
}

/**
 * Resize-shortest-edge then centre-crop to the model's input size, as its
 * preprocessor config specifies. Squashing to a square instead would distort
 * aspect ratio and feed the model something it was not trained on.
 */
export function toModelInput(pixels: Pixels): Float32Array {
  const { data, width, height } = pixels;
  const side = EMBED_SIDE;
  const out = new Float32Array(3 * side * side);
  const plane = side * side;

  const scale = side / Math.min(width, height);
  const cropWidth = Math.min(width, Math.round(side / scale));
  const cropHeight = Math.min(height, Math.round(side / scale));
  const left = Math.floor((width - cropWidth) / 2);
  const top = Math.floor((height - cropHeight) / 2);

  for (let y = 0; y < side; y++) {
    const sy = Math.min(height - 1, top + Math.floor((y * cropHeight) / side));
    for (let x = 0; x < side; x++) {
      const sx = Math.min(width - 1, left + Math.floor((x * cropWidth) / side));
      const source = (sy * width + sx) * 4;
      const target = y * side + x;
      // This model does no mean/std normalisation, only a 0..1 rescale.
      out[target] = data[source] / 255;
      out[plane + target] = data[source + 1] / 255;
      out[2 * plane + target] = data[source + 2] / 255;
    }
  }

  return out;
}

/** Unit-length embedding, so similarity is a plain dot product. */
export async function embedPixels(pixels: Pixels): Promise<Float32Array> {
  const ort = await import("onnxruntime-web");
  const session = await loadEmbedder();
  const input = new ort.Tensor("float32", toModelInput(pixels), [1, 3, EMBED_SIDE, EMBED_SIDE]);
  const output = await session.run({ pixel_values: input });

  const raw = output.image_embeds.data as Float32Array;
  let norm = 0;
  for (const v of raw) norm += v * v;
  norm = Math.sqrt(norm) || 1;

  const embedding = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) embedding[i] = raw[i] / norm;
  return embedding;
}

/** Cosine similarity of two unit vectors: 1 identical, 0 unrelated. */
export function embeddingSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
