-- Shipping rates by destination country and size tier, plus a
-- shipping_amount column on orders. migrate.js re-runs every file, so
-- everything here must stay idempotent. See docs/database-schema.md.

CREATE TABLE IF NOT EXISTS shipping_rates (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country               text NOT NULL CHECK (country IN ('CA', 'US')),
  size_tier             text NOT NULL CHECK (size_tier IN ('small', 'medium', 'life_size', 'xl')),
  first_unit_rate       numeric(10,2) NOT NULL,
  additional_unit_rate  numeric(10,2) NOT NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (country, size_tier)
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_amount numeric(10,2) NOT NULL DEFAULT 0;

-- ---------- Seed starter shipping rates (placeholders) ----------
-- Only CA / life_size first unit (122.00) comes from a real supplier quote
-- (UPS, DDP to Winnipeg). Everything else is scaled from it — replace with
-- real UPS quotes as they come in.

INSERT INTO shipping_rates (country, size_tier, first_unit_rate, additional_unit_rate) VALUES
  ('CA', 'small',     60.00,  30.00),
  ('CA', 'medium',    90.00,  45.00),
  ('CA', 'life_size', 122.00, 60.00),
  ('CA', 'xl',        150.00, 75.00),
  ('US', 'small',     70.00,  35.00),
  ('US', 'medium',    100.00, 50.00),
  ('US', 'life_size', 135.00, 65.00),
  ('US', 'xl',        165.00, 80.00)
ON CONFLICT (country, size_tier) DO NOTHING;
