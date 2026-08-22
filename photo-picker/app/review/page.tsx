import Link from "next/link";
import PhotoGrid from "@/components/PhotoGrid";
import SaveToPhotosButton from "@/components/SaveToPhotosButton";
import { readSession } from "@/lib/storage";

export const dynamic = "force-dynamic";

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string }>;
}) {
  const { session: sessionId } = await searchParams;
  const session = sessionId ? await readSession(sessionId).catch(() => null) : null;

  if (!sessionId || !session?.selected) {
    return (
      <div className="stack">
        <h1>Nothing to review</h1>
        <p className="muted">
          {sessionId
            ? "That upload session has expired or was never finished."
            : "No upload session in the URL."}
        </p>
        <Link className="button" href="/">
          Start over
        </Link>
      </div>
    );
  }

  const photos = session.selected.map((photo) => ({
    id: photo.id,
    name: photo.name,
    type: photo.type,
    url: `/api/photos/${sessionId}/${photo.id}`,
  }));

  return (
    <div className="stack">
      <header className="stack tight">
        <h1>Best photos</h1>
        <p className="muted">
          {photos.length} of {session.photos.length} uploaded photos.{" "}
          <span className="small">(Placeholder selection — random for now.)</span>
        </p>
      </header>

      <PhotoGrid photos={photos} />

      <SaveToPhotosButton photos={photos} />

      <Link className="button" href="/">
        Upload another batch
      </Link>
    </div>
  );
}
