// Thin fetch wrapper. In dev, Vite proxies these paths to the Express
// backend (main.js) on http://localhost:3000 — see vite.config.js.
// In production, serve the built frontend behind the same host as the
// backend (or set VITE_API_BASE) so these relative paths still resolve.
const BASE = import.meta.env.VITE_API_BASE || '';
const TOKEN_KEY = 'pos.token';

// Token storage lives here (not AuthContext) so api.js has no import cycle
// with the context and can attach the header to every request itself.
export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY) || '',
  set: (token) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

async function request(path, options = {}) {
  const token = tokenStore.get();
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });

  if (res.status === 401) {
    // Token missing/expired/invalid — clear it and let any listener (the
    // AuthContext) know so the app can drop back to the login screen.
    tokenStore.clear();
    window.dispatchEvent(new CustomEvent('auth:unauthorized'));
  }

  const contentType = res.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await res.json() : await res.text();

  if (!res.ok && typeof body === 'object' && body?.message) {
    throw new Error(body.message);
  }
  return body;
}

export const api = {
  // Auth
  login: (username, password) => request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  // Stage 12: silent re-auth — call while a session is still valid to get
  // a fresh token before the current one expires. See AuthContext.jsx for
  // the interval that drives this.
  refresh: () => request('/auth/refresh', { method: 'POST' }),

  // Products
  getProducts: (params = {}) => request(`/api/products?${new URLSearchParams(params)}`),
  // Stage 15 — admin-only, unpaginated: every product at-or-below its
  // lowStockThreshold, for the header notification bell.
  getLowStockProducts: () => request('/api/products/low-stock'),
  saveProduct: (payload) => request('/api/product', { method: 'POST', body: JSON.stringify(payload) }),
  undoProduct: (payload) => request('/product/undo', { method: 'POST', body: JSON.stringify(payload) }),
  deleteProduct: (productId) => request(`/product/${encodeURIComponent(productId)}`, { method: 'DELETE' }),
  reserveStock: (productId, quantity) => request('/billing/reserve', { method: 'POST', body: JSON.stringify({ productId, quantity }) }),
  releaseStock: (productId, quantity) => request('/billing/release', { method: 'POST', body: JSON.stringify({ productId, quantity }) }),

  // Customers
  getCustomers: (params = {}) => request(`/api/customers?${new URLSearchParams(params)}`),
  addCustomer: (payload) => request('/billing/addCustomer', { method: 'POST', body: JSON.stringify(payload) }),
  updateCustomer: (payload) => request('/customer/updateCustomer', { method: 'POST', body: JSON.stringify(payload) }),
  deleteCustomer: (customerName) => request('/customer/deleteCustomer', { method: 'POST', body: JSON.stringify({ customerName }) }),
  undoCustomer: (payload) => request('/customer/undoCustomer', { method: 'POST', body: JSON.stringify(payload) }),

  // Billing / orders
  getUniqueOrderId: (billId) => request('/billing/orderid', { method: 'POST', body: JSON.stringify({ billId }) }),
  // NOTE: no payload — the server commits from the cashier's persisted
  // draft (POST /billing/draft), not from anything sent here. See
  // CLAUDE.md Stage 4.
  saveOrder: () => request('/billing/orderDetails', { method: 'POST' }),
  getDraft: () => request('/billing/draft'),
  saveDraft: (payload) => request('/billing/draft', { method: 'POST', body: JSON.stringify(payload) }),
  discardDraft: () => request('/billing/draft', { method: 'DELETE' }),

  // Offline sync (Stage 11) — optional module, see lib/offlineQueue.js /
  // lib/offlineSync.js for the client-side queue this talks to.
  syncOfflineSale: (payload) => request('/api/sync/commit', { method: 'POST', body: JSON.stringify(payload) }),
  getSyncConflicts: () => request('/api/sync/conflicts'),
  resolveSyncConflict: (id, action, reason) =>
    request(`/api/sync/conflicts/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ action, reason }),
    }),

  // Dashboard
  getDashboard: (range = 'month') => request(`/dashboard/load?range=${encodeURIComponent(range)}`),

  // Exports (Stage 10) — these return CSV, not JSON, so they bypass the
  // shared `request()` helper (which assumes JSON/text-parsed bodies) and
  // are triggered as a real browser download instead.
  downloadExport: async (type, range) => {
    const params = range ? `?range=${encodeURIComponent(range)}` : '';
    const token = tokenStore.get();
    const res = await fetch(`${BASE}/api/export/${type}${params}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (res.status === 401) {
      tokenStore.clear();
      window.dispatchEvent(new CustomEvent('auth:unauthorized'));
    }
    if (!res.ok) {
      const contentType = res.headers.get('content-type') || '';
      const body = contentType.includes('application/json') ? await res.json() : await res.text();
      throw new Error(body?.message || 'Export failed.');
    }
    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : `${type}.csv`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  // Suppliers (Stage 5)
  getSuppliers: (params = {}) => request(`/api/suppliers?${new URLSearchParams(params)}`),
  saveSupplier: (payload) => request('/api/supplier', { method: 'POST', body: JSON.stringify(payload) }),
  deleteSupplier: (supplierName) => request(`/supplier/${encodeURIComponent(supplierName)}`, { method: 'DELETE' }),
  recordPurchase: (payload) => request('/supplier/purchase', { method: 'POST', body: JSON.stringify(payload) }),

  // Audit Log (Stage 14, admin-only — backend also enforces this via requireAdmin)
  getAuditLog: (params = {}) => request(`/api/audit-log?${new URLSearchParams(params)}`),

  // Orders, admin edit & refund (Stage 7)
  getOrders: (params = {}) => request(`/api/orders?${new URLSearchParams(params)}`),
  getOrder: (orderID) => request(`/api/orders/${encodeURIComponent(orderID)}`),
 editOrderItem: (orderID, payload) =>
  request(`/api/order/${encodeURIComponent(orderID)}/edit`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }), refundOrder: (orderID, payload) =>
    request(`/api/order/${encodeURIComponent(orderID)}/refund`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};