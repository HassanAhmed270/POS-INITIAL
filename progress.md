# Billing System Rebuild — Progress Log

Companion to `CLAUDE.md`, which contains full narrative detail per stage.

Fast-reference version: what exists, where, and what remains open.

Repo root: `POS-INITIAL/`. Backend: Express + Mongoose at root (`main.js`).
Frontend: React + Vite + Tailwind in `frontend/`.
Legacy EJS views are reference-only and are not maintained.

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

## Route Inventory — End of Stage 11

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
- `POST /order/:orderID/edit`
- `POST /order/:orderID/refund`
- `GET /api/sync/conflicts`
- `POST /api/sync/conflicts/:id/resolve`

List routes support:
`search`, `sortBy`, `sortDir`, `page`, `limit`.

Dashboard supports:
`range=week|month|year`.

Exports:
`summary`, `sales`, `refunds`, `credit`, `payables`.

## Current Known Cross-Cutting Gaps

1. Some read routes remain public/auth-only.
2. Legacy EJS application remains broken/reference-only.
3. No refresh-token flow.
4. Billing receipt/cart does not display stored `discountAmount`.
5. Refund cash-back vs store-credit is not distinguished.
6. Stage 8 sort allow-list, fielded search and URL state remain absent.
7. Dashboard refund count/amount use different date scopes.
8. Offline sync has not been stress-tested at scale.

## Current Status

Stages 1–10 are implemented and verified.

Stage 11 is implemented and **end-to-end verified in the real browser and
database**, including offline sale creation, durable queueing, automatic
reconnection sync, conflict detection and conflict resolution.

No unresolved functional issue was found in the primary Stage 11 flow.

Remaining items are deliberate scope limitations, security hardening,
and stress-testing unless the next specification adds new functionality.

## Stage Numbering Note

The spec stages are independent of the initial React migration stage.
Use the `Spec Stage N` headings in this file when matching the supplied
stage specifications.