-- Studio customization per item: the printed width (auto from the photo's
-- proportions, or set by hand when proportions are unlocked) and any text
-- elements (speech bubble / placard / caption). migrate.js re-runs every
-- file, so keep this idempotent.

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS width_in numeric(6,2);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS text_elements jsonb NOT NULL DEFAULT '[]';
