import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    'postgres://postgres:h38cUAhVwkITI9HqXg60YakepF3p0fuGO5LT8pCcxTKpMzLZWTa1pPzt21ZB54M0@145.239.90.205:6767/postgres',
  max: 5,
});

export const q = (sql: string, params?: unknown[]) => pool.query(sql, params);
