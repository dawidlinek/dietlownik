import { Pool, type QueryResultRow } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __dietlownikPool: Pool | undefined;
}

function makePool() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Expected it in /Users/rei/projects/dietlownik/.env (loaded via next.config.ts)."
    );
  }
  return new Pool({
    connectionString: url,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export const pool: Pool = global.__dietlownikPool ?? makePool();

if (process.env.NODE_ENV !== "production") {
  global.__dietlownikPool = pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
) {
  const res = await pool.query<T>(text, params as never[]);
  return res.rows;
}
