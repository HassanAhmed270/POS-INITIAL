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
- `POST /billing/orderid`

**Authenticated**
- `POST /auth/refresh` (Stage 12)
- `GET /api/products` (Stage 12: was public)
- `GET /api/customers` (Stage 12: was public)
- `GET /dashboard/load` (Stage 12: was public)
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

1. ~~Some read routes remain public/auth-only.~~ Closed in Stage 12 —
   `/dashboard/load`, `/api/products`, `/api/customers` now require auth.
   `POST /billing/orderid` and `POST /auth/login` are the only
   intentionally-public routes left (order-ID lookup during checkout and
   login itself).
2. ~~No refresh-token flow.~~ Closed in Stage 12 — see `POST /auth/refresh`
   and the frontend's 30-minute silent-refresh interval.
3. Billing receipt/cart does not display stored `discountAmount`.
4. Refund cash-back vs store-credit is not distinguished.
5. Stage 8 sort allow-list, fielded search and URL state remain absent.
6. Dashboard refund count/amount use different date scopes.
7. Offline sync has not been stress-tested at scale (large queues,
   prolonged outages, many devices).

## Current Status

Stages 1–10, 12, and 13 are implemented and verified (Stage 12/13's
DB-touching or live-browser paths are syntax/logic-verified only — see
each Verification section; no live MongoDB in this sandbox).

Stage 11 is implemented and **end-to-end verified in the real browser and
database**, including offline sale creation, durable queueing, automatic
reconnection sync, conflict detection and conflict resolution.

EJS removal is complete and verified: the app is single-deployment MERN
(`main.js` serves `frontend/dist`), no server-rendered UI remains.

No unresolved functional issue was found in the primary Stage 11 flow.

Remaining items are deliberate scope limitations, security hardening,
and stress-testing unless the next specification adds new functionality.

## Spec Stage 12 — Close Remaining Security Gaps

- `GET /dashboard/load`, `GET /api/products`, `GET /api/customers` were
  public through Stage 11/EJS-removal; all three now require
  `requireAuth`, same as every other data route.
- Added `POST /auth/refresh`: silent re-auth. Requires a currently-valid
  token (`requireAuth`), re-reads the user from the DB by `userId` (so a
  deleted/deactivated account or role change takes effect immediately
  instead of riding out the old token's claims), and issues a fresh token
  with a new full-length expiry via the existing `signToken()`.
- Frontend: `AuthContext.jsx` now runs a 30-minute interval while
  `user` is set, calling `api.refresh()` and swapping in the new token —
  comfortably inside the default 8h `JWT_EXPIRES_IN` even if that's later
  configured shorter. A failed refresh (network hiccup) just retries next
  interval; an outright 401 already flows through the existing
  `auth:unauthorized` listener and logs the person out, same as before.
  No new auth state machine — reuses the existing token store/listener
  pattern from Spec Stage 1.
- Known gap: refresh is purely interval-driven, not activity-aware — a
  session extends every 30 minutes as long as the tab stays open, whether
  or not the cashier is actively using it. That's an accepted tradeoff for
  the "no full re-login mid-shift" exit criteria, not a bug.

### Stage 12 Verification

- `main.js`, `routes/auth.js`, `middleware/auth.js` pass `node --check`.
- **No live MongoDB in this sandbox** (no `mongod` package available, and
  the network egress allowlist doesn't include `mongodb.org`/Atlas) — the
  three previously-public routes and `/auth/refresh` were boot-tested
  against a running server with no DB connected: all four correctly
  return `401` with no token, confirming the auth gate is live at the
  HTTP layer before any Mongo call would even run.
- `requireAuth` middleware was additionally unit-tested directly (mock
  req/res, no HTTP/DB): a validly-signed token calls `next()` and
  populates `req.user`; a missing token 401s with "Login required."; a
  malformed token 401s with "Session expired.".
- Did **not** verify: `auth/refresh`'s DB re-read (`User.findById`) and
  the downstream `/api/products`/`/api/customers`/`/dashboard/load`
  handlers past the auth gate, since that needs a live replica set this
  sandbox doesn't have. Same limitation applies to the frontend's 30-min
  refresh interval — code-reviewed and it builds clean, but not observed
  firing against a real backend session.
- Frontend: `npm run build` succeeds with the `AuthContext.jsx`/`api.js`
  changes.

## Spec Stage 13 — Product Price Edit: Show Previous vs. New Amount (Admin-only)

- Products edit form: when an admin opens a product to update it, a
  "Previous: <amount>" line now appears above the Price input, showing
  the price that was in effect before this edit (`p.price`, i.e. the
  latest `sellingPriceHistory` entry, captured at the moment the row is
  selected via `handleSelectForUpdate`). The editable input itself is
  unaffected — this is a read-only reference line alongside it.
- Suppliers purchase-recording form: same treatment for buying price —
  once a product is picked from the dropdown, a "Previous: <amount>"
  line shows that product's latest `costPrice` (from `GET /api/products`,
  already fetched into `allProducts` for the dropdown) above the Unit
  Cost input.
- Both are gated on `isAdmin` from `AuthContext` (same pattern as
  `Orders.jsx`'s admin-only edit/refund buttons) — cashiers see the forms
  exactly as before, no previous-price line.
- No backend changes: `p.price`/`p.costPrice` were already present in the
  `GET /api/products` response (Stage 5's `lib/pricing.js` latest-history
  helpers); this was purely a UI gap, as scoped.
- Known simplification: a product with no purchase history yet shows
  "Previous: Rs 0.00" (Suppliers form) rather than a distinct "no prior
  purchase" message — `getLatestBuyingPrice()` already returns 0 for an
  empty history everywhere else in the app (e.g. Products list's cost
  column), so this stays consistent with that existing convention instead
  of introducing a new backend field just to distinguish the two cases.

### Stage 13 Verification

- Frontend `npm run build` succeeds.
- `npm run lint` (oxlint) passes — 0 errors; the one pre-existing warning
  in `AuthContext.jsx` (fast-refresh export shape) predates this change
  and isn't in either file touched here.
- Not verified: not exercised in a live browser against a real backend/DB
  in this sandbox (same limitation as Stage 12 — no MongoDB replica set
  available here). Logic was traced by hand against the actual
  `GET /api/products` response shape (`price`, `costPrice` fields
  confirmed present in `main.js`) rather than observed live.

## Stage Numbering Note

The spec stages are independent of the initial React migration stage.
Use the `Spec Stage N` headings in this file when matching the supplied
stage specifications.