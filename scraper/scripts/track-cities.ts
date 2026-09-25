// Manage the tracked-city set — the cities the national scrape keeps fresh
// (catering list, delivery terms, advertised prices). See CLAUDE.md
// "City scope".
//
//   npm run cities:track                    track Poland's 66 county-level
//                                           cities (COUNTY_CITIES)
//   npm run cities:track -- Józefów Łomianki  track these (by name; dietly's
//                                           largest locality of that name)
//   npm run cities:track -- --list          show the tracked set
//   npm run cities:track -- --untrack Sopot  stop refreshing a city (its
//                                           memberships stay as last seen)
//
// Tracking is cheap to add and not free to keep: each tracked city costs ~1
// request per catering delivering there (~150) on every daily refresh.

import "dotenv/config";
import { closeCfBrowser } from "../cf-fetch";
import { pool, q } from "../db";
import {
  COUNTY_CITIES,
  getTrackedCities,
  resolveCityByName,
  trackCities,
} from "../scrapers/city";

const list = async (): Promise<void> => {
  const tracked = await getTrackedCities();
  console.log(`${tracked.length} tracked cities:`);
  for (const c of tracked) {
    const at =
      c.last_refreshed_ms === null
        ? "never refreshed"
        : `refreshed ${new Date(c.last_refreshed_ms).toISOString().slice(0, 16)}`;
    console.log(
      `  ${c.name.padEnd(24)} ${String(c.city_id).padStart(7)}  ${at}`
    );
  }
};

const untrack = async (names: readonly string[]): Promise<void> => {
  for (const name of names) {
    const city = await resolveCityByName(name);
    if (city === null) {
      console.warn(`  ? ${name}: not found`);
      continue;
    }
    await q(`UPDATE cities SET tracked = FALSE WHERE city_id = $1`, [
      city.cityId,
    ]);
    console.log(`  - ${city.name} (${city.cityId})`);
  }
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    await list();
    return;
  }
  if (args[0] === "--untrack") {
    await untrack(args.slice(1));
    return;
  }
  const names = args.length > 0 ? args : COUNTY_CITIES;
  console.log(`tracking ${names.length} cities...`);
  const { tracked, unresolved } = await trackCities(names);
  for (const c of tracked) {
    console.log(
      `  + ${c.name.padEnd(24)} ${String(c.cityId).padStart(7)}  ${c.provinceName ?? ""}`
    );
  }
  if (unresolved.length > 0) {
    console.warn(
      `unresolved (dietly search doesn't know them): ${unresolved.join(", ")}`
    );
  }
  console.log(
    `\n${tracked.length} tracked; the next scrape refreshes them (≈150 requests each).`
  );
};

try {
  await main();
} catch (error) {
  console.error(
    "track-cities failed:",
    error instanceof Error ? error.message : error
  );
  process.exitCode = 1;
} finally {
  await pool.end();
  // The CF-bypass Chrome keeps the event loop alive otherwise.
  await closeCfBrowser();
}
