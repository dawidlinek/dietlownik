import { scrapeCity } from './scrapers/city.js';
import { listCompanies } from './scrapers/companies.js';
import { scrapeDietTags } from './scrapers/diet_tags.js';
import { scrapeCatalog } from './scrapers/catalog.js';
import { scrapePrices } from './scrapers/prices.js';
import { scrapeCampaigns } from './scrapers/campaigns.js';
import { pool } from './db.js';

const CITY = process.env.CITY ?? 'Wrocław';
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : undefined;

async function run(): Promise<void> {
  console.log(`\n=== dietlownik scraper — ${CITY} ===\n`);

  try {
    const city = await scrapeCity(CITY);

    await scrapeDietTags();
    await scrapeCampaigns();

    const companies = await listCompanies(city);
    const slice = LIMIT ? companies.slice(0, LIMIT) : companies;
    console.log(`\n[run] processing ${slice.length}/${companies.length} companies...\n`);

    let ok = 0;
    let fail = 0;

    for (const company of slice) {
      const companyId = company.companyId ?? company.name;
      if (!companyId) {
        console.warn('[run] company missing companyId, skipping');
        continue;
      }
      try {
        await scrapeCatalog(companyId, city.cityId);
        await scrapePrices(companyId, city.cityId);
        ok++;
      } catch (err) {
        console.error(`[run] ✗ ${companyId}: ${(err as Error).message}`);
        fail++;
      }
    }

    console.log(`\n=== done: ${ok} ok, ${fail} failed ===\n`);
  } finally {
    await pool.end();
  }
}

run();
