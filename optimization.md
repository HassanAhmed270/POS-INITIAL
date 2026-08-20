# POS System — Optimization Plan (Post Stage 11 / EJS Removal)

Continuation of `IMPROVEMENT_PLAN.md`. Stages 1–11 plus the EJS-removal
pass are done (see `progress.md`). This file picks up from there: gaps
found while auditing the finished work, plus new requirements given
directly. Same format as the original plan — ordered by dependency,
each with an exit criteria — so it can be worked the same way.

Nothing in this file has been built yet. This is planning only.

---

## Stage 12 — Close Remaining Security Gaps
*Carried over from the Stage 9/EJS-removal audit — the riskiest thing to leave sitting in production, so it goes first.*

1. Add `requireAuth` to `GET /dashboard/load`, `GET /api/products`, `GET /api/customers` — currently public. Anyone with the URL can read sales totals, customer credit exposure, and the full product/customer list with no login.
2. Add a refresh-token (or silent re-auth) flow. Currently a flat 8-hour JWT with no renewal — a cashier mid-shift gets hard-logged-out with no graceful recovery, which will get worse once the desktop/offline work (Stage 18) makes sessions live longer between server contact.

**Exit criteria:** no route returns business data without a valid token; a session can be extended without forcing a full re-login mid-shift.

---

## Stage 13 — Product Price Edit: Show Previous vs. New Amount (Admin-only)
*Depends on Stage 1 (roles) — already done. Small, self-contained.*

The data already exists (`sellingPriceHistory`/`buyingPriceHistory` are
already arrays, not scalars — see `lib/pricing.js`). This is a UI gap, not
a data-model gap.

1. On the Products edit form, when an admin opens a product to change its
   price, show the current/previous price (last entry in the history)
   alongside the new-price input, so the admin can see what it was vs.
   what they're about to set it to.
2. Same treatment for buying price on the Suppliers purchase-recording
   flow, since that's the other place a price gets changed.
3. Non-admin (cashier) view stays as-is — this is admin-only visibility,
   not a change to what cashiers see.

**Exit criteria:** an admin changing a product's price can always see the
old value next to the new one before confirming, on both the selling-price
(Products) and buying-price (Suppliers) sides.

---

## Stage 14 — Audit Log (Refunds, Updates, New Bills)
*Depends on Stage 1 (roles/`req.user`) and Stage 7 (existing edit/refund data to build on).*

Right now, auditability is scattered: `Order.editHistory[]` covers admin
edits, the `Refund` model covers refunds, but there's no single place to
answer "what happened, when, and who did it" across the app — and nothing
at all logs product/customer/supplier updates or plain new-bill creation.

1. Add an `AuditLog` model: `action` (e.g. `order.created`,
   `order.refunded`, `order.edited`, `product.updated`,
   `customer.updated`, `supplier.updated`), `actor` (username + role),
   `targetType`/`targetId`, `before`/`after` snapshot (or diff) where it
   makes sense, `timestamp`.
2. Write an entry at the point each of those actions actually commits —
   piggyback on the existing transactions where one already exists
   (order commit, edit, refund) rather than adding new ones.
3. Add an admin-only Audit Log screen (list, filterable by action type /
   date range / actor — reuse Stage 8's search/sort/pagination pattern).
4. Decide retention: keep everything, or cap/archive old entries — flag
   this as a follow-up decision, not blocking for this stage.

**Exit criteria:** every refund, every admin edit, every new bill, and
every product/customer/supplier update produces a durable, admin-visible
record of who did it and when.

---

## Stage 15 — Low-Stock Notifications
*Depends on Stage 3's `lowStockThreshold` (already exists) — this stage is the actual notification, the red-highlight UI already covers the passive/in-context part.*

1. In-app notification first (no new infra required): a badge/bell in the
   header showing a count of products currently at-or-below threshold,
   admin-visible, checked on load and on an interval or after any stock
   change.
2. Clicking it lists the affected products (name, current stock,
   threshold) — reuse the existing product list styling.
3. Browser push notifications (real OS-level alerts) are a stretch goal,
   not default scope — they need a service worker, HTTPS, and explicit
   user permission, which is a meaningfully bigger lift. Flag as a
   follow-up if in-app isn't enough once it's actually used.

**Exit criteria:** an admin logging in (or already logged in when stock
drops) sees a clear, unmissable signal that something needs reordering,
not just a red row they have to happen to scroll past.

---

## Stage 16 — Full Responsive Design Pass
*Independent of the others — can run in parallel with any of them. Worth doing before Stage 18 (desktop exe), since that introduces more variable window sizes than a fixed browser tab.*

1. Audit every screen (Login, Dashboard, Billing, Products, Customers,
   Suppliers, Orders, Reports) at common breakpoints (mobile, tablet,
   small laptop, wide desktop) — not just "does it not break," but "is it
   actually usable" (tap targets, table overflow, modal sizing).
2. Billing is the highest-risk screen — it's the most element-dense
   (product search, cart, discount UI, payment) and the one most likely
   to be used on something other than a full desktop monitor.
3. Tables (Products/Customers/Orders/Suppliers) need a real mobile
   strategy — horizontal scroll, column priority/collapse, or a
   card-based layout under some width — not just letting them overflow.
4. No new dependency expected (existing Tailwind setup handles this) —
   this is a design/CSS pass, not an architecture change.

**Exit criteria:** every screen is fully usable — not just "not visually
broken" — from phone width up through desktop, with no horizontal
page-scroll and no element that's unreachable or unreadable at any
supported width.

---

## Stage 17 — Real PDF Receipts
*Blocked — waiting on a template/pattern to be provided before implementation starts.*

Currently receipts are a plain `window.open()` print popup
(`frontend/src/lib/print.js`) styled with inline HTML — functional, but
not a real document.

1. **Waiting on input:** an actual receipt pattern/layout will be
   provided separately before this stage is scoped in detail.
2. Once the pattern's in hand: this is a mechanism swap, not a data
   change — Stage 6/7's data (discounts, edit history, payment status)
   is already final and already flows into the current print view: it
   should be a matter of pulling that same data into a real generated
   PDF (client-side, e.g. via a library, or server-side) instead of the
   browser print dialog.
3. Should stay consistent with the existing "revised" print view for
   edited orders (Stage 7) — a PDF receipt needs the same edit-history
   treatment, not a regression to a single flat receipt.

**Exit criteria:** not yet defined — depends on the provided pattern.
Revisit this stage once it arrives.

---

## Stage 18 — Desktop Distribution: Local Frontend + Hosted Backend
*Depends on Stage 11 (offline sync) — this is what makes offline sync go from "nice to have for flaky wifi" to "the normal operating mode," since the whole point is a local desktop app talking to a backend that isn't on the same network.*

The ask: the frontend should be runnable as a local desktop
executable (no hosting needed for the frontend itself), while the
backend stays hosted remotely (cloud-hosted MongoDB + Express). This
also means offline capability matters more, not less — a request to
a remote backend can fail for reasons a LAN-hosted one wouldn't
(internet down, backend deployment mid-restart, DNS hiccup), and the
shop still needs to be able to sell during all of those.

1. **Configurable API base.** Today, `frontend/src/lib/api.js` and
   `vite.config.js`'s dev proxy assume same-origin (frontend and backend
   served together, post EJS-removal). A desktop build needs a real,
   configurable base URL (e.g. `VITE_API_BASE=https://your-backend.example.com`)
   baked in at build time, since there's no same-origin relationship once
   the frontend isn't served by the same Express process.
2. **CORS.** The hosted backend needs to actually accept requests from
   the packaged app's origin (`file://` or a custom Electron/Tauri scheme)
   — currently there's no CORS configuration at all, because same-origin
   never needed one.
3. **Desktop wrapper.** Electron is the more mature/documented option;
   Tauri is meaningfully smaller and lighter-weight if a native binary
   size/footprint matters — needs a decision, not a default assumption.
   Either way: package `frontend/dist`, point it at the configured API
   base, produce an installable/portable `.exe`.
4. **Offline sync becomes primary, not exceptional.** Stage 11's module
   already does the hard part (durable queue, conflict resolution) — this
   stage's job is making sure it's tuned for "regularly offline for
   real stretches," not just "occasionally offline for a few seconds":
   revisit the 15-second flush interval, make the offline/pending-sync
   state more prominent in the UI than the current banner, and actually
   run the stress-testing that Stage 11 flagged as not yet done (large
   queue, long outage, multiple devices reconnecting at once).
5. **Auto-update** for the desktop app is a reasonable follow-up once
   the packaging itself works, not a blocker for the first version.

**Exit criteria:** the packaged desktop app runs on a machine with no
local Node/Express/MongoDB installed at all, talks to the hosted backend
when reachable, keeps working (queuing sales) when it isn't, and syncs
cleanly when connectivity returns.

---

## Reported, Needs More Detail

**Supplier purchase bug** — a bug was flagged while recording a purchase
from a supplier ("buying from him"), but the report cut off before the
actual symptom was described. Needs reproduction steps (what was entered,
what was expected, what happened instead) before this can be scoped or
fixed. Flagging here so it isn't lost — follow up with the actual bug
description.

---

## Still Deferred (from the original plan, unchanged)

- Tax handling
- Barcode scanning
- Automated test suite
- (Real PDF receipts moved from here to Stage 17 above — no longer purely deferred, just blocked on input)