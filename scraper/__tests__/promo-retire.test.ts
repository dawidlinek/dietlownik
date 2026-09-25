import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type * as Api from "@/scraper/api";
import type { q as dbQuery } from "@/scraper/db";
import type { PriceJob } from "@/scraper/scrapers/prices";
import type { PriceLeaf } from "@/scraper/types";

const leaf = (id: number): PriceLeaf => ({
  delivery_on_saturday: false,
  delivery_on_sunday: false,
  diet_calories_id: id,
  diet_id: 1,
  is_menu_configuration: false,
  tier_diet_option_id: null,
  tier_id: 0,
});

/** The promo codes a mocked quote request carried, "-" for none. */
const codesOf = (body: unknown): string =>
  typeof body === "object" &&
  body !== null &&
  "promoCodes" in body &&
  Array.isArray(body.promoCodes)
    ? body.promoCodes.join(",") || "-"
    : "?";

const DB_SKIP =
  process.env.DATABASE_URL === undefined || process.env.DATABASE_URL === "";

// dietly rejects DEAD as an unknown code and fails everything else for an
// unrelated reason, so no quote is ever recorded — only the call pattern
// and the campaign state matter here.
vi.mock("@/scraper/api", async (importOriginal) => {
  const actual = await importOriginal<typeof Api>();
  return {
    ...actual,
    // Throwing synchronously is enough: fetchAndInsert awaits post() inside
    // a try block, which catches a throw and a rejection alike.
    post: vi.fn(
      (path: string, body: Readonly<{ promoCodes: readonly string[] }>) => {
        throw body.promoCodes.includes("DEAD")
          ? new actual.HttpError(
              "POST",
              path,
              490,
              '{"message":"Nie znaleziono takiego kodu rabatowego."}'
            )
          : new actual.HttpError("POST", path, 500, "boom");
      }
    ),
  };
});

/**
 * A promo code dietly rejects ("Nie znaleziono takiego kodu rabatowego") is
 * retired after the first rejection and skipped for the rest of the run,
 * instead of being quoted once per leaf (713 wasted requests in the first
 * national run, for 4 codes whose ends_at was still in the future).
 */
describe.skipIf(DB_SKIP)("rejected promo codes", () => {
  const COMPANY = "__promo_retire_test__";
  let q: typeof dbQuery;

  // campaigns has no ON DELETE CASCADE to companies; history does.
  const cleanup = async (): Promise<void> => {
    await q("DELETE FROM campaigns WHERE company_id = $1", [COMPANY]);
    await q("DELETE FROM companies WHERE company_id = $1", [COMPANY]);
  };

  beforeAll(async () => {
    ({ q } = await import("@/scraper/db"));
    await cleanup();
    await q("INSERT INTO companies (company_id, name) VALUES ($1, 'Test')", [
      COMPANY,
    ]);
    for (const code of ["DEAD", "OTHER"]) {
      await q(
        `INSERT INTO campaigns (company_id, code, is_active, ends_at)
         VALUES ($1, $2, TRUE, CURRENT_DATE + 30)`,
        [COMPANY, code]
      );
    }
  });

  afterAll(async () => {
    await cleanup();
  });

  it("quotes a rejected code once, retires it and skips its other quotes", async () => {
    const api = await import("@/scraper/api");
    const { runConcurrent } = await import("@/scraper/scrapers/prices");
    const jobs: PriceJob[] = [1, 2, 3, 4].flatMap((id: number) =>
      [[], ["DEAD"], ["OTHER"]].map((codes: readonly string[]) => ({
        days: 1,
        deliveryDates: ["2099-01-05"],
        leaf: leaf(id),
        promoCodes: [...codes],
      }))
    );

    // Concurrency 1: the rejection is known before the next DEAD job starts.
    expect(await runConcurrent(jobs, COMPANY, 986_283, 1)).toBe(0);

    const codesSent = vi
      .mocked(api.post)
      .mock.calls.map((call: readonly unknown[]) => codesOf(call[1]));
    expect(codesSent.filter((c: string) => c === "DEAD")).toHaveLength(1);
    expect(codesSent.filter((c: string) => c === "OTHER")).toHaveLength(4);
    expect(codesSent.filter((c: string) => c === "-")).toHaveLength(4);

    const { rows } = await q<{ code: string; is_active: boolean }>(
      `SELECT code, is_active FROM campaigns WHERE company_id = $1 ORDER BY code`,
      [COMPANY]
    );
    expect(rows).toEqual([
      { code: "DEAD", is_active: false },
      { code: "OTHER", is_active: true },
    ]);
    const { rows: history } = await q<{ is_active: boolean }>(
      `SELECT is_active FROM campaign_history
        WHERE company_id = $1 AND code = 'DEAD' AND closed_at IS NULL`,
      [COMPANY]
    );
    expect(history).toEqual([{ is_active: false }]);
  });
});
