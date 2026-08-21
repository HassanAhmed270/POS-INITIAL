# Billing System Rebuild — Progress Log

Companion to `CLAUDE.md` (full narrative detail per stage). Fast-reference
version: what exists, where, what remains open.

Repo root: `POS-INITIAL/`. Backend: Express + Mongoose at root (`main.js`).
Frontend: React + Vite + Tailwind in `frontend/`. No server-rendered UI —
legacy EJS views were removed once React covered every screen (see "EJS
removal" below).

## Stage 1 — Frontend migration kickoff

Scaffolded `frontend/` (Vite + React + Tailwind). Ported Login,
Dashboard, Billing, Products, Customers. Added JSON API routes. No auth
at this point.

## Spec Stage 1 — Auth & Error Handling

JWT login, `requireAuth`/`requireAdmin`, login rate limiting, centralized
error handling, Pino logging, `scripts/createUser.js`. Frontend token
storage + auto Bearer auth + 401 logout.

## Spec Stage 2 — Data Integrity: Validation & Pricing

Independent validators, shared money helpers, server-side price
verification, server-recomputed totals, discounts capped at 100%.

## Spec Stage 3 — Inventory Correctness

`Product.reserved` + `lowStockThreshold`, atomic reserve/release, order
commit uses a Mongo transaction, manual stock correction is admin-only.
Requires a replica set. (Abandoned-reservation expiry completed Stage 4.)

## Spec Stage 4 — Draft Bills

`PendingBill` persistence per cashier, draft GET/POST/DELETE, order
commit uses the persisted draft, background expiry sweep, frontend
autosave/restore/discard. Gap: ~7s autosave window after a crash.

## Spec Stage 5 — Customer & Supplier Credit

Split selling/buying price histories, `amountPaid`/`balanceDue`/
`paymentStatus`/`payments[]`, customer outstanding balance, Supplier
model + purchase flow (transactional restock), `Suppliers.jsx`. Gap: no
later "pay existing balance" flow.

## Spec Stage 6 — Discounts UI

`discountType`: `none|preset|manual`, 10/15/20% + manual UI, flows
through draft persistence, `discountAmount` server-computed. Gap: not
shown in Billing receipt/cart.

## Spec Stage 7 — Admin Bill Editing & Refunds

`Refund` model + order `editHistory`, `active/refunded` status,
admin-only edit (72h window) and refund (no time limit), atomic stock
restore, recomputed totals, `/api/orders` routes, `Orders.jsx`. Gap:
refund cash-back vs store-credit not distinguished.

## Spec Stage 8 — Search, Sort & Pagination

Shared query/search/pagination utilities across Products/Customers/
Orders/Suppliers; debounced search, sortable headers, pagination UI,
lazy-loaded inline details. Gaps: no sort allow-list, fielded search, or
URL state.

## Spec Stage 9 — Dashboard Reporting

Week/month/year ranges, order/refund/exchange counts, customer credit +
supplier payable snapshots, `totalSales` net of edits/refunds, stat
cards. Gaps: order-date vs refund-date scopes differ; dashboard route
under-protected (**closed in Stage 12**).

## Spec Stage 10 — CSV/Excel Export

`lib/reports.js`, dependency-free RFC 4180 CSV writer,
`GET /api/export/{summary,sales,refunds,credit,payables}` (auth +
`ENABLE_EXPORTS`), `Reports.jsx`. Verified end-to-end. Scope limitation:
CSV, not binary `.xlsx`.

## Spec Stage 11 — Offline Sync Module

Optional (`ENABLE_OFFLINE_SYNC` / `VITE_ENABLE_OFFLINE_SYNC`).
`OfflineSale` model w/ idempotency, `POST /api/sync/commit`,
`GET /api/sync/conflicts`, `POST /api/sync/conflicts/:id/resolve`,
durable IndexedDB queue, connectivity watcher, offline Billing fallback,
Reports conflict panel. **End-to-end verified in a real browser +
database**: offline sale created, queued, auto-synced on reconnect,
conflict reproduced and resolved. Deliberate limitations: device-local
queue, no substitute-item editing during conflict resolution, no max
pending duration, not stress-tested at scale.

## EJS removal — MERN-only

Cleanup pass once React covered every screen. Deleted `views/`,
`public/css`, `src/input.css`, `output.css`. `main.js` now serves
`frontend/dist` directly (unmatched GET → `index.html`; unmatched
`/api/*`/`/auth/*` → JSON 404). Removed `ejs`/root `tailwindcss` deps,
added `build-frontend` script; fixed a dev-proxy gap (`/supplier` was
missing). Rewrote `CLAUDE.md`/`frontend/README.md` to match reality.
Verified: full boot test, all client routes → 200, protected API routes
→ 401, unknown API → clean 404. One-way: no EJS fallback remains.

## Spec Stage 12 — Close Remaining Security Gaps

`GET /dashboard/load`, `GET /api/products`, `GET /api/customers` were
public — now `requireAuth`. Added `POST /auth/refresh` (silent re-auth:
re-reads user from DB, issues a fresh token) + a 30-min frontend refresh
interval in `AuthContext.jsx`, inside the default 8h `JWT_EXPIRES_IN`.
Gap (accepted tradeoff): refresh is interval-driven, not activity-aware.
**Verified:** `node --check` on changed files; all 4 routes boot-tested
live, correctly 401 with no token; `requireAuth` unit-tested directly
(valid/missing/malformed token); frontend builds. **Not verified:** DB
paths past the auth gate — no live MongoDB replica set in this sandbox
(applies to every stage below too, noted once here).

## Spec Stage 13 — Product Price Edit: Show Previous vs. New (Admin-only)

Products edit form and Suppliers purchase form both show a "Previous:
<amount>" line (admin-only, via `isAdmin`) next to the Price / Unit Cost
input, sourced from data (`p.price`/`p.costPrice`) already returned by
`GET /api/products` — no backend change needed. Simplification: no
purchase history shows as "Rs 0.00", consistent with
`getLatestBuyingPrice()`'s existing convention elsewhere.
**Verified:** frontend build + lint clean. Not exercised live (sandbox
limitation, see Stage 12).

## Spec Stage 14 — Unified Audit Log (Admin-only)

New `models/AuditLog.js` (`action`, `actor{username,role}`, `targetType`,
`targetId`, `before`/`after` snapshots, `date`, indexed). New
`lib/auditLog.js`: `logAudit(entry, session?)` — **fixed-size FIFO ring
buffer**, not unbounded: past `AUDIT_LOG_MAX_ENTRIES` (default 5000,
`.env`-configurable), each write evicts the single oldest entry. Plain
collection + app-level eviction, not a native Mongo capped collection
(stays consistent with this app's plain-collection/in-memory-pagination
convention; capped can't be resized without recreating). Logging
failures are caught/logged, never thrown. Hooked into all mutation
points — 12 action types:
`order.created/edited/refunded` (inside their existing transactions),
`product.created/updated/deleted/restored`,
`customer.updated/deleted/restored`,
`supplier.created/updated/deleted/purchase` (purchase logged inside its
existing transaction). New `GET /api/audit-log`
(`requireAuth`+`requireAdmin`), reuses Stage 8's search/sort/pagination
helpers. New frontend `AuditLog.jsx` (search, action filter,
sortable/paginated table, expandable before/after JSON) +
`AdminRoute.jsx` (admin-only route guard) + admin-only Sidebar link.

**Verified:** `node --check` on all backend files; frontend build+lint
clean; `GET /api/audit-log` boot-tested live — 401 no token, 403 cashier
token; all newly-touched mutation routes regression-checked, still 401
correctly; FIFO eviction unit-tested against a mocked model (8 writes,
cap=5 → exactly the 5 most recent survive). **Not verified:** DB paths
past the auth gate (sandbox limitation, see Stage 12).

## Stage 15 — Low-Stock Notifications (Admin-only)

In-app only (browser push flagged as a follow-up, per spec — needs a
service worker/HTTPS/permission prompt, bigger lift than scoped here).

New `GET /api/products/low-stock` (`requireAuth`+`requireAdmin`),
unpaginated: every product currently at-or-below `lowStockThreshold`
(`available = quantity - reserved`), sorted most-depleted first. Reuses
the same `available`/`lowStock` shape `GET /api/products` already
computes — no new model/schema. New frontend `LowStockBell.jsx`: bell +
badge count in `Topbar.jsx` (admin-only, same convention as Stage 14's
Audit Log link), checked on mount and every 60s, dropdown lists affected
products (name, ID, available/threshold) with the same red highlight
Products.jsx already uses, links through to `/products`. Cashiers never
see the bell at all (frontend gate) and the backend route 403s them
directly if called (real boundary).

**Verified:** `node --check` on `main.js`; live boot test —
`GET /api/products/low-stock` 401 with no token, 403 ("Admins only.")
with a cashier token, reaches the DB query correctly with an admin token
(times out past that point — no local MongoDB replica set in this
sandbox, same limitation as every stage since 12); regression-checked
`/api/products`, `/dashboard/load`, `/api/audit-log` still 401 with no
token. Frontend: `npm run build` and `npm run lint` both clean (one
pre-existing unrelated warning in `AuthContext.jsx`); boot-tested the
server serving the built `frontend/dist` — `/`, `/products` (SPA route)
→ 200, unknown `/api/*` → JSON 404. **Not verified:** the actual DB
query result / dropdown contents against live data (sandbox limitation,
see Stage 12) — the query itself is a straightforward `find()` + filter
matching `GET /api/products`'s already-verified `available`/`lowStock`
logic, not new aggregation.

## Stage 16 — Full Responsive Design Pass

Frontend-only CSS/Tailwind pass, no backend/schema/route changes. Covers
all 9 screens (Login, Dashboard, Billing, Products, Customers, Suppliers,
Orders, Reports, Audit Log).

**Sidebar** (`components/Sidebar.jsx`) rebuilt as a responsive drawer:
below `md` it's a fixed, off-canvas panel toggled by a hamburger button
(+ tap-to-close backdrop) that the component renders itself, so no page
had to change its own markup to get it; at `md`+ it's unchanged —
always-visible, in-flow, exactly as before Stage 16. Nav links close the
drawer on click (mobile). `Topbar.jsx` reserves space for the hamburger
(`pl-14` below `md`), wraps instead of overflowing at narrow widths, and
hides the username label (keeps the avatar) below `sm`.

**Billing** (highest-risk per spec — doesn't use Topbar, has its own
header): added matching hamburger clearance, header now wraps, the
`h-[600px]` three-panel grid only applies at `md`+ (stacks naturally
below that), and the product-search table sits in its own
`overflow-x-auto` with a `min-w-[560px]` floor instead of columns
crushing unreadably.

**Products / Customers / Suppliers** — all three share the same
list+edit-form two-pane pattern; that pane split now stacks vertically
through `lg` (list on top, form below, both full-width) and only goes
side-by-side at `lg`+. Each list table got `overflow-x-auto` + a `min-w`
floor (Products 640px, Customers 780px — 7 columns, Suppliers 640px, plus
its nested purchase-history sub-table at 520px) rather than squishing
columns. Search inputs go full-width below `sm`.

**Orders** — table wrapped in `overflow-x-auto` + `min-w-[720px]`; the
expanded per-order detail row was already a 1-col/2-col responsive grid
and needed no change.

**Dashboard** — stat-card grid changed from a `2 → 4` column jump to
`1 → 2 → 4`, both report tables wrapped in `overflow-x-auto`, header
wraps, padding scales down on mobile.

**Reports** — header wraps, padding scales down; the export-card grid and
offline-sync/conflict panel already used responsive patterns and needed
no table/overflow fixes.

**Audit Log** — already had `overflow-x-auto` from Stage 14; added a
`min-w-[700px]` floor for consistency and matching mobile padding. The
expandable before/after JSON `<pre>` blocks already scroll independently
and needed no change.

**Login** — fixed `w-96` card replaced with fluid `w-full max-w-sm/md`,
heading sizes scale down below `sm`, page padding added so the card never
touches the viewport edge; `h-screen` → `min-h-screen` so a very short
viewport doesn't clip content.

No new dependencies — existing Tailwind/`@tailwindcss/vite` setup
handled all of it, matching the spec's expectation.

**Verified:** `npm run build` and `npm run lint` clean (frontend) — same
one pre-existing unrelated `AuthContext.jsx` warning as every prior
stage, no new warnings/errors. Live boot test (server + built
`frontend/dist`, no MongoDB in this sandbox): `/` → 200, `/products` (SPA
route) → 200, `GET /api/products` no token → 401 (regression check,
unaffected by this stage), unknown `/api/*` → clean JSON 404. Reviewed
every touched screen's markup by hand at the mobile/tablet/small-laptop/
wide-desktop breakpoints named in the spec, including nested elements
(Orders' expanded detail row, Suppliers' purchase-history sub-table,
Audit Log's before/after JSON panel) for scroll/stacking correctness.
**Not verified:** no real browser in this sandbox to visually confirm
against actual device viewports or to check touch-target sizing
empirically — this was a code-level review against Tailwind's documented
breakpoints, not a rendered-pixel check. Recommend a quick manual pass in
a real browser (or its responsive-mode devtools) before calling this
stage fully closed, particularly on Billing given its density.

## Route Inventory — End of Stage 15

**Public:** `POST /auth/login`, `POST /billing/orderid`
**Authenticated:** `POST /auth/refresh`, `GET /api/products`,
`GET /api/customers`, `GET /dashboard/load`, product/customer/supplier
mutation routes, billing reserve/release/draft/order routes,
`GET /api/orders(/:orderID)`, Stage 10 export routes,
`POST /api/sync/commit`
**Authenticated + Admin:** `POST /billing/update`,
`POST /api/order/:orderID/edit`, `POST /api/order/:orderID/refund`,
`GET /api/sync/conflicts`, `POST /api/sync/conflicts/:id/resolve`,
`GET /api/audit-log`, `GET /api/products/low-stock` (Stage 15)
**Frontend:** unmatched GET outside `/api`/`/auth` → `index.html`; React
Router owns `/`, `/dashboard`, `/billing`, `/products`, `/customers`,
`/suppliers`, `/orders`, `/reports`, `/audit-log` (admin-only). Unmatched
`/api/*`/`/auth/*` → JSON 404.

List routes support `search`/`sortBy`/`sortDir`/`page`/`limit`. Dashboard
supports `range=week|month|year`. Exports: `summary`, `sales`, `refunds`,
`credit`, `payables`.

## Current Known Cross-Cutting Gaps

1. ~~Public read routes~~ / ~~No refresh-token flow~~ — closed, Stage 12.
2. Billing receipt/cart does not display stored `discountAmount`.
3. Refund cash-back vs store-credit is not distinguished.
4. Stage 8 sort allow-list, fielded search, URL state remain absent.
5. Dashboard refund count/amount use different date scopes.
6. Offline sync not stress-tested at scale.

## Current Status

Stages 1–16 implemented. Stage 11 **end-to-end verified in a real
browser + database**. Stages 1–10/12–16 verified by
build/lint/`node --check`/boot-test/unit-test per stage above — DB paths
past the auth gate are code-reviewed only (no replica set in this
sandbox), and Stage 16's responsive layout is code-reviewed against
Tailwind breakpoints rather than checked in a real browser (no browser
available in this sandbox either — see Stage 16 above). EJS removal
complete and verified. Remaining items are deliberate scope limitations
and security/stress-testing/manual-responsive-check follow-ups unless a
new spec adds scope.

Stage 15's browser push follow-up (real OS-level alerts) remains an
explicitly deferred stretch goal, not scheduled.

## Stage Numbering Note

Spec stages are independent of the initial React migration stage. Use
the `Spec Stage N` headings when matching supplied stage specifications.
