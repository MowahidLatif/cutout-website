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
├── index.html           — one-page storefront: hero → studio → how it works
│                          → gallery (the studio is where orders are designed)
├── checkout.html        — cart + contact/shipping + order summary → Stripe
├── pricing.html         — live rate, discount and shipping tables
├── order-status.html    — customer order lookup (order ID + email); also the
│                          Stripe success page (?order=<id>), which clears the cart
├── admin.html           — owner-only: orders, supplier image links, status
│                          changes + history (not in the site nav; noindex)
├── policies.html        — returns & refunds: final sale, free reprint if damaged
├── create.html          — redirect to index.html#studio (keeps old links working)
├── css/
│   └── style.css        — one shared stylesheet: tokens, components, breakpoints
├── img/                 — PLACEHOLDER illustrations (hero, gallery, sample);
│                          replace with real photos
└── js/
    ├── icons.js          — inline SVG icon sprite; first script in <body>
    ├── site-config.js    — window.SITE: every hard-coded storefront value
    ├── pricing.js        — window.Pricing: sizeTierForHeight, calculatePrice,
    │                       calculateShipping (mirror of the backend)
    ├── api.js            — window.Api: tiny fetch() wrapper
    ├── cart.js           — window.Cart: the cart in localStorage
    ├── layout.js         — mobile nav toggle, footer year, cart badge
    ├── studio.js         — the studio on index.html
    ├── checkout.js       — checkout.html
    ├── order-status.js   — order-status.html
    └── admin.js          — admin.html
```

Keep JS as plain `<script src="...">` tags; no modules or bundler are
required. Script order matters: `icons.js` goes first in `<body>`, then at
the end `site-config.js` → `pricing.js` → `api.js` → `cart.js` →
`layout.js` → the page's own script (each page loads only what it uses).

## Placeholders: replace before launch

The design was built with values that aren't real yet, so nothing has to
wait on the supplier. They live in exactly two places:

- **`js/site-config.js` (`window.SITE`)**: `supportEmail` (no domain yet), production and transit days,
  the "from $29" price, the rating text, the material catalogue (only
  `coroplast`, shown as "Premium Corrugated", is orderable; foam board and
  acrylic show "Coming soon"), reference heights, and height/width/text
  limits.
- **HTML comments marked `PLACEHOLDER` in `index.html`** cover copy taken
  from the mockups as-is:
  - the "4.9/5 from 12,000+" rating
  - "48 hours"
  - "Our AI removes the background" (background removal isn't built; photos
    print as uploaded)
  - the "print-perfect guarantee"
  - the four gallery quotes

  Replace the invented rating and quotes with real, permissioned ones, or
  remove them, before going live.
- **`img/*.svg`** are generated illustrations. Swap in real photos and
  update the `src` attributes.

Prices are **never** placeholders. They always come from
`GET /api/pricing-config`.

## Currency

All prices are **CAD** (`SITE.currency`, and `currency` from
`/api/pricing-config`). Amounts keep the plain `$` look from the design;
where money is totalled the page says CAD (studio price card, checkout
total, pricing page, admin).

## Design system (`css/style.css`)

- **Tokens on `:root`:**
  - cream `--bg #f8f4ee`, `--surface #fffdfa`, ink `--ink #1f1915`
  - accent orange `--accent #d9572b` (+ `--accent-soft`, `--accent-muted`)
  - radii `--radius` 20px / `--radius-lg` 28px
- **Fonts** (Google Fonts, with system fallbacks): *Bricolage Grotesque*
  (headings, 800), *Inter* (body), *Permanent Marker* (the price sticker,
  gallery quotes).
- **Components:**
  - site header (brand tile, nav, `.cart-pill` with a `[data-cart-count]` badge)
  - `.btn` (`-primary` orange, `-dark`, `-ghost`/`-secondary`, `-lg`, `-block`)
  - `.dropzone`, `.card`, `.step-card` (numbered), `.segmented`, `.toggle`, `.range`
  - `.stepper`, `.option-card` (radio cards), `.price-card` (offset ink shadow)
  - `.sticker`, `.stat-card`, `.step-tile`, `.gallery-card`, `.cart-item`, `.summary-card`
- **Forms and tables** keep the old class names (`.field`, `.form-row
  cols-2/3`, `.hint`, `.error`, `.status-message`, `table`), so the
  admin, pricing and order-status pages use the same look. Wide tables
  are wrapped in `.table-scroll`.
- **Icons:** `<svg class="icon"><use href="#i-name"/></svg>`, with names
  in `js/icons.js`. The sprite is injected inline, so it also works from
  `file://`.

### Responsive behaviour

| Width | Layout |
|---|---|
| ≥ 1024px (desktop) | As designed: two-column hero and studio, 4-up "how it works" and gallery |
| 720–1023px (tablet) | The same two-column hero and studio, scaled down (`clamp()` type); 4-up grids become 2×2 |
| < 720px (mobile) | Everything stacks into one column; the hero image moves below the copy, the studio preview sits above its controls, and the nav collapses into a menu button |

There's no horizontal scrolling at any width; this was checked at 1440,
820 and 390px. `prefers-reduced-motion` turns off smooth scrolling and
transitions.

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

## `cart.js`: the cart

`window.Cart` has `get()`, `add(item)`, `update(id, changes)`,
`remove(id)`, `clear()`, `count()` (the sum of quantities) and
`makeThumbnail(src)`.

- An item is `{ id, imageKey, thumbnail, heightIn, widthIn, material,
  quantity, textElements }`. The photo itself is already on the server
  (`imageKey`), so only a ~320px JPEG thumbnail is kept for display.
- No prices are stored. Checkout recomputes them from the live config,
  and the backend recomputes them again.
- It's kept in `localStorage` (`cutoutCart.v1`). Every access is wrapped
  in try/catch, and if storage is blocked it falls back to memory for the
  current page. Badges update across tabs (via the `storage` event).
- It's cleared when Stripe returns the customer to `order-status.html?order=…`.

## Pages

### `index.html`: Storefront
1. **Hero:**
   - the rating pill, the headline, and the dropzone; dropping or choosing
     a photo loads it into the studio and scrolls there
   - "Try a sample", and the trust points
   - the hero image with the price sticker and the "5'7"" stat card
2. **Studio (`#studio`, `js/studio.js`):**
   - **Upload:** the photo is sent to `POST /api/uploads` **as soon as
     it's chosen**. Files over 25 MB are rejected in the browser first.
     Server rejections (too small, not an image, HEIC) show under the
     preview and in the price card.
   - **To-scale preview:**
     - a 9 ft wall with a 1–8 ft ruler; `--ppi` (pixels per inch) is set
       from the stage height and recomputed on resize
     - a reference figure (Person 5'9" / Door 6'8" / None), a 1 ft grid
       toggle, and fullscreen
     - the photo drawn at the chosen height × width, with text overlays
   - **① Size:**
     - height via the slider or ft/in inputs (1–8 ft)
     - width auto-calculated from the photo's proportions, or editable when
       "Lock proportions" is off; it warns if the width is outside 6"–8 ft
   - **② Text:** up to 3 speech bubbles, placards or captions (80
     characters each), shown on the preview.
   - **③ Material:** radio cards from `SITE.materials`.
   - **Price card:**
     - the live price for the height-derived tier, the breakdown (base ×
       quantity, bulk discount), and a quantity stepper
     - the delivery estimate (today + `SITE` business days) and the
       shipping to `SITE.defaultCountry`
     - **Add to cart**, disabled with a reason until a real photo is uploaded
   - The sample photo is preview-only and can't be ordered.
3. **How it works:** 4 numbered cards.
4. **Wall of fame:** 4 staggered cards and a "Make yours" button (→ `#studio`).

### `checkout.html`: Cart & checkout (`js/checkout.js`)
- **Cart items:** thumbnail, tier and material, height × width, texts, a
  quantity stepper, the line price, and Remove.
- **Contact + shipping address:** country is `CA`/`US` and drives shipping.
- **Summary:** standees (pre-discount), bulk discount, shipping (once a
  country is chosen) and the total, labelled CAD.
- **Final-sale checkbox (required):** "I understand each standee is
  custom-made… final sale". Pay is blocked until it's ticked, and the order
  is sent with `acceptedFinalSale: true`.
- **"Pay with Stripe":** `POST /api/orders` with all cart items, then
  `POST /api/orders/:id/checkout-session`, then a redirect. If a cart
  photo is missing on the server, it tells the customer to re-add that
  item.
- An empty cart shows a link back to the studio.

### `policies.html`: Returns & refunds
All sales are final (each standee is custom-made); damaged or misprinted
standees are reprinted free if reported with a photo within
`SITE.damageClaimDays` (7) of delivery. The support email, day count and
policy version are filled in from `site-config.js`. Every page footer links
here, as does the studio price card ("Final sale, no returns").

### `pricing.html`: Pricing
Fetches `GET /api/pricing-config` and renders the base rate, discount and
shipping tables (inline script).

### `order-status.html`: Order lookup
A form (order ID + email) that calls `GET /api/orders/:id?email=...` and
shows a friendly status label and the items. With `?order=<id>` (the
Stripe success URL) it prefills the ID and clears the cart.

### `admin.html`: Owner admin
- **Sign-in:** asks for the operator's name and the `ADMIN_TOKEN` once per
  tab. Both are kept in `sessionStorage` only and sent as `X-Admin-Name` /
  `X-Admin-Token` headers, never in a URL. A 401 sends you back to
  sign-in, and a 429 shows how many minutes to wait.
- **Order list:** filtered by status (the default is "Paid (to forward)").
- **Opening an order shows:**
  - customer, address and totals
  - per item: size, width, text elements, and a download link with its
    expiry date ("Generate fresh links", "Copy link")
  - a status changer with a confirm step ("shipped" emails the customer)
  - the status history
- All customer-supplied text is HTML-escaped before it's rendered.

## Live pricing logic

`js/pricing.js` attaches three pure functions to `window.Pricing`:

```js
sizeTierForHeight(heightIn)
// → "small" (≤36") | "medium" (≤60") | "life_size" (≤78") | "xl"

calculatePrice({ sizeTier, material, quantity, rates, discountTiers })
// → { baseRate, unitPrice, discountPct, subtotal, discountAmount, total } or null

calculateShipping({ country, sizeTier, quantity, shippingRates })
// → first_unit_rate + additional_unit_rate * (quantity - 1), or null
```

- `rates`, `discountTiers` and `shippingRates` come from
  `GET /api/pricing-config`. Never hardcode rates in JS.
- These functions **must produce the same results as the backend's
  pricing service** (`backend/src/services/pricing.js`), including the
  tier boundaries and `round2` rounding. They exist purely for instant UI
  feedback. The backend derives the tier from the height itself, computes
  the price from scratch when the order is created, and charges that
  stored total.
