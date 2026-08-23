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
const DB_VERSION = 3;
const STORE = "sessions";

/**
 * Preferences live in their own store because batches are deliberately
 * disposable — only the newest is kept — and what the user has taught the app
 * must outlive them.
 */
export const PREFERENCES_STORE = "preferences";

/**
 * Originals for the photos currently selected, so saving survives a reload.
 *
 * Keeping originals only in memory was wrong: iOS discards and reloads a tab
 * under memory pressure, which is exactly what a large batch causes, and the
 * user never sees a reload happen — they just find the save button gone, which
 * is the one thing the app exists to do. Only the selection is stored, and
 * under a byte budget, so this cannot grow back into the quota problem that
 * made storing every original untenable.
 */
export const ORIGINALS_STORE = "originals";

/** Roughly 40 photos at iPhone sizes; the selection is far smaller in practice. */
const ORIGINALS_BUDGET_BYTES = 150 * 1024 * 1024;

/**
 * Only the newest batch is kept.
 *
 * Photos are stored as their original files, so a 50-photo batch off an iPhone
 * is 150 MB or more. Keeping previous batches around meant every upload added
 * another copy of that to the origin's storage — and once the quota is gone,
 * writes fail and iOS can no longer stage newly picked photos, which looks
 * like the photo picker refusing to close.
 */

/**
 * A photo as persisted: metadata and a small JPEG preview, never the original.
 *
 * Writing originals here is what exhausts the origin's storage — a 500-photo
 * batch off a phone is well over a gigabyte — and on iOS an exhausted quota
 * does not raise an error the user can see, it just stops the photo picker
 * from closing. Previews cost roughly 40 KB each instead.
 */
export type StoredPhoto = PhotoMeta & { preview: Blob | null };

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
      if (!db.objectStoreNames.contains(PREFERENCES_STORE)) {
        db.createObjectStore(PREFERENCES_STORE);
      }
      if (!db.objectStoreNames.contains(ORIGINALS_STORE)) {
        db.createObjectStore(ORIGINALS_STORE);
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

/** Shared with `preferences.ts`, which stores into the same database. */
export function openDatabase(): Promise<IDBDatabase> {
  return openDb();
}

export function toPromise<T>(request: IDBRequest<T>): Promise<T> {
  return promisify(request);
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

/**
 * Originals for the batch being worked on, held in memory rather than stored.
 *
 * A picked file is already held by the browser outside this origin's quota;
 * copying it into IndexedDB is what consumes the budget. Keeping the reference
 * costs nothing extra and survives client-side navigation from the upload
 * screen to the review screen — but not a reload, which is the deliberate
 * trade: after a reload the grid still renders from previews, and the review
 * screen says that saving needs the photos picked again.
 */
const originals = new Map<string, Map<string, File>>();

export function rememberOriginals(sessionId: string, files: Map<string, File>): void {
  // Only one batch is worked on at a time; drop any earlier one's references
  // so the browser can release the files behind them.
  originals.clear();
  originals.set(sessionId, files);
}

export function getOriginals(sessionId: string): Map<string, File> | null {
  return originals.get(sessionId) ?? null;
}

function originalKey(sessionId: string, photoId: string): string {
  return `${sessionId}:${photoId}`;
}

/**
 * Persists the originals behind the current selection, newest selection wins.
 *
 * Called again whenever steering changes what is selected, so the photos the
 * user can actually see are the photos they can actually save.
 */
let originalsQueue: Promise<unknown> = Promise.resolve();

/**
 * Serialised, because this both deletes and writes.
 *
 * Steering fires it on every change, and overlapping calls raced: one call's
 * cleanup of "everything not currently selected" removed keys another call had
 * just written, leaving a single original behind and most of the selection
 * unsaveable after a reload. Chaining makes the last caller win, which is the
 * one holding the current selection.
 */
export function storeSelectedOriginals(
  sessionId: string,
  files: Map<string, File>,
  selectedIds: string[],
): Promise<void> {
  const next = originalsQueue.then(() =>
    writeSelectedOriginals(sessionId, files, selectedIds),
  );
  originalsQueue = next.catch(() => undefined);
  return next;
}

async function writeSelectedOriginals(
  sessionId: string,
  files: Map<string, File>,
  selectedIds: string[],
): Promise<void> {
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(ORIGINALS_STORE, "readwrite");
      const store = tx.objectStore(ORIGINALS_STORE);

      // Write first, prune second. The reverse order looked tidier but is not
      // crash-safe: a reload landing between the delete and the put — which is
      // exactly what iOS does when it reclaims a tab — leaves storage holding
      // fewer originals than before, and photos that can be seen but not
      // saved. This way an interruption leaves extras, which the next run
      // clears, rather than gaps.
      const wanted = new Set<string>();
      let budget = ORIGINALS_BUDGET_BYTES;
      for (const id of selectedIds) {
        const file = files.get(id);
        if (!file || file.size > budget) continue;
        budget -= file.size;
        const key = originalKey(sessionId, id);
        wanted.add(key);
        store.put(file, key);
      }

      const existing = await promisify<IDBValidKey[]>(store.getAllKeys());
      for (const key of existing) {
        if (!wanted.has(String(key))) store.delete(key);
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
    // Saving originals is best effort; previews still render either way.
  }
}

/** Originals persisted for this session, by photo id. */
export async function loadStoredOriginals(sessionId: string): Promise<Map<string, File>> {
  const found = new Map<string, File>();
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(ORIGINALS_STORE, "readonly");
      const store = tx.objectStore(ORIGINALS_STORE);
      const keys = await promisify<IDBValidKey[]>(store.getAllKeys());
      const prefix = `${sessionId}:`;

      for (const key of keys) {
        const name = String(key);
        if (!name.startsWith(prefix)) continue;
        const file = await promisify<File | undefined>(store.get(key));
        if (file) found.set(name.slice(prefix.length), file);
      }
    } finally {
      db.close();
    }
  } catch {
    // Fall back to previews.
  }
  return found;
}

/** Storage can be unavailable — private browsing, or a locked-down WebView. */
export function isStorageAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}
