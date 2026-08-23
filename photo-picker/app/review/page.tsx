"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import PhotoGrid from "@/components/PhotoGrid";
import SaveToPhotosButton, { type SharePhoto } from "@/components/SaveToPhotosButton";
import {
  getOriginals,
  loadSession,
  updateSteering,
  type BrowserSession,
  type StoredScore,
} from "@/lib/browser-session";
import { selectWithSteering, type ScoredPhoto, type Steering } from "@/lib/scoring";

type Summary = {
  total: number;
  rejectedCount: number;
  burstCount: number;
  collapsedCount: number;
  unanalyzedCount: number;
  steerable: boolean;
  /**
   * False after a reload: the grid still renders from previews, but the
   * full-quality originals are gone, so saving needs the photos picked again.
   */
  canSave: boolean;
};

type Loaded = {
  sessionId: string;
  /** Object URL per photo id, revoked on unmount. */
  urls: Map<string, string>;
  files: Map<string, File>;
  names: Map<string, string>;
  types: Map<string, string>;
  scored: StoredScore[];
  pool: StoredScore[];
  summary: Summary;
};

type State = { phase: "loading" } | { phase: "missing" } | { phase: "ready"; data: Loaded };

function Review() {
  const sessionId = useSearchParams().get("session");
  const [state, setState] = useState<State>({ phase: "loading" });
  const [steering, setSteering] = useState<Steering>({ liked: [], rejected: [] });
  const [showScores, setShowScores] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setState({ phase: "missing" });
      return;
    }

    let cancelled = false;
    let created: string[] = [];

    (async () => {
      const session: BrowserSession | null = await loadSession(sessionId).catch(() => null);
      if (cancelled) return;
      if (!session) {
        setState({ phase: "missing" });
        return;
      }

      // Originals if this is the same page load that picked them; previews
      // otherwise. Previews are fine to look at and useless to save.
      const originals = getOriginals(sessionId);
      const urls = new Map<string, string>();
      const files = new Map<string, File>();
      const names = new Map<string, string>();
      const types = new Map<string, string>();

      for (const photo of session.photos) {
        const original = originals?.get(photo.id) ?? null;
        const source = original ?? photo.preview;
        if (!source) continue;

        const url = URL.createObjectURL(source);
        created.push(url);
        urls.set(photo.id, url);
        if (original) files.set(photo.id, original);
        names.set(photo.id, photo.name);
        types.set(photo.id, photo.type);
      }

      const representatives = new Set(session.representativeIds ?? []);
      const pool = session.scores.filter(
        (photo) => representatives.has(photo.id) && photo.rejectedFor === null,
      );

      setSteering(session.steering ?? { liked: [], rejected: [] });
      setState({
        phase: "ready",
        data: {
          sessionId,
          urls,
          files,
          names,
          types,
          scored: session.scores,
          pool: pool.length > 0 ? pool : session.scores,
          summary: {
            total: session.totalPhotos ?? session.photos.length,
            rejectedCount: session.rejectedCount,
            burstCount: session.duplicateGroups.length,
            collapsedCount: session.duplicateGroups.reduce(
              (sum, group) => sum + group.alternateIds.length,
              0,
            ),
            unanalyzedCount: session.unanalyzedIds.length,
            // Steering needs embeddings to reason about; without them a tap
            // could only pin and drop, which is not worth the interface.
            steerable: session.scores.some((photo) => photo.embedding),
            canSave: files.size > 0,
          },
        },
      });
    })();

    return () => {
      cancelled = true;
      for (const url of created) URL.revokeObjectURL(url);
      created = [];
    };
  }, [sessionId]);

  const data = state.phase === "ready" ? state.data : null;

  // Re-choose locally on every tap: the expensive analysis already ran, so
  // this is a few thousand dot products, not another pass over the photos.
  const selected = useMemo(() => {
    if (!data) return [];
    return selectWithSteering(data.pool as unknown as ScoredPhoto[], steering);
  }, [data, steering]);

  useEffect(() => {
    if (!data || selected.length === 0) return;
    void updateSteering(
      data.sessionId,
      steering,
      selected.map((photo) => photo.id),
    );
  }, [data, steering, selected]);

  const steer = useCallback((id: string, action: "like" | "reject") => {
    setSteering((current) => {
      const liked = new Set(current.liked);
      const rejected = new Set(current.rejected);

      if (action === "like") {
        rejected.delete(id);
        // Tapping an already-liked photo takes the opinion back.
        if (liked.has(id)) liked.delete(id);
        else liked.add(id);
      } else {
        liked.delete(id);
        if (rejected.has(id)) rejected.delete(id);
        else rejected.add(id);
      }

      return { liked: [...liked], rejected: [...rejected] };
    });
  }, []);

  if (state.phase === "loading") return <p className="muted">Loading…</p>;

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

  const { summary, urls, files, names, types } = state.data;
  const likedIds = new Set(steering.liked);

  // The grid renders from whatever is available; only photos with an original
  // behind them can be handed to the share sheet.
  const shown = selected.filter((photo) => urls.has(photo.id));
  const saveable = shown.filter((photo) => files.has(photo.id));

  const sharePhotos: SharePhoto[] = saveable.map((photo) => ({
    id: photo.id,
    name: names.get(photo.id) ?? `${photo.id}.jpg`,
    type: types.get(photo.id) ?? "image/jpeg",
    file: files.get(photo.id)!,
    url: urls.get(photo.id)!,
  }));

  const gridPhotos = shown.map((photo) => ({
    id: photo.id,
    name: names.get(photo.id) ?? photo.id,
    url: urls.get(photo.id)!,
    badge: showScores ? photo.score.toFixed(2) : undefined,
    note: showScores ? photo.rejectedFor : null,
    liked: likedIds.has(photo.id),
    onLike: summary.steerable ? () => steer(photo.id, "like") : undefined,
    onReject: summary.steerable ? () => steer(photo.id, "reject") : undefined,
  }));

  return (
    <div className="stack">
      <header className="stack tight">
        <h1>Best photos</h1>
        <p className="muted">
          {shown.length} of {summary.total} photos.
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

      {summary.steerable && (
        <p className="muted small">
          Tap <strong>♥</strong> to keep a photo and get more like it, <strong>✕</strong> to
          drop it and photos like it. The rest re-shuffle around your choices.
          {steering.rejected.length > 0 && ` ${steering.rejected.length} dropped.`}
        </p>
      )}

      <div className="row">
        <button
          type="button"
          className="link-button small"
          onClick={() => setShowScores((shown) => !shown)}
        >
          {showScores ? "Hide scores" : "Show scores"}
        </button>
        {(steering.liked.length > 0 || steering.rejected.length > 0) && (
          <button
            type="button"
            className="link-button small"
            onClick={() => setSteering({ liked: [], rejected: [] })}
          >
            Reset choices
          </button>
        )}
      </div>

      {summary.canSave ? (
        <SaveToPhotosButton photos={sharePhotos} />
      ) : (
        <p className="muted small">
          These are stored previews — the full-quality photos aren’t kept on the device
          after a reload, because a batch of them is far more than a website is allowed
          to store. Pick the batch again to save it to your camera roll.
        </p>
      )}

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
