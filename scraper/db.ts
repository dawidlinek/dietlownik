import "dotenv/config";
import type pg from "pg";

import { getPool } from "@/lib/db";

// Scraper-side surface around the shared `lib/db.ts` Pool. The lib version
// owns the lazy globalThis-cached singleton (HMR-safe in dev). Existing
// scraper call sites (`pool.end()`, `q(sql, params)`) keep working
// unchanged.

export { getPool };

/** Proxy preserving the `pool` symbol used by scraper shutdown hooks. */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- empty target is widened by Proxy traps; outer cast names the real surface
export const pool = new Proxy({} as pg.Pool, {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ProxyHandler.get signature is fixed by lib.es2015 (target: pg.Pool, prop: string|symbol)
  get(_target, prop) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- pg.Pool's typed surface has no index signature; Proxy trap requires dynamic lookup
    const real = getPool() as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    // oxlint-disable-next-line typescript/no-unsafe-return -- value is `unknown` in the index signature; we forward it as-is to the caller
    return typeof value === "function" ? value.bind(real) : value;
  },
});

// oxlint-disable-next-line typescript/promise-function-async -- thin forwarder; adding async would force return-await dance
export const q = <R extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params?: readonly unknown[]
) => getPool().query<R>(sql, params === undefined ? undefined : [...params]);
