"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  NO_STEERING,
  selectBestPhotos,
  selectionSize,
  shortlistForEmbedding,
  type AnalyzedPhoto,
} from "@/lib/scoring";
import { analyzePhotos, embedPhotos } from "@/lib/analysis";
import {
  isStorageAvailable,
  rememberOriginals,
  saveLatestSession,
  type StoredPhoto,
} from "@/lib/browser-session";

/**
 * Photos per POST when the server round trip is enabled. Small batches keep any
 * single request from being a multi-hundred-megabyte upload off a phone, and
 * give real progress. Batches are sent sequentially — the server appends to
 * meta.json without a lock, so they must not overlap.
 */
const BATCH_SIZE = 5;

/**
 * Off by default. The photos the review screen shows and shares are the
 * browser's own copies, so the app works on any host — including serverless,
 * where there's no persistent local filesystem to store an upload in. Set
 * NEXT_PUBLIC_UPLOAD_TO_SERVER=1 to also exercise /api/upload (it needs a
 * long-running server with a real disk, i.e. local `next dev`).
 */
const UPLOAD_TO_SERVER = process.env.NEXT_PUBLIC_UPLOAD_TO_SERVER === "1";

type Status =
  | { phase: "idle" }
  | { phase: "working"; label: string; done: number; total: number }
  | { phase: "error"; message: string };

/** Analysis is the slow step, so it gets its own progress rather than a spinner. */
const ANALYZING = "Analyzing";
const LOOKING = "Looking at";

export default function PhotoUploader() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>({ phase: "idle" });

  async function handleFiles(fileList: FileList | null) {
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;

    if (!isStorageAvailable()) {
      setStatus({
        phase: "error",
        message: "This browser has no storage available (private browsing?), so the photos can't be carried to the review screen.",
      });
      return;
    }

    const sessionId = newSessionId();

    try {
      if (UPLOAD_TO_SERVER) {
        await uploadToServer(files, sessionId, (done) =>
          setStatus({ phase: "working", label: "Uploading", done, total: files.length }),
        );
      }

      const photos = files.map((file, index) => ({
        id: `p${String(index).padStart(4, "0")}`,
        name: file.name || `photo-${index + 1}.jpg`,
        type: file.type || "image/jpeg",
        size: file.size,
        file,
      }));

      setStatus({ phase: "working", label: ANALYZING, done: 0, total: files.length });

      const analyses = await analyzePhotos(
        photos.map(({ id, file }) => ({ id, file })),
        (done, total) => setStatus({ phase: "working", label: ANALYZING, done, total }),
      );

      const previews = new Map(analyses.map((result) => [result.id, result.preview]));

      // A photo whose pixels wouldn't decode can't be scored. Keep it in the
      // session — it is still the user's photo — but leave it out of ranking
      // rather than guessing a score for it.
      const byId = new Map(photos.map((photo) => [photo.id, photo]));
      const analyzed: AnalyzedPhoto[] = [];
      const unanalyzedIds: string[] = [];

      for (const analysis of analyses) {
        const photo = byId.get(analysis.id);
        if (!photo) continue;
        if (!analysis.metrics) {
          unanalyzedIds.push(analysis.id);
          continue;
        }
        const { file: _file, ...meta } = photo;
        analyzed.push({ ...meta, takenAt: analysis.takenAt, metrics: analysis.metrics });
      }

      setStatus({ phase: "working", label: "Choosing", done: files.length, total: files.length });
      let selection = selectBestPhotos(analyzed);

      // Second stage: work out what the shortlisted photos are actually *of*,
      // then choose again. Only the shortlist, because this costs roughly six
      // times what stage one does per photo. Failures here are not fatal — the
      // first selection already stands, and photos without an embedding fall
      // back to the cheap similarity signals.
      const shortlist = shortlistForEmbedding(selection);
      if (shortlist.length > 1) {
        const byId = new Map(photos.map((photo) => [photo.id, photo.file]));
        const embeddings = await embedPhotos(
          shortlist
            .map((photo) => ({ id: photo.id, file: byId.get(photo.id) }))
            .filter((input): input is { id: string; file: File } => input.file !== undefined),
          (done, total) => setStatus({ phase: "working", label: LOOKING, done, total }),
        );

        const found = new Map(
          embeddings
            .filter((result) => result.embedding !== null)
            .map((result) => [result.id, result.embedding]),
        );

        if (found.size > 1) {
          selection = selectBestPhotos(
            analyzed.map((photo) =>
              found.has(photo.id) ? { ...photo, embedding: found.get(photo.id) } : photo,
            ),
          );
        }
      }

      const selectedIds = selection.selected.map((photo) => photo.id);

      const collapsed = new Set(
        selection.duplicateGroups.flatMap((group) =>
          group.alternates.map((alternate) => alternate.id),
        ),
      );
      const representativeIds = selection.ranked
        .map((photo) => photo.id)
        .filter((id) => !collapsed.has(id));

      // If little or nothing could be analyzed — an image format this browser
      // cannot decode, say — showing an empty review screen would be the worst
      // possible answer. Fall back to unscored photos so the user still gets
      // their batch; the review screen reports how many were never scored.
      const wanted = selectionSize(photos.length);
      if (selectedIds.length < wanted && unanalyzedIds.length > 0) {
        selectedIds.push(...unanalyzedIds.slice(0, wanted - selectedIds.length));
      }

      // Originals stay in memory for this session; only previews are written.
      rememberOriginals(sessionId, new Map(photos.map((photo) => [photo.id, photo.file])));

      // Previews are cheap, but there is still no reason to keep them for
      // photos that can never appear: those that lost to a duplicate or failed
      // the quality bar.
      const keep = new Set([...representativeIds, ...selectedIds, ...unanalyzedIds]);
      const stored: StoredPhoto[] = photos
        .filter((photo) => keep.has(photo.id))
        .map(({ file: _file, ...meta }) => ({
          ...meta,
          preview: previews.get(meta.id) ?? null,
        }));

      await saveLatestSession({
        sessionId,
        createdAt: Date.now(),
        photos: stored,
        totalPhotos: photos.length,
        selectedIds,
        scores: selection.ranked.map((photo) => ({ ...photo, takenAt: photo.takenAt ?? null })),
        representativeIds,
        steering: NO_STEERING,
        duplicateGroups: selection.duplicateGroups.map((group) => ({
          bestId: group.best.id,
          alternateIds: group.alternates.map((photo) => photo.id),
        })),
        rejectedCount: selection.rejectedCount,
        unanalyzedIds,
      });

      router.push(`/review?session=${sessionId}`);
    } catch (error) {
      setStatus({
        phase: "error",
        message: error instanceof Error ? error.message : "Something went wrong",
      });
    }
  }

  const working = status.phase === "working";
  const percent =
    status.phase === "working" && status.total > 0
      ? Math.round((status.done / status.total) * 100)
      : 0;

  return (
    <div className="stack">
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/*"
        className="visually-hidden"
        disabled={working}
        onChange={(event) => {
          void handleFiles(event.target.files);
          // Allow re-picking the same files after an error.
          event.target.value = "";
        }}
      />

      <button
        type="button"
        className="button primary"
        disabled={working}
        onClick={() => inputRef.current?.click()}
      >
        {working ? `${status.label}…` : "Choose photos"}
      </button>

      {status.phase === "working" && (
        <div className="stack tight" aria-live="polite">
          <div className="progress">
            <div className="progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <p className="muted">
            {status.label} {status.done} of {status.total} photos
          </p>
        </div>
      )}

      {status.phase === "error" && (
        <p className="error" role="alert">
          {status.message}
        </p>
      )}

      <p className="muted small">
        On iPhone, tap “Choose photos” → Photo Library, then select and tap Add. Photos
        are analyzed on your device — nothing is uploaded. Keep batches to around 175
        photos; larger ones have been seen to stall before analysis starts.
      </p>

      {!working && (
        <details className="card">
          <summary className="small">Why is there a long pause after I tap Add?</summary>
          <div className="stack tight">
            <p className="muted small">
              That pause is iOS, not this app. Safari converts every photo you picked
              from HEIC to JPEG before handing them over, and shows nothing while it
              works. The more photos, the longer the wait.
            </p>
            <p className="muted small">
              To skip the conversion: in the photo picker tap <strong>Options</strong> at
              the top, then set <strong>Format</strong> to <strong>Current</strong>.
            </p>
            <p className="muted small">
              Also check <strong>Settings → Photos</strong>. If “Optimize iPhone Storage”
              is on, photos that aren’t on the device have to be downloaded from iCloud
              first — slow on cellular.
            </p>
          </div>
        </details>
      )}
    </div>
  );
}

async function uploadToServer(
  files: File[],
  sessionId: string,
  onProgress: (done: number) => void,
): Promise<void> {
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const isLast = i + BATCH_SIZE >= files.length;

    const form = new FormData();
    form.set("sessionId", sessionId);
    if (isLast) form.set("finalize", "1");
    for (const file of batch) form.append("photos", file, file.name);

    const response = await fetch("/api/upload", { method: "POST", body: form });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `Upload failed (${response.status})`);
    }

    onProgress(i + batch.length);
  }
}

function newSessionId(): string {
  // crypto.randomUUID needs a secure context; plain http on a LAN IP has none.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
