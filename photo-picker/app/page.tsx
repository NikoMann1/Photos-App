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
        <h2>Milestone 1</h2>
        <p className="muted small">
          Selection is a placeholder — a random ~10% of what you upload. The point of
          this build is to prove the save-to-Photos path on a real iPhone.
        </p>
      </section>
    </div>
  );
}
