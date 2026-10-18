# Frontend Guide

Read `architecture.md` first. This doc governs everything under `frontend/`.

## Philosophy

Plain HTML, plain CSS, small vanilla JS files. No React, no JSX, no
bundler, no npm install needed to run the frontend at all — open an `.html`
file in a browser (or serve the folder with any static file server) and
it works.

## Folder structure

```
frontend/
├── index.html           — landing page
├── pricing.html         — pricing explanation page
├── create.html          — the order flow
├── order-status.html    — order lookup page
├── admin.html           — owner-only: orders + supplier image links (not in site nav)
├── css/
│   └── style.css        — one shared stylesheet for the whole site
└── js/
    ├── pricing.js        — pure pricing-calculation function, shared by
    │                       create.html and pricing.html
    ├── api.js            — tiny fetch() wrapper for talking to the backend
    ├── create.js          — page logic for create.html (form state, live
    │                       price, submit → checkout)
    ├── order-status.js    — page logic for order-status.html
    └── admin.js           — page logic for admin.html
```

Keep JS plain `<script src="...">` tags, no modules/bundler required (use
`type="module"` with native ES imports only if it meaningfully simplifies
things — don't add a build step to get it).

## Pages (v1)

### `index.html` — Landing
Pitch: cheapest + highest quality life-size cutouts. One clear CTA button
linking to `create.html`.

### `pricing.html` — Pricing
Fetches `GET /api/pricing-config` on load and renders a simple table of
size tier × material rates, plus the quantity discount tiers, so it's
never out of sync with what `create.html` actually charges.

### `create.html` — Order flow
A single form with:

1. Image upload (`<input type="file" accept="image/*">`) + preview. The
   file is sent to `POST /api/uploads` (multipart, via `Api.upload`) **as
   soon as it's chosen**, so server rejections (too small, not an image,
   too large) show on the photo field right away. Submit awaits that upload
   and sends the returned `imageKey`.
2. Size tier (`<select>`): small / medium / life-size / XL
3. Material (`<select>`): cardboard / coroplast / foam board / acrylic
4. Height (`<input type="number">`, inches)
5. Quantity (`<input type="number" min="1">`)
6. A live price display (plain text/`<div>`, updated on every change via
   `js/create.js`, using the shared formula in `js/pricing.js`)
7. Contact + shipping fields: email, phone, address lines, city, region,
   postal code, country (`<select>`: `CA` / `US`, since it drives shipping)
8. A submit button that:
   - `POST`s to `/api/orders` to create the order
   - `POST`s to `/api/orders/:id/checkout-session`
   - redirects `window.location` to the returned Stripe URL

### `order-status.html` — Order lookup
A small form (order ID + email) that calls `GET /api/orders/:id?email=...`
and displays the status in plain text.

### `admin.html` — Owner admin
Asks for the `ADMIN_TOKEN` once (kept in `sessionStorage`, sent as
`X-Admin-Token`). Lists orders by status. Opening an order shows its
details and a download link per item, with the expiry date. "Generate
fresh links" re-signs them. All customer-supplied text is HTML-escaped
before it's rendered.

## Live pricing logic

`js/pricing.js` exports two pure functions:

```js
function calculatePrice({ sizeTier, material, quantity, rates, discountTiers }) {
  // returns { unitPrice, discountPct, subtotal, total }
}

function calculateShipping({ country, sizeTier, quantity, shippingRates }) {
  // returns first_unit_rate + additional_unit_rate * (quantity - 1), or null
}
```

The displayed total is `calculatePrice(...).total + calculateShipping(...)`.

- `rates`, `discountTiers` and `shippingRates` come from `GET /api/pricing-config`, fetched
  once when `create.html` loads — never hardcode rates in JS.
- This function **must produce the same result as the backend's pricing
  service** (`backend/src/services/pricing.js`). It exists purely for
  instant UI feedback. The price it shows is never what's actually charged
  — the backend recomputes from scratch before creating the Stripe session.
- Recompute on every `input`/`change` event on size, material, quantity,
  or country.
  No API call needed for this — it's all client-side math from the fetched
  config.

## Styling

One shared `css/style.css`, plain CSS (no preprocessor, no framework like
Bootstrap/Tailwind unless you decide you want one later). Keep it simple:
a readable layout, clear form states, a visible live-price number.
