# Frontend Guide

Read `architecture.md` first. This doc governs everything under `frontend/`.

## Philosophy

Plain HTML, plain CSS, small vanilla JS files. No React, no JSX, no
bundler, and no npm install needed to run the frontend at all. Open an
`.html` file in a browser (or serve the folder with any static file
server) and it works.

## Folder structure

```
frontend/
├── index.html           — landing page
├── pricing.html         — live rate, discount and shipping tables
├── create.html          — the order flow
├── order-status.html    — customer order lookup (order ID + email)
├── admin.html           — owner-only: orders, supplier image links, status
│                          changes + history (not in the site nav; noindex)
├── css/
│   └── style.css        — one shared stylesheet for the whole site
└── js/
    ├── pricing.js        — pure pricing + shipping functions (window.Pricing),
    │                       used by create.html
    ├── api.js            — tiny fetch() wrapper for the backend (window.Api)
    ├── create.js          — page logic for create.html (upload, live price,
    │                       validation, submit → checkout)
    ├── order-status.js    — page logic for order-status.html
    └── admin.js           — page logic for admin.html
```

`pricing.html` doesn't load `js/pricing.js`. It only renders the config
tables, using a small inline script.

Keep JS as plain `<script src="...">` tags; no modules or bundler are
required. Use `type="module"` with native ES imports only if it
meaningfully simplifies things, and don't add a build step to get it.

## `api.js`: talking to the backend

`window.Api` has `get(path, headers?)`, `post(path, data, headers?)`,
`patch(path, data, headers?)` and `upload(path, formData, headers?)`.

- Paths are relative to `window.API_BASE_URL` (set it before `api.js`
  loads), or same-origin `/api` by default, which is the setup behind
  Caddy in production.
- JSON bodies get `Content-Type: application/json`. `upload` sends
  `FormData` and lets the browser set the multipart boundary.
- On success it returns the envelope's `data`. On failure it throws an
  `Error` whose `message` is the server's (user-readable) message. The
  error also carries `status` (the HTTP code) and, on a 429, `retryAfter`
  (seconds).

## Pages (v1)

### `index.html`: Landing
Pitch: cheapest and highest-quality life-size cutouts. One clear CTA
button linking to `create.html`.

### `pricing.html`: Pricing
Fetches `GET /api/pricing-config` on load and renders three tables:
- size tier × material base rates
- quantity discount tiers
- shipping rates (country, size, first cutout, each additional)

They're never out of sync with what `create.html` actually charges.

### `create.html`: Order flow
A single form with:

1. **Photo:** image upload (`<input type="file" accept="image/*">`, click
   or drag-and-drop) with a preview. The hint states the limits: JPEG, PNG
   or WebP, at least 2000px on the longest side, up to 25 MB.
   - The file is sent to `POST /api/uploads` (via `Api.upload`) **as
     soon as it's chosen**. Files over 25 MB are rejected in the browser
     first.
   - Server rejections (too small, not an image, HEIC) appear on the photo
     field right away, not at payment. The dropzone label shows
     "Uploading…" and then "✓ <name>".
   - Choosing another photo replaces the pending upload. Submit awaits
     the latest upload and sends its `imageKey`.
2. **Size tier** (`<select>`): small / medium / life-size / XL.
3. **Material** (`<select>`): cardboard / coroplast / foam board / acrylic.
4. **Height** (`<input type="number">`, inches).
5. **Quantity** (`<input type="number" min="1">`).
6. **Contact + shipping:** email, phone, address lines, city, region,
   postal code, and country (`<select>`: `CA` / `US`, because it drives
   shipping).
7. **Live price box** (see "Live pricing logic"):
   - With a country chosen, it shows the grand total and
     "$X each × N + $Y shipping".
   - Before that, it shows the product-only total with "shipping
     calculated once you choose a country".
   - A tag shows the bulk discount when one applies.
8. **"Pay with Stripe"** button. It validates the required fields, waits
   for the photo upload, then:
   - `POST`s to `/api/orders` to create the order
   - `POST`s to `/api/orders/:id/checkout-session`
   - redirects `window.location` to the returned Stripe URL

### `order-status.html`: Order lookup
A small form (order ID + email) that calls `GET /api/orders/:id?email=...`.
It shows a friendly status label (e.g. "Paid — queued for production")
and the items. Any lookup failure shows a generic "Couldn't find that
order", because the API returns the same 404 for a wrong email, a
missing email and an unknown ID.

### `admin.html`: Owner admin
Asks for the operator's name and the `ADMIN_TOKEN` once per tab. Both are
kept in `sessionStorage` only, so they're gone when the tab closes. They're
sent as `X-Admin-Name` / `X-Admin-Token` headers, never in a URL. The
token field is cleared after sign-in. A 401 sends you back to sign-in, and
a 429 shows how many minutes to wait.

It lists orders, filtered by status (the default is "Paid (to forward)").
Opening an order shows:

- customer, address and totals, and a download link per item with its
  expiry date ("Generate fresh links" re-signs them; "Copy link" copies
  one)
- a status changer, with a confirm step. The current status is disabled,
  and "shipped" emails the customer.
- the status history: when, from → to, who, IP (hover for the user agent)

All customer-supplied text is HTML-escaped before it's rendered.

## Live pricing logic

`js/pricing.js` attaches two pure functions to `window.Pricing`:

```js
calculatePrice({ sizeTier, material, quantity, rates, discountTiers })
// → { baseRate, unitPrice, discountPct, subtotal, discountAmount, total } or null

calculateShipping({ country, sizeTier, quantity, shippingRates })
// → first_unit_rate + additional_unit_rate * (quantity - 1), or null
```

Both return `null` when an input is missing or there's no matching rate
row. The displayed total is
`calculatePrice(...).total + calculateShipping(...)`.

- `rates`, `discountTiers` and `shippingRates` come from
  `GET /api/pricing-config`, fetched once when `create.html` loads. Never
  hardcode rates in JS.
- These functions **must produce the same results as the backend's
  pricing service** (`backend/src/services/pricing.js`), including the
  same `round2` rounding. They exist purely for instant UI feedback. The
  price shown is never what's charged: the backend computes it from
  scratch when the order is created and charges that stored total.
- Recompute on every `input`/`change` event on size, material, quantity
  or country. No API call is needed; it's all client-side math from the
  fetched config.

## Styling

One shared `css/style.css`, plain CSS (no preprocessor, and no framework
like Bootstrap/Tailwind unless you decide you want one later). Colours
are tokens on `:root`. Keep it simple: a readable layout, clear form
states (`.field.has-error`), and a visible live-price number.
