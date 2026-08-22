"use client";

import { useMemo, useState } from "react";

export type SharePhoto = {
  id: string;
  name: string;
  type: string;
  /** The browser's own copy of the photo, straight from the file picker. */
  file: File;
  /** Object URL for the same file, for the grid and the download fallback. */
  url: string;
};

type ShareState =
  | { phase: "ready" }
  | { phase: "sharing" }
  | { phase: "shared" }
  | { phase: "unsupported" }
  | { phase: "error"; message: string };

/**
 * Save-to-Photos via the Web Share API.
 *
 * Two iOS Safari constraints shape this:
 *
 * 1. `navigator.share` only exists in a secure context. Over plain http on a
 *    LAN IP it is simply `undefined`, and we fall back to download links. Use
 *    HTTPS (a deployed URL, a tunnel, or `npm run dev:https`) for the real path.
 *
 * 2. `navigator.share()` must be called while the user gesture is still
 *    "live". Any `await` before it consumes that activation and Safari rejects
 *    the call with NotAllowedError. Because the photos never left the browser,
 *    there is nothing to fetch here: the File objects come straight from the
 *    file picker, and the click handler calls share() with zero async. That is
 *    the most reliable shape available on iOS — keep it that way.
 */
export default function SaveToPhotosButton({ photos }: { photos: SharePhoto[] }) {
  const files = useMemo(
    () => photos.map((photo) => withSaneFileName(photo.file, photo.name, photo.type)),
    [photos],
  );
  const [state, setState] = useState<ShareState>(() =>
    canShareFiles(files) ? { phase: "ready" } : { phase: "unsupported" },
  );

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

  if (state.phase === "unsupported") {
    return <DownloadFallback photos={photos} explainSecureContext />;
  }

  return (
    <div className="stack">
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
        Tap “Save {files.length === 1 ? "Image" : `${files.length} Images`}” in the share
        sheet to add them to your camera roll.
      </p>

      {state.phase === "shared" && (
        <p className="success" role="status">
          Handed off to the share sheet.
        </p>
      )}

      {state.phase === "error" && (
        <>
          <p className="error" role="alert">
            {state.message}
          </p>
          <DownloadFallback photos={photos} />
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
  explainSecureContext = false,
}: {
  photos: SharePhoto[];
  explainSecureContext?: boolean;
}) {
  const insecure = typeof window !== "undefined" && !window.isSecureContext;

  return (
    <div className="stack tight">
      {explainSecureContext && (
        <p className="muted small">
          Sharing files isn’t available in this browser
          {insecure ? " — the page isn’t in a secure context, so open it over HTTPS" : ""}.
          Falling back to downloads.
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
  if (files.length === 0) return false;
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
function withSaneFileName(file: File, name: string, type: string): File {
  if (/\.[a-z0-9]{3,4}$/i.test(name)) return file;
  const extension = type.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
  return new File([file], `${name || "photo"}.${extension}`, { type: file.type || type });
}
