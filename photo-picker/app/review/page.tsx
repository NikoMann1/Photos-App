"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import PhotoGrid from "@/components/PhotoGrid";
import SaveToPhotosButton, { type SharePhoto } from "@/components/SaveToPhotosButton";
import { loadSession } from "@/lib/browser-session";

type State =
  | { phase: "loading" }
  | { phase: "missing" }
  | { phase: "ready"; photos: SharePhoto[]; total: number };

function Review() {
  const sessionId = useSearchParams().get("session");
  const [state, setState] = useState<State>({ phase: "loading" });

  useEffect(() => {
    if (!sessionId) {
      setState({ phase: "missing" });
      return;
    }

    let cancelled = false;
    // Object URLs are created here and revoked on unmount, so the grid and the
    // download fallback can point at the browser's own copies of the photos.
    let urls: string[] = [];

    (async () => {
      const session = await loadSession(sessionId).catch(() => null);
      if (cancelled) return;

      if (!session) {
        setState({ phase: "missing" });
        return;
      }

      const selected = session.photos.filter((photo) =>
        session.selectedIds.includes(photo.id),
      );
      const photos: SharePhoto[] = selected.map((photo) => {
        const url = URL.createObjectURL(photo.file);
        urls.push(url);
        return { id: photo.id, name: photo.name, type: photo.type, file: photo.file, url };
      });

      setState({ phase: "ready", photos, total: session.photos.length });
    })();

    return () => {
      cancelled = true;
      for (const url of urls) URL.revokeObjectURL(url);
      urls = [];
    };
  }, [sessionId]);

  if (state.phase === "loading") {
    return <p className="muted">Loading…</p>;
  }

  if (state.phase === "missing") {
    return (
      <div className="stack">
        <h1>Nothing to review</h1>
        <p className="muted">
          {sessionId
            ? "That batch isn’t in this browser’s storage — it may have been cleared, or opened in a different browser."
            : "No upload session in the URL."}
        </p>
        <Link className="button" href="/">
          Start over
        </Link>
      </div>
    );
  }

  return (
    <div className="stack">
      <header className="stack tight">
        <h1>Best photos</h1>
        <p className="muted">
          {state.photos.length} of {state.total} photos.{" "}
          <span className="small">(Placeholder selection — random for now.)</span>
        </p>
      </header>

      <PhotoGrid photos={state.photos} />

      <SaveToPhotosButton photos={state.photos} />

      <Link className="button" href="/">
        Upload another batch
      </Link>
    </div>
  );
}

export default function ReviewPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <Review />
    </Suspense>
  );
}
