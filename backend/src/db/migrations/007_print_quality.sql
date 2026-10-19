-- Print quality per item. There's no minimum photo resolution any more: the
-- server measures the stored image, rates how sharply it will print at the
-- chosen size (pixels per printed inch), and for a "low" rating records that
-- the customer confirmed they accept it. migrate.js re-runs every file, so
-- keep this idempotent.

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS image_width_px integer;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS image_height_px integer;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS print_ppi integer;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS low_quality_accepted boolean NOT NULL DEFAULT false;
