-- Starter ingredient taxonomy.
-- Upserted (ON CONFLICT DO NOTHING) so user edits and re-runs are safe.

INSERT INTO ingredient_taxonomy (category, label, description) VALUES
  ('psiankowate',  'Psiankowate',  'Rośliny psiankowate — pomidor, ziemniak, papryka, bakłażan, papryczki, chili.'),
  ('strączkowe',   'Strączkowe',   'Rośliny strączkowe — fasola, soczewica, ciecierzyca, soja, groch.'),
  ('nabiał',       'Nabiał',       'Produkty mleczne — mleko, twaróg, ser, jogurt, kefir, śmietana, masło.'),
  ('ryby',         'Ryby',         'Ryby morskie i słodkowodne — łosoś, dorsz, makrela, pstrąg, tuńczyk itd.'),
  ('owoce_morza',  'Owoce morza',  'Krewetki, małże, ośmiornica, kalmary, mule, ostrygi.'),
  ('orzechy',      'Orzechy',      'Orzechy włoskie, laskowe, nerkowca, migdały, pistacje, pekan, makadamia.')
ON CONFLICT (category) DO NOTHING;

INSERT INTO ingredient_taxonomy_members (category, ingredient_pattern) VALUES
  -- psiankowate
  ('psiankowate', 'pomidor'),
  ('psiankowate', 'ziemniak'),
  ('psiankowate', 'papryka'),
  ('psiankowate', 'bakłażan'),
  ('psiankowate', 'baklazan'),
  ('psiankowate', 'papryczka'),
  ('psiankowate', 'chili'),
  -- strączkowe
  ('strączkowe', 'fasola'),
  ('strączkowe', 'soczewica'),
  ('strączkowe', 'ciecierzyca'),
  ('strączkowe', 'soja'),
  ('strączkowe', 'groch'),
  -- nabiał
  ('nabiał', 'mleko'),
  ('nabiał', 'twaróg'),
  ('nabiał', 'twarog'),
  ('nabiał', 'ser'),
  ('nabiał', 'jogurt'),
  ('nabiał', 'kefir'),
  ('nabiał', 'śmietana'),
  ('nabiał', 'smietana'),
  ('nabiał', 'masło'),
  ('nabiał', 'maslo'),
  -- ryby
  ('ryby', 'ryba'),
  ('ryby', 'łosoś'),
  ('ryby', 'losos'),
  ('ryby', 'dorsz'),
  ('ryby', 'makrela'),
  ('ryby', 'pstrąg'),
  ('ryby', 'pstrag'),
  ('ryby', 'tuńczyk'),
  ('ryby', 'tunczyk'),
  ('ryby', 'śledź'),
  ('ryby', 'sledz'),
  ('ryby', 'sardynka'),
  ('ryby', 'mintaj'),
  -- owoce_morza
  ('owoce_morza', 'krewetk'),
  ('owoce_morza', 'małż'),
  ('owoce_morza', 'malz'),
  ('owoce_morza', 'ośmiornic'),
  ('owoce_morza', 'osmiornic'),
  ('owoce_morza', 'kalmar'),
  ('owoce_morza', 'mule'),
  ('owoce_morza', 'ostryg'),
  -- orzechy
  ('orzechy', 'orzech'),
  ('orzechy', 'migdał'),
  ('orzechy', 'migdal'),
  ('orzechy', 'pistacj'),
  ('orzechy', 'nerkowiec'),
  ('orzechy', 'nerkowca'),
  ('orzechy', 'pekan'),
  ('orzechy', 'makadamia')
ON CONFLICT (category, ingredient_pattern) DO NOTHING;
