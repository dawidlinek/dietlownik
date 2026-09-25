import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * CityResolver only returns cities the scraper tracks. A real but untracked
 * locality must fail loudly (with the tracked cities of its voivodeship)
 * instead of resolving to an id every tool would answer emptily for. dietly's
 * search is mocked by URL: it knows "Świnouj" but not the exact
 * "Świnoujście", like the live API.
 */

interface City {
  cityId: number;
  name: string;
  cityStatus: boolean;
  provinceName: string;
  countyName: string;
  largestCityForName: boolean;
}

const DIETLY: Record<string, City[]> = {
  Józefów: [
    {
      cityId: 1,
      cityStatus: true,
      countyName: "otwocki",
      largestCityForName: true,
      name: "Józefów",
      provinceName: "MAZOWIECKIE",
    },
  ],
  Świnouj: [
    {
      cityId: 979_722,
      cityStatus: true,
      countyName: "Świnoujście",
      largestCityForName: false,
      name: "Świnoujście",
      provinceName: "ZACHODNIOPOMORSKIE",
    },
  ],
};

interface TrackedRow {
  readonly city_id: number;
  readonly name: string;
  readonly province: string;
}

// Tracked cities in the fake database.
const TRACKED: readonly TrackedRow[] = [
  { city_id: 918_123, name: "Warszawa", province: "MAZOWIECKIE" },
  { city_id: 977_976, name: "Szczecin", province: "ZACHODNIOPOMORSKIE" },
];

const fakeRows = (sql: string, arg: unknown): readonly TrackedRow[] => {
  if (sql.includes("LOWER(name) = LOWER($1)")) {
    return TRACKED.filter(
      (c: Readonly<TrackedRow>) =>
        c.name.toLowerCase() === String(arg).toLowerCase()
    );
  }
  if (sql.includes("city_id = $1 AND tracked")) {
    return TRACKED.filter(
      (c: Readonly<TrackedRow>) => c.city_id === Number(arg)
    );
  }
  if (sql.includes("province_name = $1")) {
    return TRACKED.filter((c: Readonly<TrackedRow>) => c.province === arg);
  }
  return [];
};

vi.mock("@/mcp/http", () => ({
  // oxlint-disable-next-line typescript/promise-function-async -- mock hands back a settled promise
  fetchWithRetry: vi.fn((url: string) => Promise.resolve({ url })),
  // oxlint-disable-next-line typescript/promise-function-async -- mock hands back a settled promise
  parseResponse: vi.fn((res: Readonly<{ url: string }>) =>
    Promise.resolve({
      cities: DIETLY[new URL(res.url).searchParams.get("query") ?? ""] ?? [],
    })
  ),
}));

vi.mock("@/scraper/db", () => ({
  // oxlint-disable-next-line typescript/promise-function-async -- mock hands back a settled promise
  q: vi.fn((sql: string, params: readonly unknown[] = []) =>
    Promise.resolve({ rows: fakeRows(sql, params[0]) })
  ),
}));

describe("CityResolver", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("resolves a tracked city from the database", async () => {
    const { CityResolver } = await import("@/mcp/city");
    await expect(new CityResolver().resolve("warszawa")).resolves.toEqual({
      id: 918_123,
      name: "Warszawa",
    });
  });

  it("finds a locality dietly only matches by prefix", async () => {
    const { CityResolver } = await import("@/mcp/city");
    const http = await import("@/mcp/http");
    // Untracked, and dietly's search returns nothing for the exact name: only
    // the prefix retry reaches it, so the error can name its region.
    const attempt = new CityResolver().resolve("Świnoujście");
    await expect(attempt).rejects.toThrow(/Szczecin/u);
    expect(vi.mocked(http.fetchWithRetry).mock.calls.length).toBeGreaterThan(1);
  });

  it("refuses an untracked locality and names the tracked cities nearby", async () => {
    const { CityResolver, CityResolveError } = await import("@/mcp/city");
    const attempt = new CityResolver().resolve("Józefów");
    await expect(attempt).rejects.toBeInstanceOf(CityResolveError);
    await expect(attempt).rejects.toThrow(/no data for it/u);
    await expect(attempt).rejects.toThrow(/Warszawa/u);
  });
});
