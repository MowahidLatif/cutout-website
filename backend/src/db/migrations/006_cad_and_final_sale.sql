-- The site now charges in Canadian dollars, and every order records that
-- the customer accepted the final-sale (no returns) policy.
-- migrate.js re-runs every file, so keep this idempotent.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'CAD';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS final_sale_accepted_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS final_sale_policy_version text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS currency text;

-- One-time data changes are recorded here so a re-run can never repeat them
-- (e.g. re-converting a price you later set to a value that happens to
-- equal an old seed).
CREATE TABLE IF NOT EXISTS schema_flags (
  name        text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- Convert the USD placeholder prices to CAD (× 1.38, whole dollars) ----------
-- The seeds in 001/002 were entered as US dollars (the supplier quotes in
-- USD). Only rows still at their exact original seed value are converted;
-- anything edited by hand is left alone. Discount tiers are percentages.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_flags WHERE name = '006_seed_prices_usd_to_cad') THEN
    UPDATE pricing_config p
    SET base_rate = round(p.base_rate * 1.38), updated_at = now()
    FROM (VALUES
      ('small', 'cardboard', 25.00), ('small', 'coroplast', 32.00), ('small', 'foam_board', 38.00), ('small', 'acrylic', 60.00),
      ('medium', 'cardboard', 35.00), ('medium', 'coroplast', 45.00), ('medium', 'foam_board', 53.00), ('medium', 'acrylic', 85.00),
      ('life_size', 'cardboard', 45.00), ('life_size', 'coroplast', 58.00), ('life_size', 'foam_board', 68.00), ('life_size', 'acrylic', 110.00),
      ('xl', 'cardboard', 60.00), ('xl', 'coroplast', 78.00), ('xl', 'foam_board', 92.00), ('xl', 'acrylic', 150.00)
    ) AS seed (size_tier, material, base_rate)
    WHERE p.size_tier = seed.size_tier AND p.material = seed.material AND p.base_rate = seed.base_rate;

    UPDATE shipping_rates s
    SET first_unit_rate = round(s.first_unit_rate * 1.38),
        additional_unit_rate = round(s.additional_unit_rate * 1.38),
        updated_at = now()
    FROM (VALUES
      ('CA', 'small', 60.00, 30.00), ('CA', 'medium', 90.00, 45.00), ('CA', 'life_size', 122.00, 60.00), ('CA', 'xl', 150.00, 75.00),
      ('US', 'small', 70.00, 35.00), ('US', 'medium', 100.00, 50.00), ('US', 'life_size', 135.00, 65.00), ('US', 'xl', 165.00, 80.00)
    ) AS seed (country, size_tier, first_unit_rate, additional_unit_rate)
    WHERE s.country = seed.country AND s.size_tier = seed.size_tier
      AND s.first_unit_rate = seed.first_unit_rate AND s.additional_unit_rate = seed.additional_unit_rate;

    INSERT INTO schema_flags (name) VALUES ('006_seed_prices_usd_to_cad');
  END IF;
END $$;
