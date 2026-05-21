-- v9: capture dietly's per-catering "is the nutrition / ingredient body
-- displayable" flags. Some caterings (urbanfits, mojcatering, dietapirata,
-- przelomwodzywianiu, ...) opt out of showing nutrition or ingredients in
-- dietly's own UI; the menu API still returns a body for those — often a
-- placeholder blob replicated across every option (the "leczo bug") — but
-- dietly's clients honor formSettings and never show it. We need to do the
-- same.
--
-- Both default to TRUE (the historically-assumed behavior). The catalog
-- scraper will overwrite per scrape from constant.formSettings.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS nutrition_visible   BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS ingredients_visible BOOLEAN NOT NULL DEFAULT TRUE;
