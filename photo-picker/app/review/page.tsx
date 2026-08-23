"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import PhotoGrid from "@/components/PhotoGrid";
import SaveToPhotosButton, { type SharePhoto } from "@/components/SaveToPhotosButton";
import {
  getOriginals,
  loadSession,
  loadStoredOriginals,
  storeSelectedOriginals,
  updateSteering,
  type BrowserSession,
  type StoredScore,
} from "@/lib/browser-session";
import {
  explainPicks,
  reasonLabel,
  selectWithSteering,
  type ScoredPhoto,
  type Steering,
} from "@/lib/scoring";
import {
  countRemembered,
  exemplars,
  forgetPreferences,
  loadPreferences,
  rememberBatch,
  NO_PREFERENCES,
  type Preferences,
} from "@/lib/preferences";

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
  /** Photo id to how many near-duplicates it beat. */
  alternates: Map<string, number>;
  summary: Summary;
};

type State = { phase: "loading" } | { phase: "missing" } | { phase: "ready"; data: Loaded };

function Review() {
  const sessionId = useSearchParams().get("session");
  const [state, setState] = useState<State>({ phase: "loading" });
  const [steering, setSteering] = useState<Steering>({ liked: [], rejected: [] });
  const [preferences, setPreferences] = useState<Preferences>(NO_PREFERENCES);
  const [showWhy, setShowWhy] = useState(false);

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

      // In-memory originals if this is the same page load that picked them;
      // otherwise the ones persisted for the selection. Previews are fine to
      // look at and useless to save, so they are the last resort.
      const remembered = getOriginals(sessionId);
      // Only read them back when memory is empty — on the common path, right
      // after an upload, the originals are already here, and reading tens of
      // megabytes of files back would delay the grid for nothing.
      const persisted = remembered ? new Map<string, File>() : await loadStoredOriginals(sessionId);
      if (cancelled) return;

      const originals = new Map<string, File>([...persisted, ...(remembered ?? [])]);
      const urls = new Map<string, string>();
      const files = new Map<string, File>();
      const names = new Map<string, string>();
      const types = new Map<string, string>();

      for (const photo of session.photos) {
        const original = originals.get(photo.id) ?? null;
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
      setPreferences(await loadPreferences());
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
          alternates: new Map(
            session.duplicateGroups.map((group) => [group.bestId, group.alternateIds.length]),
          ),
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
  // Only earlier batches inform this one: this batch's own taps are already
  // applied directly, and counting them twice would double their weight.
  const remembered = useMemo(() => {
    const others: Preferences = {
      batches: preferences.batches.filter((batch) => batch.sessionId !== data?.sessionId),
    };
    return { liked: exemplars(others, "liked"), rejected: exemplars(others, "rejected") };
  }, [preferences, data]);

  const selected = useMemo(() => {
    if (!data) return [];
    return selectWithSteering(
      data.pool as unknown as ScoredPhoto[],
      steering,
      undefined,
      remembered,
    );
  }, [data, steering, remembered]);

  useEffect(() => {
    if (!data || selected.length === 0) return;
    void updateSteering(
      data.sessionId,
      steering,
      selected.map((photo) => photo.id),
    );

    // Steering changes what is selected, so keep the saved originals in step
    // with it — otherwise a photo steering brought in could be shown but not
    // saved after a reload.
    const available = getOriginals(data.sessionId);
    if (available) {
      void storeSelectedOriginals(
        data.sessionId,
        available,
        selected.map((photo) => photo.id),
      );
    }
  }, [data, steering, selected]);

  /**
   * Recording preferences depends only on what the user said, never on what
   * was selected as a result.
   *
   * Sharing an effect with the code above meant that changing preferences
   * changed the selection, which re-ran this, which read-modify-wrote the
   * preferences back — so Forget cleared them and then immediately restored
   * them from the read that was already in flight.
   */
  useEffect(() => {
    if (!data) return;

    const embeddingOf = (id: string) =>
      data.scored.find((photo) => photo.id === id)?.embedding ?? null;
    const collect = (ids: string[]) =>
      ids.map(embeddingOf).filter((e): e is Float32Array => e != null);

    void rememberBatch(
      data.sessionId,
      collect(steering.liked),
      collect(steering.rejected),
    ).then(setPreferences);
  }, [data, steering]);

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

  const { summary, urls, files, names, types, alternates } = state.data;
  const rememberedCount = countRemembered({
    batches: preferences.batches.filter((batch) => batch.sessionId !== state.data.sessionId),
  });
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

  // Why each photo is here, rather than a score: on a real batch every
  // survivor lands within a few hundredths, and the number describes a signal
  // that stopped being the deciding one several changes ago.
  const reasons = explainPicks(shown, { steering, remembered, alternates });

  const gridPhotos = shown.map((photo) => ({
    id: photo.id,
    name: names.get(photo.id) ?? photo.id,
    url: urls.get(photo.id)!,
    badge: showWhy
      ? reasonLabel(reasons.get(photo.id) ?? "top-quality", alternates.get(photo.id) ?? 0)
      : undefined,
    note: showWhy ? photo.rejectedFor : null,
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

      {rememberedCount.liked + rememberedCount.rejected > 0 && (
        <p className="muted small">
          Also using {rememberedCount.liked} kept and {rememberedCount.rejected} dropped
          from earlier batches.{" "}
          <button
            type="button"
            className="link-button small inline"
            onClick={() => void forgetPreferences().then(setPreferences)}
          >
            Forget
          </button>
        </p>
      )}

      <div className="row">
        <button
          type="button"
          className="link-button small"
          onClick={() => setShowWhy((on) => !on)}
        >
          {showWhy ? "Hide reasons" : "Why these?"}
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

      {shown.length > saveable.length && saveable.length > 0 && (
        <p className="muted small">
          {shown.length - saveable.length} of these can’t be saved: they came into the
          selection after the page reloaded, and the full-quality photos behind them are
          no longer on the device. Pick the batch again to save everything.
        </p>
      )}

      {summary.canSave ? (
        <SaveToPhotosButton photos={sharePhotos} />
      ) : (
        <p className="muted small">
          These are previews — the full-quality photos behind them are no longer on the
          device, so they can’t be saved to your camera roll. Pick the batch again to
          save it.
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
