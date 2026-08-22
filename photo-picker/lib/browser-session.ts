/**
 * Client-side session storage (IndexedDB).
 *
 * The photos the user picks stay in the browser: the review screen reads them
 * back from here, and the share hands the very same File objects to
 * `navigator.share`. Nothing has to travel to a server and back for the
 * save-to-Photos flow to work, which is what lets this deploy to any host
 * (including serverless, where there is no persistent local filesystem) and
 * what makes the share call fully synchronous — see SaveToPhotosButton.
 *
 * IndexedDB rather than in-memory state so a reload on /review doesn't lose
 * the batch. Structured clone stores File objects directly, so what comes back
 * out is still a File, with its name and type intact.
 */

import type { PhotoMeta, ScoredPhoto, Steering } from "./scoring";

const DB_NAME = "photo-picker";
const DB_VERSION = 1;
const STORE = "sessions";

/**
 * Only the newest batch is kept.
 *
 * Photos are stored as their original files, so a 50-photo batch off an iPhone
 * is 150 MB or more. Keeping previous batches around meant every upload added
 * another copy of that to the origin's storage — and once the quota is gone,
 * writes fail and iOS can no longer stage newly picked photos, which looks
 * like the photo picker refusing to close.
 */

export type StoredPhoto = PhotoMeta & { file: File };

/**
 * Everything the scorer worked out about one photo, minus the file itself.
 *
 * The whole scored photo is kept, embedding included, so the review screen can
 * re-choose when the user steers without re-running any analysis — the
 * expensive stage costs ~300ms a photo and must not be repeated for a tap.
 * A 512-float embedding is 2 KB, so a 50-photo batch adds well under 100 KB.
 */
export type StoredScore = Omit<ScoredPhoto, "takenAt"> & { takenAt: number | null };

/** A burst: one frame kept, the rest set aside. */
export type StoredDuplicateGroup = { bestId: string; alternateIds: string[] };

export type BrowserSession = {
  sessionId: string;
  createdAt: number;
  /**
   * Only the photos that can ever be displayed: the pool steering draws from,
   * plus anything currently shown. Photos that lost to a duplicate or failed
   * the quality bar are counted but not kept — storing every original file was
   * the bulk of the space, for photos the user will never see.
   */
  photos: StoredPhoto[];
  /** How many photos were in the batch, including ones not kept above. */
  totalPhotos: number;
  /** Ids of the photos currently shown, after any steering. */
  selectedIds: string[];
  /** Every photo's score, best-first. */
  scores: StoredScore[];
  /** Ids that survived duplicate collapsing — the pool steering re-chooses from. */
  representativeIds: string[];
  /** What the user has said about this batch so far. */
  steering: Steering;
  duplicateGroups: StoredDuplicateGroup[];
  /** How many photos the quality bar rejected outright. */
  rejectedCount: number;
  /** Photos whose pixels could not be decoded, so they were never scored. */
  unanalyzedIds: string[];
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "sessionId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open IndexedDB"));
  });
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

/** Records a steering change without rewriting the photos themselves. */
export async function updateSteering(
  sessionId: string,
  steering: Steering,
  selectedIds: string[],
): Promise<void> {
  const session = await loadSession(sessionId);
  if (!session) return;
  await saveSession({ ...session, steering, selectedIds });
}

export async function saveSession(session: BrowserSession): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    await promisify(store.put(session));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not save session"));
      tx.onabort = () => reject(tx.error ?? new Error("Save aborted — storage may be full"));
    });
  } finally {
    db.close();
  }
}

/**
 * Saves a batch, dropping every earlier one first so storage holds one batch
 * at a time. If the write still fails for space, clear everything and try once
 * more before giving up — a full store is recoverable, and the alternative is
 * an app that silently stops accepting photos.
 */
export async function saveLatestSession(session: BrowserSession): Promise<void> {
  await deleteOtherSessions(session.sessionId);

  try {
    await saveSession(session);
  } catch (error) {
    if (!isQuotaError(error)) throw error;
    await deleteOtherSessions(null);
    await saveSession(session);
  }
}

function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" || error.name === "NotEnoughSpaceError")
  );
}

/** Removes every stored batch except `keepId`; pass null to remove all. */
export async function deleteOtherSessions(keepId: string | null): Promise<void> {
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const keys = await promisify<IDBValidKey[]>(store.getAllKeys());
      for (const key of keys) {
        if (key !== keepId) store.delete(key);
      }
      await new Promise<void>((resolve) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    } finally {
      db.close();
    }
  } catch {
    // Never fail an upload because cleanup could not run.
  }
}

export async function loadSession(sessionId: string): Promise<BrowserSession | null> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readonly");
    const result = await promisify<BrowserSession | undefined>(
      tx.objectStore(STORE).get(sessionId),
    );
    return result ?? null;
  } finally {
    db.close();
  }
}

/** Storage can be unavailable — private browsing, or a locked-down WebView. */
export function isStorageAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}
