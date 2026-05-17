import cron from "node-cron";

import { dumpApiMetrics } from "./api";
import { pool } from "./db";
import { recordScrapeError, withRun } from "./scrape-run";
import { scrapeCatalog } from "./scrapers/catalog";
import { scrapeCity } from "./scrapers/city";
import { listCompanies } from "./scrapers/companies";
import { scrapeDietTags } from "./scrapers/diet-tags";
import { scrapePrices } from "./scrapers/prices";
import type { CompanySearchItem, DeepReadonly } from "./types";

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

const REPEAT =
  process.env.SCRAPE_SCHEDULER === "1" || process.argv.includes("--repeat");

const errMsg = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const runMenusForCompany = async (
  companyId: string,
  cityId: number
): Promise<void> => {
  try {
    // Lazy-import so the file is optional during the migration window.
    const m = await import("./scrapers/menus.js");
    await m.scrapeMenus(companyId, cityId);
  } catch (error) {
    console.warn(`[run] menus skipped (${errMsg(error)})`);
    await recordScrapeError(null, "menus", { companyId, error });
  }
};

const processCompany = async (
  companyId: string,
  cityId: number,
  extras: DeepReadonly<CompanySearchItem> | null
): Promise<void> => {
  await scrapeCatalog(companyId, cityId, extras);
  const work: Promise<unknown>[] = [];
  if (!SKIP_PRICES) {
    work.push(scrapePrices(companyId, cityId));
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

const run = async (): Promise<void> => {
  console.log(
    `\n=== dietlownik scraper — city=${CITY}${hasCompany ? ` company=${COMPANY}` : ""} ===\n`
  );

  const scope = `${CITY}${hasCompany ? `/${COMPANY}` : ""}`;
  await withRun("scrape", scope, async () => {
    const city = await scrapeCity(CITY);

    if (!SKIP_TAGS) {
      await scrapeDietTags();
    }

    const companies: CompanySearchItem[] = hasCompany
      ? [
          {
            companyId: COMPANY,
            fullName: COMPANY ?? "",
            name: COMPANY ?? "",
          },
        ]
      : await listCompanies(city);
    const slice =
      LIMIT !== undefined && LIMIT > 0 ? companies.slice(0, LIMIT) : companies;
    console.log(
      `\n[run] processing ${slice.length}/${companies.length} companies (concurrency=${COMPANY_CONCURRENCY})...\n`
    );

    const t0 = Date.now();
    const { ok, fail } = await runPool(
      slice,
      COMPANY_CONCURRENCY,
      async (c: DeepReadonly<CompanySearchItem>) => {
        const companyId = c.companyId ?? c.name;
        if (companyId === undefined || companyId === "") {
          console.warn("[run] company missing companyId, skipping");
          return;
        }
        try {
          await processCompany(companyId, city.cityId, c);
        } catch (error) {
          await recordScrapeError(null, "catalog", { companyId, error });
          throw error;
        }
      }
    );

    if (!SKIP_PROMOS) {
      try {
        const { scrapePromotions } = await import("./scrapers/promotions.js");
        await scrapePromotions(city.cityId, companies);
      } catch (error) {
        console.warn(`[run] promotions skipped (${errMsg(error)})`);
        await recordScrapeError(null, "promotions", { error });
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
    }
  };
  // oxlint-disable-next-line promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- top-level entry point
  main().catch((error: unknown) => {
    console.error("[run] fatal:", error);
    process.exit(1);
  });
}
