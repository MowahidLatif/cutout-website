# Frontend Guide

Read `architecture.md` first. This doc governs everything under `frontend/`.

## Philosophy

Plain HTML, plain CSS, small vanilla JS files. No React, no JSX, no
bundler, and no build step. **The Express backend serves this folder** on
the same origin as the API: run the backend and open http://localhost:4000.
The JS calls `/api/...` directly, with no base URL and no CORS. (Opening the
`.html` files from disk shows the layout, but nothing that needs the API
will work.)

**Clean URLs:** `/pricing`, `/checkout`, `/policies`, `/order-status`,
`/admin` and `/create` serve the matching `.html` file (via
`express.static`'s `extensions` option). The `.html` URLs work too, and the
pages link to each other with relative `*.html` links.

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
│                          (page scripts are files, e.g. js/pricing-page.js,
│                           js/policies.js — the CSP forbids inline <script>)
├── create.html          — redirect to index.html#studio (keeps old links working)
├── favicon.svg          — site icon (/favicon.ico redirects here)
├── css/
│   └── style.css        — one shared stylesheet: tokens, components, breakpoints
├── img/                 — PLACEHOLDER illustrations (hero, gallery, sample);
│                          replace with real photos
└── js/
    ├── icons.js          — inline SVG icon sprite; first script in <body>
    ├── site-config.js    — window.SITE: every hard-coded storefront value,
    │                       the API base URL and the background remover's
    │                       pinned URLs (loaded by every page)
    ├── pricing.js        — window.Pricing: sizeTierForHeight, calculatePrice,
    │                       calculateOrderShipping (mirror of the backend)
    ├── api.js            — window.Api: tiny fetch() wrapper
    ├── cart.js           — window.Cart: the cart in localStorage
    ├── layout.js         — mobile nav toggle, footer year, cart badge
    ├── background-removal.js — window.BackgroundRemoval: in-browser background
    │                       removal (Transformers.js + MODNet, lazy-loaded)
    ├── cutout-cleanup.js — window.CutoutCleanup: fills holes inside a cutout and
    │                       trims its empty margins (before upload)
    ├── trace-editor.js   — window.TraceEditor: the review modal's manual
    │                       lasso / crop-box editor (canvas, pointer events)
    ├── studio.js         — the studio on index.html
    ├── checkout.js       — checkout.html
    ├── order-status.js   — order-status.html
    └── admin.js          — admin.html
```

Keep JS as plain `<script src="...">` tags; no modules or bundler are
required. Script order matters: `icons.js` goes first in `<body>`, then at
the end `site-config.js` → `pricing.js` → `api.js` → `cart.js` →
`layout.js` → the page's own script (each page loads only what it uses).
Every page loads `site-config.js` first, because `api.js` and
`background-removal.js` read from it.

**Config and secrets:**
- URLs, endpoints and constants go in `js/site-config.js`, not in page
  scripts.
- Nothing in `frontend/` is secret, and nothing can be: the browser
  downloads all of it. Secrets live only in `backend/.env`.
- The only backend address the browser knows is the relative `/api`.

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

Phones and tablets are checked with an automated audit (real app, touch
emulation) at 320, 375, 390, 768, 820, 1024 and 1366×1024, plus a landscape
phone (844×390), across every page and the filled states (studio with
photos and text, a cart, admin list and detail). It checks for:
- no horizontal scrolling and nothing off-screen
- every tap target ≥ 44px
- inputs ≥ 16px, so iPhones don't zoom in on focus

**Touch rules** (the end of `style.css`):
- `@media (pointer: coarse)` gives phones and tablets (not desktop mice)
  44px tap targets: nav and footer links, small buttons, selects, steppers,
  the photo-card remove button, the slider thumb, and the "Try a sample" /
  "Remove" links.
- Below 720px:
  - speech bubbles stay inside the standee preview
  - tables marked `.stack-on-phone` (the admin orders and history tables)
    turn into one labelled card per row, using `data-label` on each cell
- Phones held sideways (`max-height: 500px`) get a shorter studio preview
  that fits the screen.
- Also: `touch-action: manipulation` (no double-tap delay), and
  safe-area padding for notched phones (`viewport-fit=cover`).

Grids that hold wide content use `minmax(0, 1fr)` columns so their content
can't widen the page.

`prefers-reduced-motion` turns off smooth scrolling and transitions.

## `api.js`: talking to the backend

`window.Api` has `get(path, headers?)`, `post(path, data, headers?)`,
`patch(path, data, headers?)`, `upload(path, formData, headers?)` and
`download(path, headers?)` (returns `{ blob, filename }`, used for the admin
zip).

**No inline scripts:** the Content-Security-Policy blocks them, so page
logic always lives in `js/*.js` files.

- Calls go to `SITE.apiBaseUrl` (`js/site-config.js`), which is the
  same-origin `/api`, both locally (http://localhost:4000) and in production
  behind Caddy. Only if the frontend is ever hosted on another origin:
  change it to the API's full URL and set `FRONTEND_ORIGIN` on the backend
  for CORS.
- JSON bodies get `Content-Type: application/json`. `upload` sends
  `FormData` and lets the browser set the multipart boundary.
- On success it returns the envelope's `data`. On failure it throws an
  `Error` whose `message` is the server's (user-readable) message. The
  error also carries `status` (the HTTP code) and, on a 429, `retryAfter`
  (seconds).

## `cart.js`: the cart

`window.Cart` has `get()`, `add(item)`, `addMany(items)`,
`update(id, changes)`, `remove(id)`, `clear()`, `count()` (the sum of
quantities), `totals()` (`{ quantity, uniqueImages }`, for the order
limits) and `makeThumbnail(src)`.

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
   - **Upload (multi-photo):**
     - Choose or drop **several photos at once** (the input has `multiple`).
       Each becomes a *design* in `state.designs` and uploads to
       `POST /api/uploads` straight away. Files over 18 MB (`SITE.maxUploadMb`) are rejected in
       the browser first.
     - **Photo tray:** one card per photo, with a thumbnail, its upload
       status (or the server's rejection reason), a **quantity box**,
       and remove. Click a card to edit that photo; the size, text and
       material controls and the preview all follow the selected photo.
     - An "Add photos" tile shows how many more are allowed.
   - **JPEG, PNG, WebP, HEIC or PDF**, up to 18 MB (others get the server's
     415 message). Browsers can't display PDF or HEIC, so those show
     "Processing…" until the upload returns `previewUrl`. For every photo,
     the studio then switches to the server's processed image, which is
     rotated and is exactly what will print.
   - **Background removal** (`js/background-removal.js`), **on by default**:
     - **When:** once a photo has uploaded, the studio removes the
       background from the server's `previewUrl` (already rotated and
       converted), in the browser.
     - **What it uses:** Transformers.js 4.3.0 from jsDelivr and the
       MODNet model (`Xenova/modnet`, ~6.6 MB, pinned revision) from
       Hugging Face. Both are Apache-2.0. They're downloaded on first use,
       then cached by the browser. The photo itself isn't sent anywhere
       extra.
     - **Queue:** photos are processed one at a time, and Add to cart waits
       ("Removing the background from N photos…").
     - **Review modal** (`<dialog id="review-modal">`, one photo at a
       time, in tray order, "Photo 2 of 3"):
       - **Loading:** a spinner while the photo uploads and its background
         is removed. The first time it shows "Downloading the background
         remover (first time only)… N%".
       - **Review:** the cutout on a checkerboard with **Accept** and
         **Edit / Trace**, plus "Keep the original background instead".
       - **Failed** (model download blocked, out of memory…): the original,
         with **Use the original**, **Trace it myself** and "Try the
         automatic removal again".
       - **Trace** (`js/trace-editor.js`): **Lasso** (drag around what to
         keep; outside becomes transparent) or **Crop box** (cuts the image
         down), on the AI cutout or the original photo. Shapes stack, with
         Undo, Reset and Cancel. **Done** uploads the result as the cutout
         (`uploadCutout`) and goes back to Review ("✓ Custom cutout"). The
         canvas is capped at 16 MP, the iOS limit, so huge PDF renders
         are scaled down.
       - **Closing** (X, Escape, backdrop) is the same as Accept: removal
         stays on, even if it's still running. Escape while tracing only
         leaves trace mode. The next photo waiting opens afterwards.
       - Each design gets `reviewed` once it's been through the modal. A
         **"Review cutout"** link on the tray card reopens it. A failure
         after the photo was reviewed shows a `#tray-message` notice
         instead.
     - **Clean-up** (`js/cutout-cleanup.js`), since a standee is cut along
       its outer outline only:
       - `fillHoles` makes everything the outside background can't reach
         solid. This fixes MODNet punching holes in a white shirt or a
         watermark; the original colours come back. Gaps open to an edge
         (between the legs) stay transparent, and the outline keeps its
         soft edge.
       - `trimToContent` crops the empty margins, from both the AI cutout
         and traced results. The image's bottom is then the subject's
         feet, and the chosen height is the subject's height.
       - The stage also pins cutouts to the floor
         (`object-position: center bottom`), even with unlocked
         proportions.
     - **Two versions per design:** `design.original` and `design.cutout`
       (`{ key, src, width, height }`).
       - `applyBackgroundChoice` points `imageKey` / `src` / pixel size /
         aspect at the chosen version (a crop has its own proportions).
         The **"Remove background" toggle** (size card) switches
         instantly.
       - The preview shows a cutout without the photo frame (an outline in
         the border colour, plus a shadow). The tray thumbnail sits on a
         checkerboard.
     - The sample photo is never processed.
     - MODNet is tuned for people; pets and objects can come out rough,
       which is what the toggle is for.
   - **Print quality:** once the server reports the pixel size, each tray
     card and the size card show **"Quality 84/100 · Good"** from
     `Pricing.printQuality`, updated live as the height changes. There's a
     tip, and a **"Why does resolution matter?"** explainer. Photos under
     1000 px can't score above Fair. **Low** shows a required checkbox ("I understand this
     photo may print blurry…"). Add to cart is blocked until it's ticked,
     and the cart item carries `acceptedLowQuality`.
   - **Image audit** (the upload response's `audit`; see `api-spec.md`):
     - **Blurry or heavily compressed:** the score is capped at Fair, with
       the tip "Photo looks blurry or out of focus…" or "…heavily
       compressed (blocky)…". The flags live on each version
       (`original` / `cutout`) and follow `applyBackgroundChoice`. The cart
       item carries them for checkout's quality line.
     - **Screenshot / web photo:** a non-blocking info note (`#source-note`,
       blue, not red) under Print quality, plus a tag on the tray card.
     - **Flat artwork** (`looksLikeGraphic`): MODNet isn't run. The review
       popup opens a **Graphic** pane with **Make it a vector**, **Keep as
       is**, and "It's a photo — remove the background instead". The vector
       (`POST /uploads/:key/vectorize`) becomes the design's `cutout`
       (`vector: true`): the tray shows "✓ Vector graphic", the score is
       "100/100 · Great · Vector", and Edit / Trace is hidden.
   - **"Inspect print detail" lens** (magnifier in the preview tools):
     - a 200 × 200 px canvas at actual printed size (96 CSS px = 1 in, so
       ≈ 2.1 × 2.1 in), drawn from the full-resolution image with smoothing
     - **Caption:** pixels per inch, plus "looks blurry" or "vector". It
       redraws live as the size changes.
     - **Default spot:** the centre, or the top quarter for cutouts (the
       face), snapped to the nearest visible pixel. Clicking the preview
       moves it.
     - On phones it's pinned to the screen corner.
   - **Order limits:** at most `SITE.maxUniqueImages` (10) different photos
     and `SITE.maxOrderQuantity` (500) cutouts per order, counting what's
     already in the cart (`Cart.totals()`).
     - Extra photos are skipped with a message.
     - **Quantity boxes** (`<input type="number">`, price card and tray
       cards) accept 1 … whatever is left of the 500 (`maxQuantityFor`).
       - `readQuantity` applies valid numbers while typing, so the price
         updates live. On leaving the box it's clamped, with a hint such
         as "Max 480 — an order can have 500 cutouts in total…".
       - Typing in a tray box doesn't rebuild the tray (that would drop
         focus); the price-card box is never rebuilt.
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
     - covers **every photo in the tray**: "Your standees · 3 designs · 27
       cutouts", the total, and one line per design (tier × quantity, its
       own bulk discount). With a single photo it shows base × quantity and
       the discount, as before.
     - a quantity box for the selected photo (kept in sync with its tray
       card)
     - **Border** (per photo): a switch, on by default in White, and named
       swatches from `SITE.borderColors` (White, Black, Blue, Green,
       Orange, Red, Yellow). The design stores the hex code (`borderColor`,
       or `null` for none), which also drives the preview's outline
       (`--edge`). It's free; the price doesn't change.
     - **Notes for the supplier** (per photo): "Add notes for the supplier"
       reveals a textarea capped at `SITE.maxNotesLength` (150), with a
       live counter.
     - the delivery estimate (today + `SITE` business days) and order-level
       shipping to `SITE.defaultCountry`
     - **"Add 3 designs to cart"** adds each design as its own cart item
       (`Cart.addMany`), then clears the tray. It's disabled with a reason
       until every photo has uploaded, every size is valid, and the limits
       hold.
   - The sample photo is preview-only and can't be ordered.
3. **How it works:** 4 numbered cards.
4. **Wall of fame:** 4 staggered cards and a "Make yours" button (→ `#studio`).

### `checkout.html`: Cart & checkout (`js/checkout.js`)
- **Cart items:** thumbnail, tier and material, height × width, texts,
  border and notes, a **quantity box** (1 … 500 minus the other items;
  typing updates the line price and summary live, and leaving the box
  clamps it), the line price, and Remove. `borderColor` and `notes` are
  sent with each order item. If the cart breaks a limit (e.g. an old cart), checkout says
  so and disables Pay.
- **Contact + shipping address:** a required **Full name** (for the
  shipping label), email, phone and address, with the same `maxlength`s as
  the server's limits. Country is `CA`/`US` and drives shipping.
- **Summary:** "27 cutouts · 3 designs" (pre-discount), bulk discount,
  order-level shipping (once a country is chosen), and the total, labelled
  CAD.
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

### `admin.html`: Owner admin (`js/admin.js`)
- **Sign-in:** asks for the operator's name and the `ADMIN_TOKEN` once per
  tab. Both are kept in `sessionStorage` only (never `localStorage`, never in
  a URL), with a **Log out** link. The token is sent as
  `Authorization: Bearer`, the name as `X-Admin-Name`. A 401 sends you back
  to sign-in; a 429 shows how many minutes to wait. The page is `noindex`
  and isn't linked from public pages.
- **Order list:**
  - status filter (the default is **Needs action**: paid + in production)
  - search by email, name or order ID; From/To dates
  - 25 per page with Previous/Next
  - columns: short ID, created, name + email, status, total (CAD), items
    (and cutouts), country
- **Order detail:**
  - contact, ship-to address, totals including shipping
  - the Stripe payment ID and the final-sale acceptance time
  - tracking, once shipped
  - items: size, dimensions, material, quantity, text, print-quality score,
    and download/copy links
- **Actions:**
  - **Download supplier bundle** (a zip, fetched with the token and saved
    via `Api.download`)
  - **Generate fresh image links**
- **Change status:** only the allowed next statuses are offered. "Shipped"
  shows required carrier and tracking-number fields (plus an optional
  URL). There's a confirm step. If the shipped email failed, a warning is
  shown (the status is still saved).
- **Internal notes:** a list with time and author, plus an add form (2000
  characters). Never shown to customers.
- **History:** every status change, with who, from → to, time and IP.

All customer-supplied text is HTML-escaped before it's rendered.

## Live pricing logic

`js/pricing.js` attaches three pure functions to `window.Pricing`:

```js
sizeTierForHeight(heightIn)
// → "small" (≤36") | "medium" (≤60") | "life_size" (≤78") | "xl"

calculatePrice({ sizeTier, material, quantity, rates, discountTiers })
// → { baseRate, unitPrice, discountPct, subtotal, discountAmount, total } or null

printQuality({ widthPx, heightPx, heightIn, widthIn })
// → { ppi, score: 0–100, grade: "great" | "good" | "fair" | "low" }
//   score = min(100, ppi × 2), capped at 59 under 1000 px; grades ≥90 / ≥60 / ≥36 / below

calculateOrderShipping({ country, items: [{ sizeTier, quantity }], shippingRates })
// → one first-unit charge (largest size) + every other cutout at its size's
//   additional rate, or null if no country / no rate
```

- `rates`, `discountTiers` and `shippingRates` come from
  `GET /api/pricing-config`. Never hardcode rates in JS.
- These functions **must produce the same results as the backend's
  pricing service** (`backend/src/services/pricing.js`), including the
  tier boundaries and `round2` rounding. They exist purely for instant UI
  feedback. The backend derives the tier from the height itself, computes
  the price from scratch when the order is created, and charges that
  stored total.
