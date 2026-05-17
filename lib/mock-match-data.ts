// Hardcoded mock data for the /match design exploration.
// Shape mirrors the eventual `RankedDayOffer` from the backend plan so the
// component contracts won't budge when we wire this up. No DB access.

export interface MockHit {
  readonly source: "allergen" | "category" | "macro" | "embedding";
  readonly keyword: string;
  readonly channel: "prefer" | "avoid";
  /** Signed; positive for prefer hits, negative for avoid. */
  readonly contribution: number;
  readonly reason: string;
}

/** Per-meal macros (one serving). */
export interface MealMacros {
  readonly kcal: number;
  readonly protein_g: number;
  readonly fat_g: number;
  readonly carbs_g: number;
  readonly fiber_g: number;
  readonly sugar_g: number;
}

/** A single meal option in a slot (sans slot context). */
export interface MockMealOption extends MealMacros {
  readonly meal_name: string;
  /** Signed; sum of this option's hits.contribution. */
  readonly meal_score: number;
  readonly is_default: boolean;
  readonly hits: readonly MockHit[];
  /** Comma-separated ingredient list, Polish, as the dietly API returns it. */
  readonly ingredients_raw: string;
  /** Normalized allergen names from `dietlyAllergenName`. */
  readonly allergens: readonly string[];
}

export interface MockPick extends MockMealOption {
  readonly slot_name: string;
  /** Other meals available in this slot — only set on menu-config offers. */
  readonly alternates?: readonly MockMealOption[];
}

export interface MockOffer {
  readonly offer_id: string;
  readonly company_name: string;
  readonly diet_name: string;
  readonly tier_name: string | null;
  /** Diet's target kcal tier (1500 in the mock). */
  readonly calories: number;
  readonly is_menu_configuration: boolean;
  readonly price_per_day: number;
  readonly score_default: number;
  readonly score_best: number;
  readonly picks: readonly MockPick[];
  /** Aggregated daily macros across the picks. */
  readonly total_kcal: number;
  readonly total_protein_g: number;
  readonly total_fat_g: number;
  readonly total_carbs_g: number;
  readonly total_fiber_g: number;
  readonly total_sugar_g: number;
}

export interface MockDay {
  /** ISO yyyy-mm-dd. */
  readonly date: string;
  readonly weekday_short_pl: string;
  /** May be null when no menus were captured for this date. */
  readonly cheapest: MockOffer | null;
  /** May === cheapest (collapsed row) or null when no menus captured. */
  readonly best_fit: MockOffer | null;
  readonly total_considered: number;
  /** All offers for that day — for the scatter view. Includes cheapest + best_fit. */
  readonly all_offers: readonly MockOffer[];
}

/** Internal — a day before all_offers is computed. */
type RawDay = Omit<MockDay, "all_offers">;

export const MOCK_PREFER: readonly string[] = ["kurczak", "dużo białka"];
export const MOCK_AVOID: readonly string[] = ["pomidor", "gluten", "ostre"];
export const MOCK_ACTIVE_DAYS = 10;

// ── Hit helpers ──────────────────────────────────────────────────────────────

const preferHit = (
  source: MockHit["source"],
  keyword: string,
  contribution: number,
  reason: string
): MockHit => ({ channel: "prefer", contribution, keyword, reason, source });

const avoidHit = (
  source: MockHit["source"],
  keyword: string,
  contribution: number,
  reason: string
): MockHit => ({ channel: "avoid", contribution, keyword, reason, source });

// ── Macro registry ──────────────────────────────────────────────────────────
// Per-meal macros, keyed by meal_name. Values are illustrative for design,
// not real API data. `pick()` injects them into the literals below.

const macro = (
  kcal: number,
  protein: number,
  fat: number,
  carbs: number,
  fiber: number,
  sugar: number
): MealMacros => ({
  carbs_g: carbs,
  fat_g: fat,
  fiber_g: fiber,
  kcal,
  protein_g: protein,
  sugar_g: sugar,
});

const MEAL_MACROS: Readonly<Record<string, MealMacros>> = {
  "Ciasteczka owsiane z bananem": macro(240, 6, 10, 32, 3, 22),
  "Grzanki z serem i pomidorem": macro(320, 13, 14, 36, 4, 4),
  "Hummus z warzywami i podpłomykiem": macro(360, 14, 18, 36, 8, 6),
  "Indyk pieczony z cukinią i kaszą jaglaną": macro(460, 36, 14, 44, 6, 5),
  "Kanapka z serem żółtym i sałatą": macro(280, 15, 14, 24, 2, 3),
  "Koktajl białkowy banan-kakao": macro(240, 28, 4, 24, 3, 16),
  "Kurczak po grecku z ryżem basmati": macro(520, 38, 16, 54, 4, 4),
  "Mieszanka orzechów z suszoną żurawiną": macro(220, 8, 18, 12, 4, 16),
  "Omlet z kurczakiem i szpinakiem": macro(380, 32, 22, 8, 3, 2),
  "Owsianka z malinami i orzechami": macro(350, 10, 11, 52, 8, 18),
  "Pad thai z tofu i papryczką chili": macro(540, 22, 24, 56, 6, 14),
  "Pieczony łosoś z warzywami sezonowymi": macro(480, 32, 22, 28, 6, 6),
  "Sałatka grecka z fetą i pomidorami": macro(320, 14, 22, 18, 4, 8),
  "Sałatka z grillowanym kurczakiem i komosą": macro(380, 32, 16, 22, 6, 4),
  "Skyr z borówkami i pestkami dyni": macro(200, 22, 4, 18, 3, 18),
  "Spaghetti bolognese w sosie pomidorowym": macro(580, 24, 22, 68, 5, 12),
  "Tatar z łososia z kaparami i awokado": macro(320, 28, 18, 8, 2, 2),
  "Tortilla z kurczakiem, salsą i awokado": macro(420, 22, 18, 42, 4, 6),
};

/** Per-meal ingredients + allergens (illustrative). */
interface MealDetails {
  readonly ingredients_raw: string;
  readonly allergens: readonly string[];
}

const MEAL_DETAILS: Readonly<Record<string, MealDetails>> = {
  "Ciasteczka owsiane z bananem": {
    allergens: ["gluten"],
    ingredients_raw: "płatki owsiane, banan, miód, cynamon, olej kokosowy, sól",
  },
  "Grzanki z serem i pomidorem": {
    allergens: ["gluten", "mleko"],
    ingredients_raw:
      "chleb pszenny, ser żółty, pomidor, oliwa, oregano, czosnek",
  },
  "Hummus z warzywami i podpłomykiem": {
    allergens: ["gluten", "sezam"],
    ingredients_raw:
      "ciecierzyca, tahini, oliwa, czosnek, cytryna, kumin, marchew, papryka, ogórek, podpłomyk",
  },
  "Indyk pieczony z cukinią i kaszą jaglaną": {
    allergens: [],
    ingredients_raw:
      "pierś z indyka, cukinia, kasza jaglana, oliwa, tymianek, czosnek, sól, pieprz",
  },
  "Kanapka z serem żółtym i sałatą": {
    allergens: ["gluten", "mleko"],
    ingredients_raw: "chleb pszenny, ser żółty, sałata, ogórek, masło",
  },
  "Koktajl białkowy banan-kakao": {
    allergens: ["mleko"],
    ingredients_raw:
      "białko serwatkowe, mleko migdałowe, banan, kakao, daktyle, cynamon",
  },
  "Kurczak po grecku z ryżem basmati": {
    allergens: [],
    ingredients_raw:
      "pierś z kurczaka, ryż basmati, oliwa, czosnek, oregano, cytryna, papryka, sól, pieprz",
  },
  "Mieszanka orzechów z suszoną żurawiną": {
    allergens: ["orzechy"],
    ingredients_raw:
      "migdały, nerkowce, orzechy włoskie, pestki dyni, suszona żurawina",
  },
  "Omlet z kurczakiem i szpinakiem": {
    allergens: ["jaja"],
    ingredients_raw:
      "jaja, pierś z kurczaka, szpinak, oliwa, cebula, sól, pieprz",
  },
  "Owsianka z malinami i orzechami": {
    allergens: ["gluten", "mleko", "orzechy"],
    ingredients_raw:
      "płatki owsiane, mleko, maliny, orzechy włoskie, miód, cynamon",
  },
  "Pad thai z tofu i papryczką chili": {
    allergens: ["gluten", "soja", "orzechy"],
    ingredients_raw:
      "makaron ryżowy, tofu, papryka, papryczka chili, sos sojowy, orzeszki ziemne, kolendra, limonka",
  },
  "Pieczony łosoś z warzywami sezonowymi": {
    allergens: ["ryby"],
    ingredients_raw:
      "łosoś atlantycki, brokuły, marchew, cukinia, oliwa, koperek, cytryna, sól",
  },
  "Sałatka grecka z fetą i pomidorami": {
    allergens: ["mleko"],
    ingredients_raw:
      "feta, pomidory malinowe, ogórek, czerwona cebula, oliwki, oliwa, oregano, sól",
  },
  "Sałatka z grillowanym kurczakiem i komosą": {
    allergens: [],
    ingredients_raw:
      "pierś z kurczaka, komosa ryżowa, rukola, pomidorki koktajlowe, oliwa, cytryna, sól",
  },
  "Skyr z borówkami i pestkami dyni": {
    allergens: ["mleko"],
    ingredients_raw: "skyr naturalny, borówki, pestki dyni, miód",
  },
  "Spaghetti bolognese w sosie pomidorowym": {
    allergens: ["gluten", "mleko"],
    ingredients_raw:
      "makaron spaghetti, wołowina mielona, pomidory pelati, cebula, czosnek, marchew, parmezan, oliwa, bazylia",
  },
  "Tatar z łososia z kaparami i awokado": {
    allergens: ["ryby"],
    ingredients_raw:
      "surowy łosoś, awokado, kapary, cebula szalotka, oliwa, sok z cytryny, koperek",
  },
  "Tortilla z kurczakiem, salsą i awokado": {
    allergens: ["gluten"],
    ingredients_raw:
      "tortilla pszenna, pierś z kurczaka, awokado, salsa pomidorowa, sałata, kolendra",
  },
};

const FALLBACK_DETAILS: MealDetails = {
  allergens: [],
  ingredients_raw: "—",
};

const pick = (
  bare: Omit<
    MockPick,
    keyof MealMacros | "alternates" | "ingredients_raw" | "allergens"
  >
): MockPick => ({
  ...bare,
  ...(MEAL_MACROS[bare.meal_name] ?? macro(300, 15, 10, 35, 4, 6)),
  ...(MEAL_DETAILS[bare.meal_name] ?? FALLBACK_DETAILS),
});

/** Sum a list of picks into total daily macros. */
export const aggregateMacros = (
  meals: readonly Readonly<MealMacros>[]
): MealMacros => {
  let kcal = 0;
  let protein_g = 0;
  let fat_g = 0;
  let carbs_g = 0;
  let fiber_g = 0;
  let sugar_g = 0;
  for (const m of meals) {
    kcal += m.kcal;
    protein_g += m.protein_g;
    fat_g += m.fat_g;
    carbs_g += m.carbs_g;
    fiber_g += m.fiber_g;
    sugar_g += m.sugar_g;
  }
  return { carbs_g, fat_g, fiber_g, kcal, protein_g, sugar_g };
};

// ── Pick library — small reusable bank of slot picks, hand-crafted. ──────────
// Names are realistic-Polish; macros come from `MEAL_MACROS` above.

const owsiankaMaliny = pick({
  hits: [],
  is_default: true,
  meal_name: "Owsianka z malinami i orzechami",
  meal_score: 0,
  slot_name: "śniadanie",
});

const omletKurczak = pick({
  hits: [
    preferHit("embedding", "kurczak", 0.82, 'matches "kurczak" (sim=0.81)'),
    preferHit("macro", "dużo białka", 1, "protein 14g / 100kcal ≥ p75"),
  ],
  is_default: false,
  meal_name: "Omlet z kurczakiem i szpinakiem",
  meal_score: 1.82,
  slot_name: "śniadanie",
});

const grzankiPomidor = pick({
  hits: [
    avoidHit("category", "gluten", -1, "allergen: gluten (chleb pszenny)"),
    avoidHit("embedding", "pomidor", -0.74, 'matches "pomidor" (sim=0.74)'),
  ],
  is_default: true,
  meal_name: "Grzanki z serem i pomidorem",
  meal_score: -1.74,
  slot_name: "śniadanie",
});

const koktajlBialkowy = pick({
  hits: [
    preferHit("macro", "dużo białka", 1, "protein 18g / 100kcal ≥ p75"),
    preferHit("embedding", "kurczak", 0.42, "embedding (sim=0.42, weak)"),
  ],
  is_default: false,
  meal_name: "Koktajl białkowy banan-kakao",
  meal_score: 1.42,
  slot_name: "ii śniadanie",
});

const kanapkaSer = pick({
  hits: [avoidHit("category", "gluten", -1, "allergen: gluten (chleb)")],
  is_default: true,
  meal_name: "Kanapka z serem żółtym i sałatą",
  meal_score: -1,
  slot_name: "ii śniadanie",
});

const kurczakRyz = pick({
  hits: [
    preferHit("embedding", "kurczak", 0.91, 'matches "kurczak" (sim=0.91)'),
    preferHit("macro", "dużo białka", 1, "protein 13g / 100kcal ≥ p75"),
  ],
  is_default: true,
  meal_name: "Kurczak po grecku z ryżem basmati",
  meal_score: 1.91,
  slot_name: "obiad",
});

const lososWarzywa = pick({
  hits: [preferHit("macro", "dużo białka", 1, "protein 12g / 100kcal ≥ p75")],
  is_default: false,
  meal_name: "Pieczony łosoś z warzywami sezonowymi",
  meal_score: 1,
  slot_name: "obiad",
});

const padThaiOstry = pick({
  hits: [
    avoidHit("embedding", "ostre", -0.68, 'matches "ostre" (sim=0.68)'),
    avoidHit("category", "gluten", -1, "allergen: gluten (sos sojowy)"),
  ],
  is_default: true,
  meal_name: "Pad thai z tofu i papryczką chili",
  meal_score: -1.68,
  slot_name: "obiad",
});

const spaghettiPomidor = pick({
  hits: [
    avoidHit("embedding", "pomidor", -0.88, 'matches "pomidor" (sim=0.88)'),
    avoidHit("category", "gluten", -1, "allergen: gluten (makaron)"),
  ],
  is_default: true,
  meal_name: "Spaghetti bolognese w sosie pomidorowym",
  meal_score: -1.88,
  slot_name: "obiad",
});

const indykCukinia = pick({
  hits: [
    preferHit("embedding", "kurczak", 0.61, 'matches "kurczak" (sim=0.61)'),
    preferHit("macro", "dużo białka", 1, "protein 11g / 100kcal ≥ p75"),
  ],
  is_default: false,
  meal_name: "Indyk pieczony z cukinią i kaszą jaglaną",
  meal_score: 1.61,
  slot_name: "obiad",
});

const orzechyMigdaly = pick({
  hits: [],
  is_default: true,
  meal_name: "Mieszanka orzechów z suszoną żurawiną",
  meal_score: 0,
  slot_name: "podwieczorek",
});

const skyrBorowki = pick({
  hits: [preferHit("macro", "dużo białka", 1, "protein 10g / 100kcal ≥ p75")],
  is_default: false,
  meal_name: "Skyr z borówkami i pestkami dyni",
  meal_score: 1,
  slot_name: "podwieczorek",
});

const ciasteczkaOwsiane = pick({
  hits: [avoidHit("category", "gluten", -1, "allergen: gluten (owies)")],
  is_default: true,
  meal_name: "Ciasteczka owsiane z bananem",
  meal_score: -1,
  slot_name: "podwieczorek",
});

const salataKurczak = pick({
  hits: [
    preferHit("embedding", "kurczak", 0.87, 'matches "kurczak" (sim=0.87)'),
    preferHit("macro", "dużo białka", 1, "protein 16g / 100kcal ≥ p75"),
  ],
  is_default: true,
  meal_name: "Sałatka z grillowanym kurczakiem i komosą",
  meal_score: 1.87,
  slot_name: "kolacja",
});

const salataFetaPomidor = pick({
  hits: [
    avoidHit("embedding", "pomidor", -0.79, 'matches "pomidor" (sim=0.79)'),
  ],
  is_default: true,
  meal_name: "Sałatka grecka z fetą i pomidorami",
  meal_score: -0.79,
  slot_name: "kolacja",
});

const hummusWarzywa = pick({
  hits: [],
  is_default: true,
  meal_name: "Hummus z warzywami i podpłomykiem",
  meal_score: 0,
  slot_name: "kolacja",
});

const tortilla = pick({
  hits: [
    avoidHit("category", "gluten", -1, "allergen: gluten (tortilla)"),
    avoidHit("embedding", "pomidor", -0.55, 'matches "pomidor" (sim=0.55)'),
  ],
  is_default: true,
  meal_name: "Tortilla z kurczakiem, salsą i awokado",
  meal_score: -0.55,
  slot_name: "kolacja",
});

const tatarLososiowy = pick({
  hits: [preferHit("macro", "dużo białka", 1, "protein 17g / 100kcal ≥ p75")],
  is_default: false,
  meal_name: "Tatar z łososia z kaparami i awokado",
  meal_score: 1,
  slot_name: "kolacja",
});

// ── Per-slot alternates ──────────────────────────────────────────────────────
// For menu-config offers, each picked meal gets siblings from the same slot
// so the user can swap. Built once from the pick library above.

const toOption = (p: MockPick): MockMealOption => ({
  allergens: p.allergens,
  carbs_g: p.carbs_g,
  fat_g: p.fat_g,
  fiber_g: p.fiber_g,
  hits: p.hits,
  ingredients_raw: p.ingredients_raw,
  is_default: p.is_default,
  kcal: p.kcal,
  meal_name: p.meal_name,
  meal_score: p.meal_score,
  protein_g: p.protein_g,
  sugar_g: p.sugar_g,
});

const SLOT_ALTERNATES: Readonly<Record<string, readonly MockMealOption[]>> = {
  "ii śniadanie": [koktajlBialkowy, kanapkaSer].map(toOption),
  kolacja: [
    salataKurczak,
    salataFetaPomidor,
    hummusWarzywa,
    tortilla,
    tatarLososiowy,
  ].map(toOption),
  obiad: [
    kurczakRyz,
    lososWarzywa,
    padThaiOstry,
    spaghettiPomidor,
    indykCukinia,
  ].map(toOption),
  podwieczorek: [orzechyMigdaly, skyrBorowki, ciasteczkaOwsiane].map(toOption),
  śniadanie: [owsiankaMaliny, omletKurczak, grzankiPomidor].map(toOption),
};

const withAlternates = (p: MockPick): MockPick => {
  const pool = SLOT_ALTERNATES[p.slot_name] ?? [];
  const others = pool.filter((o) => o.meal_name !== p.meal_name);
  return { ...p, alternates: others };
};

// ── Offer builders ───────────────────────────────────────────────────────────

const offer = (
  id: string,
  company: string,
  diet: string,
  tier: string | null,
  calories: number,
  price: number,
  picks: readonly MockPick[],
  opts?: Readonly<{
    is_menu_configuration?: boolean;
    score_default_override?: number;
  }>
): MockOffer => {
  const isMenuConfig = opts?.is_menu_configuration ?? false;
  const resolved = isMenuConfig ? picks.map(withAlternates) : picks;
  const scoreBest = resolved.reduce((acc, p) => acc + p.meal_score, 0);
  const scoreDefault =
    opts?.score_default_override ??
    resolved
      .filter((p) => p.is_default)
      .reduce((acc, p) => acc + p.meal_score, 0);
  const totals = aggregateMacros(resolved);
  return {
    calories,
    company_name: company,
    diet_name: diet,
    is_menu_configuration: isMenuConfig,
    offer_id: id,
    picks: resolved,
    price_per_day: price,
    score_best: Number(scoreBest.toFixed(2)),
    score_default: Number(scoreDefault.toFixed(2)),
    tier_name: tier,
    total_carbs_g: totals.carbs_g,
    total_fat_g: totals.fat_g,
    total_fiber_g: totals.fiber_g,
    total_kcal: totals.kcal,
    total_protein_g: totals.protein_g,
    total_sugar_g: totals.sugar_g,
  };
};

// ── Day library ──────────────────────────────────────────────────────────────

// Strongly negative cheapest, premium best-fit — biggest contrast day.
const day_2026_05_18: RawDay = {
  best_fit: offer(
    "fitcatering::vege::1500",
    "fitcatering",
    "wege premium",
    "vege",
    1500,
    62.5,
    [omletKurczak, koktajlBialkowy, kurczakRyz, skyrBorowki, salataKurczak]
  ),
  cheapest: offer(
    "robinfood::std::1500",
    "robinfood",
    "standard",
    "klasyczny",
    1500,
    49.9,
    [
      grzankiPomidor,
      kanapkaSer,
      spaghettiPomidor,
      ciasteczkaOwsiane,
      salataFetaPomidor,
    ]
  ),
  date: "2026-05-18",
  total_considered: 14,
  weekday_short_pl: "pon",
};

// Cheap == best-fit — collapsed row.
const day_2026_05_19_offer = offer(
  "maczfit::std::1500",
  "maczfit",
  "standard",
  "elastyczny",
  1500,
  54.2,
  [owsiankaMaliny, koktajlBialkowy, kurczakRyz, skyrBorowki, salataKurczak]
);
const day_2026_05_19: RawDay = {
  best_fit: day_2026_05_19_offer,
  cheapest: day_2026_05_19_offer,
  date: "2026-05-19",
  total_considered: 14,
  weekday_short_pl: "wt",
};

// Very negative cheapest score (lots of avoid hits).
const day_2026_05_20: RawDay = {
  best_fit: offer(
    "fitness-meals::premium::1500",
    "fitness-meals",
    "high-protein",
    "premium",
    1500,
    71.2,
    [omletKurczak, koktajlBialkowy, kurczakRyz, skyrBorowki, tatarLososiowy]
  ),
  cheapest: offer(
    "bodychief::std::1500",
    "bodychief",
    "standard",
    null,
    1500,
    47.3,
    [
      grzankiPomidor,
      kanapkaSer,
      padThaiOstry,
      ciasteczkaOwsiane,
      salataFetaPomidor,
    ]
  ),
  date: "2026-05-20",
  total_considered: 16,
  weekday_short_pl: "śr",
};

// Menu-config best-fit: score_best > score_default (achievable via picks).
const day_2026_05_21: RawDay = {
  best_fit: offer(
    "bodychief::active::1500",
    "bodychief",
    "active",
    "menu-config",
    1500,
    56.8,
    [omletKurczak, koktajlBialkowy, indykCukinia, skyrBorowki, salataKurczak],
    { is_menu_configuration: true, score_default_override: 1.2 }
  ),
  cheapest: offer(
    "dieta-od-brzucha::std::1500",
    "dieta od brzucha",
    "standard",
    null,
    1500,
    51.4,
    [owsiankaMaliny, kanapkaSer, lososWarzywa, orzechyMigdaly, hummusWarzywa],
    { score_default_override: 0 }
  ),
  date: "2026-05-21",
  total_considered: 13,
  weekday_short_pl: "czw",
};

// Mixed channels — both prefer and avoid present in cheapest.
const day_2026_05_22: RawDay = {
  best_fit: offer(
    "be-diet::vege::1500",
    "be-diet",
    "wege",
    "vege+",
    1500,
    64.3,
    [omletKurczak, koktajlBialkowy, indykCukinia, skyrBorowki, salataKurczak]
  ),
  cheapest: offer(
    "lightbox::std::1500",
    "lightbox",
    "standard",
    null,
    1500,
    48.7,
    [
      owsiankaMaliny,
      koktajlBialkowy,
      spaghettiPomidor,
      ciasteczkaOwsiane,
      tortilla,
    ]
  ),
  date: "2026-05-22",
  total_considered: 15,
  weekday_short_pl: "pt",
};

// Weekend menu-config — score_best > score_default again, smaller margin.
const day_2026_05_23: RawDay = {
  best_fit: offer(
    "maczfit::weekend::1500",
    "maczfit",
    "weekend",
    "menu-config",
    1500,
    58.4,
    [omletKurczak, kanapkaSer, indykCukinia, skyrBorowki, salataKurczak],
    { is_menu_configuration: true, score_default_override: 0 }
  ),
  cheapest: offer(
    "robinfood::weekend::1500",
    "robinfood",
    "weekend",
    "klasyczny",
    1500,
    52.1,
    [
      grzankiPomidor,
      kanapkaSer,
      padThaiOstry,
      orzechyMigdaly,
      salataFetaPomidor,
    ]
  ),
  date: "2026-05-23",
  total_considered: 11,
  weekday_short_pl: "sob",
};

// No captured menus for this date — graceful placeholder.
const day_2026_05_24: RawDay = {
  best_fit: null,
  cheapest: null,
  date: "2026-05-24",
  total_considered: 0,
  weekday_short_pl: "nd",
};

// Cheap == best-fit again, second occurrence — visual rhythm check.
const day_2026_05_25_offer = offer(
  "fitcatering::vege::1500",
  "fitcatering",
  "wege premium",
  "vege",
  1500,
  60.1,
  [omletKurczak, koktajlBialkowy, kurczakRyz, skyrBorowki, salataKurczak]
);
const day_2026_05_25: RawDay = {
  best_fit: day_2026_05_25_offer,
  cheapest: day_2026_05_25_offer,
  date: "2026-05-25",
  total_considered: 14,
  weekday_short_pl: "pon",
};

// Small negative cheapest, small premium for best-fit — quiet day.
const day_2026_05_26: RawDay = {
  best_fit: offer(
    "pure-food::std::1500",
    "pure-food",
    "standard",
    "balanced",
    1500,
    55.9,
    [omletKurczak, koktajlBialkowy, indykCukinia, skyrBorowki, hummusWarzywa]
  ),
  cheapest: offer(
    "bodychief::std::1500",
    "bodychief",
    "standard",
    null,
    1500,
    47.3,
    [owsiankaMaliny, kanapkaSer, lososWarzywa, ciasteczkaOwsiane, tortilla]
  ),
  date: "2026-05-26",
  total_considered: 16,
  weekday_short_pl: "wt",
};

// Best-fit is also menu-config — biggest score_best lift in the set.
const day_2026_05_27: RawDay = {
  best_fit: offer(
    "bodychief::active-premium::1500",
    "bodychief",
    "active premium",
    "menu-config",
    1500,
    61.3,
    [omletKurczak, koktajlBialkowy, kurczakRyz, skyrBorowki, tatarLososiowy],
    { is_menu_configuration: true, score_default_override: 1.8 }
  ),
  cheapest: offer(
    "robinfood::std::1500",
    "robinfood",
    "standard",
    "klasyczny",
    1500,
    49.5,
    [owsiankaMaliny, koktajlBialkowy, lososWarzywa, orzechyMigdaly, tortilla]
  ),
  date: "2026-05-27",
  total_considered: 17,
  weekday_short_pl: "śr",
};

// ── Extras pool — fills out the scatter so each day has 6–8 offers ──────────
// Companies here do NOT appear as cheapest/best_fit anywhere above, so
// offer_ids stay unique within a single day's all_offers list.

interface ExtraSpec {
  readonly id: string;
  readonly company: string;
  readonly diet: string;
  readonly tier: string | null;
}

const EXTRA_POOL: readonly ExtraSpec[] = [
  {
    company: "naturhouse",
    diet: "standard",
    id: "naturhouse::std::1500",
    tier: null,
  },
  {
    company: "kuchnia Tomasza",
    diet: "standard",
    id: "kuchnia-tomasza::std::1500",
    tier: "domowy",
  },
  {
    company: "fitfusion",
    diet: "premium",
    id: "fitfusion::premium::1500",
    tier: "balanced",
  },
  {
    company: "strefa cateringu",
    diet: "wege",
    id: "strefa::vege::1500",
    tier: "vege",
  },
  {
    company: "vivedo",
    diet: "sport",
    id: "vivedo::sport::1500",
    tier: "high-protein",
  },
  {
    company: "smartchef",
    diet: "standard",
    id: "smartchef::std::1500",
    tier: null,
  },
];

// Six pick combos covering the score spectrum.
const PICK_COMBOS: readonly (readonly MockPick[])[] = [
  // 0: strongly positive — protein-heavy with kurczak picks
  [omletKurczak, koktajlBialkowy, kurczakRyz, skyrBorowki, salataKurczak],
  // 1: balanced — mostly neutral, one prefer hit
  [
    owsiankaMaliny,
    koktajlBialkowy,
    lososWarzywa,
    orzechyMigdaly,
    hummusWarzywa,
  ],
  // 2: strongly negative — pomidor + gluten heavy
  [
    grzankiPomidor,
    kanapkaSer,
    spaghettiPomidor,
    ciasteczkaOwsiane,
    salataFetaPomidor,
  ],
  // 3: mostly positive with one mid-negative
  [omletKurczak, kanapkaSer, indykCukinia, skyrBorowki, salataKurczak],
  // 4: mixed
  [
    owsiankaMaliny,
    koktajlBialkowy,
    spaghettiPomidor,
    ciasteczkaOwsiane,
    salataKurczak,
  ],
  // 5: positive
  [omletKurczak, koktajlBialkowy, indykCukinia, orzechyMigdaly, tatarLososiowy],
];

const EXTRA_PRICES: readonly number[] = [52.6, 56.3, 49.4, 58.7, 64.2, 68.5];

const makeExtras = (dayIdx: number): readonly MockOffer[] =>
  EXTRA_POOL.map((spec, i) => {
    const combo = PICK_COMBOS[(i + dayIdx) % PICK_COMBOS.length];
    const price = EXTRA_PRICES[i] + ((dayIdx % 3) - 1) * 0.6;
    return offer(
      spec.id,
      spec.company,
      spec.diet,
      spec.tier,
      1500,
      price,
      combo
    );
  });

const buildAllOffers = (
  raw: Readonly<RawDay>,
  dayIdx: number
): readonly MockOffer[] => {
  if (raw.cheapest === null || raw.best_fit === null) {
    return [];
  }
  const base =
    raw.cheapest.offer_id === raw.best_fit.offer_id
      ? [raw.cheapest]
      : [raw.cheapest, raw.best_fit];
  return [...base, ...makeExtras(dayIdx)];
};

const RAW_DAYS: readonly RawDay[] = [
  day_2026_05_18,
  day_2026_05_19,
  day_2026_05_20,
  day_2026_05_21,
  day_2026_05_22,
  day_2026_05_23,
  day_2026_05_24,
  day_2026_05_25,
  day_2026_05_26,
  day_2026_05_27,
];

export const MOCK_DAYS: readonly MockDay[] = RAW_DAYS.map((d, i) => ({
  ...d,
  all_offers: buildAllOffers(d, i),
}));
