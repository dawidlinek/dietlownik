import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

export const q = (sql: string, params?: unknown[]) => pool.query(sql, params);
