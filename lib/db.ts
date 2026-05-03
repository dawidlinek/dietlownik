import { Pool } from "pg";
import type { QueryResultRow } from "pg";

declare global {
  // oxlint-disable-next-line no-underscore-dangle, no-var -- HMR-safe singleton on globalThis; double-underscore avoids collisions with user code
  var __dietlownikPool: Pool | undefined;
}

const makePool = (): Pool => {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === "") {
    throw new Error(
      "DATABASE_URL is not set. Provide it via .env (dev) or environment (prod)."
    );
  }
  return new Pool({
    connectionString: url,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    max: 5,
  });
};

// Lazy: pool is created on first call, then cached on globalThis so HMR
// doesn't leak connections in dev. Module load must NOT throw — Next collects
// page data at build time without env vars set, and the MCP test suite
// imports the module without DATABASE_URL.
export const getPool = (): Pool => {
  // oxlint-disable-next-line no-underscore-dangle -- HMR-safe singleton key on globalThis
  if (global.__dietlownikPool) {
    // oxlint-disable-next-line no-underscore-dangle -- HMR-safe singleton key on globalThis
    return global.__dietlownikPool;
  }
  const pool = makePool();
  // oxlint-disable-next-line no-underscore-dangle -- HMR-safe singleton key on globalThis
  global.__dietlownikPool = pool;
  return pool;
};

export const query = async <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = []
) => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- pg's overload requires mutable array; copy the readonly input to a local array
  const res = await getPool().query<T>(text, [...params] as never[]);
  return res.rows;
};
