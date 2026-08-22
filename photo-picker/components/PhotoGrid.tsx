export type GridPhoto = {
  id: string;
  name: string;
  url: string;
  /** Optional overlay, e.g. the score — shown when the user asks to see it. */
  badge?: string;
  /** Optional note, e.g. why the quality bar rejected this one. */
  note?: string | null;
  liked?: boolean;
  onLike?: () => void;
  onReject?: () => void;
};

/** Square-cropped thumbnail grid, with optional keep/drop controls. */
export default function PhotoGrid({ photos }: { photos: GridPhoto[] }) {
  if (photos.length === 0) {
    return <p className="muted">No photos selected.</p>;
  }

  return (
    <ul className="grid">
      {photos.map((photo) => (
        <li key={photo.id} className={`grid-item${photo.liked ? " liked" : ""}`}>
          {/* Plain <img>: these are object URLs for files already in the
              browser, so there is nothing for next/image's optimizer to do. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photo.url} alt={photo.name} loading="lazy" decoding="async" />

          {photo.badge && <span className="badge">{photo.badge}</span>}
          {photo.note && <span className="note">{photo.note}</span>}

          {photo.onReject && (
            <button
              type="button"
              className="tile-action drop"
              onClick={photo.onReject}
              aria-label={`Drop ${photo.name} and photos like it`}
            >
              ✕
            </button>
          )}
          {photo.onLike && (
            <button
              type="button"
              className={`tile-action keep${photo.liked ? " on" : ""}`}
              onClick={photo.onLike}
              aria-label={`Keep ${photo.name} and show more like it`}
              aria-pressed={photo.liked ?? false}
            >
              ♥
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
