"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Photos per POST. Small batches keep any single request from being a
 * multi-hundred-megabyte upload off a phone, and give us real progress.
 * Batches are sent sequentially — the server appends to meta.json without a
 * lock, so they must not overlap.
 */
const BATCH_SIZE = 5;

type Status =
  | { phase: "idle" }
  | { phase: "uploading"; done: number; total: number }
  | { phase: "error"; message: string };

export default function PhotoUploader() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>({ phase: "idle" });

  async function handleFiles(fileList: FileList | null) {
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;

    const sessionId = newSessionId();
    setStatus({ phase: "uploading", done: 0, total: files.length });

    try {
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

        setStatus({ phase: "uploading", done: i + batch.length, total: files.length });
      }

      router.push(`/review?session=${sessionId}`);
    } catch (error) {
      setStatus({
        phase: "error",
        message: error instanceof Error ? error.message : "Upload failed",
      });
    }
  }

  const uploading = status.phase === "uploading";
  const percent =
    status.phase === "uploading" && status.total > 0
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
        disabled={uploading}
        onChange={(event) => {
          void handleFiles(event.target.files);
          // Allow re-picking the same files after an error.
          event.target.value = "";
        }}
      />

      <button
        type="button"
        className="button primary"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
      >
        {uploading ? "Uploading…" : "Choose photos"}
      </button>

      {status.phase === "uploading" && (
        <div className="stack tight" aria-live="polite">
          <div className="progress">
            <div className="progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <p className="muted">
            Uploaded {status.done} of {status.total} photos
          </p>
        </div>
      )}

      {status.phase === "error" && (
        <p className="error" role="alert">
          {status.message}
        </p>
      )}

      <p className="muted small">
        Pick 20–30 photos for now. On iPhone, tap “Choose photos” → Photo Library, then
        select and tap Add.
      </p>
    </div>
  );
}

function newSessionId(): string {
  // crypto.randomUUID needs a secure context; the LAN-over-http case has none.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
