"use client";

import { useEffect, useState } from "react";

export type SharePhoto = {
  id: string;
  name: string;
  type: string;
  url: string;
};

type ShareState =
  | { phase: "preparing" }
  | { phase: "ready" }
  | { phase: "sharing" }
  | { phase: "shared" }
  | { phase: "unsupported" }
  | { phase: "error"; message: string };

/**
 * Save-to-Photos via the Web Share API.
 *
 * Two iOS Safari constraints drive the shape of this component:
 *
 * 1. `navigator.share` only exists in a secure context. Over plain http on a
 *    LAN IP it is simply `undefined`, and we fall back to download links. Use
 *    the HTTPS dev server or a tunnel to exercise the real path.
 *
 * 2. `navigator.share()` must be called while the user gesture is still
 *    "live". Awaiting fetches inside the click handler consumes that
 *    activation and Safari rejects the call with NotAllowedError. So the File
 *    objects are fetched up front, on mount, and the click handler calls
 *    share() synchronously with files already in hand.
 */
export default function SaveToPhotosButton({ photos }: { photos: SharePhoto[] }) {
  const [files, setFiles] = useState<File[]>([]);
  const [state, setState] = useState<ShareState>({ phase: "preparing" });

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "preparing" });

    (async () => {
      try {
        const fetched = await Promise.all(
          photos.map(async (photo) => {
            const response = await fetch(photo.url);
            if (!response.ok) throw new Error(`Could not load ${photo.name}`);
            const blob = await response.blob();
            const type = blob.type || photo.type;
            return new File([blob], fileNameFor(photo.name, type), { type });
          }),
        );
        if (cancelled) return;

        setFiles(fetched);
        setState(canShareFiles(fetched) ? { phase: "ready" } : { phase: "unsupported" });
      } catch (error) {
        if (cancelled) return;
        setState({
          phase: "error",
          message: error instanceof Error ? error.message : "Could not prepare photos",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [photos]);

  // Deliberately not async: share() must run in the gesture's own task.
  function handleShare() {
    if (files.length === 0) return;
    setState({ phase: "sharing" });

    navigator
      .share({ files })
      .then(() => setState({ phase: "shared" }))
      .catch((error: unknown) => {
        // The user dismissing the share sheet is not an error.
        if (error instanceof DOMException && error.name === "AbortError") {
          setState({ phase: "ready" });
          return;
        }
        setState({
          phase: "error",
          message: error instanceof Error ? error.message : "Share failed",
        });
      });
  }

  if (state.phase === "preparing") {
    return (
      <button type="button" className="button primary" disabled>
        Preparing photos…
      </button>
    );
  }

  const shareAvailable =
    state.phase === "ready" || state.phase === "sharing" || state.phase === "shared";

  return (
    <div className="stack">
      {shareAvailable ? (
        <>
          <button
            type="button"
            className="button primary"
            onClick={handleShare}
            disabled={state.phase === "sharing"}
          >
            {state.phase === "sharing"
              ? "Opening share sheet…"
              : `Save ${files.length} photo${files.length === 1 ? "" : "s"} to Photos`}
          </button>
          <p className="muted small">
            Tap “Save {files.length === 1 ? "Image" : `${files.length} Images`}” in the
            share sheet to add them to your camera roll.
          </p>
          {state.phase === "shared" && (
            <p className="success" role="status">
              Handed off to the share sheet.
            </p>
          )}
        </>
      ) : (
        <DownloadFallback photos={photos} reason={state} />
      )}

      {state.phase === "error" && (
        <>
          <p className="error" role="alert">
            {state.message}
          </p>
          <DownloadFallback photos={photos} reason={state} />
        </>
      )}
    </div>
  );
}

/**
 * Fallback for browsers without Web Share with files — including iOS Safari
 * over plain http, where `navigator.share` doesn't exist at all. On iOS these
 * links save into Files, not Photos; that's the ceiling without a secure
 * context.
 */
function DownloadFallback({
  photos,
  reason,
}: {
  photos: SharePhoto[];
  reason: ShareState;
}) {
  return (
    <div className="stack tight">
      {reason.phase === "unsupported" && (
        <p className="muted small">
          Sharing files isn’t available in this browser
          {typeof window !== "undefined" && !window.isSecureContext
            ? " — the page is not in a secure context, so serve it over HTTPS or localhost"
            : ""}
          . Falling back to downloads.
        </p>
      )}
      <ul className="stack tight">
        {photos.map((photo, index) => (
          <li key={photo.id}>
            <a className="button" href={photo.url} download={photo.name}>
              Download photo {index + 1}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function canShareFiles(files: File[]): boolean {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function") {
    return false;
  }
  if (typeof navigator.canShare !== "function") return false;
  try {
    return navigator.canShare({ files });
  } catch {
    return false;
  }
}

/** iOS keys off the extension when saving, so make sure there is a sane one. */
function fileNameFor(name: string, type: string): string {
  if (/\.[a-z0-9]{3,4}$/i.test(name)) return name;
  const extension = type.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
  return `${name || "photo"}.${extension}`;
}
