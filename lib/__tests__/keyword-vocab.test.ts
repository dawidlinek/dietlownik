import { describe, expect, it } from "vitest";

import {
  ALLERGEN_WORDS,
  CATEGORY_WORDS,
  foldKeyword,
  KEYWORD_EXAMPLES,
  MACRO_WORDS,
  matchStaticVocab,
} from "@/lib/keyword-vocab";
import type { KeywordKind } from "@/lib/keyword-vocab";
import { routePreferences } from "@/lib/preference-router";

// Category routing reads the live taxonomy table.
const NO_DB =
  process.env.DATABASE_URL === undefined || process.env.DATABASE_URL === "";

describe("keyword vocab (pure)", () => {
  it("folds ł, which NFD leaves alone", () => {
    expect(foldKeyword("Łosoś")).toBe("losos");
  });

  it("matches from any word start", () => {
    expect(matchStaticVocab("bia").map((s) => s.label)).toContain(
      "dużo białka"
    );
    expect(matchStaticVocab("morz").map((s) => s.label)).toContain(
      "owoce morza"
    );
    expect(matchStaticVocab("")).toHaveLength(0);
  });
});

// The picker tags each hint with the channel it will hit. If the router's
// lexicons move, a hint would silently turn into a fuzzy ingredient match —
// this pins every tag to the real routing.
describe.skipIf(NO_DB)("keyword vocab routes as tagged", () => {
  const SOURCE: Readonly<Record<KeywordKind, string>> = {
    alergen: "allergen",
    kategoria: "category",
    makro: "macro",
    składnik: "ingredient",
  };

  const tagged: readonly (readonly [string, KeywordKind])[] = [
    ...ALLERGEN_WORDS.map((w) => [w, "alergen"] as const),
    ...MACRO_WORDS.map((w) => [w, "makro"] as const),
    ...CATEGORY_WORDS.map((w) => [w, "kategoria"] as const),
    ...KEYWORD_EXAMPLES.prefer.map((e) => [e.label, e.kind] as const),
    ...KEYWORD_EXAMPLES.avoid.map((e) => [e.label, e.kind] as const),
  ];

  it.each(tagged)(
    "%s → %s",
    async (word, kind) => {
      // One keyword in, so every non-empty intent list belongs to it.
      const routed = await routePreferences({ avoid: [], prefer: [word] });
      const sources = (
        ["allergen", "category", "macro", "ingredient"] as const
      ).filter((k) => routed[k].length > 0);
      expect(sources).toContain(SOURCE[kind]);
    },
    30_000
  );
});
