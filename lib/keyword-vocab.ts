// Keyword vocabulary for the lubię / unikam picker: worked examples when the
// search box is empty, and the static half of autocomplete. Every entry here
// routes to the channel it is tagged with in `lib/preference-router.ts` —
// `lib/__tests__/keyword-vocab.test.ts` checks that against the real router,
// so a lexicon change there can't silently turn an "alergen" hint into a
// fuzzy ingredient match.
//
// Client-safe: no DB, no embeddings.

export type KeywordKind = "alergen" | "makro" | "kategoria" | "składnik";

export interface KeywordSuggestion {
  readonly label: string;
  readonly kind: KeywordKind;
}

/** Lowercase, strip diacritics incl. ł (which NFD leaves alone). */
export const foldKeyword = (s: string): string =>
  s
    .toLocaleLowerCase("pl-PL")
    .replaceAll("ł", "l")
    .normalize("NFD")
    .replaceAll(/\p{M}/gu, "")
    .trim();

/** Allergen-lexicon keys as people type them. Any of them also works after
 *  "bez" in the genitive ("bez glutenu", "bez jaj"), on the opposite list. */
export const ALLERGEN_WORDS: readonly string[] = [
  "gluten",
  "mleko",
  "nabiał",
  "jaja",
  "orzechy",
  "orzeszki ziemne",
  "ryby",
  "soja",
  "seler",
  "sezam",
  "gorczyca",
  "skorupiaki",
  "mięczaki",
  "łubin",
  "siarczyny",
];

export const MACRO_WORDS: readonly string[] = [
  "dużo białka",
  "dużo błonnika",
  "mało cukru",
  "mało tłuszczu",
  "mało węglowodanów",
  "mało soli",
  "niskokaloryczne",
  "wysokokaloryczne",
];

/** Taxonomy categories that reach the category channel. `ryby`, `nabiał`
 *  and `orzechy` are categories too, but the allergen lexicon claims them
 *  first — they are listed as allergens above. */
export const CATEGORY_WORDS: readonly string[] = [
  "psiankowate",
  "strączkowe",
  "owoce morza",
];

const STATIC_VOCAB: readonly KeywordSuggestion[] = [
  ...MACRO_WORDS.map((label) => ({ kind: "makro" as const, label })),
  ...ALLERGEN_WORDS.map((label) => ({ kind: "alergen" as const, label })),
  ...CATEGORY_WORDS.map((label) => ({ kind: "kategoria" as const, label })),
];

/** One of each kind, phrased the way each list is usually used. */
export const KEYWORD_EXAMPLES: Readonly<
  Record<"prefer" | "avoid", readonly KeywordSuggestion[]>
> = {
  avoid: [
    { kind: "alergen", label: "gluten" },
    { kind: "alergen", label: "nabiał" },
    { kind: "kategoria", label: "psiankowate" },
    { kind: "makro", label: "dużo cukru" },
    { kind: "składnik", label: "grzyby" },
  ],
  prefer: [
    { kind: "makro", label: "dużo białka" },
    { kind: "makro", label: "mało cukru" },
    { kind: "alergen", label: "ryby" },
    { kind: "składnik", label: "kurczak" },
    { kind: "składnik", label: "łosoś" },
  ],
};

/** Static vocabulary entries whose words start with the query. */
export const matchStaticVocab = (
  query: string
): readonly KeywordSuggestion[] => {
  const q = foldKeyword(query);
  if (q === "") {
    return [];
  }
  // Match from any word start: "bia" finds "dużo białka".
  return STATIC_VOCAB.filter((s) => {
    const words = foldKeyword(s.label).split(" ");
    return words.some((_, i) => words.slice(i).join(" ").startsWith(q));
  });
};
