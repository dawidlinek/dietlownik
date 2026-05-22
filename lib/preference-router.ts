// Preference router — dispatches free-form preference strings to one of four
// channels (allergen, macro, category, embedding) per the plan at
// `plan-for-nown-tingly-dragonfly.md` lines 51–73. Channel ('prefer' | 'avoid')
// is metadata stamped on each result; routing logic is identical for both.
//
// IMPORTANT: a single keyword can NOT match more than one channel. The order
// below is the priority order — first match wins, anything unmatched falls
// through to embedding. Notable collisions, called out in the upstream plan:
//   - 'ryby'    → allergen (also a taxonomy category; allergen wins)
//   - 'orzechy' → allergen (also a taxonomy category; allergen wins for now)
//
// The router does NOT enforce the per-channel max-15 limit; that's the
// MCP layer's job. We just iterate.

import { query } from "./db";
import { embedKeyword } from "./embeddings";
import { stemPolish } from "./polish-stem";

export type Channel = "prefer" | "avoid";

export interface AllergenIntent {
  readonly source: "allergen";
  readonly channel: Channel;
  readonly keyword: string;
  readonly allergen: string;
}

export interface CategoryIntent {
  readonly source: "category";
  readonly channel: Channel;
  readonly keyword: string;
  readonly category: string;
  readonly patterns: readonly string[];
}

export type MacroField =
  | "protein_g"
  | "fat_g"
  | "carbs_g"
  | "fiber_g"
  | "sugar_g"
  | "salt_g"
  | "kcal";

export type MacroOp =
  | { readonly kind: "high" }
  | { readonly kind: "low" }
  | { readonly kind: "max"; readonly value: number }
  | { readonly kind: "min"; readonly value: number };

export interface MacroIntent {
  readonly source: "macro";
  readonly channel: Channel;
  readonly keyword: string;
  readonly field: MacroField;
  readonly op: MacroOp;
}

export interface IngredientIntent {
  readonly source: "ingredient";
  readonly channel: Channel;
  /** Verbatim user input — used for display in hit reasons. */
  readonly keyword: string;
  /** Diacritic-folded + suffix-stemmed; this is the form fed to the
   * trigram similarity comparison against meal_ingredients.name_normalized. */
  readonly stem: string;
}

export interface EmbeddingIntent {
  readonly source: "embedding";
  readonly channel: Channel;
  readonly keyword: string;
  readonly vector: Float32Array;
}

export interface RoutedIntents {
  readonly allergen: readonly AllergenIntent[];
  readonly category: readonly CategoryIntent[];
  readonly macro: readonly MacroIntent[];
  readonly ingredient: readonly IngredientIntent[];
  readonly embedding: readonly EmbeddingIntent[];
}

// ── Normalization ────────────────────────────────────────────────────────────
// NFKD-decompose, strip combining marks, fold Polish-specific precomposed
// letters that DO NOT decompose under NFKD (ł, ż, ę, ć, ń, ś, ź — these are
// not "letter + combining mark" in Unicode, so the \p{M} pass leaves them
// alone), then lowercase + trim. Diacritic-stripped so 'Strączkowe' /
// 'straczkowe' / 'STRĄCZKOWE' / 'białka' all collapse to the same key for
// matching purposes. The original input is preserved on the intent
// (`keyword`) and used verbatim for `embedKeyword`.
const COMBINING_MARKS_RE = /\p{M}/gu;
const POLISH_FOLD_RE = /[łŁżŻźŹćĆńŃśŚęĘąĄóÓ]/gu;
const POLISH_FOLD_TABLE: Readonly<Record<string, string>> = {
  Ó: "O",
  ó: "o",
  Ą: "A",
  ą: "a",
  Ć: "C",
  ć: "c",
  Ę: "E",
  ę: "e",
  Ł: "L",
  ł: "l",
  Ń: "N",
  ń: "n",
  Ś: "S",
  ś: "s",
  Ź: "Z",
  ź: "z",
  Ż: "Z",
  ż: "z",
};

const normalize = (s: string): string =>
  s
    .normalize("NFKD")
    .replace(COMBINING_MARKS_RE, "")
    .replace(POLISH_FOLD_RE, (m) => POLISH_FOLD_TABLE[m] ?? m)
    .toLowerCase()
    .trim();

// ── 1. Allergen lexicon ──────────────────────────────────────────────────────
// Keys are normalized (ASCII-folded lowercase); values are the Polish allergen
// name stored verbatim on `meals.allergens` (which is TEXT[] of Polish-native
// strings — see db/schema.sql line 254). Multiple keys can map to the same
// allergen output (e.g. 'mleko' / 'nabial' both → 'mleko').
const ALLERGEN_LEXICON: Readonly<Record<string, string>> = {
  gluten: "gluten",
  gorczyca: "gorczyca",
  jaja: "jaja",
  lupin: "łubin",
  miekczaki: "mięczaki",
  mleko: "mleko",
  nabial: "mleko",
  orzechy: "orzechy",
  orzechy_arachidowe: "orzeszki ziemne",
  ryby: "ryby",
  seler: "seler",
  sezam: "sezam",
  siarczyny: "siarczyny",
  skorupiaki: "skorupiaki",
  soja: "soja",
};

// ── 2. Macro grammar ─────────────────────────────────────────────────────────
// Macro word → field. Includes both diacritic and ASCII-folded forms so we
// can match against the normalized token directly (no second normalization
// inside the lexicon).
// eslint sort-keys is enforced repo-wide; keys are alphabetical, comments
// annotate the macro field each cluster belongs to.
const MACRO_FIELD_LEXICON: Readonly<Record<string, MacroField>> = {
  bialka: "protein_g",
  bialko: "protein_g",
  blonnika: "fiber_g",
  carbs: "carbs_g",
  cukru: "sugar_g",
  fat: "fat_g",
  fiber: "fiber_g",
  kalorie: "kcal",
  kalorii: "kcal",
  kcal: "kcal",
  protein: "protein_g",
  salt: "salt_g",
  soli: "salt_g",
  sugar: "sugar_g",
  tluszcz: "fat_g",
  tluszczu: "fat_g",
  wegli: "carbs_g",
  weglowodanow: "carbs_g",
};

const HIGH_QUALIFIERS: ReadonlySet<string> = new Set([
  "duzo",
  "wysokie",
  "wiele",
]);
const LOW_QUALIFIERS: ReadonlySet<string> = new Set([
  "malo",
  "niskie",
  "brak",
  "low",
  "no",
  "bez",
]);
const MAX_QUALIFIERS: ReadonlySet<string> = new Set(["pod", "ponizej", "max"]);
const MIN_QUALIFIERS: ReadonlySet<string> = new Set(["nad", "powyzej", "min"]);

const tryMatchAllergen = (
  norm: string,
  keyword: string,
  channel: Channel
): AllergenIntent | null => {
  const hit = ALLERGEN_LEXICON[norm];
  if (hit === undefined) {
    return null;
  }
  return { allergen: hit, channel, keyword, source: "allergen" };
};

interface NumericToken {
  readonly index: number;
  readonly value: number;
}

const findNumericToken = (tokens: readonly string[]): NumericToken | null => {
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (/^\d+$/u.test(t)) {
      return { index: i, value: Number.parseInt(t, 10) };
    }
  }
  return null;
};

const findMacroFieldToken = (
  tokens: readonly string[]
): { readonly index: number; readonly field: MacroField } | null => {
  for (let i = 0; i < tokens.length; i += 1) {
    const f = MACRO_FIELD_LEXICON[tokens[i]];
    if (f !== undefined) {
      return { field: f, index: i };
    }
  }
  return null;
};

const findQualifier = (
  tokens: readonly string[]
): { readonly kind: "high" | "low" | "max" | "min" } | null => {
  for (const t of tokens) {
    if (HIGH_QUALIFIERS.has(t)) {
      return { kind: "high" };
    }
    if (LOW_QUALIFIERS.has(t)) {
      return { kind: "low" };
    }
    if (MAX_QUALIFIERS.has(t)) {
      return { kind: "max" };
    }
    if (MIN_QUALIFIERS.has(t)) {
      return { kind: "min" };
    }
  }
  return null;
};

const tryMatchMacro = (
  norm: string,
  keyword: string,
  channel: Channel
): MacroIntent | null => {
  // Single-word synonyms: 'wysokokaloryczne' / 'niskokaloryczne'.
  if (norm === "wysokokaloryczne") {
    return {
      channel,
      field: "kcal",
      keyword,
      op: { kind: "high" },
      source: "macro",
    };
  }
  if (norm === "niskokaloryczne") {
    return {
      channel,
      field: "kcal",
      keyword,
      op: { kind: "low" },
      source: "macro",
    };
  }

  // Tokenize on whitespace. Punctuation is NOT a separator (per spec). All
  // tokens are already normalized because `norm` was normalized.
  const tokens = norm.split(/\s+/u).filter((t) => t.length > 0);
  if (tokens.length < 2) {
    return null;
  }

  const fieldHit = findMacroFieldToken(tokens);
  if (fieldHit === null) {
    return null;
  }
  const qualifier = findQualifier(tokens);
  if (qualifier === null) {
    return null;
  }

  if (qualifier.kind === "high" || qualifier.kind === "low") {
    return {
      channel,
      field: fieldHit.field,
      keyword,
      op: { kind: qualifier.kind },
      source: "macro",
    };
  }

  // max/min only valid for kcal AND require a numeric token.
  if (fieldHit.field !== "kcal") {
    return null;
  }
  const num = findNumericToken(tokens);
  if (num === null) {
    return null;
  }
  return {
    channel,
    field: "kcal",
    keyword,
    op: { kind: qualifier.kind, value: num.value },
    source: "macro",
  };
};

// ── 3. Category lookup ───────────────────────────────────────────────────────
// Cache the taxonomy in-memory for the lifetime of the process. The router
// is hit once per request — keeping a cached normalized → (category, patterns)
// map saves an n-query roundtrip per call.
interface TaxonomyRow {
  category: string;
  ingredient_pattern: string | null;
}

interface CachedTaxonomy {
  // normalized PK → raw category PK
  readonly byNorm: ReadonlyMap<string, string>;
  // raw category PK → patterns
  readonly patterns: ReadonlyMap<string, readonly string[]>;
}

let taxonomyCache: Promise<CachedTaxonomy> | null = null;

const loadTaxonomy = async (): Promise<CachedTaxonomy> => {
  const rows = await query<TaxonomyRow>(
    `SELECT t.category, m.ingredient_pattern
       FROM ingredient_taxonomy t
       LEFT JOIN ingredient_taxonomy_members m USING (category)`,
    []
  );
  const byNorm = new Map<string, string>();
  const patterns = new Map<string, string[]>();
  for (const row of rows) {
    const key = normalize(row.category);
    byNorm.set(key, row.category);
    let list = patterns.get(row.category);
    if (list === undefined) {
      list = [];
      patterns.set(row.category, list);
    }
    if (row.ingredient_pattern !== null) {
      list.push(row.ingredient_pattern);
    }
  }
  return { byNorm, patterns };
};

const getTaxonomy = async (): Promise<CachedTaxonomy> => {
  if (taxonomyCache !== null) {
    try {
      return await taxonomyCache;
    } catch {
      // Cached promise rejected — reset and re-fetch below.
      taxonomyCache = null;
    }
  }
  const fresh = loadTaxonomy();
  taxonomyCache = fresh;
  try {
    return await fresh;
  } catch (error) {
    // Reset on failure so the NEXT call retries cleanly.
    taxonomyCache = null;
    throw error;
  }
};

// Exposed for tests / hot-reload — drop the in-memory taxonomy cache so the
// next `routePreferences` call re-queries Postgres.
export const resetTaxonomyCache = (): void => {
  taxonomyCache = null;
};

const tryMatchCategory = async (
  norm: string,
  keyword: string,
  channel: Channel
): Promise<CategoryIntent | null> => {
  const tax = await getTaxonomy();
  const rawCategory = tax.byNorm.get(norm);
  if (rawCategory === undefined) {
    return null;
  }
  const patterns = tax.patterns.get(rawCategory) ?? [];
  return {
    category: rawCategory,
    channel,
    keyword,
    patterns,
    source: "category",
  };
};

// ── Dispatcher ───────────────────────────────────────────────────────────────
interface Routed {
  readonly allergen: AllergenIntent | null;
  readonly category: CategoryIntent | null;
  readonly macro: MacroIntent | null;
  readonly ingredient: IngredientIntent | null;
  readonly embedding: EmbeddingIntent | null;
}

const empty = (): Routed => ({
  allergen: null,
  category: null,
  embedding: null,
  ingredient: null,
  macro: null,
});

const routeOne = async (
  raw: string,
  channel: Channel
): Promise<Routed | null> => {
  // Drop empty / whitespace-only silently.
  const keyword = raw;
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const norm = normalize(raw);

  // 1. Allergen wins (including the documented 'ryby' / 'orzechy' collisions).
  const allergen = tryMatchAllergen(norm, keyword, channel);
  if (allergen !== null) {
    return { ...empty(), allergen };
  }

  // 2. Macro grammar.
  const macro = tryMatchMacro(norm, keyword, channel);
  if (macro !== null) {
    return { ...empty(), macro };
  }

  // 3. Taxonomy category PK lookup.
  const category = await tryMatchCategory(norm, keyword, channel);
  if (category !== null) {
    return { ...empty(), category };
  }

  // 4. Fall-through: emit BOTH an ingredient (lexical) AND embedding (semantic)
  //    intent. They cover different cases — 'pomidor' wants the ingredient
  //    trigram match, 'ostre' / 'shake' want the embedding semantic match —
  //    but it's cheap to ask both and let the SQL produce whichever fires.
  const stem = stemPolish(norm);
  const vector = await embedKeyword(raw);
  return {
    ...empty(),
    embedding: { channel, keyword, source: "embedding", vector },
    ingredient: { channel, keyword, source: "ingredient", stem },
  };
};

export const routePreferences = async (
  args: Readonly<{
    prefer: readonly string[];
    avoid: readonly string[];
  }>
): Promise<RoutedIntents> => {
  const allergen: AllergenIntent[] = [];
  const category: CategoryIntent[] = [];
  const macro: MacroIntent[] = [];
  const ingredient: IngredientIntent[] = [];
  const embedding: EmbeddingIntent[] = [];

  const inputs: readonly (readonly [string, Channel])[] = [
    ...args.prefer.map((s) => [s, "prefer"] as const),
    ...args.avoid.map((s) => [s, "avoid"] as const),
  ];

  // Sequential to keep DB / embedding load bounded; per-keyword latency is
  // dominated by embedKeyword's cache check anyway.
  for (const [raw, channel] of inputs) {
    const routed = await routeOne(raw, channel);
    if (routed === null) {
      continue;
    }
    if (routed.allergen !== null) {
      allergen.push(routed.allergen);
    }
    if (routed.category !== null) {
      category.push(routed.category);
    }
    if (routed.macro !== null) {
      macro.push(routed.macro);
    }
    if (routed.ingredient !== null) {
      ingredient.push(routed.ingredient);
    }
    if (routed.embedding !== null) {
      embedding.push(routed.embedding);
    }
  }

  return { allergen, category, embedding, ingredient, macro };
};
