import { describe, it, expect } from "vitest";

import {
  parsePrice,
  parseInfoMacros,
  parseKcalNumber,
  parseGrams,
  futureWeekdays,
  nextNDates,
  newLimiterForTests,
} from "../api";

describe("parsePrice", () => {
  it("strips zł and parses dot decimals", () => {
    expect(parsePrice("67.00 zł")).toBe(67);
    expect(parsePrice("1234.50 zł")).toBe(1234.5);
  });

  it("handles Polish thousands separator and comma decimal", () => {
    expect(parsePrice("1 234,50 zł")).toBe(1234.5);
    // non-breaking space
    expect(parsePrice("1 234,50 zł")).toBe(1234.5);
  });

  it("passes numbers through", () => {
    expect(parsePrice(42)).toBe(42);
  });

  it("returns null for null/undefined/garbage", () => {
    expect(parsePrice(null)).toBeNull();
    expect(parsePrice()).toBeNull();
    expect(parsePrice("not a price")).toBeNull();
  });
});

describe("parseInfoMacros", () => {
  it('parses the standard "300 kcal • B:19g • W:30g • T:11g" format', () => {
    expect(parseInfoMacros("300 kcal • B:19g • W:30g • T:11g")).toEqual({
      carbs_g: 30,
      fat_g: 11,
      kcal: 300,
      protein_g: 19,
    });
  });

  it("handles decimals with dot or comma", () => {
    expect(parseInfoMacros("606 kcal • B:18g • W:61g • T:32g")).toMatchObject({
      kcal: 606,
      protein_g: 18,
    });
    expect(parseInfoMacros("300.5 kcal • B:19,5g")).toMatchObject({
      kcal: 300.5,
      protein_g: 19.5,
    });
  });

  it("returns nulls for missing fields", () => {
    expect(parseInfoMacros("300 kcal")).toEqual({
      carbs_g: null,
      fat_g: null,
      kcal: 300,
      protein_g: null,
    });
    expect(parseInfoMacros(null)).toEqual({
      carbs_g: null,
      fat_g: null,
      kcal: null,
      protein_g: null,
    });
    expect(parseInfoMacros("")).toEqual({
      carbs_g: null,
      fat_g: null,
      kcal: null,
      protein_g: null,
    });
  });

  it("B/W/T are protein/carbs/fat (Polish letters), not in alpha order", () => {
    // Reality check: Polish "Białka W̨ęglowodany Tłuszcze" map to protein/carbs/fat.
    const r = parseInfoMacros("300 kcal • B:19g • W:30g • T:11g");
    // B
    expect(r.protein_g).toBe(19);
    // W
    expect(r.carbs_g).toBe(30);
    // T
    expect(r.fat_g).toBe(11);
  });
});

describe("parseKcalNumber", () => {
  it('extracts number from "300.45 kcal / 1257 kJ"', () => {
    expect(parseKcalNumber("300.45 kcal / 1257 kJ")).toBe(300.45);
  });
  it("handles plain numbers and nulls", () => {
    expect(parseKcalNumber(42)).toBe(42);
    expect(parseKcalNumber(null)).toBeNull();
  });
});

describe("parseGrams", () => {
  it('parses "18.87g"', () => {
    expect(parseGrams("18.87g")).toBe(18.87);
  });
  it("handles comma decimals", () => {
    expect(parseGrams("18,87g")).toBe(18.87);
  });
  it("null safety", () => {
    expect(parseGrams(null)).toBeNull();
    expect(parseGrams()).toBeNull();
  });
});

describe("futureWeekdays", () => {
  it("returns N consecutive non-weekend dates by default", () => {
    const dates = futureWeekdays(5);
    expect(dates).toHaveLength(5);
    for (const d of dates) {
      const day = new Date(d).getUTCDay();
      // 0 = Sunday, 6 = Saturday — should not appear by default.
      expect(day === 0 || day === 6).toBe(false);
    }
  });

  it("all dates strictly increase", () => {
    const dates = futureWeekdays(10);
    for (let i = 1; i < dates.length; i += 1) {
      expect(dates[i] > dates[i - 1]).toBe(true);
    }
  });

  it("includeSaturday=true allows Saturdays", () => {
    const ds = futureWeekdays(20, { includeSaturday: true });
    const hasSat = ds.some((d) => new Date(d).getUTCDay() === 6);
    // Over 20 entries we'll certainly hit a Saturday.
    expect(hasSat).toBe(true);
  });

  it("starts ≥ tomorrow by default", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(futureWeekdays(1)[0] > today).toBe(true);
  });
});

describe("nextNDates", () => {
  it("returns N consecutive calendar days including today", () => {
    const ds = nextNDates(3);
    expect(ds).toHaveLength(3);
    for (let i = 1; i < ds.length; i += 1) {
      expect(ds[i] > ds[i - 1]).toBe(true);
    }
  });
  it("starts at today by default", () => {
    expect(nextNDates(1)[0]).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe("Limiter (in-flight semaphore)", () => {
  it("caps in-flight at maxInFlight", async () => {
    const lim = newLimiterForTests(2, 0);
    let peak = 0;
    let active = 0;

    const job = async () => {
      await lim.acquire();
      active += 1;
      peak = Math.max(peak, active);
      // oxlint-disable-next-line promise/avoid-new -- low-level sleep primitive in test
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
      active -= 1;
      lim.release();
    };

    await Promise.all([job(), job(), job(), job(), job(), job()]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("does not deadlock when acquire/release pair always run", async () => {
    const lim = newLimiterForTests(1, 0);
    let count = 0;
    for (let i = 0; i < 50; i += 1) {
      await lim.acquire();
      count += 1;
      lim.release();
    }
    expect(count).toBe(50);
  });

  it("with minIntervalMs, total time across N requests >= (N-1)*interval", async () => {
    const lim = newLimiterForTests(8, 50);
    const t0 = Date.now();
    const N = 5;
    await Promise.all(
      Array.from({ length: N }, async () => {
        await lim.acquire();
        lim.release();
      })
    );
    const elapsed = Date.now() - t0;
    // 10ms slack
    expect(elapsed).toBeGreaterThanOrEqual((N - 1) * 50 - 10);
  });
});
