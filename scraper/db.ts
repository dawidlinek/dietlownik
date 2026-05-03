import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

// Lazy: do NOT throw at import time. Modules that only import types from
// here (or that import this transitively but never query) — including the
// MCP route test harness in CI — must be safe to load without a DB URL.
// The error fires on the first query attempt instead.
let _pool: pg.Pool | undefined;

function getPool(): pg.Pool {
  if (_pool) {
    return _pool;
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }
  _pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.PG_POOL_MAX ?? 20),
  });
  return _pool;
}

/**
 * Proxy that forwards every method/property access to the lazily-constructed
 * pg.Pool. Existing call sites (`pool.end()`, `pool.connect()`, etc.) keep
 * working without changes.
 */
export const pool = new Proxy({} as pg.Pool, {
  get(_target, prop) {
    const real = getPool() as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    return typeof value === "function" ? value.bind(real) : value;
  },
});

export const q = async <R extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params?: unknown[]
) => getPool().query<R>(sql, params);
