// Hardcoded mock data for the /match design exploration.
// Shape lives in `lib/match-types.ts`; this file only supplies fixtures.

import { aggregateMacros } from "./match-types";
import type {
  Day,
  Hit,
  MealMacros,
  MealOption,
  Offer,
  Pick,
  Promo,
} from "./match-types";

export { aggregateMacros };

/** Internal — a day before all_offers is computed. */
type RawDay = Omit<Day, "all_offers">;

export const MOCK_PREFER: readonly string[] = ["kurczak", "dużo białka"];
export const MOCK_AVOID: readonly string[] = ["pomidor", "gluten", "ostre"];
export const MOCK_ACTIVE_DAYS = 10;

// ── Hit helpers ──────────────────────────────────────────────────────────────

const preferHit = (
  source: Hit["source"],
  keyword: string,
  contribution: number,
  reason: string
): Hit => ({ channel: "prefer", contribution, keyword, reason, source });

const avoidHit = (
  source: Hit["source"],
  keyword: string,
  contribution: number,
  reason: string
): Hit => ({ channel: "avoid", contribution, keyword, reason, source });

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
  "Pierś z kurczaka z batatami i awokado": macro(540, 42, 18, 38, 7, 6),
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
  "Pierś z kurczaka z batatami i awokado": {
    allergens: [],
    ingredients_raw:
      "pierś z kurczaka, batat, awokado, oliwa z oliwek, czosnek, papryka wędzona, limonka, kolendra, sól, pieprz",
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
    Pick,
    | keyof MealMacros
    | "alternates"
    | "ingredients_raw"
    | "allergens"
    | "review_score"
  >
): Pick => ({
  ...bare,
  ...(MEAL_MACROS[bare.meal_name] ?? macro(300, 15, 10, 35, 4, 6)),
  ...(MEAL_DETAILS[bare.meal_name] ?? FALLBACK_DETAILS),
  review_score: null,
});

// `aggregateMacros` is re-exported from "./match-types" above.

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

// Premium pick used to showcase menu-config swaps — beats every PICK_COMBOS
// option so the menu-config offer ranks #1 by score-desc on its day.
const piersKurczakaBataty = pick({
  hits: [
    preferHit(
      "embedding",
      "kurczak",
      1.1,
      'silne dopasowanie "kurczak" (sim=0.93)'
    ),
    preferHit("macro", "dużo białka", 1.2, "protein 21g / 100kcal ≥ p90"),
  ],
  is_default: false,
  meal_name: "Pierś z kurczaka z batatami i awokado",
  meal_score: 2.3,
  slot_name: "kolacja",
});

// ── Per-slot alternates ──────────────────────────────────────────────────────
// For menu-config offers, each picked meal gets siblings from the same slot
// so the user can swap. Built once from the pick library above.

const toOption = (p: Pick): MealOption => ({
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
  review_score: p.review_score,
  sugar_g: p.sugar_g,
});

const SLOT_ALTERNATES: Readonly<Record<string, readonly MealOption[]>> = {
  "ii śniadanie": [koktajlBialkowy, kanapkaSer].map(toOption),
  kolacja: [
    piersKurczakaBataty,
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

const withAlternates = (p: Pick): Pick => {
  const pool = SLOT_ALTERNATES[p.slot_name] ?? [];
  const others = pool.filter((o) => o.meal_name !== p.meal_name);
  return { ...p, alternates: others };
};

// ── Real Wrocław catering names + logos ─────────────────────────────────────
// Snapshotted from the production DB (cities.city_id = 986283). Used so the
// /match mockup shows actual brand marks in the scatter and offer rows.

interface RealCatering {
  readonly name: string;
  readonly logo_url: string;
}

const REAL_CATERINGS: readonly RealCatering[] = [
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/27catering/27catering-catering_27catering-c940.png",
    name: "27 Catering",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/5posilkowdziennie/5posilkowdziennie-catering-5posilkowdziennie-adb5-63f5.png",
    name: "5 Posiłków Dziennie",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/activbox/activbox-catering-activbox-39c7-8b76.png",
    name: "Activ Box",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/afterfit/afterfit-catering-afterfit-a677.png",
    name: "AfterFit",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/barekmleczny/barekmleczny-barek-mleczny-72b7.png",
    name: "Barek Mleczny",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/beketocatering/beketocatering-catering-beketocatering-7807-3990.png",
    name: "BEKETO CATERING",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/betterlifecateringdietetyczny/betterlifecateringdietetyczny-catering_betterlife2-2f3b.png",
    name: "Better Life Catering Dietetyczny",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/cateringbroccoli/cateringbroccoli-brokulek-6de5.png",
    name: "Catering Broccoli",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/cateringdieta/cateringdieta-cd-a93f.png",
    name: "CateringDieta",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/cateringmistrza/cateringmistrza-catering_mistrza-a048.png",
    name: "Catering Mistrza",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/cateringpodketo/cateringpodketo-catering-cateringpodketo-e2cf-2e3f.png",
    name: "Catering Podketo.pl",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/chefbox/chefbox-catering-chefbox-86b1.png",
    name: "Chef Box",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/codograma/codograma-logocodo-78b1.png",
    name: "Co Do Grama",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/diabelskodobre/diabelskodobre-catering_diabelskodobre-1561.png",
    name: "Diabelsko Dobre",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/dietabanana/dietabanana-catering-dietabanana-19fd-ddc1.png",
    name: "Dieta Banana",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/dietapirata/dietapirata-dietapirata-ea49.jpg",
    name: "Dieta Pirata",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/dobregodniacatering/dobregodniacatering-catering_dobregodnia1-2ed0.png",
    name: "dobreGO dnia",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/domowejedzonko/domowejedzonko-domowe-02cf.png",
    name: "Domowe Jedzonko",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/dzikibox/dzikibox-catering-dzikibox-2d04.png",
    name: "Dziki Box",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/eatfit/eatfit-catering_eatfit-1bdd.png",
    name: "Eat Fit",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/fenomen/fenomen-catering-fenomen-055c-5a43.png",
    name: "Fenomen",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/fitboxcatering/fitboxcatering-catering_fitbox-9648.png",
    name: "FitBox Catering",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/fitdieta/fitdieta-catering-fitdieta-72f5-a6b3.png",
    name: "Fit Dieta",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/fitelita/fitelita-catering-fitelita-dae7-dc9b.png",
    name: "FitElita",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/fitking/fitking-catering-fitking-ce8a-79e9.png",
    name: "Fit King Catering",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/fitkuchniadomowa40zl/fitkuchniadomowa40zl-catering-fitkuchniadomowa40zl-9d84-6074.png",
    name: "FIT KUCHNIA DOMOWA",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/simplebox/simplebox-catering_fitmarchewa-c9d3.png",
    name: "Fit Marchewa",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/fitmeal/fitmeal-catering-fitmeal-e2ea-51ba.png",
    name: "Fit Meal catering",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/fitszamka/fitszamka-catering-fitszamka-8c06-07e6.png",
    name: "Fit Szamka",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/foodieboxbycanapa/foodieboxbycanapa-catering-foodieboxbycanapa-614e-8c05.png",
    name: "Foodiebox Kuchnie Świata",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/glodnymis/glodnymis-catering_glodnymis-ffad.png",
    name: "Głodny Miś",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/cateringhealthyeat/cateringhealthyeat-templatka%E2%80%94kopia-2ead.png",
    name: "Healthyeat",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/kalafiori/kalafiori-kalafiorilogo-81ca.png",
    name: "Kalafiori",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/kapitanbox/kapitanbox-catering_kapitanbox-e4e0.png",
    name: "Kapitan Box",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/kluskaikompot/kluskaikompot-kluskakompot-ab3b.png",
    name: "Kluska i kompot - catering domowy",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/kosmicznybox/kosmicznybox-catering_kosmicznybox2-767d.png",
    name: "Kosmiczny Box",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/kulinarniefit/kulinarniefit-kulinarniefitlogo-336b.png",
    name: "Kulinarnie FIT",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/ligasmaku/ligasmaku-catering_ligasmaku-9718.png",
    name: "Liga Smaku",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/lightmenu/lightmenu-catering-lightmenu-2ecc.png",
    name: "Light Menu",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/likeat/likeat-likeeat-41ed.png",
    name: "Likeat",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/maczfit/maczfit-logomaczfitkwadrat-e8ce.png",
    name: "Maczfit",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/magicfitcatering/magicfitcatering-catering-magicfitcatering-bc8f.png",
    name: "MagicFit Catering",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/malinowybox/malinowybox-catering-malinowybox-391b-79f6.png",
    name: "MalinowyBox",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/mangodiet/mangodiet-catering_mangodiet-322b.png",
    name: "mango.diet",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/miodmalinacatering/miodmalinacatering-malinalogo-a1bc.png",
    name: "Miód Malina",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/mojcatering/mojcatering-mojcatering-e7ef.jpg",
    name: "Mój Catering",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/nalekko/nalekko-catering_nalekko-8d1c.png",
    name: "Na Lekko",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/nasmak/nasmak-catering-nasmak-193a.png",
    name: "NA SMAK",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/nieziemskakuchnia/nieziemskakuchnia-catering_nieziemskakuchnia-42c2.png",
    name: "Nieziemska Kuchnia",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/optimalfit/optimalfit-catering-optimalfit-f0c9-1ca8.png",
    name: "Optimal Fit",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/paczkasmaku/paczkasmaku-catering-paczkasmaku-e98e-7dbd.png",
    name: "Paczka Smaku",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/perfectchef/perfectchef-catering-perfectchef-8f0b-cf9f.png",
    name: "Perfect Chef",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/polskirycerz/polskirycerz-polskirycerz2-61b8.png",
    name: "Polski Rycerz",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/przelomwodzywianiu/przelomwodzywianiu-przelomwodzywianiu-f4a7.jpg",
    name: "Przełom w Odżywianiu",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/robinfood/robinfood-logorgbialetlo-c2b7.jpg",
    name: "Robin Food",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/royalcook/royalcook-catering-royalcook-d071.png",
    name: "Royal Cook",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/slimway/slimway-catering-slimway-b2bf-d208.png",
    name: "Slim Way",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/smaczniejem/smaczniejem-smaczniejem-4b7e.png",
    name: "SmacznieJem",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/smakialpakicatering/smakialpakicatering-templatka%E2%80%94kopia-07c7.png",
    name: "Smaki Alpaki",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/suvibox/suvibox-suviv-cd42.png",
    name: "Suvibox Catering Dietetyczny",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/sztukawyboru/sztukawyboru-sztukawyborulogo-1d48.png",
    name: "Sztuka Wyboru",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/takeawaydiet/takeawaydiet-talogonowe-b806.jpg",
    name: "TakeAway Diet",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/takszef/takszef-catering-takszef-1a2a.png",
    name: "TAK SZEF",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/targcatering/targcatering-catering_targcatering-3666.png",
    name: "Targ Catering Pesco Wegetariański",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/timcatering/timcatering-catering_timcatering1-0c21.png",
    name: "TIM Catering",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/torebkawcukierce/torebkawcukierce-catering_torebkawcukierce-2f92.png",
    name: "Torebka w Cukierce",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/towarspodlady/towarspodlady-towarspodlady1-8662.png",
    name: "Towar spod lady",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/twojemenu/twojemenu-catering_twojemenu-53ef.png",
    name: "Twoje Menu",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/tytkafit/tytkafit-catering-tytkafit-72d9.png",
    name: "Tytka Fit catering dietetyczny",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/ucztawilka/ucztawilka-ucztawilka-6ec3.png",
    name: "Uczta Wilka",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/uhrabiego/uhrabiego-catering-uhrabiego-ea19-17eb.png",
    name: "uHrabiego",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/urbanfits/urbanfits-urban-9b7d.png",
    name: "UrbanFits",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/wdobrejformie/wdobrejformie-catering-wdobrejformie-ed5d-100d.png",
    name: "W Dobrej Formie",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/wlasciwywybor/wlasciwywybor-wlasciwyw-96a3.png",
    name: "Właściwy Wybór",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/wybierzpudelkocatering/wybierzpudelkocatering-wybierzpudelko-4fa6.png",
    name: "Wybierz Pudełko",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/wyborketo/wyborketo-wyborketologoo-d5b5.png",
    name: "Wybór KETO",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/wybormenu/wybormenu-catering-wybormenu-6460-3c71.png",
    name: "Wybór Menu",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/wykwintnybox/wykwintnybox-catering-wykwintnybox-aa4e-1500.png",
    name: "Wykwintny Box",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/wysmakowani/wysmakowani-catering-wysmakowani-1f9e-7f09.png",
    name: "Wysmakowani",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/zdrowaszama/zdrowaszama-catering_zdrowaszama-0fe6.png",
    name: "Zdrowa Szama",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/zdrowszadieta/zdrowszadieta-catering-zdrowszadieta-310e.png",
    name: "Zdrowsza Dieta",
  },
  {
    logo_url:
      "https://ml-assets.com/images/company-logo/zryjzdrowo/zryjzdrowo-catering-zryjzdrowo-0539-fb31.png",
    name: "Żryj Zdrowo!",
  },
];

const normalizeBrand = (s: string): string =>
  s.toLowerCase().replaceAll(/[^\da-z]+/gu, "");

// Lookup: display name → logo URL. Includes both canonical names and a
// normalized key, so hand-built day specs that use alternate spellings
// (e.g. "robinfood" → Robin Food) still resolve.
const LOGO_BY_NAME: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const c of REAL_CATERINGS) {
    m.set(c.name, c.logo_url);
    m.set(normalizeBrand(c.name), c.logo_url);
  }
  return m;
})();

const lookupLogo = (companyName: string): string | null =>
  LOGO_BY_NAME.get(companyName) ??
  LOGO_BY_NAME.get(normalizeBrand(companyName)) ??
  null;

// ── Offer builders ───────────────────────────────────────────────────────────

const offer = (
  id: string,
  company: string,
  diet: string,
  tier: string | null,
  calories: number,
  price: number,
  picks: readonly Pick[],
  opts?: Readonly<{
    is_menu_configuration?: boolean;
    score_default_override?: number;
    promos?: readonly Promo[];
  }>
): Offer => {
  const isMenuConfig = opts?.is_menu_configuration ?? false;
  const resolved = isMenuConfig ? picks.map(withAlternates) : picks;
  const scoreBest = resolved.reduce((acc, p) => acc + p.meal_score, 0);
  const scoreDefault =
    opts?.score_default_override ??
    resolved
      .filter((p) => p.is_default)
      .reduce((acc, p) => acc + p.meal_score, 0);
  const totals = aggregateMacros(resolved);
  // Compose final price from base + multiplicative promo stack.
  const promos = opts?.promos ?? [];
  const finalPrice = promos.reduce(
    (p, promo) => p * (1 - promo.discount_percent / 100),
    price
  );
  const priceFinal = Number(finalPrice.toFixed(2));
  return {
    calories,
    // First chunk of offer_id is `v1:{company_id}:{dc}[:{tdo}]` for live data;
    // mocks pass a simpler `{slug}::std::1500`. In either case, take chunk 0.
    company_id: id.startsWith("v1:")
      ? (id.split(":")[1] ?? "")
      : (id.split(":")[0] ?? ""),
    company_name: company,
    diet_name: diet,
    is_menu_configuration: isMenuConfig,
    logo_url: lookupLogo(company),
    offer_id: id,
    picks: resolved,
    price_per_day: priceFinal,
    price_per_day_before_promo: promos.length === 0 ? null : price,
    promos,
    review_score: null,
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

// Mock promo codes — campaigns the user could imagine seeing on dietly.pl.
const PROMO_BLACK15: Promo = {
  code: "BLACK15",
  discount_percent: 15,
  ends_at: "2026-05-31",
};
const PROMO_WIOSNA10: Promo = {
  code: "WIOSNA10",
  discount_percent: 10,
  ends_at: "2026-05-25",
};
const PROMO_WELCOME5: Promo = {
  code: "WELCOME5",
  discount_percent: 5,
};

// Strongly negative cheapest, premium best-fit — biggest contrast day.
const day_2026_05_18: RawDay = {
  best_fit: offer(
    "fitcatering::vege::1500",
    "fitcatering",
    "wege premium",
    "vege",
    1500,
    62.5,
    [omletKurczak, koktajlBialkowy, kurczakRyz, skyrBorowki, salataKurczak],
    { promos: [PROMO_BLACK15] }
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
    [omletKurczak, koktajlBialkowy, kurczakRyz, skyrBorowki, tatarLososiowy],
    { promos: [PROMO_WIOSNA10] }
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

// Menu-config showcase: the same offer is both cheapest and best-fit, so the
// row collapses. score_best beats every extra in PICK_COMBOS, and the offer
// is flagged is_menu_configuration so the user can swap meals per slot.
const day_2026_05_21_menuConfig = offer(
  "maczfit::elastyczny::1500",
  "Maczfit",
  "elastyczny",
  "menu-config",
  1500,
  44,
  [omletKurczak, koktajlBialkowy, kurczakRyz, skyrBorowki, piersKurczakaBataty],
  { is_menu_configuration: true, score_default_override: 1.8 }
);
const day_2026_05_21: RawDay = {
  best_fit: day_2026_05_21_menuConfig,
  cheapest: day_2026_05_21_menuConfig,
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
    {
      is_menu_configuration: true,
      promos: [PROMO_BLACK15],
      score_default_override: 1.8,
    }
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

// All available brand names for the extras pool — pulled from the real list.
const HANDCRAFTED_BRANDS: readonly string[] = REAL_CATERINGS.slice(0, 20).map(
  (c) => c.name
);
const GENERATED_BRANDS: readonly string[] = REAL_CATERINGS.slice(20).map(
  (c) => c.name
);

const DIET_LABELS: readonly string[] = [
  "standard",
  "premium",
  "wege",
  "sport",
  "high-protein",
  "balanced",
  "active",
  "klasyczny",
  "vital",
  "light",
];
const TIER_LABELS: readonly (string | null)[] = [
  null,
  "balanced",
  "premium",
  "vege",
  "domowy",
  null,
  null,
  null,
];

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replaceAll("&", "and")
    .replaceAll(/[^\da-z]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");

const EXTRA_POOL: readonly ExtraSpec[] = [
  ...HANDCRAFTED_BRANDS,
  ...GENERATED_BRANDS,
]
  .slice(0, 80)
  .map((company, i) => ({
    company,
    diet: DIET_LABELS[i % DIET_LABELS.length],
    id: `${slugify(company)}::${i}::1500`,
    tier: TIER_LABELS[i % TIER_LABELS.length],
  }));

// Six pick combos covering the score spectrum.
const PICK_COMBOS: readonly (readonly Pick[])[] = [
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

// Deterministic price + promo per pool index — wraps to any pool size.
const priceForIndex = (i: number, dayIdx: number): number => {
  // Sweep 48..78 zł across the full pool so every index gets a unique price
  // (otherwise the scatter dots stack and the chart looks sparse).
  // Price range in zł.
  const span = 30;
  const poolSize = 80;
  const stepped = 48 + ((i * 31) % poolSize) * (span / poolSize);
  // Small per-day jitter so days don't look identical.
  return Number((stepped + ((dayIdx % 3) - 1) * 0.4).toFixed(2));
};

const promoForIndex = (i: number): readonly Promo[] => {
  if (i % 11 === 3) {
    return [PROMO_BLACK15];
  }
  if (i % 13 === 5) {
    return [PROMO_WIOSNA10];
  }
  if (i % 17 === 7) {
    return [PROMO_WELCOME5];
  }
  return [];
};

const makeExtras = (dayIdx: number, minPriceFloor: number): readonly Offer[] =>
  EXTRA_POOL.map((spec, i) => {
    const combo = PICK_COMBOS[(i + dayIdx) % PICK_COMBOS.length];
    // Keep the day's curated cheapest as the actual minimum on the scatter
    // by lifting any extra that would undercut it.
    const rawPrice = priceForIndex(i, dayIdx);
    const promos = promoForIndex(i);
    // After promos the final price drops — back-solve a base price that lands
    // ≥ floor after the discount stack, then let `offer()` apply the discount.
    const promoFactor = promos.reduce(
      (acc, p) => acc * (1 - p.discount_percent / 100),
      1
    );
    const liftedRaw = Math.max(rawPrice, (minPriceFloor + 0.5) / promoFactor);
    return offer(
      spec.id,
      spec.company,
      spec.diet,
      spec.tier,
      1500,
      Number(liftedRaw.toFixed(2)),
      combo,
      { promos }
    );
  });

const buildAllOffers = (
  raw: Readonly<RawDay>,
  dayIdx: number
): readonly Offer[] => {
  if (raw.cheapest === null || raw.best_fit === null) {
    return [];
  }
  const base =
    raw.cheapest.offer_id === raw.best_fit.offer_id
      ? [raw.cheapest]
      : [raw.cheapest, raw.best_fit];
  // The hand-crafted cheapest must remain the genuinely lowest price in the
  // pool — pass its final (post-promo) price as the floor for extras.
  return [...base, ...makeExtras(dayIdx, raw.cheapest.price_per_day)];
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

export const MOCK_DAYS: readonly Day[] = RAW_DAYS.map((d, i) => ({
  ...d,
  all_offers: buildAllOffers(d, i),
}));
