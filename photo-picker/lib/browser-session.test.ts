import test from "node:test";
import assert from "node:assert/strict";

/**
 * A deliberately strict, minimal IndexedDB.
 *
 * Real IndexedDB deactivates a transaction as soon as control returns to the
 * event loop with no request outstanding, so a request issued after an `await`
 * throws TransactionInactiveError. Chromium is lenient about this; Safari is
 * not — which produced a bug that passed every browser test here and broke
 * saving on the device three times, because the throw was caught and an empty
 * result returned.
 *
 * This shim enforces the strict rule, so that mistake fails in `npm test`
 * rather than on a phone.
 */
type Store = Map<string, unknown>;

class StrictRequest<T> {
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  result!: T;
  error: Error | null = null;
}

class StrictTransaction {
  active = true;
  pending = 0;
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor(private readonly stores: Map<string, Store>) {
    // Deactivate once the current task drains, exactly as the spec requires.
    queueMicrotask(() => {
      if (this.pending === 0) this.finish();
    });
  }

  private finish(): void {
    if (!this.active) return;
    this.active = false;
    this.oncomplete?.();
  }

  private run<T>(work: () => T): StrictRequest<T> {
    if (!this.active) {
      throw new DOMException("Transaction is not active", "TransactionInactiveError");
    }
    const request = new StrictRequest<T>();
    this.pending++;
    queueMicrotask(() => {
      request.result = work();
      this.pending--;
      request.onsuccess?.();
      // Deactivate as soon as the success callback returns. Resolving the
      // promise above only *queues* the awaiting continuation, so anything
      // that continuation issues arrives after this point — which is exactly
      // when Safari refuses it.
      if (this.pending === 0) this.finish();
    });
    return request;
  }

  objectStore(name: string) {
    const store = this.stores.get(name)!;
    return {
      get: (key: IDBValidKey) => this.run(() => store.get(String(key))),
      getAll: () => this.run(() => [...store.values()]),
      getAllKeys: () => this.run(() => [...store.keys()]),
      put: (value: unknown, key?: IDBValidKey) =>
        this.run(() => {
          store.set(String(key ?? (value as { sessionId: string }).sessionId), value);
          return undefined;
        }),
      delete: (key: IDBValidKey) => this.run(() => { store.delete(String(key)); return undefined; }),
    };
  }
}

function strictDatabase(storeNames: string[]) {
  const stores = new Map<string, Store>(storeNames.map((name) => [name, new Map()]));
  return {
    stores,
    objectStoreNames: { contains: (n: string) => stores.has(n) },
    createObjectStore: (n: string) => stores.set(n, new Map()),
    transaction: () => new StrictTransaction(stores),
    close: () => undefined,
  };
}

/** The shape the storage code uses: issue, then await. */
function promisify<T>(request: StrictRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("failed"));
  });
}

test("reading many records must issue every request before awaiting", async () => {
  const db = strictDatabase(["originals"]);
  db.stores.get("originals")!.set("s1:a", "A");
  db.stores.get("originals")!.set("s1:b", "B");

  // The pattern that broke on Safari: await, then issue another request.
  const awaitThenIssue = async () => {
    const tx = db.transaction();
    const store = tx.objectStore("originals");
    const keys = await promisify(store.getAllKeys());
    return keys.map((k) => store.get(k)); // throws once the transaction closed
  };
  await assert.rejects(awaitThenIssue, /TransactionInactiveError/);

  // The pattern the storage code uses now: issue both, then await both.
  const issueThenAwait = async () => {
    const tx = db.transaction();
    const store = tx.objectStore("originals");
    const keysRequest = store.getAllKeys();
    const valuesRequest = store.getAll();
    const [keys, values] = await Promise.all([
      promisify(keysRequest),
      promisify(valuesRequest),
    ]);
    return keys.map((k, i) => [k, values[i]]);
  };
  assert.deepEqual(await issueThenAwait(), [["s1:a", "A"], ["s1:b", "B"]]);
});

test("a write transaction must not read its key list mid-flight", async () => {
  const db = strictDatabase(["originals"]);
  db.stores.get("originals")!.set("old:1", "stale");

  const writeThenAwaitThenPrune = async () => {
    const tx = db.transaction();
    const store = tx.objectStore("originals");
    store.put("new", "s2:1");
    const existing = await promisify(store.getAllKeys());
    for (const key of existing) if (key !== "s2:1") store.delete(key); // throws
  };
  await assert.rejects(writeThenAwaitThenPrune, /TransactionInactiveError/);

  // Reading the key list in its own transaction first is what the code does.
  const readFirst = async () => {
    const existing = await promisify(db.transaction().objectStore("originals").getAllKeys());
    const tx = db.transaction();
    const store = tx.objectStore("originals");
    store.put("new", "s2:1");
    for (const key of existing) if (key !== "s2:1") store.delete(key);
    await new Promise<void>((resolve) => { tx.oncomplete = () => resolve(); });
  };
  await readFirst();
  assert.deepEqual([...db.stores.get("originals")!.keys()], ["s2:1"]);
});
