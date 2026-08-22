export type GridPhoto = {
  id: string;
  name: string;
  url: string;
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
          {/* Plain <img>: these are temp-storage URLs behind an API route, so
              there is nothing for next/image's optimizer to do here. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photo.url} alt={photo.name} loading="lazy" decoding="async" />
        </li>
      ))}
    </ul>
  );
}
