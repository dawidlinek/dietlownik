// City price check — does city_quotes() give each city the price dietly
// actually quotes there?
//
// The national scrape quotes each catering in few cities (its home city and
// its price-group representatives) and serves every other tracked city from
// those quotes, with the delivery fee adjusted (db/schema.sql city_quotes).
// This samples (catering, tracked city) pairs and asks dietly for live
// quotes of the same leaf in that city AND in its price city, then scores
// two separate things:
//
//   city rule   live(city) = live(price city) + fee delta — is borrowing
//               another city's quote (with the delivery fee swapped) right?
//               Independent of when the stored quote was taken.
//   freshness   stored quote = live(price city) — has the price moved since
//               the last scrape? Stale quotes are a scrape-cadence fact, not
//               a city-rule bug: a first run against a day-old clone scored
//               45/96 end-to-end, and every miss was the same in all three
//               cities, home included.
//
// Every pair is labelled by how its price is produced:
//   own       the city is its own price city — the stored quote, unmodified
//   borrowed  the city uses another city's quotes (home or group rep)
//   +fee      …and the delivery fee was adjusted on the way
//
// Exit code 1 when the city rule fails anywhere, so this can run as a
// monitor; staleness alone exits 0.
//
// Usage:
//   npm run check:prices
//   npm run check:prices -- --cities=20 --per-city=6 --leaves=2 --seed=3
//   npm run check:prices -- --company=mangodiet,fitdieta
//
// Options (all --key=value):
//   --cities=N      tracked cities to sample                 (default 12)
//   --per-city=N    caterings per city                       (default 5)
//   --leaves=N      leaves quoted per (catering, city)       (default 2)
//   --company=a,b   only these caterings (every tracked city they serve)
//   --seed=N        deterministic sampling                   (default 1)
//   --out=PATH      JSON report       (default reports/city-prices.json)

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { futureWeekdays, post } from "../api";
import { closeCfBrowser } from "../cf-fetch";
import { pool, q } from "../db";
import type { PriceRequestBody, PriceResponse } from "../types";

interface Options {
  readonly cities: number;
  readonly companies: readonly string[] | null;
  readonly leaves: number;
  readonly out: string;
  readonly perCity: number;
  readonly seed: number;
}

const parseOptions = (argv: readonly string[]): Options => {
  const get = (key: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${key}=`))?.slice(key.length + 3);
  const num = (key: string, fallback: number): number => {
    const raw = get(key);
    const n = raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  const companies = get("company")
    ?.split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return {
    cities: num("cities", 12),
    companies:
      companies === undefined || companies.length === 0 ? null : companies,
    leaves: num("leaves", 2),
    out: get("out") ?? "reports/city-prices.json",
    perCity: num("per-city", 5),
    seed: num("seed", 1),
  };
};

/** One sampled leaf in one city, with everything needed to re-quote it. */
interface Sample {
  readonly company_id: string;
  readonly city_id: string;
  readonly city: string;
  readonly quoted_city: string;
  readonly quoted_city_id: string;
  readonly mode: string;
  readonly diet_calories_id: number;
  readonly tier_id: number;
  readonly tier_diet_option_id: string | null;
  readonly is_menu_configuration: boolean;
  readonly delivery_on_saturday: boolean;
  readonly delivery_on_sunday: boolean;
  readonly total_cost: string;
  readonly stored_total: string;
  readonly stored_delivery: string;
  readonly fee_delta: string;
}

// Pairs are drawn with a seeded hash of (company, city) so a run is
// replayable; leaves are the lowest ids of the pair's current no-promo,
// one-day quotes.
const SAMPLE_SQL = `
  WITH cities_pick AS (
    SELECT c.city_id, c.name FROM cities c
     WHERE c.tracked
     ORDER BY md5(c.city_id::text || $1::text)
     LIMIT $2
  ),
  pairs AS (
    SELECT cc.company_id, cc.city_id, cp.name,
           row_number() OVER (PARTITION BY cc.city_id
                              ORDER BY md5(cc.company_id || $1::text)) AS rk
      FROM company_cities cc
      JOIN cities_pick cp USING (city_id)
     WHERE cc.is_active AND cc.price_city_id IS NOT NULL
       AND ($4::text[] IS NULL OR cc.company_id = ANY ($4::text[]))
  )
  SELECT p.company_id, p.city_id::text, p.name AS city, qc.name AS quoted_city,
         cq.quoted_city_id::text,
         CASE WHEN cq.quoted_city_id = cq.city_id THEN 'own' ELSE 'borrowed' END
           || CASE WHEN cq.total_cost <> h.total_cost THEN '+fee' ELSE '' END AS mode,
         cq.diet_calories_id, cq.tier_id, do2.tier_diet_option_id,
         d.is_menu_configuration,
         COALESCE(co.delivery_on_saturday, FALSE) AS delivery_on_saturday,
         COALESCE(co.delivery_on_sunday, FALSE) AS delivery_on_sunday,
         cq.total_cost::text, h.total_cost::text AS stored_total,
         COALESCE(h.total_delivery_cost, 0)::text AS stored_delivery,
         (cq.total_cost - h.total_cost)::text AS fee_delta
    FROM pairs p
    CROSS JOIN LATERAL (
      SELECT * FROM city_quotes(p.city_id) x
       WHERE x.company_id = p.company_id AND x.closed_at IS NULL
         AND x.order_days = 1 AND x.promo_codes = '{}'
       ORDER BY x.diet_calories_id, x.tier_id
       LIMIT $5
    ) cq
    JOIN price_history h ON h.id = cq.id
    JOIN cities qc ON qc.city_id = cq.quoted_city_id
    JOIN companies co ON co.company_id = p.company_id
    JOIN diet_calories dc ON dc.company_id = cq.company_id
     AND dc.diet_calories_id = cq.diet_calories_id AND dc.tier_id = cq.tier_id
    JOIN diets d ON d.company_id = dc.company_id AND d.diet_id = dc.diet_id
    LEFT JOIN diet_options do2 ON do2.company_id = dc.company_id
     AND do2.diet_id = dc.diet_id AND do2.tier_id = dc.tier_id
     AND do2.diet_option_id = dc.diet_option_id
   WHERE $4::text[] IS NOT NULL OR p.rk <= $3
   ORDER BY p.city_id, p.company_id, cq.diet_calories_id, cq.tier_id`;

interface Quote {
  readonly live: number | null;
  readonly liveDelivery: number | null;
  readonly error: string | null;
}

interface Checked extends Quote {
  readonly sample: Sample;
  /** Live quote of the same leaf in the price city (null for `own`). */
  readonly reference: Quote | null;
}

const quoteLive = async (
  s: Readonly<Sample>,
  cityId: number
): Promise<Quote> => {
  const useTdo =
    s.is_menu_configuration &&
    s.tier_diet_option_id !== null &&
    s.tier_diet_option_id !== "";
  const body: PriceRequestBody = {
    cityId,
    deliveryDates: futureWeekdays(1, {
      includeSaturday: s.delivery_on_saturday,
      includeSunday: s.delivery_on_sunday,
    }),
    dietCaloriesId: s.diet_calories_id,
    promoCodes: [],
    testOrder: false,
    ...(useTdo && s.tier_diet_option_id !== null
      ? { tierDietOptionId: s.tier_diet_option_id }
      : {}),
  };
  try {
    const res = await post<PriceResponse>(
      `/api/mobile/open/company-card/${s.company_id}/quick-order/calculate-price`,
      body,
      { companyId: s.company_id }
    );
    return {
      error: null,
      live: res.cart?.totalCostToPay ?? null,
      liveDelivery: res.cart?.totalDeliveryCost ?? null,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      live: null,
      liveDelivery: null,
    };
  }
};

const cents = (n: number | string): number => Math.round(Number(n) * 100);

interface Score {
  readonly byMode: ReadonlyMap<string, Readonly<{ n: number; ok: number }>>;
  readonly ruleMisses: readonly Checked[];
  readonly fresh: number;
  readonly freshScored: number;
  readonly staleExamples: readonly Checked[];
}

/** Live quotes for every sample, and for its price city when it borrows. */
const collect = async (
  rows: readonly Sample[]
): Promise<{ results: Checked[]; quotes: Quote[] }> => {
  // One live quote per (catering, leaf, city); a price-city reference is
  // shared by every city that borrows it.
  const cache = new Map<string, Quote>();
  const cached = async (
    sample: Readonly<Sample>,
    cityId: number
  ): Promise<Quote> => {
    const key = `${sample.company_id}|${sample.diet_calories_id}|${sample.tier_id}|${cityId}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
      return hit;
    }
    const quote = await quoteLive(sample, cityId);
    cache.set(key, quote);
    return quote;
  };
  const results: Checked[] = [];
  for (const sample of rows) {
    const here = await cached(sample, Number(sample.city_id));
    const own = sample.quoted_city_id === sample.city_id;
    const reference = own
      ? null
      : await cached(sample, Number(sample.quoted_city_id));
    results.push({ ...here, reference, sample });
  }
  return { quotes: [...cache.values()], results };
};

/**
 * City rule: live here vs live in the price city, shifted by the fee delta
 * (`own` pairs have no rule to test). Freshness: stored vs live in the
 * price city.
 */
const score = (results: readonly Checked[]): Score => {
  const byMode = new Map<string, { n: number; ok: number }>();
  const ruleMisses: Checked[] = [];
  const staleExamples: Checked[] = [];
  let fresh = 0;
  let freshScored = 0;
  for (const r of results) {
    const ref = r.reference ?? r;
    if (ref.live !== null) {
      freshScored += 1;
      if (cents(ref.live) === cents(r.sample.stored_total)) {
        fresh += 1;
      } else if (staleExamples.length < 10) {
        staleExamples.push(r);
      }
    }
    if (r.reference === null || r.live === null || r.reference.live === null) {
      continue;
    }
    const tally = byMode.get(r.sample.mode) ?? { n: 0, ok: 0 };
    tally.n += 1;
    if (cents(r.live) === cents(r.reference.live) + cents(r.sample.fee_delta)) {
      tally.ok += 1;
    } else {
      ruleMisses.push(r);
    }
    byMode.set(r.sample.mode, tally);
  }
  return { byMode, fresh, freshScored, ruleMisses, staleExamples };
};

/** "Not sold here" is a real answer from dietly, not a transport problem. */
const errorKind = (message: string): string => {
  if (/nie ustalił ceny/u.test(message)) {
    return "not sold in that city";
  }
  if (/Nie znaleziono takiego kodu/u.test(message)) {
    return "unknown promo code";
  }
  return message.slice(0, 60);
};

const printReport = (
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Score holds a ReadonlyMap; the rule flags Map types regardless
  s: Readonly<Score>,
  quotes: readonly Quote[]
): void => {
  console.log("\n  city rule (live here = live in price city + fee delta)");
  for (const [mode, t] of [...s.byMode.entries()].toSorted(
    (a: readonly [string, unknown], b: readonly [string, unknown]) =>
      a[0].localeCompare(b[0])
  )) {
    console.log(`    ${mode.padEnd(13)} ${t.ok}/${t.n}`);
  }
  for (const m of s.ruleMisses.slice(0, 30)) {
    const x = m.sample;
    console.log(
      `    ✗ ${x.company_id} @ ${x.city} leaf=${x.diet_calories_id}/${x.tier_id} [${x.mode}, from ${x.quoted_city}]: live here ${m.live} (delivery ${m.liveDelivery}), live in ${x.quoted_city} ${m.reference?.live} (delivery ${m.reference?.liveDelivery}), fee delta ${x.fee_delta}`
    );
  }
  console.log(
    `\n  freshness (stored quote = live in price city): ${s.fresh}/${s.freshScored}`
  );
  for (const m of s.staleExamples) {
    const x = m.sample;
    const ref = m.reference ?? m;
    console.log(
      `    ~ ${x.company_id} leaf=${x.diet_calories_id}/${x.tier_id} in ${x.quoted_city}: stored ${x.stored_total} (delivery ${x.stored_delivery}), live ${ref.live} (delivery ${ref.liveDelivery})`
    );
  }
  const failed = quotes.filter((qv: Readonly<Quote>) => qv.error !== null);
  if (failed.length > 0) {
    const kinds = new Map<string, number>();
    for (const f of failed) {
      const kind = errorKind(f.error ?? "");
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
    const summary = [...kinds.entries()]
      .map(([k, n]: readonly [string, number]) => `${n}× ${k}`)
      .join("; ");
    console.log(
      `  (${failed.length} live quotes failed — not scored: ${summary})`
    );
  }
};

const main = async (): Promise<number> => {
  const opts = parseOptions(process.argv.slice(2));
  const { rows } = await q<Sample>(SAMPLE_SQL, [
    opts.seed,
    opts.cities,
    opts.perCity,
    opts.companies,
    opts.leaves,
  ]);
  console.log(`[check-prices] ${rows.length} (catering, city, leaf) samples`);

  const { results, quotes } = await collect(rows);
  const scored = score(results);
  printReport(scored, quotes);

  const ruleScored = [...scored.byMode.values()].reduce(
    (a: number, t: Readonly<{ n: number }>) => a + t.n,
    0
  );
  const matched = ruleScored - scored.ruleMisses.length;
  console.log(
    `\n[check-prices] city rule ${matched}/${ruleScored}, fresh ${scored.fresh}/${scored.freshScored}`
  );

  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(
    opts.out,
    `${JSON.stringify(
      {
        fresh: scored.fresh,
        freshScored: scored.freshScored,
        generatedAt: new Date().toISOString(),
        matched,
        modes: Object.fromEntries(scored.byMode),
        options: opts,
        ruleMisses: scored.ruleMisses,
        ruleScored,
        staleExamples: scored.staleExamples,
      },
      null,
      2
    )}\n`
  );
  return scored.ruleMisses.length === 0 ? 0 : 1;
};

try {
  process.exitCode = await main();
} catch (error) {
  console.error(
    "check-city-prices failed:",
    error instanceof Error ? error.message : error
  );
  process.exitCode = 2;
} finally {
  await pool.end();
  await closeCfBrowser();
}
