// Stage 11 — watches connectivity and drains offlineQueue.js whenever the
// server is reachable. Mounted once, app-wide (see App.jsx), so a sale
// queued on the Billing page still syncs even if the cashier has since
// navigated elsewhere — the point of a background flush, not a
// page-local one.
import { api } from './api';
import { listQueue, updateSale, isOfflineSyncEnabled } from './offlineQueue';

const FLUSH_INTERVAL_MS = 15000;

// A failed fetch (offline, DNS, server down) throws a TypeError from the
// browser's fetch implementation with no HTTP status attached — that's
// how we tell "couldn't reach the server, try again later" apart from
// "reached the server, it said no" (400/401/409), which resolves the
// queue entry one way or the other instead of retrying forever.
function isNetworkError(err) {
  return err instanceof TypeError || err?.message === 'Failed to fetch';
}
export { isNetworkError };

async function flushOne(sale) {
  try {
    const result = await api.syncOfflineSale(sale);
    // A 200 here only ever means the server actually synced it (or it
    // was already synced by an earlier attempt) — see routes/sync.js.
    if (result.status === 'synced') {
      await updateSale(sale.idempotencyKey, { status: 'synced', resultingOrderID: result.orderID, lastError: null });
    } else {
      await updateSale(sale.idempotencyKey, { status: 'conflict', lastError: result.message || 'Sync conflict.' });
    }
  } catch (err) {
    // request() (lib/api.js) throws on any non-2xx response, so a 409
    // conflict/already-flagged reply from the server lands here, not in
    // the try block above.
    if (isNetworkError(err)) {
      // Still offline (or the server's unreachable) — leave it pending,
      // the next tick or the next 'online' event will retry.
      return;
    }
    // A genuine server-side rejection reached us (bad request shape,
    // auth issue, stock/price conflict, etc.) — record it as a conflict
    // rather than retrying an attempt that won't succeed unattended.
    await updateSale(sale.idempotencyKey, { status: 'conflict', lastError: err.message || 'Sync failed.' });
  }
}

export async function flushQueue() {
  if (!isOfflineSyncEnabled()) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  const queue = await listQueue();
  const pending = queue.filter((s) => s.status === 'pending');
  // Sequential, not Promise.all — sales replay in the order they were
  // made offline, and it keeps this gentle on the server instead of
  // firing a burst of concurrent commits after a long offline stretch.
  for (const sale of pending) {
    // eslint-disable-next-line no-await-in-loop
    await flushOne(sale);
  }
}

let started = false;

// Call once, near the app root. Safe to call multiple times — only the
// first call actually starts the interval/listeners.
export function startOfflineSyncWatcher() {
  if (started || !isOfflineSyncEnabled()) return;
  started = true;

  flushQueue();
  const interval = setInterval(flushQueue, FLUSH_INTERVAL_MS);
  window.addEventListener('online', flushQueue);

  return () => {
    clearInterval(interval);
    window.removeEventListener('online', flushQueue);
    started = false;
  };
}
