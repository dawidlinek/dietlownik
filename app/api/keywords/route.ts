import { NextResponse } from "next/server";

import { query } from "@/lib/db";
import { foldKeyword, matchStaticVocab } from "@/lib/keyword-vocab";
import type { KeywordSuggestion } from "@/lib/keyword-vocab";

// Autocomplete for the lubię / unikam picker. Static vocabulary (allergens,
// macro phrases, categories) first, then ingredient names as caterings write
// them, most-used first.
//
// Ingredient names are grouped on their head — `name_raw` up to the first
// bracket or comma — so "Łosoś (świeży)", "łosoś (wędzony) (ryby)" and
// "Łosoś" collapse into one "łosoś" suggestion. Matching runs on the folded
// `name_normalized` column (trigram-indexed), from any word start.

export const dynamic = "force-dynamic";

const MAX_SUGGESTIONS = 8;
/** Over-fetch: a row can match on a bracketed note ("mąka pszenna (gluten)")
 *  that the head drops, and those get filtered out below. */
const DB_CANDIDATES = 24;
const MIN_DB_QUERY = 2;
const MAX_QUERY = 40;
const CACHE_MAX = 500;

const INGREDIENT_SQL = `
  SELECT head, SUM(n)::int AS n, bool_or(prefix) AS prefix
  FROM (
    SELECT lower(btrim(regexp_replace(name_raw, '\\s*[(,/:;].*$', ''))) AS head,
           COUNT(*) AS n,
           bool_or(name_normalized LIKE $1) AS prefix
    FROM meal_ingredients
    WHERE name_normalized LIKE $1 OR name_normalized LIKE $2
    GROUP BY 1
  ) t
  WHERE length(head) BETWEEN 3 AND 40
  GROUP BY head
  ORDER BY bool_or(prefix) DESC, SUM(n) DESC
  LIMIT ${DB_CANDIDATES}
`;

interface IngredientRow {
  readonly head: string;
  readonly n: number;
}

// Vocabulary changes once a day at most (scrape), so a process-lifetime
// cache is fine; insertion order doubles as a cheap LRU for eviction.
const cache = new Map<string, readonly KeywordSuggestion[]>();

const escapeLike = (s: string): string => s.replaceAll(/[\\%_]/gu, "\\$&");

const suggest = async (raw: string): Promise<readonly KeywordSuggestion[]> => {
  const q = foldKeyword(raw).slice(0, MAX_QUERY);
  const hit = cache.get(q);
  if (hit !== undefined) {
    return hit;
  }
  const out: KeywordSuggestion[] = [...matchStaticVocab(q)];
  if (q.length >= MIN_DB_QUERY) {
    const like = escapeLike(q);
    const rows = await query<IngredientRow>(INGREDIENT_SQL, [
      `${like}%`,
      `% ${like}%`,
    ]);
    const seen = new Set(out.map((s) => s.label));
    for (const r of rows) {
      const words = foldKeyword(r.head).split(" ");
      const startsWord = words.some((_, i) =>
        words.slice(i).join(" ").startsWith(q)
      );
      if (startsWord && !seen.has(r.head)) {
        seen.add(r.head);
        out.push({ kind: "składnik", label: r.head });
      }
    }
  }
  const result = out.slice(0, MAX_SUGGESTIONS);
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(q, result);
  return result;
};

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Next.js route handler signature requires Web standard Request; cannot be made deeply readonly
export const GET = async (request: Request) => {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  if (q.trim() === "") {
    return NextResponse.json({ suggestions: [] });
  }
  try {
    return NextResponse.json({ suggestions: await suggest(q) });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "query failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
};
