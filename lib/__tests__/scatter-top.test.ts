import { describe, expect, it } from "vitest";

import type { Offer } from "@/lib/match-types";
import { getMetric } from "@/lib/scatter-metrics";
import {
  ratioLeg,
  selectTopOffers,
  TOP_N,
  topByMetric,
} from "@/lib/scatter-top";

interface OfferOverrides {
  readonly company?: string;
  readonly price?: number;
  readonly score?: number;
  readonly protein?: number;
  readonly fat?: number;
}

const mkOffer = (id: string, o: Readonly<OfferOverrides> = {}): Offer => ({
  calories: 2000,
  company_id: (o.company ?? "c").toLowerCase(),
  company_name: o.company ?? "c",
  diet_name: "standard",
  is_menu_configuration: false,
  logo_url: null,
  offer_id: id,
  picks: [],
  price_per_day: o.price ?? 60,
  price_per_day_before_promo: null,
  promos: [],
  review_score: null,
  score_best: o.score ?? 0,
  score_default: o.score ?? 0,
  tier_name: null,
  total_carbs_g: 200,
  total_fat_g: o.fat ?? 60,
  total_fiber_g: 30,
  total_kcal: 2000,
  total_protein_g: o.protein ?? 100,
  total_sugar_g: 40,
});

const price = getMetric("price");
const score = getMetric("score");
const protein = getMetric("protein");
const fat = getMetric("fat");

describe("topByMetric", () => {
  it("ranks lower-is-better metrics ascending", () => {
    const offers = [
      mkOffer("a", { price: 80 }),
      mkOffer("b", { price: 50 }),
      mkOffer("c", { price: 65 }),
    ];
    expect(topByMetric(offers, price, 2).map((o) => o.offer_id)).toEqual([
      "b",
      "c",
    ]);
  });

  it("ranks higher-is-better metrics descending", () => {
    const offers = [
      mkOffer("a", { protein: 90 }),
      mkOffer("b", { protein: 140 }),
      mkOffer("c", { protein: 120 }),
    ];
    expect(topByMetric(offers, protein, 2).map((o) => o.offer_id)).toEqual([
      "b",
      "c",
    ]);
  });

  it("drops unreported macros from a lower-is-better ranking", () => {
    // Caterings that declare no macros report 0 g. Without the eligibility
    // guard they sweep every "least fat" slot ahead of real lean diets.
    const offers = [
      mkOffer("no-macros-1", { fat: 0 }),
      mkOffer("no-macros-2", { fat: 0 }),
      mkOffer("lean", { fat: 35 }),
      mkOffer("rich", { fat: 90 }),
    ];
    expect(topByMetric(offers, fat, 2).map((o) => o.offer_id)).toEqual([
      "lean",
      "rich",
    ]);
  });
});

describe("ratioLeg", () => {
  it("divides benefit by cost regardless of axis order", () => {
    const xFirst = ratioLeg(price, protein);
    const yFirst = ratioLeg(protein, price);
    expect(xFirst?.label).toBe("białko/cena");
    expect(yFirst?.label).toBe("białko/cena");
    const o = mkOffer("a", { price: 50, protein: 100 });
    expect(xFirst?.accessor(o)).toBe(2);
    expect(yFirst?.accessor(o)).toBe(2);
  });

  it("maps a benefit-over-price pair to its existing sort branch", () => {
    expect(ratioLeg(price, protein)?.poolSortId).toBe("protein-per-zl");
    expect(ratioLeg(price, score)?.poolSortId).toBe("score-per-zl");
  });

  it("has no sort branch when the cost axis is not price", () => {
    expect(ratioLeg(fat, protein)?.poolSortId).toBeUndefined();
  });

  it("returns null when both axes pull the same way", () => {
    expect(ratioLeg(score, protein)).toBeNull();
    expect(ratioLeg(price, fat)).toBeNull();
  });

  it("excludes offers whose cost axis has no reported value", () => {
    const leg = ratioLeg(fat, protein);
    expect(leg?.eligible(mkOffer("a", { fat: 0 }))).toBe(false);
    expect(leg?.eligible(mkOffer("b", { fat: 40 }))).toBe(true);
  });
});

describe("selectTopOffers", () => {
  const cheap = mkOffer("cheap", { price: 30, protein: 40, score: -2 });
  const rich = mkOffer("rich", { price: 200, protein: 300, score: 9 });
  const value = mkOffer("value", { price: 40, protein: 150, score: 1 });
  const filler = [
    mkOffer("f1", { price: 100, protein: 90, score: 0 }),
    mkOffer("f2", { price: 110, protein: 85, score: 0 }),
    mkOffer("f3", { price: 120, protein: 80, score: 0 }),
    mkOffer("f4", { price: 130, protein: 75, score: 0 }),
    mkOffer("f5", { price: 140, protein: 70, score: 0 }),
  ];
  const offers = [cheap, rich, value, ...filler];

  it("takes TOP_N from each of the three legs", () => {
    const { offers: picked, ratioLabel } = selectTopOffers({
      cheapestId: "cheap",
      offers,
      selectedId: "cheap",
      xMetric: price,
      yMetric: protein,
    });
    expect(ratioLabel).toBe("białko/cena");
    const ids = picked.map((o) => o.offer_id);
    // cheapest three by price, then most protein, then best protein/zł.
    expect(ids).toContain("cheap");
    expect(ids).toContain("value");
    expect(ids).toContain("rich");
    expect(ids.length).toBeLessThanOrEqual(TOP_N * 3 + 2);
  });

  it("plots each offer once when it leads on several legs", () => {
    const { offers: picked } = selectTopOffers({
      cheapestId: "cheap",
      offers,
      selectedId: "value",
      xMetric: price,
      yMetric: protein,
    });
    expect(new Set(picked.map((o) => o.offer_id)).size).toBe(picked.length);
  });

  it("keeps a catering's sibling offers out unless they earn a slot", () => {
    // Same catering owns four offers; only the two that actually lead on an
    // axis should be plotted. Selecting by company name would plot all four.
    const sameCo = [
      mkOffer("s1", { company: "Sama", price: 31, protein: 200 }),
      mkOffer("s2", { company: "Sama", price: 32, protein: 195 }),
      mkOffer("s3", { company: "Sama", price: 180, protein: 20 }),
      mkOffer("s4", { company: "Sama", price: 190, protein: 15 }),
    ];
    const { offers: picked } = selectTopOffers({
      cheapestId: "s1",
      offers: sameCo,
      selectedId: "s1",
      xMetric: price,
      yMetric: protein,
    });
    expect(picked.map((o) => o.offer_id)).not.toContain("s4");
  });

  it("pins the cheapest and selected offers even off-podium", () => {
    const { offers: picked } = selectTopOffers({
      cheapestId: "cheap",
      offers,
      selectedId: "f5",
      xMetric: score,
      yMetric: protein,
    });
    const ids = picked.map((o) => o.offer_id);
    expect(ids).toContain("cheap");
    expect(ids).toContain("f5");
  });

  it("falls back to two legs when the axes share a direction", () => {
    const { offers: picked, ratioLabel } = selectTopOffers({
      cheapestId: "cheap",
      offers,
      selectedId: "cheap",
      xMetric: score,
      yMetric: protein,
    });
    expect(ratioLabel).toBeNull();
    // top-3 score ∪ top-3 protein ∪ cheapest(=selected), never more.
    expect(picked.length).toBeLessThanOrEqual(TOP_N * 2 + 1);
  });
});
