/**
 * bench-integrity: one-shot data-integrity sweep over the scraped corpus.
 *
 * Runs a suite of read-only SQL checks and prints WARN / OK per check. Used
 * before the bench (and any major release) to confirm we're not benchmarking
 * against a corrupt or partial corpus.
 *
 *   npm run bench:integrity
 *
 * Exit code 0 on all OK, 1 if any WARN — pipe-friendly in CI.
 */

import "dotenv/config";
import { query } from "../../lib/db.js";
import { PASSAGE_VERSION } from "../meal-passage.js";

interface Finding {
  severity: "OK" | "WARN" | "INFO";
  label: string;
  detail: string;
}

const fmt = (n: number | string): string => {
  const v = typeof n === "string" ? Number.parseFloat(n) : n;
  return Number.isFinite(v) ? v.toLocaleString() : String(n);
};

const pctOf = (x: number, of: number): string =>
  `${((x / of) * 100).toFixed(1)}%`;

const checks: (() => Promise<Finding>)[] = [
  // ── Core counts ────────────────────────────────────────────────────────────
  async () => {
    const rows = await query<{ t: string; n: string }>(
      `SELECT 'companies' AS t, COUNT(*)::text AS n FROM companies
       UNION ALL SELECT 'meals',             COUNT(*)::text FROM meals
       UNION ALL SELECT 'meal_variants',     COUNT(*)::text FROM meal_variants
       UNION ALL SELECT 'menu_items',        COUNT(*)::text FROM menu_items
       UNION ALL SELECT 'variant_embeddings',COUNT(*)::text FROM variant_embeddings
       UNION ALL SELECT 'meal_ingredients',  COUNT(*)::text FROM meal_ingredients
       UNION ALL SELECT 'price_history',     COUNT(*)::text FROM price_history
       UNION ALL SELECT 'diets',           COUNT(*)::text FROM diets
       UNION ALL SELECT 'tiers',           COUNT(*)::text FROM tiers
       UNION ALL SELECT 'diet_calories',   COUNT(*)::text FROM diet_calories`
    );
    const detail = rows
      .map((r: Readonly<{ t: string; n: string }>) => `${r.t}=${fmt(r.n)}`)
      .join("  ");
    return { detail, label: "core counts", severity: "INFO" };
  },

  // ── NULL rates: dish content (latest variant) + portion macros ────────────
  // Content is per dish (its latest variant; a dish with no variant counts as
  // NULL). Macros are per portion now, so their rate is over open menu items.
  async () => {
    const [r] = await query<{
      total: string;
      null_ingredients: string;
      null_allergens: string;
      items: string;
      null_kcal: string;
      null_macros: string;
    }>(
      `WITH content AS (
         SELECT
           COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE lv.ingredients_raw IS NULL OR lv.ingredients_raw = '')::text AS null_ingredients,
           COUNT(*) FILTER (WHERE lv.allergens IS NULL OR cardinality(lv.allergens) = 0)::text AS null_allergens
         FROM meals m
         LEFT JOIN meal_latest_variant lv ON lv.meal_id = m.id
       ), portions AS (
         SELECT
           COUNT(*)::text AS items,
           COUNT(*) FILTER (WHERE kcal IS NULL)::text AS null_kcal,
           COUNT(*) FILTER (WHERE protein_g IS NULL OR fat_g IS NULL OR carbs_g IS NULL)::text AS null_macros
         FROM current_menu_items
       )
       SELECT * FROM content, portions`
    );
    const total = Number.parseInt(r.total, 10);
    const items = Number.parseInt(r.items, 10);
    const ni = Number.parseInt(r.null_ingredients, 10);
    const na = Number.parseInt(r.null_allergens, 10);
    const nk = Number.parseInt(r.null_kcal, 10);
    const nm = Number.parseInt(r.null_macros, 10);
    // Warn if ingredients > 5% null, allergens > 30% null, macros > 5% null
    let sev: Finding["severity"] = "OK";
    if (ni / total > 0.05 || nm / items > 0.05 || na / total > 0.3) {
      sev = "WARN";
    }
    return {
      detail: `ingredients_NULL=${pctOf(ni, total)}  allergens_NULL=${pctOf(na, total)}  (of ${fmt(total)} meals)  kcal_NULL=${pctOf(nk, items)}  macros_NULL=${pctOf(nm, items)}  (of ${fmt(items)} open menu items)`,
      label: "meal column NULL rates",
      severity: sev,
    };
  },

  // ── Allergen casing inconsistency ──────────────────────────────────────────
  async () => {
    const rows = await query<{ canonical: string; variants: string }>(
      `SELECT lower(a) AS canonical, COUNT(DISTINCT a)::text AS variants
         FROM meal_variants, UNNEST(allergens) a
         GROUP BY lower(a)
         HAVING COUNT(DISTINCT a) > 1
         ORDER BY COUNT(DISTINCT a) DESC
         LIMIT 5`
    );
    if (rows.length === 0) {
      return {
        detail: "allergens vocabulary canonical (no case splits)",
        label: "allergen casing",
        severity: "OK",
      };
    }
    const top = rows
      .map(
        (r: Readonly<{ canonical: string; variants: string }>) =>
          `${r.canonical} (${r.variants} variants)`
      )
      .join(", ");
    return {
      detail: `${rows.length}+ allergens have casing variants — top: ${top}`,
      label: "allergen casing",
      severity: "WARN",
    };
  },

  // ── Slot-name canonical hygiene ────────────────────────────────────────────
  async () => {
    const rows = await query<{ canonical: string; variants: string }>(
      `SELECT lower(slot_name) AS canonical, COUNT(DISTINCT slot_name)::text AS variants
         FROM menu_items
         GROUP BY lower(slot_name)
         HAVING COUNT(DISTINCT slot_name) > 1
         ORDER BY COUNT(DISTINCT slot_name) DESC
         LIMIT 5`
    );
    if (rows.length === 0) {
      return {
        detail: "slot_name canonical",
        label: "slot name casing",
        severity: "OK",
      };
    }
    const top = rows
      .map(
        (r: Readonly<{ canonical: string; variants: string }>) =>
          `${r.canonical} (${r.variants})`
      )
      .join(", ");
    return {
      detail: `${rows.length}+ slots have casing variants — top: ${top}`,
      label: "slot name casing",
      severity: "WARN",
    };
  },

  // ── Orphans / missing references ───────────────────────────────────────────
  async () => {
    const [r] = await query<{
      empty_companies: string;
      no_menus_with_diets: string;
      menu_no_variant: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM companies c WHERE NOT EXISTS (SELECT 1 FROM meals m WHERE m.company_id = c.company_id))::text AS empty_companies,
         (SELECT COUNT(*) FROM companies c
            WHERE EXISTS (SELECT 1 FROM diets d WHERE d.company_id = c.company_id)
              AND NOT EXISTS (SELECT 1 FROM menu_items mi WHERE mi.company_id = c.company_id))::text AS no_menus_with_diets,
         (SELECT COUNT(*) FROM current_menu_items WHERE variant_id IS NULL)::text AS menu_no_variant`
    );
    const e = Number.parseInt(r.empty_companies, 10);
    const n = Number.parseInt(r.no_menus_with_diets, 10);
    // menu_items.meal_id is NOT NULL; variant_id is the nullable reference
    // (ON DELETE SET NULL — clean-hidden-bodies removes hidden variants).
    const m = Number.parseInt(r.menu_no_variant, 10);
    const sev = e > 0 || n > 0 ? "WARN" : "OK";
    return {
      detail: `companies-no-meals=${e}  diets-without-menus=${n}  open-menu-slots-without-variant=${m}`,
      label: "orphans / missing references",
      severity: sev,
    };
  },

  // ── Embedding staleness ────────────────────────────────────────────────────
  // One vector per variant; stale = built by an older buildPassage().
  async () => {
    const [r] = await query<{
      total: string;
      embedded: string;
      stale: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM meal_variants)::text AS total,
         (SELECT COUNT(*) FROM variant_embeddings)::text AS embedded,
         (SELECT COUNT(*) FROM variant_embeddings
           WHERE passage_version < $1)::text AS stale`,
      [PASSAGE_VERSION]
    );
    const total = Number.parseInt(r.total, 10);
    const embedded = Number.parseInt(r.embedded, 10);
    const stale = Number.parseInt(r.stale, 10);
    const pct = ((embedded / total) * 100).toFixed(1);
    let sev: Finding["severity"] = "OK";
    if (embedded / total < 0.9) {
      sev = "WARN";
    } else if (stale > 0) {
      sev = "INFO";
    }
    return {
      detail: `${fmt(embedded)}/${fmt(total)} (${pct}%) embedded, ${fmt(stale)} stale (rerun npm run embed)`,
      label: "embedding coverage",
      severity: sev,
    };
  },

  // ── Wrocław slice coverage for the bench's busiest day ─────────────────────
  async () => {
    const [r] = await query<{
      menu_date: string;
      meals: string;
      companies: string;
    }>(
      `SELECT menu_date::text, COUNT(DISTINCT meal_id)::text AS meals, COUNT(DISTINCT company_id)::text AS companies
         FROM menu_items
        WHERE city_id = 986283
        GROUP BY menu_date
        ORDER BY COUNT(DISTINCT meal_id) DESC, menu_date DESC
        LIMIT 1`
    );
    if (r === undefined) {
      return {
        detail: "no Wrocław menu data at all",
        label: "bench slice (Wrocław busiest day)",
        severity: "WARN",
      };
    }
    const m = Number.parseInt(r.meals, 10);
    const c = Number.parseInt(r.companies, 10);
    const sev = m < 500 || c < 30 ? "WARN" : "OK";
    return {
      detail: `${r.menu_date}: ${fmt(m)} distinct meals × ${fmt(c)} companies`,
      label: "bench slice (Wrocław busiest day)",
      severity: sev,
    };
  },

  // ── Macro outliers (sanity bounds) ─────────────────────────────────────────
  // Macros are per portion on menu_items; count distinct dishes (not option
  // rows, which repeat per city/date/diet) across what is on offer now.
  async () => {
    const [r] = await query<{
      huge_kcal: string;
      negative_macros: string;
      tiny_kcal: string;
    }>(
      `SELECT
         (SELECT COUNT(DISTINCT meal_id) FROM current_menu_items WHERE kcal > 5000)::text AS huge_kcal,
         (SELECT COUNT(DISTINCT meal_id) FROM current_menu_items WHERE protein_g < 0 OR fat_g < 0 OR carbs_g < 0 OR kcal < 0)::text AS negative_macros,
         (SELECT COUNT(DISTINCT meal_id) FROM current_menu_items WHERE kcal IS NOT NULL AND kcal < 10 AND kcal > 0)::text AS tiny_kcal`
    );
    const huge = Number.parseInt(r.huge_kcal, 10);
    const neg = Number.parseInt(r.negative_macros, 10);
    const tiny = Number.parseInt(r.tiny_kcal, 10);
    const sev = neg > 0 || huge > 5 ? "WARN" : "OK";
    return {
      detail: `kcal>5000=${huge}  negative_macros=${neg}  0<kcal<10=${tiny}`,
      label: "macro outliers",
      severity: sev,
    };
  },

  // ── Content duplicates (informational — same recipe at multiple caterers) ──
  // The old meals.fingerprint hashed name + content + macros. Macros are per
  // portion now, so a duplicate is the same name with the same latest-variant
  // content_sha under another company.
  async () => {
    const [r] = await query<{ dup: string; pct: string }>(
      `WITH latest AS (
         SELECT m.name, v.content_sha
           FROM meals m
           JOIN meal_latest_variant lv ON lv.meal_id = m.id
           JOIN meal_variants v ON v.id = lv.variant_id
       )
       SELECT (COUNT(*) - COUNT(DISTINCT (name, content_sha)))::text AS dup,
              ROUND(100.0 * (COUNT(*) - COUNT(DISTINCT (name, content_sha))) / NULLIF(COUNT(*),0), 1)::text AS pct
         FROM latest`
    );
    const d = Number.parseInt(r.dup, 10);
    const p = Number.parseFloat(r.pct);
    return {
      detail: `${fmt(d)} meals share name + content with another (${p.toFixed(1)}%) — likely same recipe across companies`,
      label: "content duplicates",
      severity: "INFO",
    };
  },
];

const pad = (s: string, n: number): string =>
  s.length >= n ? s : s + " ".repeat(n - s.length);

const main = async (): Promise<void> => {
  const findings: Finding[] = [];
  for (const c of checks) {
    try {
      findings.push(await c());
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      findings.push({
        detail: msg,
        label: "internal check error",
        severity: "WARN",
      });
    }
  }

  const colour: Record<Finding["severity"], string> = {
    INFO: "·",
    OK: "✓",
    WARN: "⚠",
  };
  for (const f of findings) {
    console.log(`  ${colour[f.severity]}  ${pad(f.label, 32)}  ${f.detail}`);
  }
  const warnCount = findings.filter(
    (f: Readonly<Finding>) => f.severity === "WARN"
  ).length;
  console.log();
  const summary =
    warnCount === 0
      ? "✓ all clear"
      : `⚠ ${warnCount} warning(s) — review above before benching`;
  console.log(summary);
  process.exit(warnCount === 0 ? 0 : 1);
};

try {
  await main();
} catch (error) {
  console.error("bench-integrity failed:", error);
  process.exit(2);
}
