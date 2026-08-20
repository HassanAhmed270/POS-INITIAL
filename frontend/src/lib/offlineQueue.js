// Stage 11 — the client-side half of the offline sync module. A thin,
// dependency-free wrapper around the browser's own IndexedDB (no library
// pulled in, same "modular means no extra baggage" spirit as Stage 10's
// CSV writer) — this is what makes a queued sale durable across a tab
// close, browser crash, or device restart, which is the whole point of
// "offline" meaning "no data loss" rather than just "works while
// disconnected".
//
// Each queue entry mirrors what POST /api/sync/commit expects (see
// routes/sync.js) plus local-only bookkeeping (`status`, `queuedAt`,
// `lastError`). Nothing in here talks to the network — see
// offlineSync.js for the connectivity watcher and flush loop that reads
// from this queue.

const DB_NAME = 'pos-offline-queue';
const DB_VERSION = 1;
const STORE = 'sales';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'idempotencyKey' });
        store.createIndex('status', 'status', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    Promise.resolve(fn(store))
      .then((r) => {
        result = r;
      })
      .catch(reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Queue one offline sale. `sale` should already have every field
// POST /api/sync/commit needs (idempotencyKey, customerName, items,
// paidInput, paymentMethod, clientBillID, createdOfflineAt) — this just
// adds local bookkeeping and persists it.
export async function enqueueSale(sale) {
  const record = {
    ...sale,
    status: 'pending', // pending | synced | conflict
    queuedAt: new Date().toISOString(),
    lastError: null,
    resultingOrderID: null,
  };
  await withStore('readwrite', (store) => requestToPromise(store.add(record)));
  return record;
}

export async function listQueue() {
  return withStore('readonly', (store) => requestToPromise(store.getAll()));
}

export async function updateSale(idempotencyKey, patch) {
  return withStore('readwrite', async (store) => {
    const existing = await requestToPromise(store.get(idempotencyKey));
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    await requestToPromise(store.put(updated));
    return updated;
  });
}

// Only ever called on sales already marked 'synced' — a queue entry is
// evidence of an offline sale and stays around (as history) even after
// a successful sync, until explicitly cleared. Never deletes 'pending' or
// 'conflict' entries, so a sale can't silently disappear before it's
// actually accounted for server-side.
export async function clearSynced() {
  return withStore('readwrite', async (store) => {
    const all = await requestToPromise(store.getAll());
    await Promise.all(
      all.filter((s) => s.status === 'synced').map((s) => requestToPromise(store.delete(s.idempotencyKey)))
    );
  });
}

export function isOfflineSyncEnabled() {
  return import.meta.env.VITE_ENABLE_OFFLINE_SYNC === 'true';
}
