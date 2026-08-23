import PhotoUploader from "@/components/PhotoUploader";

export default function UploadPage() {
  return (
    <div className="stack">
      <header className="stack tight">
        <h1>Trip photos</h1>
        <p className="muted">
          Upload a batch, and we’ll pick the best ones for you to save back to your
          camera roll.
        </p>
      </header>

      <PhotoUploader />

      <section className="card stack tight">
        <h2>How photos get picked</h2>
        <p className="muted small">
          Every photo is measured for focus, exposure and tone, and a burst of near
          identical shots collapses to its best frame.
        </p>
        <p className="muted small">
          A small model then looks at what each photo is <em>of</em>, so the picks
          spread across subjects instead of repeating one, and rates how good a
          photograph it is — learned from 20,000 photos rated by photographers, so it
          has an opinion before you have said anything.
        </p>
        <p className="muted small">
          Tap ♥ or ✕ on the review screen and it re-chooses around you, and carries
          what it learns into your next batch.
        </p>
        <p className="muted small">
          All of it runs on this device. Nothing is uploaded.
        </p>
      </section>
    </div>
  );
}
