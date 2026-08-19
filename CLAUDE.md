# CLAUDE.md

This file gives Claude Code (claude.ai/code) the context it needs to work in this repository.

## What this project is

A simple **Point-of-Sale / Billing Management System** for a single shop, built as a monolithic Express + EJS server-rendered app backed by MongoDB. There is no build step for the backend and no frontend framework — pages are rendered server-side with EJS and given interactivity via inline `<script>` blocks using `fetch()` against JSON API routes on the same server.

Core entities: **Products**, **Customers**, **Orders** (bills). The app has four screens: Login, Dashboard, Billing (create invoice), Products, Customers.

## Commands

```bash
npm install          # install dependencies
npm start             # run the server via nodemon (main.js), reads PORT env var, defaults to 3000
npm run build          # one-off Tailwind CSS build: src/input.css -> public/css/output.css
npm run watch           # Tailwind build in watch mode (run during frontend/EJS work)
```

There are no automated tests (`npm test` is a stub that exits with an error) and no linter configured. There is no `.env` handling — MongoDB URI is hardcoded (see below).

MongoDB must be running locally (`mongodb://localhost:27017/billing_system`) for the app to function; without it the server still starts but every DB-backed route will fail.

## Architecture

- **`main.js`** — single entry point containing the Express app, all routes, and the MongoDB connection. There is no router/controller/service split; everything (including business logic like restocking math and dashboard aggregation) lives inline in route handlers.
- **`models/`** — three Mongoose schemas:
  - `Product.js` — `productID` (format `#0000`, regex-enforced, unique), `productName`, `category`, `quantity`, `unitPrice` (array of `{price, date}` — a price *history*, not a single field), `supplier`, `hidden`.
  - `Customers.js` — `customerName` (unique, whitespace-normalized via a Mongoose `set`), `mobileNo`, `emergencyMobile`, `email`, `address`, and an embedded `orders` array (`orderNo` + `orderDate` only — a lightweight reference, not the full order).
  - `Order.js` — `orderID` (format `#0000`), `customerName`, `products` (embedded array of `{productID, quantity, amount, discount}`), `cashier`, `totalAmount`, `orderDate`.
- **`views/`** — EJS templates, one per page (`login`, `dashboard`, `billing`, `product`, `customer`, `newcustomer`), plus `sidebar.ejs` which is `include`d into the authenticated pages for nav. Almost all client-side logic (cart building, search/filter, modals, undo-toasts after delete) is written as vanilla JS inside `<script>` tags at the bottom of each `.ejs` file — this is where most "frontend logic" actually lives, not in separate JS files.
- **`public/css/output.css`** — compiled Tailwind output, generated from **`src/input.css`** by the `build`/`watch` scripts. `login.ejs` links this compiled file; other pages instead load the Tailwind CDN script directly (`<script src="https://cdn.tailwindcss.com">`) — the two approaches are mixed inconsistently across views.

### Data flow pattern

Each page route (`GET /billing`, `GET /product`, `GET /customer`, `GET /dashboard`) does a server-side Mongoose fetch and renders an EJS template with the data. Mutations (add/edit/delete product or customer, save an order) go through separate `POST`/`DELETE` JSON API routes that the page's inline `<script>` calls via `fetch()`, then the script updates the DOM or reloads — there's no client-side routing or state management library.

### Notable implementation details / quirks to be aware of

- **No authentication**: `POST /dashboard`... actually `GET /dashboard` just reads `?username=` from the query string and renders it — login does not check credentials against a database at all; any username/password logged in via the form is accepted and just passed through as a query param on redirect.
- **IDs are business identifiers, not Mongo `_id`s**: products and orders use a human-facing `#0000`-style ID (regex `^#\d{4}$`) as the real lookup key throughout the app (`Product.findOne({ productID })`, etc.).
- **"Restock" via re-submitting the add-product form**: `POST /product` checks whether a `productID` already exists — if so it *adds* the submitted stock to existing stock rather than creating a duplicate; only creates a new product doc if the ID is new.
- **Undo pattern**: delete routes (`/product/:productID`, customer delete) just delete; the corresponding `/product/undo` and `/customer/undoCustomer` POST routes exist so the frontend can show an "undo" toast and re-insert the same data if the user clicks it within a time window. This restore logic lives client-side in the EJS `<script>` blocks, not as a server-side soft-delete/trash mechanism.
- **`unitPrice` is an array**, not a scalar — code reads current price as `unitPrice.price` in some places, which likely refers to `unitPrice[unitPrice.length - 1].price` conceptually but should be checked carefully when touching pricing logic, since Mongoose projections like `"unitPrice.price"` return the whole array of price objects.
- **Customer linkage on order save** (`POST /billing/orderDetails`): saves the `Order` doc, then separately does `Customer.updateOne({customerName}, {$push: {orders: {...}}})` — these two writes are not wrapped in a transaction, so a crash between them can leave an order that isn't referenced from the customer record.
- **Mixed languages/comments**: some inline comments are in Roman Urdu/English mix (e.g. `// 🔥 JSON handle karne ke liye`) — this is a solo/small-team project without a strict style guide; match the existing tone if editing nearby code rather than imposing a different convention.
- **Hardcoded config**: `MONGO_URI` and `port` fallback are hardcoded in `main.js` rather than pulled from a `.env` file — if adding config, consider introducing `dotenv` rather than continuing to hardcode, but check with the user first since this is a deliberate simplicity choice in a small project.

## Frontend migration (React + Vite + Tailwind) — in progress

The UI is being rebuilt page by page as a React app in **`/frontend`**,
replacing the EJS views one screen at a time. This section is the source of
truth for that migration and gets updated at the end of every stage — read
it before making further frontend changes.

### Structure

- **`/frontend`** — new React app (Vite, Tailwind via `@tailwindcss/vite`
  package, no CDN). Talks to the existing Express backend over JSON only;
  it never touches MongoDB directly. See `frontend/README.md` for the
  detailed layout and run instructions.
  - `frontend/src/pages/` — one component per screen (`Login`, `Dashboard`,
    `Billing`, `Products`, `Customers`) — mirrors `views/*.ejs` 1:1 by name.
  - `frontend/src/components/` — `Sidebar`, `Topbar`, `ProtectedRoute`
    (shared chrome, was `sidebar.ejs` + inline header markup per page).
  - `frontend/src/lib/api.js` — **every** backend call goes through here.
    When adding a new API interaction, add it here rather than calling
    `fetch` directly from a component.
  - `frontend/src/lib/AuthContext.jsx` — client-side session (username in
    `sessionStorage`). No real credential check exists yet on the backend
    either, so this intentionally mirrors that (see "No authentication"
    below) — don't add fake client-side validation that implies otherwise.
- **`main.js` / `models/` / `views/`** — unchanged and still fully
  functional as the original server-rendered app. Left in place
  intentionally as a working reference while the migration is in progress;
  do not delete until the whole frontend has been migrated and the person
  confirms it's safe to remove.
- **`public/css`, `src/input.css`, root `package.json`'s `build`/`watch`
  scripts** — belong to the old EJS/Tailwind-CDN setup. Not used by
  `/frontend`, which has its own Tailwind pipeline.

### Backend additions made to support the React app

Two JSON endpoints were added to `main.js`, additive only — nothing
existing was removed or changed:
- `GET /api/products`, `GET /api/customers` — JSON list data (the EJS
  routes fetched this server-side; React needs it as JSON).
- `POST /api/product` — same add/restock logic as `POST /product`, but
  responds with JSON instead of a redirect (that route is shaped for an
  HTML form submit).

Everything else the frontend calls (`/billing/*`, `/customer/*`,
`/product/undo`, `DELETE /product/:id`) already returned JSON and is reused
unchanged.

### UI/UX fixes applied during this stage (kept intentionally small)

- Sidebar's dead `href=""` links (Reports/Workers/Suppliers/Webpage) are
  now visibly disabled instead of silently doing nothing.
- Header avatar no longer depends on `via.placeholder.com` (was liable to
  break with no network) — replaced with a initials badge.
- Empty dashboard tables now show a "no data" row instead of staying blank.
- Product/Customer "select row → edit" is a plain click-to-edit instead of
  the original's checkbox + two-hidden-forms + broken `openDelete()`
  no-op — same backend calls, fewer moving parts.
- Colors that were hardcoded as `bg-[#065b8a]` etc. throughout the EJS
  views are now Tailwind theme tokens (`bg-brand`, `text-brand-green`, …)
  defined once in `frontend/src/index.css`.

No behavior beyond the above was intentionally changed — anything else
that looks different from the EJS version is a bug, not a redesign.

### Stage log

| Stage | Date | What changed |
|---|---|---|
| 1 | 2026-08-10 | Scaffolded `/frontend` (Vite + React + Tailwind package, no CDN). Ported all 5 screens (Login, Dashboard, Billing, Products, Customers) to React, wired to the existing backend via 2 new JSON endpoints. No visual redesign — same layout/colors/copy as the EJS views, only the flaws listed above fixed. |

When a new stage lands, append a row here (don't rewrite history) and
update any section above that's now stale.

## Working in this codebase

- Routes, models, and views are all fairly small — when adding a feature, prefer following the existing pattern (inline route handler in `main.js`, Mongoose model in `models/`, EJS view with inline `<script>`) over introducing new architectural layers (routers, controllers, a frontend build pipeline) unless asked.
- When editing anything touching prices or stock quantities, double-check the `unitPrice` array-of-history shape in `Product.js` and the `isNaN(parseInt(...))`-guarded parsing pattern used throughout `main.js` for numeric form fields — replicate that defensive parsing rather than assuming clean input.
- When editing a view's client-side script, remember the Tailwind CDN vs compiled-CSS inconsistency above — check which one a given page uses before assuming Tailwind classes will pick up custom config from `src/input.css`.
- There's no test suite, so verify changes by running the app against a local MongoDB instance and exercising the relevant page/route manually.