-- The border printed around each cutout: a hex colour from the storefront's
-- palette (services/catalog.js BORDER_COLORS), or null for no border.
-- Idempotent like 001–009.

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS border_color text
  CHECK (border_color IS NULL OR border_color ~ '^#[0-9A-F]{6}$');
