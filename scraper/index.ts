import { pool } from "./db.js";
import { scrapeCatalog } from "./scrapers/catalog.js";
import { scrapeCity } from "./scrapers/city.js";
import { listCompanies } from "./scrapers/companies.js";
import { scrapeDietTags } from "./scrapers/diet_tags.js";
import { scrapePrices } from "./scrapers/prices.js";
import type { CompanySearchItem } from "./types.js";

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
  }
};

const processCompany = async (
  companyId: string,
  cityId: number
): Promise<void> => {
  await scrapeCatalog(companyId, cityId);
  const work: Promise<unknown>[] = [];
  if (!SKIP_PRICES) {
    work.push(scrapePrices(companyId, cityId));
  }
  if (!SKIP_MENUS) {
    work.push(runMenusForCompany(companyId, cityId));
  }
  await Promise.all(work);
};

const runPool = async <T>(
  items: T[],
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

  try {
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
      async (c) => {
        const companyId = c.companyId ?? c.name;
        if (companyId === undefined || companyId === "") {
          console.warn("[run] company missing companyId, skipping");
          return;
        }
        await processCompany(companyId, city.cityId);
      }
    );

    if (!SKIP_PROMOS) {
      try {
        const { scrapePromotions } = await import("./scrapers/promotions.js");
        await scrapePromotions(city.cityId, companies);
      } catch (error) {
        console.warn(`[run] promotions skipped (${errMsg(error)})`);
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n=== done: ${ok} ok, ${fail} failed in ${elapsed}s ===\n`);
  } finally {
    await pool.end();
  }
};

// oxlint-disable-next-line promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- top-level entry point
run().catch((error: unknown) => {
  console.error("[run] fatal:", error);
  process.exit(1);
});
