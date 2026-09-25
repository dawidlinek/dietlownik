/**
 * Round-trip real tools through `callTool` against a live database.
 *
 * The history below predates the tool redesign (rank_day / plan_week became
 * `plan`); the lesson stands for every tool.
 *
 * Why this file exists: two schema bugs shipped and survived for months
 * because nothing ever validated a real tool's OUTPUT.
 *
 *   1. `rank_day` / `plan_week` declared
 *      `source: z.enum(["allergen","category","macro","embedding"])`, but
 *      `lib/queries.ts` also emits `"ingredient"` (the lexical channel).
 *      Any keyword hitting the fall-through — `kurczak`, `pomidor`, most
 *      real queries — produced "Tool returned invalid output".
 *   2. `find_diets` declared `promo.deadline: z.string()`, but
 *      `campaigns.ends_at` is a Postgres `date`, so `pg` hands back a JS
 *      `Date`. Every offer carrying a promo failed validation.
 *
 * Neither was reachable from the existing suite:
 *   - `find-diets.test.ts` snapshots the wire contract and deliberately
 *     never executes the tool.
 *   - `rank-day.test.ts` / `plan-week.test.ts` call `tool.execute(...)`
 *     directly, bypassing `callTool` — the only place `outputSchema` runs.
 *     `rank-day.test.ts` even passes `prefer: ["kurczak"]`, the exact
 *     trigger, and still could not fail.
 *   - `tool.test.ts` exercises `callTool` with synthetic toy tools only.
 *
 * So: drive the real registry through the real dispatcher and assert the
 * result is not an error. Any future schema/runtime drift fails here.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const HEAVY_SKIP =
  process.env.SKIP_HEAVY_TESTS === "1" ||
  process.env.DATABASE_URL === undefined ||
  process.env.DATABASE_URL === "";

const WROCLAW_ID = 986_283;

/** `callTool` signals failure in-band via `isError`, not by throwing. */
const expectOk = (
  result: Readonly<{ isError?: boolean; content?: readonly unknown[] }>,
  label: string
): void => {
  const text =
    result.content === undefined
      ? ""
      : // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- MCP text content
        ((result.content[0] as { text?: string } | undefined)?.text ?? "");
  expect(
    result.isError === true ? `${label} failed: ${text}` : null
  ).toBeNull();
};

/** Parsed JSON payload of a successful call. */
const payloadOf = (
  result: Readonly<{ content?: readonly unknown[] }>
): unknown => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- MCP text content
  const text = (result.content?.[0] as { text?: string } | undefined)?.text;
  return JSON.parse(text ?? "null");
};

describe.skipIf(HEAVY_SKIP)("real tools round-trip through callTool", () => {
  vi.setConfig({ testTimeout: 300_000 });

  const buildCtx = async () => {
    const { DietlyClient } = await import("../client");
    const { q } = await import("@/scraper/db");
    const client = new DietlyClient();
    // Seed the city memo so resolution never touches the network.
    interface WithMemo {
      readonly memo: Map<string, { id: number; name: string }>;
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only access to the private memo, mirrors rank-day.test.ts
    const { memo } = client.cities as unknown as WithMemo;
    memo.set("wrocław", { id: WROCLAW_ID, name: "Wrocław" });
    return { client, q };
  };

  const populatedDate = async (
    q: Awaited<ReturnType<typeof buildCtx>>["q"]
  ): Promise<string | null> => {
    const { rows } = await q<{ menu_date: string }>(
      `SELECT to_char(menu_date, 'YYYY-MM-DD') AS menu_date
       FROM menu_items
       WHERE closed_at IS NULL
         AND company_id IN (SELECT company_id FROM company_cities
                             WHERE city_id = $1 AND is_active)
       GROUP BY menu_date ORDER BY count(*) DESC LIMIT 1`,
      [WROCLAW_ID]
    );
    return rows[0]?.menu_date ?? null;
  };

  it("get_context validates", async () => {
    const { callTool } = await import("../tool");
    const { get_context } = await import("../tools/get-context");
    const { client } = await buildCtx();
    const result = await callTool(get_context, {}, { client });
    expectOk(result, "get_context");
  });

  it("find_diets validates, and prices each offer with its own catering's code", async () => {
    const { callTool } = await import("../tool");
    const { find_diets } = await import("../tools/find-diets");
    const { client, q } = await buildCtx();
    const result = await callTool(
      find_diets,
      { city: "Wrocław", limit: 50, max_price_per_day: 200 },
      { client }
    );
    expectOk(result, "find_diets");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape validated by outputSchema above
    const { offers } = payloadOf(result) as {
      offers: {
        catering: { id: string };
        price: { per_day: number; promo: { code: string } | null };
      }[];
    };
    expect(offers.length).toBeGreaterThan(0);
    // The old promo lateral wasn't scoped to the company: every offer of
    // every catering carried the same campaign (slimway's FORMA20).
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- test-local payload, read only
    for (const o of offers.filter((x) => x.price.promo !== null)) {
      const { rows } = await q(
        `SELECT 1 FROM price_history
          WHERE company_id = $1 AND $2 = ANY(promo_codes) LIMIT 1`,
        [o.catering.id, o.price.promo?.code]
      );
      expect(rows.length).toBe(1);
    }
  });

  it("plan validates ingredient-channel hits and returns selections", async () => {
    const { callTool } = await import("../tool");
    const { plan } = await import("../tools/plan");
    const { client, q } = await buildCtx();
    const date = await populatedDate(q);
    if (date === null) {
      expect(true).toBe(true);
      return;
    }
    // `kurczak` falls through to the lexical ingredient channel — the case
    // that once failed outputSchema validation.
    const result = await callTool(
      plan,
      { alternatives: 2, dates: [date], detail: "full", prefer: ["kurczak"] },
      { client }
    );
    expectOk(result, "plan(kurczak)");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape validated by outputSchema above
    const out = payloadOf(result) as {
      days: { pick: { tier: string | null } | null }[];
      selections: { offer_id: string }[];
    };
    const pickedDays = out.days.filter(
      (d: Readonly<{ pick: unknown }>) => d.pick !== null
    ).length;
    expect(out.selections.length).toBe(pickedDays);
    // "dla dwojga" packages are off by default.
    for (const d of out.days) {
      expect(d.pick?.tier ?? "").not.toMatch(/dwoj|\bdu(?:o|et|ecie)\b/iu);
    }
  });

  it("plan moves 'bez glutenu' onto the avoid list", async () => {
    const { callTool } = await import("../tool");
    const { plan } = await import("../tools/plan");
    const { client, q } = await buildCtx();
    const date = await populatedDate(q);
    if (date === null) {
      expect(true).toBe(true);
      return;
    }
    const result = await callTool(
      plan,
      { alternatives: 0, dates: [date], prefer: ["bez glutenu"] },
      { client }
    );
    expectOk(result, "plan(bez glutenu)");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape validated by outputSchema above
    const out = payloadOf(result) as {
      keywords: { note: string | null; understood_as: string }[];
    };
    expect(out.keywords[0].understood_as).toBe("allergen: gluten");
    expect(out.keywords[0].note).toMatch(/avoid/u);
  });

  it("get_offer validates and lists swappable dishes", async () => {
    const { callTool } = await import("../tool");
    const { get_offer } = await import("../tools/get-offer");
    const { plan } = await import("../tools/plan");
    const { client, q } = await buildCtx();
    const date = await populatedDate(q);
    if (date === null) {
      expect(true).toBe(true);
      return;
    }
    const planned = await callTool(
      plan,
      { alternatives: 0, dates: [date], detail: "summary" },
      { client }
    );
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape validated by outputSchema
    const { selections } = payloadOf(planned) as {
      selections: { offer_id: string }[];
    };
    if (selections.length === 0) {
      expect(true).toBe(true);
      return;
    }
    const result = await callTool(
      get_offer,
      { date, offer_id: selections[0].offer_id },
      { client }
    );
    expectOk(result, "get_offer");
  });
});
