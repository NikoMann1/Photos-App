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

/** Fraction of uploaded photos to keep. */
export const SELECTION_RATIO = 0.1;

/**
 * Placeholder: assigns a random score.
 * TODO(milestone 2): replace with real image analysis.
 */
export function scorePhoto(photo: PhotoMeta): ScoredPhoto {
  return { ...photo, score: Math.random() };
}

/**
 * Picks the top ~`ratio` of photos by score. With the placeholder scorer this
 * is just a random subset. Always returns at least one photo when given any.
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
  const keepCount = Math.max(1, Math.round(photos.length * ratio));

  const keepIds = new Set(
    [...scored]
      .sort((a, b) => b.score - a.score)
      .slice(0, keepCount)
      .map((p) => p.id),
  );

  return scored.filter((p) => keepIds.has(p.id));
}
