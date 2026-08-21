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

## Stage 17 — Special Bill (Alternate Receipt Layout)

Scoped from a supplied catering-invoice reference image once it arrived
(this stage was blocked on that — see prior entry). Turned out to be a
different ask than the original Stage 17 framing ("swap the print popup
for a real generated PDF") — instead: a **second, selectable receipt
layout**, previewed before commit, both still going through the existing
`window.open()` print flow (`lib/print.js` untouched).

Billing.jsx now has two buttons at the payment step: **Generate Bill**
(unchanged — original plain-table receipt) and **🧾 Special Bill**, which
opens an on-screen preview modal styled after the reference image
(double border, "INVOICE" title, BILLED TO / ORDER INFO two-box header,
Quantity/Description/Price/Amount table, Grand Total, italic "Thanks"
footer) before anything is committed. The modal's own "Generate Bill"
button then runs the exact same commit path as the normal button
(`saveDraftNow` → `api.saveOrder`, same validation, same Stage 11
offline-queue fallback) and prints using the special layout instead of
the default one — `handleGenerateBill` took a `special` flag rather than
becoming two separate functions, so there is one commit path, not two.

**No new fields anywhere** — every value on the Special Bill layout
already existed: Bill ID, order date, cashier (`username`), payment
method, cart line items, and Grand Total/Paid/Balance are the same as the
default receipt; customer mobile/address/email are real `Customer`
document fields already returned by `GET /api/customers` (Stage 8) —
Billing previously only kept the customer *name* from that response for
its dropdown and discarded the rest, so a `customerDirectory` lookup
(name → {mobileNo, email, address}) was added to keep what the API
already sends, not to add new data. The reference template's Ship To,
Delivery Date/Terms/People/Delivery Time, and company-logo/address boxes
were dropped entirely — no such fields exist anywhere in this app's
schema, and the ask was explicit that none should be added.

**Verified:** `npm run build` and `npm run lint` clean (frontend) — same
one pre-existing unrelated `AuthContext.jsx` warning as every prior
stage, no new ones. Live boot test of the server serving the built
`frontend/dist` (no MongoDB in this sandbox): `/` → 200, `/billing` (SPA
route) → 200, `GET /api/products` and `GET /api/customers` (regression
check, unrelated to this stage's change) → 401 with no token, all
unchanged. **Not verified:** no live MongoDB replica set or real browser
in this sandbox — the actual print popup output, the on-screen preview
modal's rendering, and a real order commit through either button path
are code-reviewed only, not exercised end-to-end. Recommend a manual
pass (place a real cart, try both buttons, confirm the print dialog
layout matches) before treating this as fully closed.

**Addendum — logo:** both the printed HTML and the on-screen preview
modal now reference `frontend/public/logo.png` (top of the invoice,
above the "INVOICE" title) — the person's shop logo, dropped into
`frontend/public/` by them, not something this app generates or stores.
The printed popup uses an absolute URL (`window.location.origin +
'/logo.png'`) since it's a blank window with no base URL of its own to
resolve a relative path against; the on-screen preview uses a normal
relative `/logo.png` (served from the app's own origin either way). Both
fail gracefully (`onerror`/`onError` hides the `<img>`) if the file isn't
present yet, so this doesn't break anything before the logo is actually
added. Not verified with a real file in this sandbox — only that the
markup builds clean and degrades safely without one.

## Stage 19 — Worker Permissions & Walk-in / Unknown Customers

(Stage 18 — Desktop Distribution — remains skipped/deferred; commented
out in `optimization.md` rather than deleted, per the person's note that
it tends to get skipped. Picking up at 19.)

**Backend permission tightening** — `requireAdmin` added (alongside the
existing `requireAuth`) to the product and supplier *master-data*
mutation routes: `POST /api/product` (create/update), `DELETE
/product/:productID`, `POST /product/undo`, `POST /api/supplier`
(create/update), `DELETE /supplier/:supplierName`. This is enforced at
the route/middleware level, same pattern as the existing admin-only
routes (`/billing/update`, `/api/order/:orderID/edit`, etc.) — a worker
calling these directly with a valid worker token now gets a clean 403
`{ success: false, message: 'Admins only.' }`, not just a hidden button.

**Deliberately left `requireAuth`-only (not admin-gated):**
`POST /supplier/purchase` (restocking) and `POST /billing/addCustomer` /
`POST /customer/updateCustomer` — restocking is inventory work, not
supplier*-management* (it references an existing supplier, it doesn't
create/edit/delete one), and customer creation is explicitly meant to
stay available to workers per the spec. This matches Stage 20's existing
note in `optimization.md` that a restock screen shouldn't imply
supplier-management rights.

**Frontend UI gating** — `Products.jsx` and `Suppliers.jsx` already
imported `useAuth`/`isAdmin` for the Stage 13 "previous price" display;
that same flag now also gates the mutation UI itself for non-admins:

* Products — the Edit/Delete icons per row, the whole Add/Update form
  panel, and the "Add Product +" / "Undo Deleted" buttons are all
  `isAdmin`-only. A worker sees the product table (read-only) with an
  em-dash in the Actions column instead of the icons, and the whole
  right-hand form panel doesn't render (list takes the full width
  instead of 2/3).
* Suppliers — the Delete icon per row and the whole "Add Supplier" form
  panel are `isAdmin`-only. The "Record a Purchase" (restock) form below
  is untouched and stays available to everyone, matching the backend.

No change was needed to `App.jsx`/`Sidebar.jsx` routing — both pages stay
reachable by workers (they still need to browse products/suppliers and
restock), only the mutation affordances inside them are gated. This is
different from Stage 14's Audit Log pattern (fully admin-only route via
`AdminRoute`), which fits here since Stage 19 explicitly wants workers to
keep read/restock access, not be bounced from the page.

**Walk-in / Unknown customer** — a new `Walk-in / Unknown` option was
added to Billing's customer dropdown (`🚶 Walk-in / Unknown`), between
the placeholder and the real customer list. This is a plain sentinel
*string*, not a code — `WALKIN_CUSTOMER = 'Walk-in / Unknown'` is defined
identically in both `main.js` and `Billing.jsx` (with a comment on each
side pointing at the other) since the frontend already sends whatever's
in `customer` state straight through as `customerName`, same as any real
customer name. No new field, no new draft/order shape.

`POST /billing/orderDetails` now special-cases this exact value: it
skips the `Customer.findOne` lookup/404 entirely (there's nothing to
find) and skips the `Customer.updateOne $push` that records order history
against a customer (there's no customer document to push onto). Every
other part of the existing commit path — price re-verification, the
atomic stock decrement, payment/balance calculation, the Order document
itself, the audit log entry — runs unchanged; a walk-in sale is a fully
real, fully audited `Order`, it's just not attached to any `Customer`
document. Dashboard/report aggregations that group by `Order.customerName`
directly (`lib/reports.js`'s sales/refund summaries, CSV exports) will
naturally show "Walk-in / Unknown" as a bucket; the *credit*-related
aggregations (`Customer.aggregate` for total credit, the payables report
keyed off `Customer.find({'orders.balanceDue': {$gt:0}})`) never see
walk-in sales at all, since nothing was ever pushed to a Customer
document — so a walk-in sale can never accidentally create/contribute to
a credit account, per spec.

No changes were needed to `POST /billing/draft` (already accepts any
`customerName` string permissively — it just autosaves whatever's typed)
or to `PendingBill`/`Order`/`Customer` schemas.

**Verified:** `node --check` clean on every touched/adjacent backend
file. Live boot test (no MongoDB in this sandbox): unauthenticated
requests to the now-admin-gated routes → 401 (unchanged); a worker-role
JWT against `POST /api/product`, `POST /api/supplier`, `DELETE
/product/:productID`, `POST /product/undo`, `DELETE
/supplier/:supplierName` → clean 403 `Admins only.`; the same worker
token against `POST /supplier/purchase`, `POST /billing/addCustomer`,
`GET /api/products`, and `POST /billing/draft` with
`customerName: "Walk-in / Unknown"` → all pass the auth/role gate (500,
not 401/403 — the expected shape with no live DB in this sandbox); an
admin-role JWT against `POST /api/product` and `DELETE
/supplier/:supplierName` → likewise passes the gate (500, not 403).
`npm run build` and `npm run lint` clean on the frontend — same one
pre-existing unrelated `AuthContext.jsx` warning as every prior stage, no
new ones. Re-ran the full boot test against the built `frontend/dist`
afterward: `/`, `/products`, `/suppliers`, `/billing` (SPA routes) → 200,
unknown `/api/*` → clean JSON 404, `GET /api/products` with no token →
401 (regression, unchanged).

**Not verified:** no live MongoDB replica set or real browser in this
sandbox — the actual DB-backed behavior (a worker's product/supplier
mutation attempt being rejected *after* successfully authenticating, a
real walk-in order committing end-to-end and never appearing in a credit
report, the dropdown/UI rendering correctly for a logged-in worker vs.
admin) is code-reviewed and auth/role-gate-tested only, not exercised
against a real database or in a real browser. Recommend a manual pass
(log in as both roles, try Products/Suppliers mutations as a worker, run
a walk-in sale through Billing) before treating this fully closed.

## Route Inventory — End of Stage 15

**Public:** `POST /auth/login`, `POST /billing/orderid`
**Authenticated:** `POST /auth/refresh`, `GET /api/products`,
`GET /api/customers`, `GET /dashboard/load`, customer mutation routes,
`POST /supplier/purchase` (restock), billing reserve/release/draft/order
routes (including a `Walk-in / Unknown` `customerName`, Stage 19),
`GET /api/orders(/:orderID)`, Stage 10 export routes,
`POST /api/sync/commit`
**Authenticated + Admin:** `POST /billing/update`,
`POST /api/order/:orderID/edit`, `POST /api/order/:orderID/refund`,
`GET /api/sync/conflicts`, `POST /api/sync/conflicts/:id/resolve`,
`GET /api/audit-log`, `GET /api/products/low-stock` (Stage 15),
`POST /api/product`, `DELETE /product/:productID`, `POST /product/undo`,
`POST /api/supplier`, `DELETE /supplier/:supplierName` (Stage 19 — moved
from plain `requireAuth`; product/supplier *master-data* mutations are
now admin-only, restocking and customer creation remain worker-accessible)
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

Stages 1–17 and 19 implemented (Stage 18, desktop distribution, remains
deliberately skipped/deferred — see the note at the top of its Stage 19
entry above). Stage 11 **end-to-end verified in a real browser +
database**. Stages 1–10/12–17/19 verified by
build/lint/`node --check`/boot-test/unit-test per stage above — DB paths
past the auth gate are code-reviewed only (no replica set in this
sandbox), Stage 16's responsive layout and Stage 17's print/preview
output are code-reviewed against Tailwind breakpoints / the reference
image rather than checked in a real browser (no browser available in
this sandbox either — see Stage 16/17 above). EJS removal complete and
verified. Remaining items are deliberate scope limitations and
security/stress-testing/manual-check follow-ups unless a new spec adds
scope.

Stage 15's browser push follow-up (real OS-level alerts) remains an
explicitly deferred stretch goal, not scheduled.

## Stage Numbering Note

Spec stages are independent of the initial React migration stage. Use
the `Spec Stage N` headings when matching supplied stage specifications.
