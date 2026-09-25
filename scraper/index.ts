import cron from "node-cron";

import { dumpApiMetrics } from "./api";
import { closeCfBrowser } from "./cf-fetch";
import { pool, q } from "./db";
import {
  getCurrentRunId,
  recordScrapeError,
  recordStageResult,
  withRun,
} from "./scrape-run";
import { scrapeCatalog } from "./scrapers/catalog";
import { getTrackedCities, scrapeCity } from "./scrapers/city";
import type { TrackedCity } from "./scrapers/city";
import { refreshCity } from "./scrapers/city-refresh";
import { fetchCityListing } from "./scrapers/companies";
import { scrapeDietTags } from "./scrapers/diet-tags";
import {
  assignHomeCities,
  assignPriceCities,
  closeUnquotedPrices,
  nationalTargets,
  priceGroupTargets,
} from "./scrapers/price-groups";
import type { Target } from "./scrapers/price-groups";
import { scrapePrices } from "./scrapers/prices";
import type { CompanySearchItem, DeepReadonly } from "./types";

// The anchor: always tracked, and every catering's preferred home city.
const CITY = process.env.CITY ?? "Wrocław";
// e.g. "robinfood" — skip company-list, scrape just this one
const COMPANY = process.env.COMPANY?.trim();
const LIMIT =
  process.env.LIMIT !== undefined && process.env.LIMIT !== ""
    ? Number(process.env.LIMIT)
    : undefined;
const COMPANY_CONCURRENCY = Number(process.env.COMPANY_CONCURRENCY ?? 4);
const SKIP_MENUS = process.env.SKIP_MENUS === "1";
const SKIP_PROMOS = process.env.SKIP_PROMOS === "1";
const SKIP_PRICES = process.env.SKIP_PRICES === "1";
const SKIP_TAGS = process.env.SKIP_TAGS === "1";
const SKIP_CITY_REFRESH = process.env.SKIP_CITY_REFRESH === "1";
const SKIP_PRICE_GROUPS = process.env.SKIP_PRICE_GROUPS === "1";
// A tracked city is refreshed when its last refresh is older than this.
const CITY_REFRESH_HOURS = Number(process.env.CITY_REFRESH_HOURS ?? 20);

const REPEAT =
  process.env.SCRAPE_SCHEDULER === "1" || process.argv.includes("--repeat");

const errMsg = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const runMenusForCompany = async (
  companyId: string,
  cityId: number
): Promise<void> => {
  const startedAt = new Date();
  try {
    // Lazy-import so the file is optional during the migration window.
    const m = await import("./scrapers/menus.js");
    const { errors } = await m.scrapeMenus(companyId, cityId);
    await recordStageResult(companyId, "menus", startedAt, true, errors);
  } catch (error) {
    console.warn(`[run] menus skipped (${errMsg(error)})`);
    await recordScrapeError(getCurrentRunId(), "menus", { companyId, error });
    await recordStageResult(companyId, "menus", startedAt, false);
  }
};

const runPricesForCompany = async (
  companyId: string,
  cityId: number,
  stage = "prices"
): Promise<void> => {
  const startedAt = new Date();
  try {
    const { fail } = await scrapePrices(companyId, cityId);
    await recordStageResult(companyId, stage, startedAt, true, fail);
  } catch (error) {
    await recordStageResult(companyId, stage, startedAt, false);
    throw error;
  }
};

const processCompany = async (
  companyId: string,
  cityId: number,
  extras: DeepReadonly<CompanySearchItem> | null
): Promise<void> => {
  const catalogStartedAt = new Date();
  try {
    await scrapeCatalog(companyId, cityId, extras);
  } catch (error) {
    await recordStageResult(companyId, "catalog", catalogStartedAt, false);
    throw error;
  }
  await recordStageResult(companyId, "catalog", catalogStartedAt, true);
  const work: Promise<unknown>[] = [];
  if (!SKIP_PRICES) {
    work.push(runPricesForCompany(companyId, cityId));
  }
  if (!SKIP_MENUS) {
    work.push(runMenusForCompany(companyId, cityId));
  }
  // reviews dropped from the new schema scope.
  await Promise.all(work);
};

const runPool = async <T>(
  items: readonly T[],
  n: number,
  fn: (item: T) => Promise<void>
): Promise<{ ok: number; fail: number }> => {
  const queue = [...items];
  let ok = 0;
  let fail = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, n) }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item === undefined) {
          break;
        }
        try {
          await fn(item);
          ok += 1;
        } catch (error) {
          fail += 1;
          console.error(`[run] ✗ ${errMsg(error)}`);
        }
      }
    })
  );
  return { fail, ok };
};

const hasCompany = COMPANY !== undefined && COMPANY !== "";

/**
 * Refresh every tracked city whose per-city facts are older than
 * CITY_REFRESH_HOURS. Returns the listing entries seen, keyed
 * "company@city", so each catering's catalog pass gets the entry of its own
 * home city (search-only fields: order window, params, promo).
 */
const refreshDueCities = async (): Promise<Map<string, CompanySearchItem>> => {
  const listed = new Map<string, CompanySearchItem>();
  const cutoff = Date.now() - CITY_REFRESH_HOURS * 3_600_000;
  const tracked = await getTrackedCities();
  const due = tracked.filter(
    (c: Readonly<TrackedCity>) =>
      c.last_refreshed_ms === null || c.last_refreshed_ms < cutoff
  );
  console.log(`\n[run] city refresh: ${due.length} tracked cities due\n`);
  for (const city of due) {
    try {
      const result = await refreshCity(city.city_id, city.name);
      for (const item of result.items) {
        listed.set(`${item.name}@${city.city_id}`, item);
      }
    } catch (error) {
      console.warn(`[run] city ${city.name} refresh failed: ${errMsg(error)}`);
      await recordScrapeError(getCurrentRunId(), "city-refresh", {
        context: `city=${city.city_id}`,
        error,
      });
    }
  }
  return listed;
};

/** A single-catering run: its home city, else the anchor. */
const singleTarget = async (
  companyId: string,
  anchorCityId: number
): Promise<Target> => {
  const { rows } = await q<{ home_city_id: string | null }>(
    `SELECT home_city_id FROM companies WHERE company_id = $1`,
    [companyId]
  );
  const home = rows[0]?.home_city_id ?? null;
  return { cityId: home === null ? anchorCityId : Number(home), companyId };
};

/**
 * Listing entries for promotions: whatever this run listed, one per
 * catering; a run that refreshed no city lists the anchor (one request).
 */
const promotionItems = async (
  listed: readonly DeepReadonly<CompanySearchItem>[],
  anchorCityId: number
): Promise<DeepReadonly<CompanySearchItem>[]> => {
  if (hasCompany || listed.length > 0) {
    return [
      ...new Map(
        listed.map((item: DeepReadonly<CompanySearchItem>) => [item.name, item])
      ).values(),
    ];
  }
  const anchorListing = await fetchCityListing(anchorCityId);
  return anchorListing.items;
};

const run = async (): Promise<void> => {
  console.log(
    `\n=== dietlownik scraper — national, anchor=${CITY}${hasCompany ? ` company=${COMPANY}` : ""} ===\n`
  );

  const scope = `national${hasCompany ? `/${COMPANY}` : ""}`;
  await withRun("scrape", scope, async () => {
    const anchor = await scrapeCity(CITY);
    await q(`UPDATE cities SET tracked = TRUE WHERE city_id = $1`, [
      anchor.cityId,
    ]);

    if (!SKIP_TAGS) {
      await scrapeDietTags();
    }

    // 1. Per-city facts for the tracked cities: who delivers, fees, terms,
    //    advertised prices. Skipped for single-catering runs.
    const listed =
      hasCompany || SKIP_CITY_REFRESH
        ? new Map<string, CompanySearchItem>()
        : await refreshDueCities();

    // 2. National pass: each catering once, from its home city — catalog,
    //    menus (stored city-less) and quotes.
    const moved = await assignHomeCities(
      anchor.cityId,
      hasCompany ? [COMPANY ?? ""] : null
    );
    if (moved > 0) {
      console.log(`[run] ${moved} caterings got a new home city`);
    }
    const targets = hasCompany
      ? [await singleTarget(COMPANY ?? "", anchor.cityId)]
      : await nationalTargets();
    const slice =
      LIMIT !== undefined && LIMIT > 0 ? targets.slice(0, LIMIT) : targets;
    console.log(
      `\n[run] national pass: ${slice.length}/${targets.length} caterings (concurrency=${COMPANY_CONCURRENCY})...\n`
    );

    const t0 = Date.now();
    const { ok, fail } = await runPool(
      slice,
      COMPANY_CONCURRENCY,
      async (t: Readonly<Target>) => {
        try {
          await processCompany(
            t.companyId,
            t.cityId,
            listed.get(`${t.companyId}@${t.cityId}`) ?? null
          );
        } catch (error) {
          await recordScrapeError(getCurrentRunId(), "catalog", {
            companyId: t.companyId,
            error,
          });
          throw error;
        }
      }
    );

    // 3. Price groups: which city's quotes each (catering, city) uses, and
    //    quotes for every group representative that isn't a home city.
    const scopeIds = hasCompany ? [COMPANY ?? ""] : null;
    const repriced = await assignPriceCities(scopeIds);
    if (!SKIP_PRICES && !SKIP_PRICE_GROUPS) {
      const groups = await priceGroupTargets(scopeIds);
      console.log(
        `\n[run] price groups: ${groups.length} extra (catering, city) quote sets; ${repriced} memberships changed price city\n`
      );
      await runPool(
        groups,
        COMPANY_CONCURRENCY,
        async (g: Readonly<Target>) => {
          await runPricesForCompany(
            g.companyId,
            g.cityId,
            `prices@${g.cityId}`
          );
        }
      );
    }
    if (!SKIP_PRICES) {
      const closed = await closeUnquotedPrices(scopeIds);
      if (closed > 0) {
        console.log(
          `[run] closed ${closed} quote spans in cities no longer quoted`
        );
      }
    }

    if (!SKIP_PROMOS) {
      try {
        const { scrapePromotions } = await import("./scrapers/promotions.js");
        await scrapePromotions(
          anchor.cityId,
          await promotionItems([...listed.values()], anchor.cityId)
        );
      } catch (error) {
        console.warn(`[run] promotions skipped (${errMsg(error)})`);
        await recordScrapeError(getCurrentRunId(), "promotions", { error });
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n=== done: ${ok} ok, ${fail} failed in ${elapsed}s ===\n`);
    dumpApiMetrics();

    // End-of-run hook: embed any meals queued during this scrape. Lazy-load
    // the helper so cold start doesn't pull in @xenova/transformers when
    // SKIP_MENUS=1 produces nothing to embed. Non-fatal.
    try {
      const { flushEmbeddings } = await import("./embed-queue.js");
      await flushEmbeddings();
    } catch (error) {
      console.warn(`[run] embed flush failed: ${errMsg(error)}`);
    }

    return { fail, ok, value: undefined };
  });
};

const shutdown = (): void => {
  console.log("\n[run] shutting down scheduler...");
  // oxlint-disable-next-line promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- fire-and-forget cleanup, exit follows immediately
  pool.end().catch((error: unknown) => {
    console.error(error);
  });
  process.exit(0);
};

if (REPEAT) {
  console.log("[run] scheduler mode — daily at 06:00 (Warsaw time)");
  cron.schedule("0 6 * * *", () => {
    // oxlint-disable-next-line promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- cron callback must return void; .catch() handles errors correctly
    run().catch((error: unknown) => {
      console.error("[run] fatal:", error);
      process.exit(1);
    });
  });
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} else {
  // Dump API metrics on Ctrl-C / SIGTERM so we get a summary even when we
  // stop a long scrape early.
  const earlyShutdown = (sig: string): void => {
    console.log(`\n[run] ${sig} — dumping metrics and exiting`);
    try {
      dumpApiMetrics();
    } catch {
      // best-effort
    }
    process.exit(130);
  };
  process.on("SIGINT", () => {
    earlyShutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    earlyShutdown("SIGTERM");
  });

  const main = async (): Promise<void> => {
    try {
      await run();
    } catch (error) {
      console.error("[run] fatal:", error);
      process.exitCode = 1;
    } finally {
      try {
        await pool.end();
      } catch (error) {
        console.error(error);
      }
      // Headless Chrome keeps the event loop alive; close it so a one-shot
      // run actually exits.
      await closeCfBrowser();
    }
  };
  // oxlint-disable-next-line promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- top-level entry point
  main().catch((error: unknown) => {
    console.error("[run] fatal:", error);
    process.exit(1);
  });
}
