// Light suffix-stripping stemmer for Polish food terms. Intentionally
// conservative — combined with pg_trgm fuzzy matching on the column side,
// even a small amount of suffix folding raises recall meaningfully
// (e.g. 'pomidorowy' → 'pomidor', 'ostrego' → 'ostr', 'kurczaka' → 'kurczak').
//
// This is NOT a real morphological analyser. It does not handle infixes,
// vowel-mutation stems (e.g. 'kotek' → 'kot'), or non-Polish loanwords
// gracefully. The MIN_STEM guard prevents the most absurd over-stripping;
// trigram similarity on the query side picks up the rest.
//
// Input is expected to already be normalized (lowercase + diacritic-folded
// via `normalize()` in preference-router.ts). Stemming on raw Polish with
// diacritics still in place would miss the folded suffixes here.

const MIN_STEM = 3;

// Suffix list, applied longest-first. Order within the same length doesn't
// matter — only the first match (post-sort) is stripped.
const SUFFIXES: readonly string[] = [
  // 4-char adjectival
  "iego",
  "iemu",
  // 3-char adjectival / plural
  "ami",
  "ach",
  "ego",
  "emu",
  "iej",
  "ich",
  "ych",
  "imi",
  "ymi",
  "owy",
  "owa",
  "owe",
  "owi",
  // 2-char case markers
  "ej",
  "om",
  "em",
  "ie",
  "ow",
  "ie",
  "ym",
  "im",
  // 1-char (vowel case markers); guarded by MIN_STEM
  "a",
  "e",
  "i",
  "o",
  "u",
  "y",
];

// Pre-sort once at module load — longest suffix wins.
const SORTED_SUFFIXES: readonly string[] = [...SUFFIXES].toSorted(
  (a, b) => b.length - a.length
);

export const stemPolish = (s: string): string => {
  if (s.length <= MIN_STEM) {
    return s;
  }
  for (const suf of SORTED_SUFFIXES) {
    if (s.endsWith(suf) && s.length - suf.length >= MIN_STEM) {
      return s.slice(0, -suf.length);
    }
  }
  return s;
};
