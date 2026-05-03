import { Pool } from "pg";
import type { QueryResultRow } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __dietlownikPool: Pool | undefined;
}

function makePool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) {
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
}

// Lazy: pool is created on first call, then cached on globalThis so HMR
// doesn't leak connections in dev. Module load must NOT throw — Next collects
// page data at build time without env vars set.
function getPool(): Pool {
  if (global.__dietlownikPool) {
    return global.__dietlownikPool;
  }
  const pool = makePool();
  global.__dietlownikPool = pool;
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
) {
  const res = await getPool().query<T>(text, params as never[]);
  return res.rows;
}
