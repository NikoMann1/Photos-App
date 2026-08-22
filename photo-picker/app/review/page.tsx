"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import PhotoGrid from "@/components/PhotoGrid";
import SaveToPhotosButton, { type SharePhoto } from "@/components/SaveToPhotosButton";
import { loadSession } from "@/lib/browser-session";

type Summary = {
  total: number;
  rejectedCount: number;
  burstCount: number;
  collapsedCount: number;
  unanalyzedCount: number;
};

type State =
  | { phase: "loading" }
  | { phase: "missing" }
  | {
      phase: "ready";
      photos: SharePhoto[];
      scores: Map<string, { score: number; rejectedFor: string | null }>;
      summary: Summary;
    };

function Review() {
  const sessionId = useSearchParams().get("session");
  const [state, setState] = useState<State>({ phase: "loading" });
  const [showScores, setShowScores] = useState(false);

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

      const selectedIds = new Set(session.selectedIds);
      const selected = session.photos.filter((photo) => selectedIds.has(photo.id));
      const photos: SharePhoto[] = selected.map((photo) => {
        const url = URL.createObjectURL(photo.file);
        urls.push(url);
        return { id: photo.id, name: photo.name, type: photo.type, file: photo.file, url };
      });

      const scores = new Map(
        session.scores.map((entry) => [
          entry.id,
          { score: entry.score, rejectedFor: entry.rejectedFor },
        ]),
      );

      setState({
        phase: "ready",
        photos,
        scores,
        summary: {
          total: session.photos.length,
          rejectedCount: session.rejectedCount,
          burstCount: session.duplicateGroups.length,
          collapsedCount: session.duplicateGroups.reduce(
            (sum, group) => sum + group.alternateIds.length,
            0,
          ),
          unanalyzedCount: session.unanalyzedIds.length,
        },
      });
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

  const { summary } = state;
  const gridPhotos = state.photos.map((photo) => {
    const score = state.scores.get(photo.id);
    return {
      ...photo,
      badge: showScores && score ? score.score.toFixed(2) : undefined,
      note: showScores ? score?.rejectedFor ?? null : null,
    };
  });

  return (
    <div className="stack">
      <header className="stack tight">
        <h1>Best photos</h1>
        <p className="muted">
          {state.photos.length} of {summary.total} photos.
        </p>
        <ul className="reasons small">
          {summary.collapsedCount > 0 && (
            <li>
              {summary.collapsedCount} near-duplicate
              {summary.collapsedCount === 1 ? "" : "s"} set aside across {summary.burstCount}{" "}
              group{summary.burstCount === 1 ? "" : "s"}
            </li>
          )}
          {summary.rejectedCount > 0 && (
            <li>{summary.rejectedCount} rejected as blurry or badly exposed</li>
          )}
          {summary.unanalyzedCount > 0 && (
            <li>{summary.unanalyzedCount} could not be analyzed</li>
          )}
        </ul>
      </header>

      <PhotoGrid photos={gridPhotos} />

      <button
        type="button"
        className="link-button small"
        onClick={() => setShowScores((shown) => !shown)}
      >
        {showScores ? "Hide scores" : "Show scores"}
      </button>

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
