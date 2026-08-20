# Billing System Rebuild — Progress Log

Companion to `CLAUDE.md` (which has full narrative detail per stage).
This file is the fast-reference version: what exists, where, and what's
still open — read this first, go to `CLAUDE.md`'s matching section only
when you need the "why."

Repo root: `POS-INITIAL/`. Backend: Express + Mongoose at root (`main.js`).
Frontend: React + Vite + Tailwind in `frontend/`. Legacy EJS views
(`views/`, `public/css`) kept as broken reference only — not maintained
since Stage 1, actively broken (auth + missing fields) since Stage 5.

## Stage 1 — Frontend migration kickoff
- Scaffolded `frontend/` (Vite + React + Tailwind package, no CDN).
- Ported all screens to React: Login, Dashboard, Billing, Products, Customers.
- Added `GET /api/products`, `GET /api/customers`, `POST /api/product` (JSON versions of EJS-era routes).
- No auth yet at this point — that's Stage "1" in the *spec* numbering below (confusing overlap: this migration stage predates the spec's numbered stages).

## Spec Stage 1 — Auth & Error Handling
- `models/User.js` (username/passwordHash/role: admin|cashier).
- `POST /auth/login` (`routes/auth.js`) issues JWT via `middleware/auth.js` (`signToken`, `requireAuth`, `requireAdmin`).
- `requireAuth` on every mutating route. `requireAdmin` defined, unused until Stage 5/7.
- `middleware/rateLimit.js` — login attempts limited.
- `middleware/errorHandler.js` — `asyncHandler` + centralized handler, generic client messages, full detail logged via `lib/logger.js` (pino).
- `scripts/createUser.js` — only way to provision accounts (no public signup).
- Frontend: `frontend/src/lib/api.js` (`tokenStore`, auto-attaches Bearer token, 401 → logout event), `AuthContext.jsx` (real login, exposes `username`/`role`/`isAdmin`).
- `.env` required (`JWT_SECRET` etc.) — `main.js` throws at boot without it.

## Spec Stage 2 — Data Integrity: Validation & Pricing
- `lib/validators.js` (email/phone/productId/orderId/discount, independent of Mongoose).
- `lib/money.js` — `roundMoney()`, always `parseFloat`, never `parseInt`, for all currency math (mirrored in `frontend/src/lib/money.js` as `roundMoney`/`formatMoney`).
- `lib/pricing.js` — `getLatestPrice()` (later split, see Stage 5) replacing `unitPrice[0]` reads.
- `POST /billing/orderDetails` re-verifies price server-side, rejects (409) on mismatch >1¢, recomputes `totalAmount` itself.
- `Order` schema: discount capped `max: 100`.

## Spec Stage 3 — Inventory Correctness: Reservation & Atomic Stock
- `Product.reserved` + `Product.lowStockThreshold` (default 10) fields.
- `POST /billing/reserve` / `POST /billing/release` — atomic `$expr`-guarded `$inc`, fixes oversell race (no check-then-write).
- `POST /billing/orderDetails` now a MongoDB **transaction** (`session.withTransaction`) — price verify + atomic stock commit + order insert + customer push, all-or-nothing.
- `POST /billing/update` demoted to admin-only manual stock correction (`requireAdmin` — first real use).
- Low-stock highlighting in Products/Billing tables.
- **Requires MongoDB replica set** (transactions don't work on standalone `mongod`) — `main.js` warns at boot if missing (`mongod --replSet rs0` + `rs.initiate()` once).
- Frontend: `Billing.jsx` cart calls real reserve/release API; `beforeunload`/unmount best-effort cleanup.
- Known gap (closed in Stage 4): no server-side expiry on an abandoned reservation.

## Spec Stage 4 — Draft Bills: Persistence Before Commit
- `models/PendingBill.js` — one doc per cashier (upserted by `cashier`), `status: active/committed/abandoned`, `items[]`, `billID`, `customerName`.
- `GET/POST/DELETE /billing/draft` — read / autosave (upsert) / discard (releases all held stock in one call).
- `POST /billing/orderDetails` now commits from the **persisted draft**, not the request body — closes the same tampering class Stage 2 fixed for price, applied to the whole order shape.
- Background sweep (`setInterval`, `DRAFT_IDLE_TIMEOUT_MS`/`DRAFT_SWEEP_INTERVAL_MS` env vars, defaults 15min/60s) releases stock for idle drafts — **this is what closes Stage 3's gap**.
- Frontend: 7s-debounced autosave (`saveDraftNow`), resume-or-discard `confirm()` prompt on page load, immediate (non-debounced) saves at two critical points (Preview, Cancel).
- Known gap: ~7s window where a crash could lose an item from the *persisted* draft before autosave fires (stock reservation itself is still safe). One draft per cashier, not per device.

## Spec Stage 5 — Customer & Supplier Credit
- `Product.unitPrice` **renamed/split** → `sellingPriceHistory` (customer-facing) + `buyingPriceHistory` (with `supplierID`, populated only via supplier purchases). `lib/pricing.js` → `getLatestSellingPrice()` / `getLatestBuyingPrice()`.
- `Order` gained `amountPaid`, `balanceDue`, `paymentStatus` (`paid/partial/unpaid`), `payments[]`. Computed server-side from **`PendingBill.paidInput`** (new draft field, same tamper-resistant path) — bills no longer require full payment; underpayment → customer credit with a `confirm()` instead of a hard block.
- `Customer.orders[]` enriched (`totalAmount`/`amountPaid`/`balanceDue`); `totalBalanceDue` computed explicitly in `GET /api/customers` (Mongoose virtuals don't auto-serialize) and shown as a red-highlighted column in `Customers.jsx`.
- New `models/Supplier.js` (+ embedded `purchases[]`, `purchaseID` format `PUR-\d{4}`). Routes: `GET/POST /api/supplier(s)`, `DELETE /supplier/:name` (no undo, deliberate), `POST /supplier/purchase` (transactional — restocks + logs buying price + records what's owed).
- New `frontend/src/pages/Suppliers.jsx`; sidebar "Suppliers" link enabled (was a disabled placeholder since Stage 1).
- **Legacy EJS views now render broken prices** (`unitPrice` no longer exists) — unfixed, consistent with reference-only status.
- Known gap: no "pay off existing balance later" flow — `payments[]`/purchase `amountPaid` only ever get the one entry from commit time.

## Spec Stage 6 — Discounts UI
- Small, targeted. `discountType` (`none/preset/manual`) added to `Order.products[]` and `PendingBill.items[]`. `discountAmount` ($ saved, computed server-side from current price at commit) added to `Order.products[]` only.
- `Billing.jsx`: plain "Discount %" input replaced with a "+ Add Discount" toggle revealing 10%/15%/20% preset buttons + manual field. `discountType` flows through the existing draft-autosave/resume machinery — no new plumbing needed.
- No new files, no new routes.
- Known gap: `discountAmount` computed and stored correctly but not yet displayed anywhere (receipt/cart preview).

## Spec Stage 7 — Admin Bill Editing (Exchange) & Refunds
- New `models/Refund.js` — separate from `Order.editHistory`; one doc per refund action (can cover multiple line items).
- `Order` gained `status` (`active/refunded`) and `editHistory[]` (`editedBy/editedAt/productID/originalQty/newQty/reason/action`) — `action` is `edit` or `refund`, both append to the same timeline.
- Shared `main.js` helpers: `applyLineReduction()` (reduce/remove one line, restore stock atomically via `$inc`, log an audit entry — uses the price the line was **actually sold at**, not today's price) and `recomputeOrderTotals()` (re-derive `totalAmount`/`balanceDue`/`paymentStatus`, same formula as Stage 5 commit-time).
- `POST /order/:orderID/edit` — `requireAdmin`, **72-hour window from `orderDate`** (hardcoded `ORDER_EDIT_WINDOW_MS`, not env-configurable), rejects if already refunded, mandatory `reason`.
- `POST /order/:orderID/refund` — `requireAdmin`, **no time window**, multi-item, always sets `order.status = 'refunded'` (no partial-refund status), writes a `Refund` doc.
- Both sync `Customer.orders[]`'s matching subdocument after mutating.
- New `GET /api/orders` (list) / `GET /api/orders/:orderID` (detail + refunds) — `requireAuth` only, viewing isn't admin-gated.
- New `frontend/src/pages/Orders.jsx` — first orders-browsing page in the app. List + detail panel, admin-only edit/refund forms (`isAdmin` from `useAuth()`), "Print (Revised)" button showing edit history + refunds inline when present. Sidebar "Orders" link added.
- New `frontend/src/lib/print.js` — `printReceipt()` extracted from `Billing.jsx` (was a local function) so `Orders.jsx` can reuse it. `Billing.jsx` now imports it.
- Known gap: refund doesn't distinguish cash-back vs. store-credit — `Order.amountPaid` is never adjusted by a refund, only `balanceDue` (which just clamps at 0 if overpaid relative to the new smaller total). No "we owe the customer cash back" figure surfaces anywhere.
- Known gap: `GET /dashboard/load`'s monthly sales aggregation wasn't revisited — a refunded order's original `totalAmount` still counts toward that month's `overallSales` as if untouched. **(Fixed in Stage 9.)**

## Spec Stage 8 — Orders & Suppliers Screens (search, sort, pagination)
- New `lib/query.js` — `escapeRegex`/`parsePagination`/`sortAndPaginate`. DB does the search filter (regex, case-insensitive, escaped); computed fields (price, available, totalBalanceDue, avgPayment) are sorted/paginated **in memory** after mapping — real pagination from the client's view (page/limit/total), just not DB-level skip/limit for those fields. Fine at this scale; flagged if collections grow large.
- All four list routes (`GET /api/products`, `/customers`, `/orders`, `/suppliers`) accept `?search=&sortBy=&sortDir=&page=&limit=`. `orders` gained `avgPayment` (mean of `payments[].amount`) and `displayStatus` (`refunded` wins over `paymentStatus`).
- New frontend shared pieces: `lib/useDebouncedValue.js` (300ms), `components/SortableHeader.jsx`, `components/Pagination.jsx` — used by all four list pages.
- `Orders.jsx`/`Suppliers.jsx` restructured: Stage 7's split list+side-panel → row-click expands in place (inline `<tr>`, detail lazy-fetched on expand via `GET /api/orders/:orderID`, not baked into the list payload).
- **Real bug caught and fixed**: pagination would have silently capped `Billing.jsx`'s cart product search and `Suppliers.jsx`'s purchase-form dropdowns to whichever page happened to be loaded. Both now explicitly request `{ limit: 1000 }` instead of relying on the (now-paginated) default; `Suppliers.jsx` keeps two separate states — `suppliers` (paginated, table) vs. `allSuppliers`/`allProducts` (full list, dropdowns only).
- Known gap: `sortBy` isn't validated against an allow-list (a bogus field just sorts as-if-equal, doesn't error). Search has no fielded syntax. No URL state — refreshing a list page resets search/sort/page to defaults.

## Spec Stage 9 — Dashboard Reporting
- `GET /dashboard/load` takes `?range=week|month|year` (default `month`) instead of a hardcoded start-of-month. `week` = back to Sunday, `year` = Jan 1.
- **Key insight, drives the whole design**: `totalSales` (`$sum: totalAmount`) needs no separate refund subtraction — `Order.totalAmount` is already kept net by Stage 7's `recomputeOrderTotals()` (both edits and refunds recompute it from what's left on the order). Summing it is automatically net of both.
- New metrics: `totalOrders` (count, any status, in range), `refundedOrders` (count where `status:'refunded'`, in range), `refundedAmount` (sum of `Refund.refundAmount` where `refundDate` in range — informational only, NOT subtracted again from `totalSales`), `exchangedOrders` (count with an `editHistory` entry where `action:'edit'`, distinct from refund entries), `totalCustomerCreditOutstanding`/`totalSupplierPayable` (both **as-of-now snapshots**, not date-scoped — sum of `balanceDue` across all customers/suppliers).
- `Dashboard.jsx`: week/month/year toggle, new stat cards (refunded/exchanged/credit/payable), switched from ad hoc `.toFixed(2)` to the shared `formatMoney()` helper.
- Known inconsistency (documented, not fixed): `refundedOrders`/`exchangedOrders` counts are scoped by the *order's* `orderDate`, while `refundedAmount` is scoped by the *refund's* `refundDate` — an order placed last month but refunded this week counts toward last month's order-count but this week's refund-amount.
- Known gap: route still unauthenticated, now exposes more sensitive aggregates (total payables, credit outstanding) than before — widens a pre-existing gap.

## Spec Stage 10 — CSV/Excel Export (Modular)

[#spec-stage-10--csvexcel-export-modular](#spec-stage-10--csvexcel-export-modular)

- New `lib/reports.js` — Stage 9's `/dashboard/load` aggregation moved here unchanged (`getDashboardSummary()`), plus new row-level query functions for the export: `getSalesRows()`/`getRefundRows()` (date-scoped like the dashboard), `getCustomerCreditRows()`/`getSupplierPayableRows()` (as-of-now snapshots, same convention as the dashboard's credit/payable figures). `main.js`'s `/dashboard/load` is now a thin wrapper calling `getDashboardSummary()` — same output, same numbers, just relocated so export can reuse it.
- New `lib/csv.js` — dependency-free RFC 4180 CSV writer (`toCSV(rows, columns)`), so the export module adds zero new npm packages.
- New `routes/export.js` — `GET /api/export/{summary,sales,refunds,credit,payables}`, all `requireAuth` (matches Orders/Suppliers' access level, not `requireAdmin` — these are the same underlying numbers those screens already show, just reshaped for download). `summary`/`sales`/`refunds` accept `?range=week|month|year`; `credit`/`payables` are snapshots with no range param.
- Mounted behind `ENABLE_EXPORTS` (`.env`, defaults to enabled): `if (process.env.ENABLE_EXPORTS !== 'false') app.use('/api/export', exportRoutes)`. Setting it to `false` unmounts the route entirely (404, not just blocked) — verified by boot-testing both states.
- Frontend: new `frontend/src/pages/Reports.jsx` (sidebar "Reports" link enabled, was a disabled placeholder since Stage 1) — range toggle + one card per export type, each triggering a real file download. `api.downloadExport()` added to `lib/api.js`, bypassing the JSON-only `request()` helper since these responses are CSV blobs, not JSON.
- **Bugs fixed in passing, not part of the Stage 10 spec itself**: `main.js` required `./models/Refund` (file is `Refunds.js`) and `routes/auth.js`/`scripts/createUser.js` required `../models/User` (file is `user.js`) — both `require()` calls were case-mismatched against the actual filenames and would fail at boot on any case-sensitive filesystem (Linux, and most CI). Fixed all three references; verified the module resolves under Node afterward.
- Verified: frontend builds clean via `vite build`; backend boots clean with the flag on and off; `/api/export/*` returns 401 with no/bad token and 404 when the flag is off; CSV escaping tested directly against commas/quotes/embedded newlines. Not verified against a live MongoDB — no `mongod` available in the sandbox this was built in, so the aggregation queries themselves (identical to Stage 9's, which are already live in production) weren't re-run against real data.
- Known gap: no `.xlsx` (binary Excel) writer — "Excel export" here means CSV, which Excel opens natively; a true `.xlsx` would need a new dependency (e.g. `exceljs`), which was deliberately avoided to keep the module dependency-free per its own exit criteria.

## Spec Stage 11 — Offline Sync Module (Modular, Optional)

[#spec-stage-11--offline-sync-module-modular-optional](#spec-stage-11--offline-sync-module-modular-optional)

Depends on Stage 3/4 (reservation + drafts) and follows Stage 10's module pattern (own files, own feature flag, mounted with one line). Off by default (`ENABLE_OFFLINE_SYNC=false`), unlike Stage 10's exports which default on — this stage's own spec calls it "optional."

**Design decision, stated up front:** this does *not* refactor `/billing/orderDetails`'s commit transaction to share code with the offline path, unlike Stage 10 sharing `lib/reports.js`. Two things are structurally different for an offline sale: (1) there's no server-held `PendingBill` to source items from, since a draft only exists because the client could reach the server to autosave it; (2) stock was never reserved for the cart, since reservation is itself a live API call. Sharing one function for both would mean branching on those differences throughout — instead, `lib/offlineSync.js` (server) is a self-contained mirror of the same transaction pattern. This keeps the exit criteria literal: the whole module (5 files + 2 mount lines total) can be deleted without touching the live billing flow at all.

**Backend:**
- `models/OfflineSale.js` — one document per offline sale a client queued and replayed: `idempotencyKey` (client-generated, unique — makes retries safe), captured `items`/`customerName`/`paidInput`/`createdOfflineAt`, `status` (`synced`/`conflict`/`rejected`), `resultingOrderID` once committed.
- `lib/offlineSync.js` — `syncOfflineSale()`: re-verifies every line's price against the DB's current value (same tolerance rule as Stage 2), checks current availability (`quantity - reserved`) directly rather than consuming a reservation, allocates a real order ID server-side (client's offline-picked ID is only a preference), and commits atomically in a transaction. Order's `orderDate` is set to `createdOfflineAt` (when the sale actually happened), not sync time, so Stage 9's date-scoped reports stay accurate. Never throws for an *expected* conflict (bad price, insufficient stock, missing customer/product) — returns `{ conflictReason }` instead, so the caller can park it for review rather than retry forever.
- `routes/sync.js` — `POST /api/sync/commit` (idempotent: replaying the same key returns the already-resolved outcome instead of double-committing), `GET /api/sync/conflicts` (admin), `POST /api/sync/conflicts/:id/resolve` with `action: retry|reject` (admin). All `requireAuth`; conflict endpoints additionally `requireAdmin`.
- Mounted in `main.js` behind `ENABLE_OFFLINE_SYNC` (`.env`, default `false`) — verified route 404s entirely when off, not just blocked.

**Frontend:**
- `frontend/src/lib/offlineQueue.js` — dependency-free IndexedDB wrapper (own object store, no library) — the durable write queue itself. Queue entries persist across tab close/crash; only cleared explicitly once `synced`, never auto-deleted.
- `frontend/src/lib/offlineSync.js` — connectivity watcher: distinguishes a genuine network failure (`fetch` throwing `TypeError`) from a real server rejection (4xx/409), only the former leaves a queue entry `pending` for retry. Auto-flushes every 15s and immediately on the browser's `online` event. Started once at the app root (`App.jsx`) so a queued sale still syncs even after the cashier navigates away from Billing.
- `frontend/.env` — new `VITE_ENABLE_OFFLINE_SYNC` (build-time flag, mirrors the backend's `ENABLE_OFFLINE_SYNC`; both need to agree).
- `pages/Billing.jsx` — `handleAddToBill` falls back to a local-only, unreserved add (flagged `offline: true`) only on a genuine network error while reserving, using cached availability for a soft client-side check; `handlePreview` falls back to a locally-generated bill ID when the server's uniqueness check is unreachable; `handleGenerateBill` falls back to `enqueueSale()` instead of failing outright, prints a receipt clearly marked "OFFLINE — PENDING SYNC," and resets the cart as if committed. `removeItem` skips the release-stock call for offline-added items (nothing was ever reserved). A banner shows when offline and the module's enabled. Every fallback triggers only on an actual network error, not a legitimate rejection (out of stock, bad discount, etc.) — those behave exactly as before this stage.
- `pages/Reports.jsx` — two new panels, both gated on the module being enabled: **Offline sales on this device** (reads the local IndexedDB queue directly — counts of pending/synced/conflict, a manual "Sync now," "Clear synced"), and **Offline sync conflicts** (admin-only, reads `GET /api/sync/conflicts`, Retry/Reject buttons). This is the "export screen distinguishes synced vs. pending records" exit criterion — the device-local queue shows what's pending sync, the server-side panel shows what needs a human decision.

**Verified:** backend syntax-checked; server boots clean with the flag on and off; `/api/sync/*` 404s when off, 401 with no token, 403 for non-admin hitting the admin-only endpoints when on; input validation confirmed to run *before* any DB call (fixed an initial ordering bug where the idempotency lookup ran first); frontend builds clean via `vite build` after every integration step. **Not verified:** no live MongoDB in this sandbox (same limitation as Stage 10), so the actual commit/conflict transaction was never run against real data — the price-tolerance and stock-availability logic should get a real end-to-end test (take a device offline, add items, reconnect, confirm the order appears with the right total and stock decremented once, not twice) before relying on it. Also not exercised: the IndexedDB queue itself in an actual browser (built and reasoned through, but this sandbox has no browser to run it in).

**Known gaps / deliberate scope limits:**
- No conflict resolution for the *reverse* case — an item added offline that turns out to not exist anymore by sync time surfaces as a conflict (correct), but there's no "edit and retry with a substitute item" flow, only retry-as-is or reject.
- The client's offline-picked order ID is cosmetic only (server always re-allocates at sync time) — if two devices offline-queue using the same client ID, that's fine and expected, but the printed offline receipt's ID may not match the final synced order's ID. Not surfaced anywhere in the UI beyond the receipt itself.
- No UI limit on how long a sale can sit `pending` — a device offline for weeks will queue indefinitely (IndexedDB has generous per-origin quotas, but this hasn't been stress-tested).

## File inventory (as of end of Stage 9)

## Route inventory (as of end of Stage 9)

**Public:** `POST /auth/login`, `GET /api/products`, `GET /api/customers`,
`GET /dashboard/load`, `POST /billing/orderid`.

**`requireAuth`:** `POST /api/product`, `POST /product` (legacy, dead),
`DELETE /product/:id`, `POST /product/undo`, `POST /customer/*`,
`POST /billing/reserve`, `POST /billing/release`, `GET/POST/DELETE
/billing/draft`, `POST /billing/orderDetails`, `GET /api/suppliers`,
`POST /api/supplier`, `DELETE /supplier/:name`, `POST /supplier/purchase`,
`GET /api/orders`, `GET /api/orders/:orderID`.

**`requireAuth` + `requireAdmin`:** `POST /billing/update` (manual stock
correction), `POST /order/:orderID/edit` (72h window), `POST
/order/:orderID/refund` (no time window).

All four list routes (`GET /api/products`, `/customers`, `/orders`,
`/suppliers`) additionally accept `?search=&sortBy=&sortDir=&page=&limit=`
(Stage 8). `GET /dashboard/load` accepts `?range=week|month|year` (Stage 9).

## Known cross-cutting gaps (carried forward, not yet fixed)

1. Read routes (`/api/products`, `/api/customers`, `/dashboard/load`,
   `/api/orders*`) are unauthenticated or auth-only-not-admin —
   `/dashboard/load` now exposes more (payables, credit outstanding)
   than before Stage 9.
2. Legacy EJS app (`views/`, routes rendering them) is broken on both
   write (auth) and read (renamed fields) — candidate for deletion,
   explicitly deferred by the person until later.
3. No refresh-token flow — JWT just expires (`JWT_EXPIRES_IN`, 8h default).
4. `discountAmount` (Stage 6) isn't displayed anywhere in the *Billing*
   cart/receipt yet (does show in Orders.jsx's line-item view) — only
   stored, not surfaced at sale time.
5. Refund cash-vs-credit ambiguity (Stage 7).
6. `sortBy` allow-list, fielded search, URL state (all Stage 8).
7. Dashboard's refund-count vs. refund-amount date-scoping inconsistency
   (Stage 9, see above). No custom/explicit date-range picker, only the
   three presets.

## Stage numbering note

The person's spec numbers stages 1–9 independently of the earlier
frontend-migration stage log in `CLAUDE.md` (which has its own 1–10
sequence covering the React port *and* the spec stages together — one
extra entry for the initial migration that predates the spec). When in
doubt, this file's headings ("Spec Stage N") are the ones that match
what the person pastes in as stage specs. `CLAUDE.md`'s stage log table
is the fine-grained version of the same history.