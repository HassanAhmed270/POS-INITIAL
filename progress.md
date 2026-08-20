# Billing System Rebuild — Progress Log

Companion to `CLAUDE.md`, which contains full narrative detail per stage.

Fast-reference version: what exists, where, and what remains open.

Repo root: `POS-INITIAL/`. Backend: Express + Mongoose at root (`main.js`).
Frontend: React + Vite + Tailwind in `frontend/`. There is no
server-rendered UI — the legacy EJS views were removed once the React
frontend covered every screen; see "EJS removal" below.

## Stage 1 — Frontend migration kickoff

- Scaffolded `frontend/` with Vite + React + Tailwind.
- Ported Login, Dashboard, Billing, Products and Customers to React.
- Added JSON API versions of product/customer routes.
- No authentication at this initial migration point.

## Spec Stage 1 — Auth & Error Handling

- Added `User` model with `admin|cashier` roles.
- Added JWT login and `requireAuth`/`requireAdmin`.
- Added login rate limiting and centralized error handling.
- Added Pino logging and `scripts/createUser.js`.
- Frontend token storage, automatic Bearer auth and 401 logout handling.
- `.env` required for JWT and server configuration.

## Spec Stage 2 — Data Integrity: Validation & Pricing

- Added independent validators and shared money helpers.
- Added server-side selling-price verification.
- `/billing/orderDetails` recomputes totals server-side.
- Discounts capped at 100%.

## Spec Stage 3 — Inventory Correctness

- Added `Product.reserved` and `lowStockThreshold`.
- Added atomic reserve/release operations.
- Order commit uses a MongoDB transaction.
- Manual stock correction is admin-only.
- Frontend performs real reservation/release.
- Requires MongoDB replica set.
- Abandoned reservation expiry was completed in Stage 4.

## Spec Stage 4 — Draft Bills

- Added `PendingBill` persistence per cashier.
- Added draft GET/POST/DELETE routes.
- Order commit now uses the persisted draft.
- Added background draft-expiry sweep.
- Frontend autosaves and restores/discards drafts.
- Remaining small gap: ~7-second autosave window after a crash.

## Spec Stage 5 — Customer & Supplier Credit

- Split product pricing into selling/buying price histories.
- Added `amountPaid`, `balanceDue`, `paymentStatus` and `payments[]`.
- Added customer outstanding balance.
- Added Supplier model and purchase flow.
- Supplier purchases restock inventory transactionally.
- Added `Suppliers.jsx`.
- Known gap: no later "pay existing balance" flow.

## Spec Stage 6 — Discounts UI

- Added `discountType`: `none|preset|manual`.
- Added 10%, 15%, 20% and manual discount UI.
- Discount data flows through draft persistence.
- `discountAmount` is calculated/stored server-side.
- Known gap: discount amount is not shown in Billing receipt/cart.

## Spec Stage 7 — Admin Bill Editing & Refunds

- Added `Refund` model and order `editHistory`.
- Added order `active/refunded` status.
- Added admin-only bill editing with a 72-hour window.
- Added admin-only refunds with no time restriction.
- Stock is restored atomically for edited/refunded items.
- Order totals and customer order data are recomputed.
- Added `/api/orders` list/detail routes.
- Added `Orders.jsx` and revised receipt printing.
- Known gap: refund cash-back vs store-credit is not distinguished.

## Spec Stage 8 — Search, Sort & Pagination

- Added shared query/search/pagination utilities.
- Products, Customers, Orders and Suppliers support search/sort/page/limit.
- Added debounced search, sortable headers and pagination UI.
- Orders/Suppliers use lazy-loaded inline details.
- Fixed product/supplier dropdowns being incorrectly paginated.
- Known gaps: no sort allow-list, fielded search or URL state.

## Spec Stage 9 — Dashboard Reporting

- Added week/month/year dashboard ranges.
- Added total orders, refunded orders and refunded amount.
- Added exchanged orders.
- Added customer credit and supplier payable snapshots.
- `totalSales` is already net because order totals are recomputed after edits/refunds.
- Added dashboard stat cards and shared money formatting.
- Known gap: order-date vs refund-date reporting scopes differ.
- Known gap: dashboard route remains insufficiently protected.

## Spec Stage 10 — CSV/Excel Export

- Added `lib/reports.js` for dashboard/export queries.
- Added dependency-free RFC 4180 CSV writer.
- Added:
  - `GET /api/export/summary`
  - `GET /api/export/sales`
  - `GET /api/export/refunds`
  - `GET /api/export/credit`
  - `GET /api/export/payables`
- Exports require authentication and are controlled by `ENABLE_EXPORTS`.
- Added `Reports.jsx` and real CSV downloads.
- CSV escaping tested for commas, quotes and newlines.
- Frontend build and backend boot verified.
- Fixed case-sensitive model `require()` issues.
- Verified exports working with the actual application.
- Scope limitation: CSV is used instead of binary `.xlsx`.

## Spec Stage 11 — Offline Sync Module

- Optional module controlled by:
  - Backend: `ENABLE_OFFLINE_SYNC`
  - Frontend: `VITE_ENABLE_OFFLINE_SYNC`
- Added `OfflineSale` model with idempotency protection.
- Added server-side offline transaction/sync logic.
- Added:
  - `POST /api/sync/commit`
  - `GET /api/sync/conflicts`
  - `POST /api/sync/conflicts/:id/resolve`
- Added durable IndexedDB queue in `offlineQueue.js`.
- Added background connectivity watcher in `offlineSync.js`.
- Queue retries genuine network failures but records server conflicts.
- Added offline Billing fallback and offline receipt indication.
- Added Reports panels for local offline sales and admin conflicts.
- Sync runs automatically after reconnection and every 15 seconds.

### Stage 11 Verification

- Backend syntax checked.
- Backend boots with offline sync enabled/disabled.
- Routes correctly 404 when feature is disabled.
- Authentication/authorization behavior verified.
- Frontend builds successfully.
- Real browser offline billing tested.
- Offline bill successfully generated while disconnected.
- Offline sale persisted in IndexedDB.
- Reconnection automatically synchronized the sale.
- Synced sale confirmed in the actual database.
- Server-side conflict was reproduced successfully.
- Conflict appeared in Reports.
- Conflict resolution was successfully completed.
- Stage 11 primary end-to-end flow is now verified.

### Stage 11 Deliberate Limitations

- Offline queue is device-local, not a global offline-sales history.
- No substitute-item editing during conflict resolution.
- Offline client bill ID may differ from the final server order ID.
- No maximum pending duration.
- Large queues, prolonged outages and multi-device stress scenarios are not
  yet stress-tested.

## EJS removal — MERN-only

Not a numbered spec stage; a cleanup pass once the React frontend covered
every screen and Stage 10/11 had landed. Requested directly: no more
server-rendered UI, single Express + React deployment.

- Deleted `views/` (all EJS templates), `public/css`, `src/input.css`,
  root `output.css` — the entire EJS-era Tailwind pipeline.
- Removed from `main.js`: `view engine` setup, all six `res.render(...)`
  page routes (`/`, `/logout`, `/dashboard`, `/billing`, `/product`,
  `/customer`), and the dead `POST /product` form-submit route (`POST
  /api/product` already covered the same logic and was the only one the
  React app ever called).
- `main.js` now serves `frontend/dist` directly: static assets served,
  any unmatched GET outside `/api`/`/auth` gets `index.html` (React Router
  decides the screen), an unmatched `/api/*` or `/auth/*` 404s as JSON
  rather than falling through to the SPA shell. If `frontend/dist` isn't
  built yet, the API still works — `main.js` just logs a warning at boot.
- `package.json`: removed `ejs` and the root `tailwindcss` devDependency
  (frontend has its own); added `build-frontend` script.
- Fixed a pre-existing dev-proxy gap while touching `vite.config.js`:
  `/supplier` was missing from the proxy list, so `deleteSupplier`/
  `recordPurchase` silently 404'd under `npm run dev` (worked fine once
  built and served by `main.js`, since same-origin has no proxy to miss).
- Rewrote `CLAUDE.md` (had been stale since before Spec Stage 1 — still
  described "no authentication" and a scalar `unitPrice`) and
  `frontend/README.md` (still described the EJS-parity migration stage)
  to match current reality.
- Verified: full boot test with both `.env` flags on — `/` and every
  client-side route (`/billing`, `/orders`, `/suppliers`, `/reports`) →
  200 (SPA shell); static asset → 200; `/api/export/*`, `/api/sync/*`,
  `/api/order/:id/edit` → 401 (real routes, correctly auth-gated);
  `/api/nonsense` → clean JSON 404. Frontend builds clean via `vite
  build`. Re-verified against the actual current `origin/main` (not a
  stale local clone) after discovering two upstream commits had already
  landed (Stage 10/11 patch applied, plus an unrelated fix moving order
  edit/refund routes to `/api/order/*` — the EJS-removal 404 guard
  benefits from that move, since it keeps everything under `/api` cleanly
  JSON-only).
- This is one-way: there is no EJS fallback anymore. Deploying `main.js`
  anywhere the UI needs to be reachable now requires `npm run
  build-frontend` first.

## Route Inventory — End of Stage 11 / EJS removal / EJS removal

**Public**
- `POST /auth/login`
- `GET /api/products`
- `GET /api/customers`
- `GET /dashboard/load`
- `POST /billing/orderid`

**Authenticated**
- Product/customer mutation routes
- Billing reserve/release/draft/order routes
- Supplier routes
- `GET /api/orders`
- `GET /api/orders/:orderID`
- Stage 10 export routes
- `POST /api/sync/commit`

**Authenticated + Admin**
- `POST /billing/update`
- `POST /api/order/:orderID/edit`
- `POST /api/order/:orderID/refund`
- `GET /api/sync/conflicts`
- `POST /api/sync/conflicts/:id/resolve`

**Frontend (all other GET requests)**
- Any unmatched GET not under `/api` or `/auth` serves
  `frontend/dist/index.html`; React Router owns everything from there
  (`/`, `/dashboard`, `/billing`, `/products`, `/customers`, `/suppliers`,
  `/orders`, `/reports`). An unmatched `/api/*` or `/auth/*` request 404s
  as JSON instead.

List routes support:
`search`, `sortBy`, `sortDir`, `page`, `limit`.

Dashboard supports:
`range=week|month|year`.

Exports:
`summary`, `sales`, `refunds`, `credit`, `payables`.

## Current Known Cross-Cutting Gaps

1. Some read routes remain public/auth-only.
2. No refresh-token flow.
3. Billing receipt/cart does not display stored `discountAmount`.
4. Refund cash-back vs store-credit is not distinguished.
5. Stage 8 sort allow-list, fielded search and URL state remain absent.
6. Dashboard refund count/amount use different date scopes.
7. Offline sync has not been stress-tested at scale (large queues,
   prolonged outages, many devices).

## Current Status

Stages 1–10 are implemented and verified.

Stage 11 is implemented and **end-to-end verified in the real browser and
database**, including offline sale creation, durable queueing, automatic
reconnection sync, conflict detection and conflict resolution.

EJS removal is complete and verified: the app is single-deployment MERN
(`main.js` serves `frontend/dist`), no server-rendered UI remains.

No unresolved functional issue was found in the primary Stage 11 flow.

Remaining items are deliberate scope limitations, security hardening,
and stress-testing unless the next specification adds new functionality.

## Stage Numbering Note

The spec stages are independent of the initial React migration stage.
Use the `Spec Stage N` headings in this file when matching the supplied
stage specifications.