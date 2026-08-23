/**
 * A learned answer to "was this a good photograph?", with nothing asked of the
 * user.
 *
 * The rest of the app measures whether a photo is technically sound and, once
 * the user has tapped a few times, what *they* keep. Neither helps on a first
 * batch from someone who has said nothing, and the models that judge a
 * photograph outright do not fit on a phone: Aesthetic Predictor v2.5 is a
 * 1.6 GB ONNX graph, and the 3 MB LAION head takes 768-dimension input, which
 * means a CLIP ViT-L/14 tower of ~300 MB against our 21 MB MobileCLIP.
 *
 * Asking MobileCLIP itself was tried and failed twice, measured both times.
 * Prompted directly — a paired direction from eight "a stunning photograph"
 * prompts against eight "a photo you would delete" prompts — it spread the
 * user's photos over 0.067 in a space where a direction learned from four taps
 * spreads them over 0.9, and ordered them wrongly; its agreement with that
 * learned direction was 0.000. Asked instead what the photos were *of*, which
 * is the one thing a distilled zero-shot model is trained for, it called a
 * bathroom plaque machinery, floor grating food, and never once picked
 * "people" for a photo with people in it.
 *
 * What does work is skipping the text tower and learning the head directly.
 * These weights are a ridge regression from MobileCLIP's own 512-dimension
 * image features onto the mean human rating in AVA — 255,000 photographs rated
 * by photographers, here a 20,437-photo training split. On 5,110 photos held
 * out of training it reaches Spearman 0.645 (Pearson 0.657) against the human
 * ratings, which is the range published NIMA-class models report on AVA. A
 * 512x64x1 network over the same features was tried and is worse (0.590,
 * falling as it trains), so this stays linear: one dot product per photo, and
 * 2 KB of weights against the 21 MB of model already downloaded.
 *
 * IMPORTANT — this is a relative signal, not an absolute one. The user's own
 * photos all score 3.97 to 4.77 where AVA's median is 5.42: phone snapshots of
 * a submarine interior are not contest photographs, and an absolute threshold
 * would throw the entire roll away. Callers must compare a photo against the
 * rest of its batch, never against a fixed bar. `CONTENT_SPREAD` is the scale
 * for doing that.
 *
 * Regenerating: see `scripts/` in the scratchpad notes — extract AVA to
 * MobileCLIP features, ridge-fit onto mean_score, base64 the float32 weights.
 */

/** The 5th-to-95th percentile span of this head's output across AVA. */
export const CONTENT_SPREAD = 1.64;

/** 512 weights and a bias, float32, little-endian, base64. */
const WEIGHTS_B64 =
  "S4Q7v2XdjT4sM6I+8zf0vu8ZMb+0h6U+JG8fv9jpjT6HXou/FRnFPXXTP72VYwu+aoPzvmMKpb+rK8e9o8gzPgb4uD7vIlQ+" +
  "UzJHvzo1R7//KmU9dx0CPjYwyL6jwvS99SWpPnUqQb8nlgy/70kTv8Y+KL1LRv8+pYPlvqAMa71zT02/eqp+vpJjUT4DrIy/" +
  "tnplPo3YyD4T+xA/Xz8wwPvpTr/P0yC+bubCPtD/rj75PsM/aG/GPUreSj7OLJo7vk3NPnNE8D6KPs4+y1/zvtfazT+UPsM/" +
  "vewJv5WlCD9X2gi/8NwQPh2KWD5SF/u+FP+Qvp6Pp72bLQs8y11uv5a+CT734zU/kMLjPusIlz06wjy/wz5Kv31GoL7H64K+" +
  "tVnOPmvNFT9js1M+4x6ivrEQyj2QxwA/1BGiPghbnD7Ezhw+TvIRP/E31T4yEJ89Ul0tPuLbMj3Cayu+AUAtvkglZz6HiuM+" +
  "t/UGv8SXKD/nCaK+4Vz8vu6VDjuq+Ke9jHUUPWXZnb7/b2W+QgdnPl2Zb70A1oa/+o0Hv1hERD548s6+f8MnPvtB5L78TVQ/" +
  "+ZbHvqGr6z1YHig/5Zu/vXxxAb9ZMUI/DfxUvuUtj7+U3QU+rKwXv+SULD6G8TW/r+tsPklteL4nj1o90I7PvX3fXr2+GLK9" +
  "3b5+u3dp9r7T3T49/UEVQP+JvT4f2wK/W0c7vuicGr5rDS++KcRPPgWq3j6KegA/0jHCvogDKL+kdrc+Q6PZvA7enD73sDU+" +
  "GXwmvUQHmb7Ul7Q98dm8vXGilz3VW5e+0MbGvcdFlz6l/YE/8K1mP3HdJ743lQq9TjImvjOzPj4Q0Au/TQ+DP/AXKT9Fj2++" +
  "8uJ2vrBz2j5kgWm+JneoPo6X4L3HEjw/ieoMPnn81r5SLBU+fxPFPgeqLz91OHY/SiE5Pn4DZj3BiI2/7OAEP3cqLTyF8fa+" +
  "DaGAP6y5BL/xq2K+UeXRvhVKEz7tAsG+9Nr5PPTOIjzxoem/Jbd7viWg5T5LiLa9A4oUPnGV1z5o3YA+SbLYPtEsGr8a8EC9" +
  "LH86v49Yxj7+hsq+1wsJPk3iFL/9PZo+PeA5PvnK5j4uRcY+jLSvvRkVEz/FZvq9zOtov1g6+D7jhT2+a2vDPn+tRb/CaPK+" +
  "b1HKP/3Pcb8RyAG/EJgkv0yNED/FkIg/zLiRvj9Ltr0jxyW+xwGAPepBKz6ZIsO+dHiuPrJpnT5Wj7U+SbCNvoQgj7unoRU/" +
  "k78Sv2Da5T6CxGi8TeAHP1uZRT4OQYc+f9Sjvft1Ez4AMXo+D55kPSvUST5FiIs+eWCovmqjWL5C7Bo95JFAPoceDr9BgaC9" +
  "AaQ+v71htD70yWg/kD7bPra7tTxqlSu/UWkov8crvD3Fhwi/e5GmPr48Tz9lZAi/+4G2Pb0mWT+Tbwu/TNUNv1/3fz6tgrQ+" +
  "RpQxP400Qj1/2MK9i7/GPh+6Jz/BvhY+HHFwvufEAz+SOqi95gNMvuG/uj0A6uC9gbKPPvEIQ7/HM789jf+IvZhoBT+kvbG+" +
  "jNaiPID2br+VGI2+XY8Zv7JTO7y2J7k8Yz2WPrSPEr89WvO+ZiiUv8kyLz/9nkI+PFZKvgRQi77ROYo+OddpvjBOUb14hoW+" +
  "8+cDv+n+i79G9/k+XWvqPsYb675/+7G+qP4dPrFmND+OSCe+riv4PqZ3bj94LyS/Iag8v0Mhsb0oVf6+NiA7v9GMbL/XjjU+" +
  "KIdyPgLLvj4TTNY+J2cTvuYjLj8V2lHAkI2IvooNLT8vDeC+6LQdv/N1Gr28Opc/t1XVPiem374FHc88T2KIPoI2C7+15jc+" +
  "mJfIvdmdib/SJY69YpK/PssPXj2TL6C+mlDPPo4BOzyi7ts+n4yfO/J5AMBTry++YguNvg7elr7EQuW+nrc9vDYgqT3MEdw+" +
  "jIsvP5EQ1jzwh8K9UzPnvs8vR7/tYh0+BX7Qvq0Ew7uU+0y+Qf5HPp8jnD0ijBA/kDcBP0EMgb6vrpk+T3ytvll5qL6ictW+" +
  "9aSBPoUzqT8B27W+9u6NPoJpUL38bxU9XwEDPlmHLb8xC+M+mMC5Pu15OT/PsNk+d+IUP78aJL8XWws/ZHHYvY6/CD/6mEk/" +
  "oYTmvtlV2T7glyk+nfvRPksWHb/Ozc28BZSdPsIfrz1Nzp2+zDQZvj3AeL9Crbk8QqllvocMPzzA79W+ZXLXvQD1wz0b3ag+" +
  "nKA+v9tTFr/wiLa8g9nRPduPfL8lyyq/2+GIv7vlbT6EZ1I+yojvPouyLz6GlYg+zCXqPvCNhL7Bn5c+0w0Uv952pb577vO8" +
  "ohyiPrWEWb904qC+fyGyPfEtAT3jqws/DqNYPn3vaT+LPmc+DHGKPqNex72vIT2+TVVSPv2LNL6CMyU+nXAovk1B6D2Ouwe/" +
  "Tb8Lv3jkLr+xUXe9XgWvvRbbuD1ukEs+v6FFv/4ytr6pNhU9F38sv8a10L9aIbg+wN39vaOU2D0GeAk/c+HyPo4G1L607aq+" +
  "aQynvhgRgb6fXhW/FlUTP899i732eAW/6AK6vn6p8b4zNdM+hqI1vyvPgT2mebs+Y/pPvSR3+b6rTAg+2RaUPuw0Tb7X5oA/" +
  "IVicPVh+ij8p09e7RWI8PzcUqj4dZlM+DApVv5955r7nhLA+yIOQvqRMErzZPL6/M8ZvPYV3vr6VTXc/M1swPdAs1D5uKXe/" +
  "Uxi9PJH8Vz6QAOa+iytZvb6r9r5aSQa/XLAsP9onqT9VOqpA";

let weights: Float32Array | null = null;

function head(): Float32Array {
  if (weights) return weights;
  const binary = atob(WEIGHTS_B64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  weights = new Float32Array(bytes.buffer);
  return weights;
}

/**
 * The predicted mean human rating for a photo, on AVA's 1-10 scale.
 *
 * Null when there is no embedding to judge: not knowing what a photo shows is
 * not evidence against it, and callers must treat it as "no opinion" rather
 * than as a low score.
 */
export function contentScore(embedding: Float32Array | null | undefined): number | null {
  if (!embedding) return null;
  const w = head();
  if (embedding.length !== w.length - 1) return null;

  let sum = w[w.length - 1];
  for (let i = 0; i < embedding.length; i++) sum += embedding[i] * w[i];
  return sum;
}
