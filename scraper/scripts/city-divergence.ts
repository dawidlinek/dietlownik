// City-divergence sampler.
//
// The question this answers: is dietly's catering data actually national, or
// does it vary by city? It matters because the scraper currently writes
// `menu_items` and `price_history` once per (company, city) — which is what
// makes "all of Poland" cost a full ~3 h scrape per locality. If
// menus and prices are identical across cities, `city_id` collapses from a
// partition key into a membership filter and the whole country fits inside
// one national scrape. If they are not, we need to know exactly where and how
// often they differ before designing anything.
//
// This is deliberately biased TOWARDS finding divergence:
//   - cities are picked for voivodeship spread, not size, so a Podkarpacie
//     village is compared against a Pomorze one;
//   - companies are picked with a bias towards caterings that are NOT listed
//     everywhere. A catering present in every city ships nationally by
//     definition; a local one with its own kitchen is where per-city pricing
//     would live. Sampling companies out of a single city's catalog only ever
//     draws national players — that sampling bias is the whole reason a
//     hand-check can come back clean and still be wrong.
//
// Per company it fixes one reference city and compares the others against it:
//
//   catalog        /constant                — diet/tier/option/kcal tree
//   list_price     /city/{id}               — dietPriceInfo + lowestPrice
//   quote_diet     calculate-price          — perDayDietCost, totalCostToPay
//   menu_lineup    /menu/.../date/{d}       — the dish lineup for N dates
//   menu_body      same response            — kcal/macros/ingredients per dish
//   delivery       /city/{id}               — fee, windows, ordersEnabled
//
// `delivery` is expected to vary by city and is reported separately: it never
// counts as divergence. The other five are the load-bearing ones — any hit
// there kills the "menus and prices are national" assumption for that
// catering.
//
// Exits 1 when a content dimension diverges, so this can later run as a
// monitor; delivery-only differences exit 0.
//
// Usage:
//   bun run check:cities
//   bun run check:cities -- --cities=16 --companies=24 --dates=3 --seed=7
//   bun run check:cities -- --city-ids=986283,918123 --company=robinfood
//
// Options (all --key=value):
//   --cities=N            cities to sample                        (default 10)
//   --companies=N         companies to sample                     (default 12)
//   --peers=N             comparison cities per company           (default 3)
//   --dates=N             menu dates compared per company         (default 2)
//   --leaves=N            price quotes per (company, city)        (default 2)
//   --local-bias=F        share of company slots reserved for
//                         caterings missing from some cities      (default 0.6)
//   --city-ids=a,b,c      explicit city ids (skips city sampling)
//   --company=slug[,slug] explicit company slugs (skips sampling)
//   --anchor=ID           preferred reference city         (default CITY_ID)
//   --max-requests=N      hard budget; stops early and reports    (default 1500)
//   --seed=N              deterministic sampling                   (default 1)
//   --out=PATH            JSON report      (default reports/city-divergence.json)

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { futureWeekdays, get, post } from "../api";
import type {
  AwardedAndTopResponse,
  City,
  CompanySearchItem,
  CityResponse,
  ConstantResponse,
  DeepReadonly,
  MealDetails,
  MenuResponse,
  PriceRequestBody,
  PriceResponse,
  TopSearchResponse,
} from "../types";

// ── options ──────────────────────────────────────────────────────────────────

interface Options {
  readonly anchorCityId: number;
  readonly cities: number;
  readonly cityIds: readonly number[] | null;
  readonly companies: number;
  readonly companySlugs: readonly string[] | null;
  readonly dates: number;
  readonly leaves: number;
  readonly localBias: number;
  readonly maxRequests: number;
  readonly out: string;
  readonly peers: number;
  readonly seed: number;
}

const argMap = (argv: readonly string[]): Map<string, string> => {
  const out = new Map<string, string>();
  for (const raw of argv) {
    if (!raw.startsWith("--")) {
      continue;
    }
    const [key, ...rest] = raw.slice(2).split("=");
    out.set(key, rest.join("=") || "true");
  }
  return out;
};

const num = (
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ReadonlyMap is already immutable; the rule flags Map types regardless
  args: ReadonlyMap<string, string>,
  key: string,
  fallback: number
): number => {
  const raw = args.get(key);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const list = (
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ReadonlyMap is already immutable; the rule flags Map types regardless
  args: ReadonlyMap<string, string>,
  key: string
): string[] | null => {
  const raw = args.get(key);
  if (raw === undefined || raw === "") {
    return null;
  }
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return parts.length > 0 ? parts : null;
};

const parseOptions = (argv: readonly string[]): Options => {
  const args = argMap(argv);
  const ids = list(args, "city-ids");
  return {
    anchorCityId: num(args, "anchor", Number(process.env.CITY_ID ?? 986_283)),
    cities: num(args, "cities", 10),
    cityIds: ids === null ? null : ids.map(Number).filter(Number.isFinite),
    companies: num(args, "companies", 12),
    companySlugs: list(args, "company"),
    dates: num(args, "dates", 2),
    leaves: num(args, "leaves", 2),
    localBias: num(args, "local-bias", 0.6),
    maxRequests: num(args, "max-requests", 1500),
    out: args.get("out") ?? "reports/city-divergence.json",
    peers: num(args, "peers", 3),
    seed: num(args, "seed", 1),
  };
};

// ── small utilities ──────────────────────────────────────────────────────────

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/** Park-Miller LCG — deterministic so a run can be replayed with --seed. */
const rngFrom = (seed: number): (() => number) => {
  const MODULUS = 2_147_483_647;
  const initial = Math.abs(Math.trunc(seed)) % MODULUS;
  let state = initial === 0 ? 1 : initial;
  return () => {
    state = (state * 48_271) % MODULUS;
    return state / MODULUS;
  };
};

const shuffled = <T>(items: readonly T[], rnd: () => number): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
};

/** Human-readable set difference — the first few entries either side holds. */
const diffSummary = (
  a: readonly string[],
  b: readonly string[],
  labelA: string,
  labelB: string,
  limit = 3
): string => {
  const setA = new Set(a);
  const setB = new Set(b);
  const onlyA = a.filter((x) => !setB.has(x)).slice(0, limit);
  const onlyB = b.filter((x) => !setA.has(x)).slice(0, limit);
  const parts: string[] = [];
  if (onlyA.length > 0) {
    parts.push(`only in ${labelA}: ${onlyA.join(" / ")}`);
  }
  if (onlyB.length > 0) {
    parts.push(`only in ${labelB}: ${onlyB.join(" / ")}`);
  }
  return parts.length > 0 ? parts.join("  ·  ") : "differ in ordering only";
};

// ── request budget ───────────────────────────────────────────────────────────
//
// A full sweep is a few hundred requests against a Cloudflare-fronted host at
// MAX_IN_FLIGHT=3. The budget exists so a mis-typed --cities=500 can't turn
// into an afternoon of traffic.

const BUDGET_EXHAUSTED = "budget-exhausted";
let requestsUsed = 0;

const spend = (): void => {
  requestsUsed += 1;
};

const budgetLeft = (opts: Readonly<Options>): number =>
  opts.maxRequests - requestsUsed;

// ── city sampling ────────────────────────────────────────────────────────────

interface CityProbe {
  readonly city: DeepReadonly<City>;
  readonly companies: readonly string[];
  readonly totalPages: number;
}

const PAGE_SIZE = 50;

/**
 * Seed cities, one per voivodeship. Without these the sample is worthless:
 * `supported-cities` is Mazowieckie-only, so a draw from it proves nothing
 * about regional differences. Resolved by name — no ids are hardcoded.
 */
const CAPITALS: readonly string[] = [
  "Warszawa",
  "Kraków",
  "Łódź",
  "Wrocław",
  "Poznań",
  "Gdańsk",
  "Szczecin",
  "Bydgoszcz",
  "Lublin",
  "Białystok",
  "Katowice",
  "Kielce",
  "Olsztyn",
  "Rzeszów",
  "Opole",
  "Zielona Góra",
];

/**
 * The Dietly Shop city list — a bare array of SIMC ids. NOT national: 1,134
 * of its 1,135 ids are in Mazowieckie. Used only as a pool of villages;
 * geographic spread comes from CAPITALS. Cities that come back with no
 * caterings are dropped below.
 */
// oxlint-disable-next-line typescript/promise-function-async -- thin forwarder; the await belongs to the caller
const fetchSupportedCities = (): Promise<number[]> => {
  spend();
  return get<number[]>("/api/dietly-shop/open/supported-cities");
};

/** Resolve the seed cities by name; unresolvable ones are simply skipped. */
const resolveCapitals = async (limit: number): Promise<number[]> => {
  const ids: number[] = [];
  for (const name of CAPITALS.slice(0, limit)) {
    try {
      spend();
      const data = await get<TopSearchResponse>(
        `/api/open/search/top-search?query=${encodeURIComponent(name)}&citiesSize=10&companiesSize=0`
      );
      const hit = (data.cities ?? []).find(
        (c: DeepReadonly<City>) =>
          c.cityStatus && c.name.toLowerCase() === name.toLowerCase()
      );
      if (hit !== undefined) {
        ids.push(hit.cityId);
      }
    } catch (error) {
      console.warn(`[cities] capital "${name}" unresolved: ${errMsg(error)}`);
    }
  }
  return ids;
};

/** One catalog page. Page 0 alone yields the city record and the page count. */
// oxlint-disable-next-line typescript/promise-function-async -- thin forwarder; the await belongs to the caller
const fetchCatalogPage = (
  cityId: number,
  page: number
): Promise<AwardedAndTopResponse> => {
  spend();
  return get<AwardedAndTopResponse>(
    `/api/open/search/full/awarded-and-top?cId=${cityId}&rV=V2023_1&pageSize=${PAGE_SIZE}&page=${page}&active=`
  );
};

const probeCity = async (cityId: number): Promise<CityProbe | null> => {
  const first = await fetchCatalogPage(cityId, 0);
  const { city } = first;
  if (city === undefined || (first.searchData?.length ?? 0) === 0) {
    return null;
  }
  return {
    city,
    companies: (first.searchData ?? []).map(
      (c: DeepReadonly<CompanySearchItem>) => c.name
    ),
    totalPages: first.totalPages ?? 1,
  };
};

/** Pull the remaining catalog pages so the availability matrix is complete. */
const completeCity = async (probe: Readonly<CityProbe>): Promise<CityProbe> => {
  const companies = [...probe.companies];
  for (let page = 1; page < probe.totalPages; page += 1) {
    const data = await fetchCatalogPage(probe.city.cityId, page);
    for (const c of data.searchData ?? []) {
      companies.push(c.name);
    }
  }
  return { ...probe, companies };
};

/**
 * Pick cities for voivodeship spread: round-robin across provinces, so 10
 * cities land in up to 10 different regions instead of 10 suburbs of the same
 * one. Regional divergence — a Kraków kitchen pricing differently from a
 * Gdańsk one — is the hypothesis under test, so the sample has to be able to
 * see it.
 */
const spreadByProvince = (
  probes: readonly CityProbe[],
  want: number
): CityProbe[] => {
  const byProvince = new Map<string, CityProbe[]>();
  for (const p of probes) {
    const key = p.city.provinceName ?? "?";
    const bucket = byProvince.get(key) ?? [];
    bucket.push(p);
    byProvince.set(key, bucket);
  }
  const buckets: readonly (readonly CityProbe[])[] = [...byProvince.values()];
  const out: CityProbe[] = [];
  let round = 0;
  while (out.length < want && buckets.some((b) => b.length > round)) {
    for (const bucket of buckets) {
      const pick = bucket[round];
      if (pick !== undefined && out.length < want) {
        out.push(pick);
      }
    }
    round += 1;
  }
  return out;
};

const sampleCities = async (
  opts: Readonly<Options>,
  rnd: () => number
): Promise<CityProbe[]> => {
  if (opts.cityIds !== null) {
    const probes: CityProbe[] = [];
    for (const id of opts.cityIds) {
      const p = await probeCity(id);
      if (p !== null) {
        probes.push(p);
      }
    }
    return probes;
  }

  const supported = await fetchSupportedCities();
  console.log(`[cities] ${supported.length} supported city ids upstream`);

  // Half the slots go to voivodeship capitals (guaranteed geographic spread),
  // half to a uniform draw from the supported list (small towns, where a
  // local kitchen is most likely). Probe ~2× the target so spreadByProvince
  // has something to choose from. The anchor is always in.
  const capitalIds = await resolveCapitals(Math.ceil(opts.cities / 2) + 2);
  const seen = new Set<number>([opts.anchorCityId, ...capitalIds]);
  const random = shuffled(
    supported.filter((id) => !seen.has(id)),
    rnd
  ).slice(0, Math.max(0, opts.cities));
  const candidates = [
    ...new Set([opts.anchorCityId, ...shuffled(capitalIds, rnd), ...random]),
  ];

  const probes: CityProbe[] = [];
  for (const id of candidates) {
    if (budgetLeft(opts) <= 0) {
      break;
    }
    try {
      const p = await probeCity(id);
      if (p !== null) {
        probes.push(p);
      }
    } catch (error) {
      console.warn(`[cities] probe ${id} failed: ${errMsg(error)}`);
    }
  }

  const anchor = probes.filter((p) => p.city.cityId === opts.anchorCityId);
  const rest = spreadByProvince(
    probes.filter((p) => p.city.cityId !== opts.anchorCityId),
    Math.max(0, opts.cities - anchor.length)
  );
  return [...anchor, ...rest];
};

// ── company sampling ─────────────────────────────────────────────────────────

interface CompanyPick {
  readonly availableIn: readonly number[];
  readonly national: boolean;
  readonly slug: string;
}

/**
 * Bias the draw towards caterings that are missing from at least one sampled
 * city. Those are the ones plausibly cooking locally rather than shipping one
 * national kitchen's output by courier — and therefore the ones that could
 * price or cook per city.
 */
const sampleCompanies = (
  probes: readonly CityProbe[],
  opts: Readonly<Options>,
  rnd: () => number
): CompanyPick[] => {
  const availability = new Map<string, number[]>();
  for (const p of probes) {
    for (const slug of p.companies) {
      const seen = availability.get(slug) ?? [];
      seen.push(p.city.cityId);
      availability.set(slug, seen);
    }
  }

  const all: CompanyPick[] = [...availability.entries()]
    .map(([slug, availableIn]: Readonly<[string, readonly number[]]>) => ({
      availableIn,
      national: availableIn.length === probes.length,
      slug,
    }))
    // Comparing needs at least two cities that carry the catering.
    .filter((c: Readonly<CompanyPick>) => c.availableIn.length >= 2);

  if (opts.companySlugs !== null) {
    const wanted = new Set(opts.companySlugs);
    return all.filter((c) => wanted.has(c.slug));
  }

  const locals = shuffled(
    all.filter((c) => !c.national),
    rnd
  );
  const nationals = shuffled(
    all.filter((c) => c.national),
    rnd
  );
  const localSlots = Math.min(
    locals.length,
    Math.round(opts.companies * opts.localBias)
  );
  const picked = [
    ...locals.slice(0, localSlots),
    ...nationals.slice(0, opts.companies - localSlots),
  ];
  console.log(
    `[companies] ${all.length} comparable · picked ${picked.length} (${localSlots} city-limited, ${picked.length - localSlots} national)`
  );
  return picked;
};

// ── per-(company, city) probe ────────────────────────────────────────────────

interface Target {
  readonly calories: number;
  readonly dietCaloriesId: number;
  readonly dietId: number;
  readonly isMenuConfiguration: boolean;
  readonly tierDietOptionId: string | null;
  readonly tierId: number | null;
}

/** Flatten the catalog tree into comparable "diet|tier|option|leaf|kcal" lines. */
const catalogLines = (c: DeepReadonly<ConstantResponse>): string[] => {
  const lines: string[] = [];
  for (const diet of c.companyDiets ?? []) {
    const groups =
      diet.dietTiers.length > 0
        ? diet.dietTiers.map((t) => ({
            options: t.dietOptions,
            tierId: t.tierId as number | null,
          }))
        : [{ options: diet.dietOptions, tierId: null }];
    for (const g of groups) {
      for (const o of g.options ?? []) {
        for (const cal of o.dietCalories ?? []) {
          lines.push(
            `${diet.dietId}|${g.tierId ?? "-"}|${o.dietOptionId}|${o.tierDietOptionId ?? "-"}|${cal.dietCaloriesId}|${cal.calories}`
          );
        }
      }
    }
  }
  return lines.toSorted();
};

/**
 * One leaf per (diet, tier, option) group, lowest kcal — the same canonical
 * set `scraper/scrapers/menus.ts` walks, so the sampler tests the surface the
 * scraper actually stores rather than an arbitrary corner of the catalog.
 */
const canonicalTargets = (c: DeepReadonly<ConstantResponse>): Target[] => {
  const best = new Map<string, Target>();
  for (const diet of c.companyDiets ?? []) {
    const groups =
      diet.dietTiers.length > 0
        ? diet.dietTiers.map((t) => ({
            options: t.dietOptions,
            tierId: t.tierId as number | null,
          }))
        : [{ options: diet.dietOptions, tierId: null }];
    for (const g of groups) {
      for (const o of g.options ?? []) {
        for (const cal of o.dietCalories ?? []) {
          const key = `${diet.dietId}|${g.tierId ?? "-"}|${o.dietOptionId}`;
          const current = best.get(key);
          if (current === undefined || cal.calories < current.calories) {
            best.set(key, {
              calories: cal.calories,
              dietCaloriesId: cal.dietCaloriesId,
              dietId: diet.dietId,
              isMenuConfiguration: diet.isMenuConfiguration,
              tierDietOptionId: o.tierDietOptionId ?? null,
              tierId: g.tierId,
            });
          }
        }
      }
    }
  }
  return [...best.values()].toSorted(
    (a, b) => a.dietCaloriesId - b.dietCaloriesId
  );
};

/**
 * One leaf per diet before a second leaf of any diet. A catering that prices
 * only one of its diets per city is invisible if every quoted leaf comes from
 * the same diet — which is what taking the first N in id order tends to do.
 */
const spreadAcrossDiets = (
  targets: readonly Target[],
  want: number
): Target[] => {
  const byDiet = new Map<number, Target[]>();
  for (const t of targets) {
    const bucket = byDiet.get(t.dietId) ?? [];
    bucket.push(t);
    byDiet.set(t.dietId, bucket);
  }
  const buckets: readonly (readonly Target[])[] = [...byDiet.values()];
  const out: Target[] = [];
  let round = 0;
  while (out.length < want && buckets.some((b) => b.length > round)) {
    for (const bucket of buckets) {
      const pick = bucket[round];
      if (pick !== undefined && out.length < want) {
        out.push(pick);
      }
    }
    round += 1;
  }
  return out;
};

/** dietPriceInfo + lowestPrice, flattened. This is the catalog's list price. */
const listPriceLines = (c: DeepReadonly<CityResponse>): string[] => {
  const lines = (c.dietPriceInfo ?? []).map(
    (p) =>
      `diet=${p.dietId} default=${p.defaultPrice ?? "-"} discount=${p.discountPrice ?? "-"} promo=${p.dietPriceInCompanyPromotion}`
  );
  lines.push(
    `lowest standard=${c.lowestPrice?.standard ?? "-"} menuConfig=${c.lowestPrice?.menuConfiguration ?? "-"}`
  );
  return lines.toSorted();
};

/** Per-city by design — reported, never counted as divergence. */
const deliveryLines = (c: DeepReadonly<CityResponse>): string[] => {
  const cs = c.citySearchResult;
  const windows = (cs?.deliveryTime ?? [])
    .map((w) => `${w.timeFrom}-${w.timeTo}`)
    .toSorted();
  return [
    `fee=${cs?.deliveryFee ?? "-"}`,
    `sector=${cs?.sectorId ?? "-"}`,
    `orders=${c.companySettings?.ordersEnabled ?? "-"}`,
    `delivery=${c.companySettings?.deliveryEnabled ?? "-"}`,
    `windows=${windows.join(",")}`,
  ];
};

const mealBodySignature = (d: DeepReadonly<MealDetails>): string => {
  const ing = (d.ingredients ?? [])
    .map((i) => i.name)
    .toSorted()
    .join("+");
  return `${d.calories ?? "-"}|${d.protein ?? "-"}|${d.fat ?? "-"}|${d.carbohydrate ?? "-"}|${ing}`;
};

const menuLineupLines = (m: DeepReadonly<MenuResponse>): string[] =>
  (m.meals ?? [])
    .flatMap((slot) =>
      (slot.options ?? []).map((o) => `${slot.name}:${o.name}`)
    )
    .toSorted();

const menuBodyLines = (m: DeepReadonly<MenuResponse>): string[] =>
  (m.meals ?? [])
    .flatMap((slot) =>
      (slot.options ?? []).map(
        (o) => `${slot.name}:${o.name}=${mealBodySignature(o.details)}`
      )
    )
    .toSorted();

interface Probe {
  readonly catalog: readonly string[];
  readonly delivery: readonly string[];
  readonly listPrice: readonly string[];
  readonly menuBody: readonly string[];
  readonly menuLineup: readonly string[];
  readonly quoteDelivery: readonly string[];
  readonly quoteDiet: readonly string[];
  readonly quoteTotal: readonly string[];
  readonly targets: readonly Target[];
}

const quoteLeaf = async (
  companyId: string,
  cityId: number,
  target: Readonly<Target>,
  deliveryDates: readonly string[]
): Promise<{ delivery: string; diet: string; total: string }> => {
  const useTdo =
    target.isMenuConfiguration &&
    target.tierDietOptionId !== null &&
    target.tierDietOptionId !== "";
  const body: PriceRequestBody = {
    cityId,
    deliveryDates: [...deliveryDates],
    dietCaloriesId: target.dietCaloriesId,
    promoCodes: [],
    testOrder: false,
    ...(useTdo && target.tierDietOptionId !== null
      ? { tierDietOptionId: target.tierDietOptionId }
      : {}),
  };
  spend();
  const res = await post<PriceResponse>(
    `/api/mobile/open/company-card/${companyId}/quick-order/calculate-price`,
    body,
    { companyId }
  );
  const item = res.items?.[0];
  const tag = `leaf=${target.dietCaloriesId}`;
  return {
    delivery: `${tag} delivery=${res.cart?.totalDeliveryCost ?? "-"}`,
    // Diet economics only — what the ranking engine consumes. `totalCostToPay`
    // is deliberately NOT here: it bundles the delivery fee, which is
    // per-city by design, so including it reported a 5 zł courier difference
    // as a price divergence on caterings whose food price was identical.
    diet: `${tag} perDay=${item?.perDayDietCost ?? "-"} gross=${res.cart?.totalCostWithoutDiscounts ?? "-"}`,
    total: `${tag} total=${res.cart?.totalCostToPay ?? "-"}`,
  };
};

const probeCompanyCity = async (
  companyId: string,
  cityId: number,
  opts: Readonly<Options>,
  fixedTargets: readonly Target[] | null,
  dates: readonly string[],
  deliveryDates: readonly string[]
): Promise<Probe> => {
  spend();
  const constant = await get<ConstantResponse>(
    `/api/mobile/open/company-card/${companyId}/constant?cityId=${cityId}`,
    { companyId }
  );
  spend();
  const city = await get<CityResponse>(
    `/api/mobile/open/company-card/${companyId}/city/${cityId}`,
    { companyId }
  );

  const targets = canonicalTargets(constant);
  // The reference city fixes the leaves; peers reuse them so both sides quote
  // and read the exact same product. A leaf missing on the peer side is a
  // catalog difference, already caught by the `catalog` dimension.
  const available = new Set(targets.map((t) => t.dietCaloriesId));
  const chosen = (fixedTargets ?? targets).filter((t) =>
    available.has(t.dietCaloriesId)
  );

  const quoteDiet: string[] = [];
  const quoteDelivery: string[] = [];
  const quoteTotal: string[] = [];
  for (const target of spreadAcrossDiets(chosen, opts.leaves)) {
    try {
      const quote = await quoteLeaf(companyId, cityId, target, deliveryDates);
      quoteDiet.push(quote.diet);
      quoteDelivery.push(quote.delivery);
      quoteTotal.push(quote.total);
    } catch (error) {
      // Stable marker, not the message: a transient 5xx on one side should
      // read as "no quote here", not as a fake price difference whose text
      // changes run to run.
      console.warn(
        `    quote ${companyId}@${cityId} leaf=${target.dietCaloriesId}: ${errMsg(error)}`
      );
      quoteDiet.push(`leaf=${target.dietCaloriesId} UNAVAILABLE`);
    }
  }

  const menuLineup: string[] = [];
  const menuBody: string[] = [];
  const [menuTarget] = chosen;
  if (menuTarget !== undefined) {
    for (const date of dates) {
      const tierQuery =
        menuTarget.tierId === null ? "" : `?tierId=${menuTarget.tierId}`;
      try {
        spend();
        const menu = await get<MenuResponse>(
          `/api/mobile/open/company-card/${companyId}/menu/${menuTarget.dietCaloriesId}/city/${cityId}/date/${date}${tierQuery}`,
          { companyId }
        );
        for (const line of menuLineupLines(menu)) {
          menuLineup.push(`${date} leaf=${menuTarget.dietCaloriesId} ${line}`);
        }
        for (const line of menuBodyLines(menu)) {
          menuBody.push(`${date} leaf=${menuTarget.dietCaloriesId} ${line}`);
        }
      } catch (error) {
        // Leaf id included so a catalog difference can't masquerade as a
        // menu difference in the report — the diff shows both leaf ids.
        console.warn(
          `    menu ${companyId}@${cityId} ${date}: ${errMsg(error)}`
        );
        menuLineup.push(
          `${date} leaf=${menuTarget.dietCaloriesId} UNAVAILABLE`
        );
      }
    }
  }

  return {
    catalog: catalogLines(constant),
    delivery: deliveryLines(city),
    listPrice: listPriceLines(city),
    menuBody: menuBody.toSorted(),
    menuLineup: menuLineup.toSorted(),
    quoteDelivery: quoteDelivery.toSorted(),
    quoteDiet: quoteDiet.toSorted(),
    quoteTotal: quoteTotal.toSorted(),
    targets,
  };
};

// ── comparison ───────────────────────────────────────────────────────────────

const CONTENT_DIMENSIONS = [
  "catalog",
  "list_price",
  "quote_diet",
  "menu_lineup",
  "menu_body",
] as const;

type ContentDimension = (typeof CONTENT_DIMENSIONS)[number];
type Dimension =
  | ContentDimension
  | "delivery"
  | "quote_delivery"
  | "quote_total";

interface Finding {
  readonly company: string;
  readonly detail: string;
  readonly dimension: Dimension;
  readonly peerCity: string;
  readonly peerCityId: number;
  readonly referenceCity: string;
  readonly referenceCityId: number;
}

const dimensionOf = (
  probe: Readonly<Probe>,
  dimension: Dimension
): readonly string[] => {
  const lookup: Readonly<Record<Dimension, readonly string[]>> = {
    catalog: probe.catalog,
    delivery: probe.delivery,
    list_price: probe.listPrice,
    menu_body: probe.menuBody,
    menu_lineup: probe.menuLineup,
    quote_delivery: probe.quoteDelivery,
    quote_diet: probe.quoteDiet,
    quote_total: probe.quoteTotal,
  };
  return lookup[dimension];
};

const ALL_DIMENSIONS: readonly Dimension[] = [
  ...CONTENT_DIMENSIONS,
  "quote_total",
  "quote_delivery",
  "delivery",
];

const isContent = (dimension: Dimension): boolean =>
  (CONTENT_DIMENSIONS as readonly string[]).includes(dimension);

interface Side {
  readonly city: DeepReadonly<City>;
  readonly probe: Probe;
}

interface Comparison {
  readonly compared: readonly Dimension[];
  readonly findings: readonly Finding[];
}

const compareProbes = (
  company: string,
  reference: Readonly<Side>,
  peer: Readonly<Side>
): Comparison => {
  const findings: Finding[] = [];
  const compared: Dimension[] = [];
  for (const dimension of ALL_DIMENSIONS) {
    const a = dimensionOf(reference.probe, dimension);
    const b = dimensionOf(peer.probe, dimension);
    // Nothing fetched on either side (a catering with menus disabled, say) —
    // silence, not a match.
    if (a.length === 0 && b.length === 0) {
      continue;
    }
    compared.push(dimension);
    if (a.join("\n") === b.join("\n")) {
      continue;
    }
    findings.push({
      company,
      detail: diffSummary(a, b, reference.city.name, peer.city.name),
      dimension,
      peerCity: peer.city.name,
      peerCityId: peer.city.cityId,
      referenceCity: reference.city.name,
      referenceCityId: reference.city.cityId,
    });
  }
  return { compared, findings };
};

// ── driver ───────────────────────────────────────────────────────────────────

const pickPeers = (
  pick: Readonly<CompanyPick>,
  probes: readonly CityProbe[],
  referenceId: number,
  want: number
): CityProbe[] => {
  const available = probes.filter(
    (p) =>
      p.city.cityId !== referenceId && pick.availableIn.includes(p.city.cityId)
  );
  // Province spread again: comparing Wrocław against three Dolnośląskie towns
  // would prove nothing about regional pricing.
  return spreadByProvince(available, want);
};

interface RunContext {
  readonly cityProbes: readonly CityProbe[];
  readonly dates: readonly string[];
  readonly deliveryDates: readonly string[];
  readonly opts: Options;
}

interface CompanyResult {
  readonly budgetHit: boolean;
  readonly comparisons: readonly Comparison[];
}

/** One company: probe its reference city, then every sampled peer city. */
const runCompany = async (
  pick: Readonly<CompanyPick>,
  referenceCity: DeepReadonly<City>,
  ctx: Readonly<RunContext>
): Promise<CompanyResult> => {
  const { cityProbes, dates, deliveryDates, opts } = ctx;
  const referenceProbe = await probeCompanyCity(
    pick.slug,
    referenceCity.cityId,
    opts,
    null,
    dates,
    deliveryDates
  );
  const peers = pickPeers(pick, cityProbes, referenceCity.cityId, opts.peers);
  const comparisons: Comparison[] = [];
  const marks: string[] = [];
  let budgetHit = false;

  for (const peer of peers) {
    if (budgetLeft(opts) < 6) {
      budgetHit = true;
      break;
    }
    const peerProbe = await probeCompanyCity(
      pick.slug,
      peer.city.cityId,
      opts,
      referenceProbe.targets,
      dates,
      deliveryDates
    );
    const comparison = compareProbes(
      pick.slug,
      { city: referenceCity, probe: referenceProbe },
      { city: peer.city, probe: peerProbe }
    );
    comparisons.push(comparison);
    const content = comparison.findings.filter((f) => isContent(f.dimension));
    marks.push(
      `${peer.city.name}${content.length === 0 ? "=" : `≠[${content.map((f) => f.dimension).join(",")}]`}`
    );
  }

  console.log(
    `  ${pick.slug.padEnd(24)} ${pick.national ? "national " : "city-ltd "} ref=${referenceCity.name.padEnd(14)} ${marks.join("  ")}`
  );
  return { budgetHit, comparisons };
};

interface DimensionRow {
  readonly checked: number;
  readonly content: boolean;
  readonly dimension: Dimension;
  readonly diverged: number;
}

const printDimensionTable = (rows: readonly DimensionRow[]): void => {
  console.log("\n=== divergence by dimension ===\n");
  for (const row of rows) {
    if (row.checked === 0) {
      continue;
    }
    const pct = ((row.diverged / row.checked) * 100).toFixed(1);
    const note = row.content ? "" : "  (per-city by design)";
    console.log(
      `  ${row.dimension.padEnd(16)} ${String(row.diverged).padStart(4)}/${String(row.checked).padEnd(4)} pairs  ${pct.padStart(5)}%${note}`
    );
  }
};

/**
 * Fold one company's comparisons into the running tallies, returning the
 * findings so the caller can keep them in order.
 */
const foldTallies = (
  comparisons: readonly Comparison[],
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- accumulators, mutated by design
  checked: Map<Dimension, number>,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- accumulators, mutated by design
  diverged: Map<Dimension, number>
): Finding[] => {
  const out: Finding[] = [];
  for (const comparison of comparisons) {
    for (const dimension of comparison.compared) {
      checked.set(dimension, (checked.get(dimension) ?? 0) + 1);
    }
    for (const finding of comparison.findings) {
      diverged.set(
        finding.dimension,
        (diverged.get(finding.dimension) ?? 0) + 1
      );
      out.push(finding);
    }
  }
  return out;
};

/** Sample cities, complete their catalogs, and print the city table. */
const collectCityProbes = async (
  opts: Readonly<Options>,
  rnd: () => number
): Promise<CityProbe[]> => {
  const sampled = await sampleCities(opts, rnd);
  if (sampled.length < 2) {
    throw new Error("need at least 2 sampled cities to compare");
  }
  const cityProbes: CityProbe[] = [];
  for (const probe of sampled) {
    cityProbes.push(await completeCity(probe));
  }
  for (const probe of cityProbes) {
    console.log(
      `[cities] ${probe.city.name.padEnd(22)} ${String(probe.city.cityId).padStart(7)}  ${(probe.city.provinceName ?? "?").padEnd(16)} ${probe.companies.length} caterings`
    );
  }
  return cityProbes;
};

const main = async (): Promise<number> => {
  const opts = parseOptions(process.argv.slice(2));
  const rnd = rngFrom(opts.seed);
  const started = Date.now();

  console.log(
    `\n=== city-divergence — cities=${opts.cities} companies=${opts.companies} peers=${opts.peers} dates=${opts.dates} leaves=${opts.leaves} seed=${opts.seed} ===\n`
  );

  const cityProbes = await collectCityProbes(opts, rnd);
  const picks = sampleCompanies(cityProbes, opts, rnd);
  if (picks.length === 0) {
    throw new Error("no comparable companies in the sampled cities");
  }

  // Identical dates on both sides — the comparison only means something when
  // the request differs in nothing but cityId.
  const dates = futureWeekdays(opts.dates, { fromDaysOffset: 3 });
  const deliveryDates = futureWeekdays(1, { fromDaysOffset: 4 });
  console.log(
    `[probe] menu dates ${dates.join(", ")} · quote delivery ${deliveryDates.join(", ")}\n`
  );

  const byCity = new Map(cityProbes.map((p) => [p.city.cityId, p.city]));
  const checked = new Map<Dimension, number>();
  const diverged = new Map<Dimension, number>();
  const findings: Finding[] = [];
  const ctx: RunContext = { cityProbes, dates, deliveryDates, opts };
  let budgetHit = false;

  for (const pick of picks) {
    // A company costs ~2 + leaves + dates requests per city; stop before a
    // half-probed company skews the tallies.
    if (budgetLeft(opts) < 12) {
      budgetHit = true;
      break;
    }
    const referenceId = pick.availableIn.includes(opts.anchorCityId)
      ? opts.anchorCityId
      : pick.availableIn[0];
    const referenceCity = byCity.get(referenceId);
    if (referenceCity === undefined) {
      continue;
    }
    try {
      const result = await runCompany(pick, referenceCity, ctx);
      budgetHit ||= result.budgetHit;
      findings.push(...foldTallies(result.comparisons, checked, diverged));
    } catch (error) {
      console.warn(`  ${pick.slug.padEnd(24)} ERROR ${errMsg(error)}`);
    }
  }

  const contentFindings = findings.filter((f) => isContent(f.dimension));
  const dimensionRows: DimensionRow[] = ALL_DIMENSIONS.map((d) => ({
    checked: checked.get(d) ?? 0,
    content: isContent(d),
    dimension: d,
    diverged: diverged.get(d) ?? 0,
  }));
  printDimensionTable(dimensionRows);

  if (contentFindings.length > 0) {
    console.log("\n=== content divergence (first 20) ===\n");
    for (const f of contentFindings.slice(0, 20)) {
      console.log(
        `  [${f.dimension}] ${f.company} — ${f.referenceCity} vs ${f.peerCity}\n      ${f.detail}`
      );
    }
  }

  const report = {
    cities: cityProbes.map((p) => ({
      cityId: p.city.cityId,
      companies: p.companies.length,
      name: p.city.name,
      province: p.city.provinceName,
    })),
    companies: picks.map((p) => ({
      availableIn: p.availableIn.length,
      national: p.national,
      slug: p.slug,
    })),
    dimensions: dimensionRows,
    findings,
    generatedAt: new Date().toISOString(),
    options: opts,
    requestsUsed,
  };
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`);

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `\n${requestsUsed} requests in ${elapsed}s${budgetHit ? ` (stopped early: ${BUDGET_EXHAUSTED})` : ""} → ${opts.out}`
  );
  console.log(
    contentFindings.length === 0
      ? "\nVERDICT: no content divergence in this sample — catalogs, menus and diet prices matched across every sampled city.\n"
      : `\nVERDICT: ${contentFindings.length} content divergence(s) found. City is NOT a pure membership filter — read the findings above.\n`
  );

  return contentFindings.length === 0 ? 0 : 1;
};

try {
  process.exit(await main());
} catch (error) {
  console.error(`city-divergence failed: ${errMsg(error)}`);
  process.exit(2);
}
