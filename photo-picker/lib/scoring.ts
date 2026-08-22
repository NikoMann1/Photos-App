/**
 * PLACEHOLDER SCORING
 *
 * Milestone 1 only needs *a* selection so the end-to-end flow can be tested.
 * This module returns a random ~10% subset of the uploaded photos.
 *
 * Milestone 2 replaces the body of `scorePhoto` / `selectBestPhotos` with real
 * work (blur detection, near-duplicate clustering, aesthetic scoring). The
 * signatures are deliberately shaped for that: scoring is per-photo and
 * selection is a separate step, so the real implementation can slot in without
 * touching the API route or the UI.
 */

export type PhotoMeta = {
  /** Stable id, also the filename on disk. */
  id: string;
  /** Original filename from the user's device. */
  name: string;
  /** MIME type as reported by the browser. */
  type: string;
  /** Bytes. */
  size: number;
};

export type ScoredPhoto = PhotoMeta & {
  /** 0..1, higher is "better". Random for now. */
  score: number;
};

/** Fraction of uploaded photos to keep, before the floor and cap below. */
export const SELECTION_RATIO = 0.1;

/**
 * A bare ratio assumes the fraction of good photos is constant, which is not
 * how batches work: 20 careful shots might be mostly keepers, while 500 with
 * burst sequences might be 5%. 10% of 20 is 2, which is too thin to judge a
 * selection by. So clamp the count — never fewer than MIN (or the whole batch,
 * if it is smaller), never more than MAX.
 */
export const MIN_SELECTION = 5;
export const MAX_SELECTION = 50;

/** How many photos to keep from a batch of `total`. */
export function selectionSize(total: number, ratio: number = SELECTION_RATIO): number {
  if (total <= 0) return 0;
  const target = Math.round(total * ratio);
  const clamped = Math.max(MIN_SELECTION, Math.min(MAX_SELECTION, target));
  return Math.min(total, clamped);
}

/**
 * Placeholder: assigns a random score.
 * TODO(milestone 2): replace with real image analysis.
 */
export function scorePhoto(photo: PhotoMeta): ScoredPhoto {
  return { ...photo, score: Math.random() };
}

/**
 * Picks the best photos by score — see `selectionSize` for how many. With the
 * placeholder scorer this is just a random subset.
 *
 * The returned list preserves the input (upload) order so the review grid is
 * stable and reads chronologically.
 */
export function selectBestPhotos(
  photos: PhotoMeta[],
  ratio: number = SELECTION_RATIO,
): ScoredPhoto[] {
  if (photos.length === 0) return [];

  const scored = photos.map(scorePhoto);
  const keepCount = selectionSize(photos.length, ratio);

  const keepIds = new Set(
    [...scored]
      .sort((a, b) => b.score - a.score)
      .slice(0, keepCount)
      .map((p) => p.id),
  );

  return scored.filter((p) => keepIds.has(p.id));
}
