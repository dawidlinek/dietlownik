-- v3: support "ready" (non-tiered) diets whose kcal IDs come from dietPriceInfo

-- diet_calories rows for ready diets have no tier/option parent
ALTER TABLE diet_calories
  ALTER COLUMN diet_option_id DROP NOT NULL,
  ALTER COLUMN tier_id        DROP NOT NULL,
  ALTER COLUMN calories       DROP NOT NULL;

-- the composite FK requires all four columns to be non-null; drop it
ALTER TABLE diet_calories
  DROP CONSTRAINT IF EXISTS diet_calories_diet_option_id_tier_id_diet_id_company_id_fkey;

-- keep individual FKs that still hold
ALTER TABLE diet_calories
  ADD CONSTRAINT fk_diet_calories_company
    FOREIGN KEY (diet_id, company_id) REFERENCES diets(diet_id, company_id) ON DELETE CASCADE;
