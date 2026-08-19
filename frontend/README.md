# Billing System — Frontend (React + Vite + Tailwind)

This is the new React frontend for the POS billing system. It replaces the
server-rendered EJS views under `../views` page by page. The Express +
MongoDB backend (`../main.js`) is unchanged and still owns all data — this
app only talks to it over JSON.

Tailwind is installed as a package (`@tailwindcss/vite`), **not** loaded
from a CDN — see `src/index.css` (`@import "tailwindcss"`) and
`vite.config.js`.

## Structure

```
frontend/
  src/
    pages/        One file per screen: Login, Dashboard, Billing, Products, Customers
    components/   Shared UI: Sidebar, Topbar, ProtectedRoute
    lib/
      api.js          Single place every backend call goes through
      AuthContext.jsx Client-side "session" (username in sessionStorage) — mirrors
                       the original app, which has no real credential check either
    index.css      Tailwind entry + theme tokens (brand colors)
    App.jsx         Routes
    main.jsx        React entry point
  vite.config.js    Dev proxy -> backend on :3000, Tailwind plugin
```

## Running it

You need the backend running first (from the repo root):

```bash
npm install
npm start          # starts Express + Mongo on :3000
```

Then, in this folder:

```bash
npm install
npm run dev         # Vite dev server on :5173, proxies API calls to :3000
```

Build for production with `npm run build` (outputs to `frontend/dist`). To
serve the built app, either point Express at `frontend/dist` as a static
folder in a later stage, or host it separately and set `VITE_API_BASE` to
the backend's URL.

## Where data comes from

Every read/write goes through `src/lib/api.js`. Two small JSON endpoints
were added to `main.js` for this stage (the old EJS routes were left alone):

- `GET /api/products` / `GET /api/customers` — list data (the EJS routes
  fetched this server-side and injected it into the template; React needs
  it as JSON instead)
- `POST /api/product` — same logic as `POST /product`, but returns JSON
  instead of a redirect (the old route is form-submit-shaped)

Everything else (`/billing/*`, `/customer/*`, `/product/undo`,
`/product/:id` DELETE) already returned JSON and is reused as-is.
