# Database Schema (PostgreSQL)

No `users` table in v1 — there's no auth. Customer identity lives directly
on the `orders` row. See `backend/src/db/migrations/001_init.sql` for the
runnable version of this.

## `orders`

| Column | Type | Notes |
|---|---|---|
| id | uuid, pk | |
| customer_email | text | required |
| customer_phone | text | required |
| shipping_address | jsonb | `{ line1, line2, city, region, postal_code, country }` |
| status | text (enum) | `pending_payment`, `paid`, `in_production`, `shipped`, `delivered`, `cancelled` |
| subtotal | numeric(10,2) | pre-discount total across all items |
| discount_amount | numeric(10,2) | for audit/display; product-only, never applied to shipping |
| shipping_amount | numeric(10,2) | sum of each item's shipping (see `shipping_rates`) |
| total_price | numeric(10,2) | what was actually charged: `subtotal - discount_amount + shipping_amount` |
| stripe_session_id | text | nullable until checkout session created |
| stripe_payment_intent_id | text | nullable until paid |
| created_at | timestamptz | |
| updated_at | timestamptz | |

## `order_items`

| Column | Type | Notes |
|---|---|---|
| id | uuid, pk | |
| order_id | uuid, fk → orders.id | |
| image_key | text | storage key from `POST /api/uploads`, e.g. `<uuid>.jpg`. Not a URL, so it works with either storage driver. Renamed from `image_url` in `003_image_key.sql` |
| size_tier | text (enum) | `small`, `medium`, `life_size`, `xl` |
| material | text (enum) | `cardboard`, `coroplast`, `foam_board`, `acrylic` |
| height_in | numeric(6,2) | manually entered by customer |
| quantity | integer | |
| unit_price | numeric(10,2) | snapshot at time of order (config may change later) |
| line_total | numeric(10,2) | `unit_price * quantity` |
| notes | text | nullable, free-form |

## `pricing_config`

| Column | Type | Notes |
|---|---|---|
| id | uuid, pk | |
| size_tier | text | see above |
| material | text | see above |
| base_rate | numeric(10,2) | |
| updated_at | timestamptz | |

Unique on `(size_tier, material)`.

## `quantity_discount_tiers`

| Column | Type | Notes |
|---|---|---|
| id | uuid, pk | |
| min_qty | integer | inclusive |
| max_qty | integer, nullable | inclusive; `null` means "and above" |
| discount_pct | numeric(5,2) | e.g. `10.00` for 10% |

Starting v1 values (adjust once real costs/margins are known):

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
| country | text | `CA`, `US` (ISO 3166 alpha-2; only these two in v1) |
| size_tier | text | see above |
| first_unit_rate | numeric(10,2) | shipping for the first unit of an item |
| additional_unit_rate | numeric(10,2) | shipping for each further unit of the same item |
| updated_at | timestamptz | |

Unique on `(country, size_tier)`. Shipping for an item is
`first_unit_rate + additional_unit_rate * (quantity - 1)`. Added in
`002_shipping.sql`; only CA / life_size first unit (122.00) is from a real
supplier quote, the rest are scaled placeholders.

## `payments`

| Column | Type | Notes |
|---|---|---|
| id | uuid, pk | |
| order_id | uuid, fk → orders.id | |
| provider | text | `stripe` |
| provider_txn_id | text | Stripe payment intent ID |
| amount | numeric(10,2) | |
| status | text (enum) | `pending`, `succeeded`, `failed`, `refunded` |
| raw_payload | jsonb | raw webhook payload, for debugging/audit |
| created_at | timestamptz | |

## Notes

- Status/tier/material columns use `text` with a `CHECK` constraint rather
  than a Postgres `enum` type, to keep the migration file simple (no
  `ALTER TYPE` ceremony later if a value needs adding).
- `pricing_config`, `quantity_discount_tiers` and `shipping_rates` are
  seeded with placeholder rates in the migrations — edit them directly once real
  supplier costs are known.
