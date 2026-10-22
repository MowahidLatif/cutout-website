-- The image audit's verdict on each item's print file, re-checked from the
-- stored file when the order is placed (services/imageAnalysis.js). Both
-- cap the print score at 59; shown to the supplier. Idempotent like 001–010.

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS is_blurry boolean NOT NULL DEFAULT false;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS is_compressed boolean NOT NULL DEFAULT false;
