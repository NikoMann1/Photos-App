export type GridPhoto = {
  id: string;
  name: string;
  url: string;
  /** Optional overlay, e.g. the score — shown when the user asks to see it. */
  badge?: string;
  /** Optional note, e.g. why the quality bar rejected this one. */
  note?: string | null;
};

/** Square-cropped thumbnail grid. Presentational only. */
export default function PhotoGrid({ photos }: { photos: GridPhoto[] }) {
  if (photos.length === 0) {
    return <p className="muted">No photos selected.</p>;
  }

  return (
    <ul className="grid">
      {photos.map((photo) => (
        <li key={photo.id} className="grid-item">
          {/* Plain <img>: these are object URLs for files already in the
              browser, so there is nothing for next/image's optimizer to do. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photo.url} alt={photo.name} loading="lazy" decoding="async" />
          {photo.badge && <span className="badge">{photo.badge}</span>}
          {photo.note && <span className="note">{photo.note}</span>}
        </li>
      ))}
    </ul>
  );
}
