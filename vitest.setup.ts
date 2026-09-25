// Load `.env` before any test module is imported.
//
// Without this, `DATABASE_URL` from `.env` never reaches the test process —
// only Next (which reads .env natively) and the scraper (`scraper/db.ts`
// imports "dotenv/config") saw it. Every DB-backed suite is guarded by
// `describe.skipIf(!DATABASE_URL)`, so `vitest run` silently skipped ~78 of
// 134 tests and still exited 0.
//
// An explicit `DATABASE_URL=... vitest run` still wins: dotenv does not
// overwrite variables already present in the environment.
import "dotenv/config";
