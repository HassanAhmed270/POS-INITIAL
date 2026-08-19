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