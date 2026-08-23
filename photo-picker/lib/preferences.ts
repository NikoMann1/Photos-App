/**
 * What the user has taught the app, carried across batches.
 *
 * The batch-size cap means a trip is several uploads, and steering used to
 * start from nothing every time — the app forgot that you kept engine rooms
 * and dropped bathrooms the moment you uploaded the next batch.
 *
 * Two deliberate choices shape this:
 *
 * - **Exemplars, not an average.** Liking engine rooms *and* harbour views
 *   averages to a direction that means neither. Affinity is the best match
 *   against any remembered photo instead, so unrelated tastes coexist.
 * - **A remembered dislike demotes; it never excludes.** Dropping one photo of
 *   a bathroom must not permanently hide the one with the plaque on the wall.
 *   Only an explicit ✕ in the current batch removes a photo outright.
 */

import { openDatabase, toPromise, PREFERENCES_STORE } from "./browser-session";
import { embeddingSimilarity } from "./analysis/embedding";

const KEY = "default";

/** Per batch, so a change of mind replaces that batch rather than piling up. */
const MAX_BATCHES = 10;
const MAX_PER_BATCH = 20;

export type BatchPreference = {
  sessionId: string;
  updatedAt: number;
  liked: Float32Array[];
  rejected: Float32Array[];
};

export type Preferences = { batches: BatchPreference[] };

export const NO_PREFERENCES: Preferences = { batches: [] };

export function countRemembered(preferences: Preferences): {
  liked: number;
  rejected: number;
  batches: number;
} {
  return {
    liked: preferences.batches.reduce((n, b) => n + b.liked.length, 0),
    rejected: preferences.batches.reduce((n, b) => n + b.rejected.length, 0),
    batches: preferences.batches.length,
  };
}

export async function loadPreferences(): Promise<Preferences> {
  try {
    const db = await openDatabase();
    try {
      const tx = db.transaction(PREFERENCES_STORE, "readonly");
      const stored = await toPromise<Preferences | undefined>(
        tx.objectStore(PREFERENCES_STORE).get(KEY),
      );
      return stored ?? NO_PREFERENCES;
    } finally {
      db.close();
    }
  } catch {
    return NO_PREFERENCES;
  }
}

async function writePreferences(preferences: Preferences): Promise<void> {
  const db = await openDatabase();
  try {
    const tx = db.transaction(PREFERENCES_STORE, "readwrite");
    await toPromise(tx.objectStore(PREFERENCES_STORE).put(preferences, KEY));
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } finally {
    db.close();
  }
}

/**
 * Records this batch's choices, replacing any earlier record for it — undoing
 * a tap must undo what was learned from it, not leave it behind.
 */
export async function rememberBatch(
  sessionId: string,
  liked: Float32Array[],
  rejected: Float32Array[],
): Promise<Preferences> {
  const current = await loadPreferences();
  const others = current.batches.filter((batch) => batch.sessionId !== sessionId);

  const batches =
    liked.length === 0 && rejected.length === 0
      ? others
      : [
          ...others,
          {
            sessionId,
            updatedAt: Date.now(),
            liked: liked.slice(0, MAX_PER_BATCH),
            rejected: rejected.slice(0, MAX_PER_BATCH),
          },
        ];

  const next: Preferences = {
    batches: batches.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_BATCHES),
  };

  try {
    await writePreferences(next);
  } catch {
    // Preferences are a convenience; never fail the review screen over them.
  }
  return next;
}

export async function forgetPreferences(): Promise<Preferences> {
  try {
    await writePreferences(NO_PREFERENCES);
  } catch {
    // Ignore: the caller resets its own state regardless.
  }
  return NO_PREFERENCES;
}

/** Every remembered photo of one kind, newest batch first. */
export function exemplars(
  preferences: Preferences,
  kind: "liked" | "rejected",
): Float32Array[] {
  return preferences.batches.flatMap((batch) => batch[kind]);
}

/**
 * Closeness to the nearest remembered photo, 0..1. Max rather than mean, so a
 * photo matching any one remembered taste scores high even when the others are
 * unrelated to it.
 */
export function affinityTo(
  embedding: Float32Array | null | undefined,
  references: Float32Array[],
): number {
  if (!embedding || references.length === 0) return 0;

  let best = 0;
  for (const reference of references) {
    if (reference.length !== embedding.length) continue;
    best = Math.max(best, embeddingSimilarity(embedding, reference));
  }
  // Remap: 0.19 is what unrelated photos score with this model, 1.0 identical.
  return Math.max(0, Math.min(1, (best - 0.19) / 0.81));
}
