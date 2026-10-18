# Database Schema (PostgreSQL)

There's no `users` table: customers check out as guests, and their
identity lives directly on the `orders` row. The admin side is a single
shared secret (`ADMIN_TOKEN`, see `api-spec.md`), not an account system.

The runnable version is `backend/src/db/migrations/`, applied in filename
order by `npm run migrate`:

| File | What it does |
|---|---|
| `001_init.sql` | All core tables; seeds `pricing_config` + `quantity_discount_tiers` |
| `002_shipping.sql` | `shipping_rates` table (seeded) + `orders.shipping_amount` |
| `003_image_key.sql` | Renames `order_items.image_url` → `image_key` |
| `004_order_status_events.sql` | Status-change audit log |
| `005_item_customization.sql` | `order_items.width_in` + `order_items.text_elements` (studio customization) |

`migrate.js` re-runs **every** file on each run, so every migration must
be idempotent (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, guarded `DO`
blocks).

## `orders`

| Column | Type | Notes |
|---|---|---|
| id | uuid, pk | |
| customer_email | text | required |
| customer_phone | text | required |
| shipping_address | jsonb | stored as sent: `{ line1, line2, city, region, postalCode, country }`; `country` is `CA` or `US` |
| status | text (enum) | `pending_payment`, `paid`, `in_production`, `shipped`, `delivered`, `cancelled` |
| subtotal | numeric(10,2) | product only, before the quantity discount; excludes shipping |
| discount_amount | numeric(10,2) | quantity discount; product only, never applied to shipping |
| shipping_amount | numeric(10,2) | sum of each item's shipping (see `shipping_rates`) |
| total_price | numeric(10,2) | what's charged: `subtotal - discount_amount + shipping_amount` |
| stripe_session_id | text | nullable until a checkout session is created |
| stripe_payment_intent_id | text | nullable until paid |
| created_at | timestamptz | |
| updated_at | timestamptz | bumped on every status change |

## `order_items`

| Column | Type | Notes |
|---|---|---|
| id | uuid, pk | |
| order_id | uuid, fk → orders.id | cascade delete |
| image_key | text | storage key from `POST /api/uploads`, e.g. `<uuid>.jpg`. Not a URL, so it works with either storage driver. Rows from before `003` still hold an old URL string |
| size_tier | text (enum) | `small`, `medium`, `life_size`, `xl`; derived server-side from `height_in` (≤36 / ≤60 / ≤78 / above) |
| material | text (enum) | `cardboard`, `coroplast`, `foam_board`, `acrylic`; the storefront's "Premium Corrugated" is `coroplast` |
| height_in | numeric(6,2) | chosen by the customer in the studio, 12–96 |
| width_in | numeric(6,2) | nullable; printed width, 6–96. Auto from the photo's proportions, or set by hand if unlocked. Null on rows from before `005` |
| text_elements | jsonb | `[{ style: "bubble"\|"placard"\|"caption", text }]`, max 3, text 1–80 characters; default `[]` |
| quantity | integer | `> 0` |
| unit_price | numeric(10,2) | after the quantity discount; snapshot at order time (config may change later) |
| line_total | numeric(10,2) | `unit_price * quantity`; product only, no shipping |
| notes | text | nullable, free-form |

## `pricing_config`

| Column | Type | Notes |
|---|---|---|
| id | uuid, pk | |
| size_tier | text | see above |
| material | text | see above |
| base_rate | numeric(10,2) | price per unit before any discount |
| updated_at | timestamptz | |

Unique on `(size_tier, material)`. Seeded with 16 placeholder rows (e.g.
life-size coroplast `58.00`), which are below the supplier's quoted cost.
Edit them once margins are settled.

## `quantity_discount_tiers`

| Column | Type | Notes |
|---|---|---|
| id | uuid, pk | |
| min_qty | integer, unique | inclusive |
| max_qty | integer, nullable | inclusive; `null` means "and above" |
| discount_pct | numeric(5,2) | e.g. `10.00` for 10% |

Seeded values (adjust once real costs/margins are known):

| min_qty | max_qty | discount_pct |
|---|---|---|
| 1 | 1 | 0 |
| 2 | 4 | 5 |
| 5 | 9 | 10 |
| 10 | 24 | 15 |
| 25 | null | 20 |

## `shipping_rates`

| Column | Type | Notes |
|---|---|---|
| id | uuid, pk | |
| country | text | `CA` or `US` (ISO 3166 alpha-2; `CHECK` constraint) |
| size_tier | text | see above |
| first_unit_rate | numeric(10,2) | shipping for the first unit of an item |
| additional_unit_rate | numeric(10,2) | shipping for each further unit of the same item |
| updated_at | timestamptz | |

Unique on `(country, size_tier)`. Shipping for one item line is
`first_unit_rate + additional_unit_rate * (quantity - 1)`.

Seeded values. Only CA / life-size first unit (`122.00`, UPS duty-paid to
Winnipeg) is from a real supplier quote; the rest are scaled placeholders:

| country | small | medium | life_size | xl |
|---|---|---|---|---|
| CA (first / additional) | 60 / 30 | 90 / 45 | 122 / 60 | 150 / 75 |
| US (first / additional) | 70 / 35 | 100 / 50 | 135 / 65 | 165 / 80 |

## `payments`

| Column | Type | Notes |
|---|---|---|
| id | uuid, pk | |
| order_id | uuid, fk → orders.id | cascade delete |
| provider | text | `stripe` |
| provider_txn_id | text | Stripe payment intent ID |
| amount | numeric(10,2) | what Stripe actually charged (`amount_total`), falling back to the order's `total_price` |
| status | text (enum) | `pending`, `succeeded`, `failed`, `refunded`. The webhook writes `succeeded`; the rest are for manual use |
| raw_payload | jsonb | the full Stripe webhook event, for debugging/audit |
| created_at | timestamptz | |

The Stripe webhook writes one row per paid order, in the same SQL
statement that flips the order to `paid`. A webhook retry finds the
order already paid and writes nothing.

## `order_status_events`

The audit trail of every status change. Each row is written in the same
statement or transaction as the change itself, so an event never exists
without the change, or the change without its event.

| Column | Type | Notes |
|---|---|---|
| id | uuid, pk | |
| order_id | uuid, fk → orders.id | cascade delete; indexed with `created_at` |
| from_status | text | nullable |
| to_status | text | |
| changed_by | text | self-declared admin name (`X-Admin-Name`, default `admin`), or `stripe-webhook` |
| ip | text | client IP (the real one via Caddy, see `TRUST_PROXY`); null for the webhook |
| user_agent | text | null for the webhook |
| created_at | timestamptz | |

## Notes

- Status, tier, material and country columns use `text` with a `CHECK`
  constraint rather than a Postgres `enum` type. That keeps migrations
  simple, with no `ALTER TYPE` ceremony when a value is added.
- `pricing_config`, `quantity_discount_tiers` and `shipping_rates` hold
  placeholder values. Edit the rows directly; the site reads them live, so
  no redeploy is needed.
- Money is `numeric(10,2)` in the database. The services convert it to
  JS numbers and round to 2 decimals.
