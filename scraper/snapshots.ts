// Drift-snapshot helper.
//
// Shared utility for the catalog scraper: after upserting a canonical entity
// row (a diet, tier, diet_option, or the discount list for a diet), call
// `captureDrift` with the entity's identity, a fingerprint hash of its
// mutable attributes, and the corresponding payload. The helper SELECTs the
// latest snapshot's `fingerprint` for that key from the snapshot table; if
// absent or different, it INSERTs a new snapshot row.
//
// Schema convention (per upstream plan lines 213–585):
// every snapshot table has a `(...keyCols, captured_at DESC)` index, an
// `id BIGSERIAL PRIMARY KEY`, a `captured_at TIMESTAMPTZ NOT NULL`, a
// `fingerprint TEXT NOT NULL`, and one or more attribute columns. The shape
// of the attribute columns varies per table:
//   - diet_snapshots / tier_snapshots / diet_option_snapshots: explicit
//     columns (name, description, ...). `payload` is a key-by-column map.
//   - diet_discount_snapshots: a single JSONB column `discounts`. Caller
//     passes `{ discounts: [...] }`; pg's driver converts arrays/objects
//     into JSONB natively when the column type is JSONB.
//
// Fingerprint convention: SHA-256 over a canonical JSON serialisation of
// the entity's mutable attrs. Keys are sorted, null/undefined collapse to
// the same empty-string form, numerics are rounded to 2 decimals. See
// `fingerprintOf` for the exact algorithm.

import { createHash } from "node:crypto";

import { q } from "./db";

export interface CaptureDriftArgs<T> {
  readonly table: string; // informational; used in error context
  readonly snapshotTable: string; // e.g. "diet_snapshots"
  readonly keyCols: readonly string[]; // e.g. ["company_id", "diet_id"]
  readonly keyValues: readonly unknown[];
  readonly newFingerprint: string;
  readonly payload: Readonly<Record<string, unknown>> &
    Readonly<{ [K in keyof T]: T[K] }>;
  /**
   * Force the insert regardless of latest-snapshot fingerprint match. Used
   * when the caller has already detected drift via a different mechanism
   * (e.g. comparing the canonical row's stored attrs to the API's), and a
   * stale snapshot would happen to share the new fingerprint by coincidence.
   */
  readonly force?: boolean;
}

export interface CaptureDriftResult {
  readonly inserted: boolean;
}

const buildKeyPredicate = (
  keyCols: readonly string[]
): { sql: string; nextParam: number } => {
  const parts: string[] = [];
  for (let i = 0; i < keyCols.length; i += 1) {
    parts.push(`${keyCols[i]} = $${i + 1}`);
  }
  return { nextParam: keyCols.length + 1, sql: parts.join(" AND ") };
};

/**
 * Append a snapshot row if and only if the fingerprint differs from the
 * latest captured one for the same key. Returns whether a new row was
 * inserted.
 */
export const captureDrift = async <T>(
  args: Readonly<CaptureDriftArgs<T>>
): Promise<CaptureDriftResult> => {
  const { snapshotTable, keyCols, keyValues, newFingerprint, payload } = args;

  if (keyCols.length !== keyValues.length) {
    throw new Error(
      `captureDrift: keyCols/keyValues length mismatch for ${args.table}`
    );
  }

  const { sql: whereSql } = buildKeyPredicate(keyCols);

  const { rows } = await q<{ fingerprint: string }>(
    `SELECT fingerprint FROM ${snapshotTable}
      WHERE ${whereSql}
      ORDER BY captured_at DESC
      LIMIT 1`,
    keyValues
  );

  const latest = rows[0]?.fingerprint ?? null;
  if (args.force !== true && latest === newFingerprint) {
    return { inserted: false };
  }

  // Build the INSERT. Columns: keyCols + fingerprint + payload keys.
  // captured_at uses the column default (NOW()).
  const payloadKeys = Object.keys(payload);
  const allCols = [...keyCols, "fingerprint", ...payloadKeys];
  const allValues = [
    ...keyValues,
    newFingerprint,
    ...payloadKeys.map((k) => payload[k]),
  ];
  const placeholders = allCols.map((_, i) => `$${i + 1}`).join(",");
  await q(
    `INSERT INTO ${snapshotTable} (${allCols.join(",")})
     VALUES (${placeholders})`,
    allValues
  );

  return { inserted: true };
};

// ── Fingerprint hashing ──────────────────────────────────────────────────────
//
// Canonical serialisation:
//   - Object keys are sorted alphabetically.
//   - null / undefined collapse to the JSON string "".
//   - Numbers are rounded to 2 decimal places (Number.parseFloat(n.toFixed(2)))
//     to avoid spurious drift from floating-point representation noise.
//   - Booleans are preserved as booleans.
//   - Strings are preserved verbatim.
//   - Arrays are serialised element-wise in input order. Callers that want
//     order-independent fingerprints (e.g. for a discount ladder where the
//     API may shuffle entries) should sort before passing in.
//
// SHA-256 returns a 64-char hex string. The full digest is preserved — the
// snapshot tables use `TEXT` so storage is fine.

const canonicalise = (value: unknown): unknown => {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return "";
    }
    return Number.parseFloat(value.toFixed(2));
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalise);
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).toSorted();
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      out[k] = canonicalise(obj[k]);
    }
    return out;
  }
  return String(value);
};

export const fingerprintOf = (
  obj: Readonly<Record<string, unknown>>
): string => {
  const canonical = canonicalise(obj);
  const payload = JSON.stringify(canonical);
  return createHash("sha256").update(payload).digest("hex");
};
