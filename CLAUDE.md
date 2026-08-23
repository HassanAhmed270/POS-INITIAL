# CLAUDE.md

This file gives Claude Code (claude.ai/code) the context it needs to work in this repository.

Companion to `progress.md`, which is the fast-reference, stage-by-stage
log (what exists, where, what's still open). This file has the narrative
detail; read `progress.md` first, come here for the "why."

## What this project is

A **Point-of-Sale / Billing Management System** for a single shop: an
Express + MongoDB (Mongoose) JSON API backend, paired with a React (Vite +
Tailwind) frontend. This is a plain **MERN** app — there is no
server-rendered UI. `main.js` never renders HTML itself; it either answers
JSON under `/api`, `/auth`, and a handful of legacy-shaped-but-still-JSON
routes (`/billing/*`, `/product/*`, `/customer/*`, `/supplier/*`,
`/dashboard/load`), or — for every other GET request — serves the built
React app from `frontend/dist` and lets React Router decide what to show.

Core entities: **Products**, **Customers**, **Orders** (bills), plus
**Suppliers**, **Refunds**, **PendingBill** (draft carts), and (optional
module) **OfflineSale**. Screens: Login, Dashboard, Billing, Products,
Customers, Suppliers, Orders, Reports.

There used to be a second, server-rendered EJS UI (`views/`) built
alongside the JSON API while the React frontend was being written
screen-by-screen. That's gone now — see "History" below.

## Commands

```bash
npm install                # backend deps
npm start                  # run the API server via nodemon (main.js), PORT env var, defaults to 3000
npm run create-user        # create a login (username/password/role) — see scripts/createUser.js
npm run build-frontend     # builds frontend/dist via `npm --prefix frontend run build`

cd frontend
npm install                # frontend deps
npm run dev                # Vite dev server on :5173, proxies /api, /auth, /billing, /product,
                            # /customer, /supplier, /dashboard/load to :3000
npm run build               # production build -> frontend/dist (this is what main.js serves)
```

There are no automated tests (`npm test` is a stub) and no backend linter
configured (frontend has `oxlint`, run via `cd frontend && npm run lint`).

**MongoDB must be running as a replica set**, not a plain standalone
`mongod` — order checkout (`POST /billing/orderDetails`), the offline sync
commit path, and a few other mutations use multi-document transactions,
which only work against a replica set (or `mongos`). Locally: run `mongod
--replSet rs0`, then `rs.initiate()` once in `mongosh`. The server still
boots against a standalone instance but warns loudly at startup, and
checkout will fail.

Copy `.env.example` to `.env` before running — `JWT_SECRET` is required;
the app throws at boot without it (see `middleware/auth.js`).

Tokens are a flat-expiry JWT (`JWT_EXPIRES_IN`, default 8h) with no
built-in renewal at the JWT layer itself — session longevity instead
comes from `POST /auth/refresh` (Stage 12): while a token is still valid,
this issues a fresh one with a full new expiry. The frontend
(`AuthContext.jsx`) calls it automatically on a 30-minute interval
whenever a user is logged in, so a shift doesn't get interrupted by a
forced re-login as long as the tab stays open. `/auth/refresh` re-reads
the user from the DB (not just the token's claims) so a role change or
account removal takes effect on the next refresh rather than riding out
the old token.

## Architecture

- **`main.js`** — single entry point: Express app, MongoDB connection,
  most routes inline (some split into `routes/`), then the static
  frontend-serving block, then the centralized error handler.
- **`models/`** — Mongoose schemas: `Product`, `Customers`, `Order`,
  `PendingBill` (Stage 4 draft carts), `Supplier`, `Refunds`, `user`
  (login accounts), `OfflineSale` (Stage 11, optional module), and
  `AuditLog` (Stage 14 — see below).
  - `Product.js` — `productID` (format `#0000`, regex-enforced, unique),
    `sellingPriceHistory`/`buyingPriceHistory` (arrays of `{price, date}` —
    a price *history*, not a scalar — see `lib/pricing.js`'s
    `getLatestSellingPrice`/`getLatestBuyingPrice`), `quantity`,
    `reserved` (Stage 3 — units held by in-progress carts, not yet
    committed), `lowStockThreshold`, `supplierID` (Stage 20 — `ObjectId
    ref: 'Supplier'`, nullable; replaces the old free-text `supplier`
    string — see below).
  - `Order.js` — `orderID` (`#0000`), `customerName`, `products` (embedded
    `{productID, quantity, amount, discount, discountType,
    discountAmount}`), `cashier`, `totalAmount`, `amountPaid`,
    `balanceDue`, `paymentStatus`, `payments[]`, `editHistory[]` (Stage 7).
  - `AuditLog.js` (Stage 14) — `action`, `actor {username, role}`,
    `targetType`, `targetId`, `before`/`after` snapshots, `date`.
    **Fixed-size ring buffer**, not an unbounded log — see
    `lib/auditLog.js`. Written only via `logAudit()`; nothing should
    insert into this collection directly.
  - `StockBatch.js` (Stage 22) — one document per restock: `productID`,
    `supplierID` (nullable), `purchaseID`, `quantityPurchased`,
    `quantityRemaining`, `unitCost` (frozen at creation), `purchaseDate`.
    Written only via `lib/costing.js`'s `createBatch()`
    (`POST /supplier/purchase`) and consumed/restored only via that same
    file's `consumeFIFO()`/`restoreConsumption()` — never mutated
    directly elsewhere. See "Batch-based costing" below.
- **`routes/`** — `auth.js` (login/JWT), `export.js` (Stage 10, CSV
  export), `sync.js` (Stage 11, offline sync). Everything else — including
  order edit/refund (`POST /api/order/:orderID/edit`,
  `POST /api/order/:orderID/refund`) and the audit log
  (`GET /api/audit-log`, Stage 14) — is still inline in `main.js`.
- **`lib/`** — shared logic: `pricing.js`, `money.js` (rounding),
  `validators.js`, `query.js` (pagination/sort helpers), `errors.js`
  (`AppError`), `reports.js` (Stage 9/10 dashboard + export aggregation),
  `csv.js` (dependency-free CSV writer), `offlineSync.js` (Stage 11 offline
  commit logic), `auditLog.js` (Stage 14 — `logAudit(entry, session?)`;
  pass the transaction's `session` when calling from inside an existing
  `session.withTransaction()` block — order commit/edit/refund — omit it
  for routes with no transaction of their own, currently product/customer/
  supplier saves), `costing.js` (Stage 22 — FIFO batch cost consumption/
  restoration; see "Batch-based costing" below).
- **`frontend/`** — the entire UI. React (Vite, Tailwind via
  `@tailwindcss/vite`, no CDN), React Router for client-side routing. Talks
  to the backend over JSON only, via `frontend/src/lib/api.js` — every
  backend call goes through that one file. See `frontend/README.md`.
  Route guarding: `ProtectedRoute.jsx` (must be logged in — used by most
  screens) vs. `AdminRoute.jsx` (Stage 14 — must be logged in *and*
  admin; currently only `/audit-log`). Most admin-only *behavior* within
  a screen (e.g. Orders' edit/refund buttons) is instead an inline
  `isAdmin` check from `useAuth()`, same page visible to everyone in a
  reduced form — `AdminRoute` is for the rarer case of a screen that's
  admin-only outright. Either way, the backend route's own `requireAdmin`
  is the real boundary; frontend gating is UX only.
  `Products.jsx`/`Suppliers.jsx` (Stage 19) follow the inline-`isAdmin`
  pattern for their *master-data mutation* UI specifically — the Edit/
  Delete icons, the Add/Update product form, and the Add Supplier form
  are all `isAdmin`-only, while the page itself and (for Suppliers) the
  restock form stay visible to every logged-in user. The matching
  backend routes (`POST /api/product`, `DELETE /product/:productID`,
  `POST /product/undo`, `POST /api/supplier`,
  `DELETE /supplier/:supplierName`) carry `requireAdmin`; restocking
  (`POST /supplier/purchase`) and customer creation
  (`POST /billing/addCustomer`, `POST /customer/updateCustomer`)
  deliberately do not — a worker can restock and manage customers, just
  not create/edit/delete products or suppliers, from either the UI or a
  direct API call.
  `components/LowStockBell.jsx` (Stage 15) is the same pattern applied to
  a header widget rather than a route: rendered from `Topbar.jsx` only
  when `isAdmin`, polls `GET /api/products/low-stock` on mount + every
  60s. The backend route's own `requireAdmin` is what actually stops a
  cashier from reading it directly.
  `components/Sidebar.jsx` (Stage 16) is responsive on its own: below
  `md` it renders as a fixed, off-canvas drawer with its own hamburger
  button and backdrop; at `md`+ it's the original always-visible in-flow
  column. Because the component owns its own responsive behavior, no
  page had to change how it mounts `<Sidebar />` — every screen got the
  drawer "for free." The one thing each page's own header/topbar *does*
  need is `pl-14` (or equivalent) below `md` so its own content doesn't
  sit under the fixed hamburger button — see `Topbar.jsx` or Billing's
  own inline header for the pattern if adding a new screen.
- **`middleware/`** — `auth.js` (`requireAuth`/`requireAdmin`, JWT),
  `errorHandler.js` (`asyncHandler` wrapper + centralized error middleware).

### How a request is served

1. `/auth/*` → `routes/auth.js`.
2. `/api/export/*`, `/api/sync/*` → optional modules (Stage 10/11), each
   behind its own `.env` flag (`ENABLE_EXPORTS`, `ENABLE_OFFLINE_SYNC`),
   mounted with one line each in `main.js`.
3. Everything else under `/api`, `/billing`, `/product`, `/customer`,
   `/supplier`, `/dashboard/load` → inline route handlers in `main.js`,
   JSON in and out. (See `progress.md`'s Route Inventory for the full
   list.) As of Stage 12, the only routes left intentionally public (no
   `requireAuth`) are `POST /auth/login` and `POST /billing/orderid`;
   everything else — including `GET /dashboard/load`, `GET /api/products`
   and `GET /api/customers`, which were public through Stage 11/EJS-removal
   — now requires a valid Bearer token. `GET /api/products/low-stock`
   (Stage 15) additionally requires `requireAdmin`.
4. Any GET request that didn't match one of the above and isn't under
   `/api` or `/auth` → served `frontend/dist/index.html` (or a static
   asset from `frontend/dist` if the path matches one). React Router picks
   the screen from there. An unmatched `/api/*` or `/auth/*` request 404s
   as JSON instead of falling through to the SPA shell — see the block
   right before `app.use(errorHandler)` in `main.js`.

If `frontend/dist` doesn't exist (frontend never built), the API still
works; `main.js` logs a warning at boot and there's just no UI to serve.

### Notable implementation details / quirks to be aware of

- **IDs are business identifiers, not Mongo `_id`s**: products and orders
  use a human-facing `#0000`-style ID (regex `^#\d{4}$`) as the real lookup
  key throughout (`Product.findOne({ productID })`, etc.).
- **Reservation before commit (Stage 3)**: adding an item to a cart calls
  `POST /billing/reserve`, which atomically increments `Product.reserved`
  — this is what prevents two cashiers from overselling the same last
  unit, not a check-then-write from the client. `POST /billing/release`
  undoes it (cancel, remove item, tab closed — see the `beforeunload`
  handler in `Billing.jsx` and the abandoned-draft sweep in `main.js`).
- **Drafts are the server's source of truth for checkout (Stage 4)**: the
  cashier's in-progress cart is autosaved server-side as a `PendingBill`.
  `POST /billing/orderDetails` (commit) reads *that*, not anything sent in
  the request body — re-verifying price/discount against current DB values
  before committing stock and creating the `Order`.
- **Walk-in / Unknown customer (Stage 19)**: `WALKIN_CUSTOMER = 'Walk-in
  / Unknown'` is a plain sentinel *string*, defined identically in
  `main.js` and `Billing.jsx` (not a special code — the frontend already
  sends whatever's in `customer` state straight through as
  `customerName`, same as a real customer name). `POST
  /billing/orderDetails` special-cases only this exact value: it skips
  the `Customer.findOne`/404 and skips the `Customer.updateOne $push`
  that would otherwise record order history against a customer. Every
  other part of commit (price re-verification, atomic stock decrement,
  payment/balance math, the `Order` document, the audit log entry) is
  unchanged — a walk-in sale is a fully real, fully audited `Order`, it's
  just never attached to a `Customer` document, so it can never
  contribute to a credit account or customer-order-history report.
- **Supplier is a real reference, not a free-text string (Stage 20)**:
  `Product.supplierID` (`ObjectId ref: 'Supplier'`, nullable) replaces the
  old `supplier` string field. `NO_SUPPLIER = 'NoSupplier'` is a plain
  sentinel string, defined identically in `main.js`, `Products.jsx`, and
  `Suppliers.jsx` — same pattern as `WALKIN_CUSTOMER` (Stage 19).
  `resolveSupplierId()` (`main.js`) is the one place that turns a
  submitted `supplierId` into either a real Supplier `_id` or `null`:
  empty/`NO_SUPPLIER` → `null`; anything else must be a valid,
  *existing* Supplier id or the request 400s — never silently accepted or
  silently coerced. `POST /supplier/purchase` (restock) accepts
  `supplierName === NO_SUPPLIER` as a self-purchase path that skips the
  Supplier lookup and `Supplier.purchases[]` push entirely (no fake
  Supplier document gets created) but still updates stock and
  `buyingPriceHistory` (with `supplierID: null`) atomically in the same
  transaction as a real-supplier purchase. Recording a restock — from a
  real supplier or self-purchased — deliberately does **not** change
  `Product.supplierID`; the product's declared current supplier is only
  ever set via the Products form, restocking is inventory work, same
  reasoning Stage 19 used to keep `/supplier/purchase`
  worker-accessible. This is a breaking schema change for any pre-Stage-
  20 data with a plain string in the old `supplier` field — there's no
  migration script (see `progress.md`'s Stage 20 entry).
- **Two receipt layouts, one commit path (Stage 17)**: `Billing.jsx` has
  `printReceiptFor` (the original plain-table layout) and
  `printSpecialReceiptFor` (catering-invoice-style layout, added Stage
  17 once a reference pattern was supplied) — both build an HTML string
  from the same in-memory cart/total/payment state and hand it to the
  same `printReceipt()` popup (`lib/print.js`, untouched). `handleGenerateBill`
  takes a `special` boolean and picks which one to call *after* the order
  actually commits — there is one validation/commit/offline-fallback path,
  not two, so a new layout is just another render function, never a new
  way to save an order. The Special Bill button opens an on-screen JSX
  preview (mirroring `printSpecialReceiptFor`'s HTML) before anything is
  committed; its own "Generate Bill" button re-enters the same
  `handleGenerateBill(true)` call as the main flow. Customer mobile/
  address/email on that layout come from `customerDirectory`, a
  name-keyed lookup built from the same `GET /api/customers` response
  Billing already fetches for its dropdown (previously only the name was
  kept) — no new endpoint, no new schema field.
- **Price is a history array, not a scalar** — always read it via
  `getLatestSellingPrice(product)` / `getLatestBuyingPrice(product)`
  (`lib/pricing.js`), never `product.sellingPriceHistory[0].price` or
  similar.
- **Restocking can update selling price too, not just cost (Stage 21)**:
  `POST /supplier/purchase` accepts an optional per-item `sellingPrice`
  alongside the required `unitCost`. Omitted/blank means "leave it
  alone" — it's validated and only written (inside the same
  `session.withTransaction()` as the stock/`buyingPriceHistory` update)
  when submitted **and** different from the product's current selling
  price, the same "did it actually move" guard `POST /api/product`
  already used for its own price field. This is the *only* place besides
  the Products edit form that writes to `sellingPriceHistory` —
  `buyingPriceHistory` and `sellingPriceHistory` stay fully independent
  arrays regardless of which flow (Products form vs. restock) triggered
  the write; updating one never implicitly touches the other.
  `Supplier.purchases[].items` doesn't declare a `sellingPrice` field, so
  Mongoose silently strips it there when the purchase record is saved —
  intentional; the durable record of the change is
  `Product.sellingPriceHistory` itself plus the action's audit-log entry,
  not a second copy on the supplier's purchase history.
- **Supplier overpayment becomes rolling credit, not a discarded
  remainder**: `Supplier.creditBalance` (`min: 0`, default 0) tracks what
  a supplier currently owes *us* from having been overpaid on a past
  purchase. `POST /supplier/purchase` applies any existing credit to a
  new purchase's total *before* computing what's owed
  (`creditApplied = min(existingCredit, totalAmount)`), and only paying
  more than what's left after that (`netOwed`) creates *further* credit,
  recorded on that purchase's own `creditGenerated` field — read/written
  on the supplier document inside the same session/transaction as the
  stock update, never as a negative `balanceDue` on an individual
  purchase (that field stays `min: 0`, floored). `creditApplied` and
  `creditGenerated` are both audit snapshots only — never re-read or
  re-applied later. `amountPaid` is no longer capped at the purchase
  total; it's validated (finite, ≥0) the same way item fields are, and
  recorded as exactly what was submitted. Self-purchases have no
  Supplier document and therefore no credit concept at all. **Note**:
  the frontend's Amount Paid field intentionally does *not* subtract
  available credit from its auto-filled suggestion (tried once, reverted
  — see progress.md) — it always suggests plain `quantity × unitCost`,
  so paying that suggested amount when the supplier already has credit
  will legitimately generate *more* credit. That's expected, not a bug;
  the admin sees the supplier's credit balance and can choose to type a
  smaller number themselves.
- **Money rounding**: use `roundMoney()` (`lib/money.js`) on every
  computed amount before storing or comparing — floating-point drift
  across many small discounts/payments is the usual source of "off by a
  cent" bugs here.
- **Batch-based costing / FIFO (Stage 22)**: every restock
  (`POST /supplier/purchase`, real-supplier or self-purchased) creates a
  `StockBatch` alongside its existing `buyingPriceHistory` entry — a
  distinct, frozen cost lot (`lib/costing.js`'s `createBatch()`). A
  completed sale (`POST /billing/orderDetails`, and the offline-sync
  equivalent in `lib/offlineSync.js`) draws down the oldest available
  batch(es) first (`consumeFIFO()`) in the same transaction as its stock
  decrement, and records exactly what it consumed on
  `Order.products[].costAmount`/`costQuantity`/`costSource`/
  `batchConsumption` — frozen from that point on; a later restock, price
  change, or product/supplier edit never rewrites an already-completed
  sale's cost basis, because it never touches an old batch's `unitCost`,
  only ever creates a new one. Admin edit/refund
  (`applyLineReduction()`) calls the inverse, `restoreConsumption()`,
  before mutating a line, so a reduced/removed line gives back exactly
  the batch units (and cost) it had consumed — this is what keeps the
  dashboard's `totalProfit` from double-counting a sale that's since been
  edited down or refunded, since that facet (`lib/reports.js`) just reads
  the same already-mutated `order.products` every other dashboard stat
  reads. Stock added via the Products admin form
  (`POST /api/product`'s `stock`/`already` fields) does **not** create a
  batch — that form never captured a cost, and Stage 22 explicitly
  forbids inventing one — so sales drawing on it (or on any pre-Stage-22
  stock) are recorded `costSource: 'unknown'` and are excluded from
  `totalProfit` rather than priced at today's cost. `unknownCostUnits` in
  the dashboard response surfaces how much of a given range's sales that
  affects, so it's visible rather than silently baked into a
  smaller-than-expected profit number.
- **Two independent feature-flagged modules (Stage 10/11)**: CSV export
  (`ENABLE_EXPORTS`, default on) and offline sync (`ENABLE_OFFLINE_SYNC`,
  default off, plus `VITE_ENABLE_OFFLINE_SYNC` on the frontend — both must
  agree). Both are designed to be deletable — their own files plus one
  `require` + one mount line in `main.js` each — without touching the core
  billing flow. See `progress.md` for what's in each.
- **Offline sync's commit path is intentionally separate** from
  `/billing/orderDetails`'s transaction (`lib/offlineSync.js`, not a
  shared function) — an offline sale has no server-held `PendingBill` to
  source items from and was never reserved, so it re-checks current stock
  availability directly at sync time instead of consuming a reservation.
  See that file's header comment before changing either commit path.
- **Mixed languages/comments**: some inline comments are in Roman
  Urdu/English mix — this is a solo/small-team project without a strict
  style guide; match the existing tone if editing nearby code.

## History

The app started as a monolithic Express + EJS server-rendered app (no
build step, no frontend framework — `views/*.ejs` with inline `<script>`
blocks for interactivity, no authentication, hardcoded Mongo URI). It was
rebuilt in phases:

1. **Frontend migration kickoff** — `frontend/` scaffolded (Vite + React +
   Tailwind), all EJS screens ported to React, two JSON endpoints added
   for what the EJS routes had been fetching server-side.
2. **Spec Stages 1–9** (see `progress.md` for the full per-stage log)
   hardened the backend: auth, validation, atomic stock reservation,
   draft-bill persistence, customer/supplier credit, discounts, admin
   edit/refund, search/sort/pagination, dashboard reporting — all built
   against the same JSON API the React frontend already used.
3. **Spec Stages 10–11** added two optional, feature-flagged modules (CSV
   export, offline sync) on top of the now-stable core.
4. **EJS removal**: once the React frontend covered every screen, `views/`,
   the EJS `view engine` setup, the `public/css` + `src/input.css`
   Tailwind-CDN-era assets, and every `res.render(...)` route were
   deleted. `main.js` now serves `frontend/dist` directly (see "How a
   request is served" above) instead of running two parallel UIs. This is
   a one-way change — there is no EJS fallback anymore, so the frontend
   must be built (`npm run build-frontend`) before deploying `main.js`
   anywhere the UI needs to be reachable.

`progress.md` has the detailed, stage-by-stage log (what changed, what was
verified, known gaps) — read it before making further backend changes.
`frontend/README.md` has the frontend-specific structure and run
instructions.

## Working in this codebase

- When adding a backend feature, prefer an inline route handler in
  `main.js` following the existing pattern, unless it's substantial enough
  to warrant its own `routes/*.js` file (the way `export.js`/`sync.js`
  are) — in which case mount it explicitly and note the mount line.
- When touching prices or stock quantities, use `lib/pricing.js` and
  `lib/money.js` rather than reading/rounding inline — see "Notable
  implementation details" above.
- When adding a frontend screen or API call, put the API call in
  `frontend/src/lib/api.js`, not `fetch()` directly in a component. If it
  adds a new backend path prefix, add it to `frontend/vite.config.js`'s
  dev proxy list too, or it'll silently 404 in `npm run dev`.
- There's no test suite — verify changes by running the app against a
  local MongoDB replica set and exercising the relevant screen/route
  manually. `frontend/dist` must be rebuilt (`npm run build-frontend`) to
  see backend-adjacent frontend changes reflected when running via
  `main.js` directly (the Vite dev server on :5173 doesn't need this — it
  serves source directly and proxies API calls).
