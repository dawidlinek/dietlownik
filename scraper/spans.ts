// Shared rules for span tables (price_history, company_city_history,
// menu_items). See the "History model" block in db/schema.sql.

import { withTx } from "./db";

/**
 * Longest silence a span may bridge. An identical observation that arrives
 * later than this after last_seen_at starts a new span instead of extending
 * the old one, so a span never claims we saw something while the scraper
 * was down. Daily scrapes land 18–30 h apart depending on where a catering
 * falls in the run; 36 h clears that with margin. db/migrate_v11_history.sql
 * uses the same value.
 */
export const SPAN_GAP_SQL = "INTERVAL '36 hours'";

/**
 * [column, SQL type] — the type each bound value is cast to. A key column
 * marked "nullable" is matched with IS NOT DISTINCT FROM (e.g. campaigns with
 * no company); others use plain `=`, which the open-key index can serve.
 */
type Column = readonly [string, string] | readonly [string, string, "nullable"];

/**
 * A span table keyed by `key` columns whose `values` columns are compared
 * observation to observation. Column names come from these constants only,
 * never from input, so interpolating them into SQL is safe.
 */
export interface SpanTable {
  readonly table: string;
  readonly key: readonly Column[];
  readonly values: readonly Column[];
}

const placeholders = (cols: readonly Column[], offset: number): string =>
  cols.map(([, type], i) => `$${i + offset + 1}::${type}`).join(", ");

const names = (cols: readonly Column[]): string =>
  cols.map(([name]) => name).join(", ");

/**
 * Record one observation of a keyed value. Identical values seen within
 * SPAN_GAP extend the open span; anything else closes it and opens a new
 * one. Bound values are cast to their column types, so the comparison sees
 * exactly what an INSERT would store (numeric rounding included).
 * Serialised per key with an advisory lock so two writers can't both open a
 * span.
 */
export const recordSpan = async (
  spec: Readonly<SpanTable>,
  key: readonly unknown[],
  values: readonly unknown[]
): Promise<void> => {
  const keyMatch = spec.key
    .map(
      ([name, type, nullable], i) =>
        `${name} ${nullable === undefined ? "=" : "IS NOT DISTINCT FROM"} $${i + 1}::${type}`
    )
    .join(" AND ");
  const params = [...key, ...values];
  await withTx(async (tq) => {
    await tq("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `${spec.table}:${JSON.stringify(key)}`,
    ]);
    const extended = await tq(
      `UPDATE ${spec.table}
          SET last_seen_at = NOW(), observations = observations + 1
        WHERE ${keyMatch} AND closed_at IS NULL
          AND last_seen_at >= NOW() - ${SPAN_GAP_SQL}
          AND ROW(${names(spec.values)})
              IS NOT DISTINCT FROM ROW(${placeholders(spec.values, spec.key.length)})`,
      params
    );
    if ((extended.rowCount ?? 0) > 0) {
      return;
    }
    await tq(
      `UPDATE ${spec.table} SET closed_at = NOW()
        WHERE ${keyMatch} AND closed_at IS NULL`,
      [...key]
    );
    await tq(
      `INSERT INTO ${spec.table} (${names(spec.key)}, ${names(spec.values)})
       VALUES (${placeholders(spec.key, 0)}, ${placeholders(spec.values, spec.key.length)})`,
      params
    );
  });
};
