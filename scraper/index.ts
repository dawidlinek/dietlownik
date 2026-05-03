import { pool } from "./db.js";
import { scrapeCatalog } from "./scrapers/catalog.js";
import { scrapeCity } from "./scrapers/city.js";
import { listCompanies } from "./scrapers/companies.js";
import { scrapeDietTags } from "./scrapers/diet_tags.js";
import { scrapePrices } from "./scrapers/prices.js";
import type { CompanySearchItem } from "./types.js";

const CITY = process.env.CITY ?? "Wrocław";
const COMPANY = process.env.COMPANY?.trim(); // e.g. "robinfood" — skip company-list, scrape just this one
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : undefined;
const COMPANY_CONCURRENCY = Number(process.env.COMPANY_CONCURRENCY ?? 4);
const SKIP_MENUS = process.env.SKIP_MENUS === "1";
const SKIP_PROMOS = process.env.SKIP_PROMOS === "1";
const SKIP_PRICES = process.env.SKIP_PRICES === "1";
const SKIP_TAGS = process.env.SKIP_TAGS === "1";

async function processCompany(
  companyId: string,
  cityId: number
): Promise<void> {
  await scrapeCatalog(companyId, cityId);
  const work: Promise<unknown>[] = [];
  if (!SKIP_PRICES) {
    work.push(scrapePrices(companyId, cityId));
  }
  if (!SKIP_MENUS) {
    // Lazy-import so the file is optional during the migration window.
    work.push(
      import("./scrapers/menus.js")
        .then(async (m) => m.scrapeMenus(companyId, cityId))
        .catch((error: unknown) => {
          const msg = error instanceof Error ? error.message : String(error);
          console.warn(`[run] menus skipped (${msg})`);
        })
    );
  }
  await Promise.all(work);
}

async function runPool<T>(
  items: T[],
  n: number,
  fn: (item: T) => Promise<void>
): Promise<{ ok: number; fail: number }> {
  const queue = [...items];
  let ok = 0;
  let fail = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, n) }, async () => {
      while (queue.length) {
        const item = queue.shift()!;
        try {
          await fn(item);
          ok += 1;
        } catch (error) {
          fail += 1;
          console.error(`[run] ✗ ${(error as Error).message}`);
        }
      }
    })
  );
  return { fail, ok };
}

async function run(): Promise<void> {
  console.log(
    `\n=== dietlownik scraper — city=${CITY}${COMPANY ? ` company=${COMPANY}` : ""} ===\n`
  );

  try {
    const city = await scrapeCity(CITY);

    if (!SKIP_TAGS) {
      await scrapeDietTags();
    }

    let companies: CompanySearchItem[];
    if (COMPANY) {
      companies = [{ companyId: COMPANY, fullName: COMPANY, name: COMPANY }];
    } else {
      companies = await listCompanies(city);
    }
    const slice = LIMIT ? companies.slice(0, LIMIT) : companies;
    console.log(
      `\n[run] processing ${slice.length}/${companies.length} companies (concurrency=${COMPANY_CONCURRENCY})...\n`
    );

    const t0 = Date.now();
    const { ok, fail } = await runPool(
      slice,
      COMPANY_CONCURRENCY,
      async (c) => {
        const companyId = c.companyId ?? c.name;
        if (!companyId) {
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
        console.warn(`[run] promotions skipped (${(error as Error).message})`);
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n=== done: ${ok} ok, ${fail} failed in ${elapsed}s ===\n`);
  } finally {
    await pool.end();
  }
}

run().catch((error: unknown) => {
  console.error("[run] fatal:", error);
  process.exit(1);
});
