import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

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

// Delivery dates are Warsaw calendar days. Pin the clock to the hours where
// Warsaw's date and UTC's date disagree, and run every case under several
// process time zones — the result must not depend on either.
const PROCESS_TZS = [
  "UTC",
  "Europe/Warsaw",
  "America/Los_Angeles",
  "Pacific/Kiritimati",
];

/** Europe/Warsaw weekday (0 = Sun) of a YYYY-MM-DD calendar date. */
const weekdayOf = (iso: string): number =>
  new Date(`${iso}T00:00:00Z`).getUTCDay();

describe.each(PROCESS_TZS)("date helpers with TZ=%s", (tz) => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    process.env.TZ = tz;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTz;
    }
  });

  describe("futureWeekdays", () => {
    it("starts tomorrow in Warsaw at 00:30 CEST (still yesterday in UTC)", () => {
      // Wed 2026-09-23 00:30 CEST
      vi.setSystemTime(new Date("2026-09-22T22:30:00Z"));
      expect(futureWeekdays(5)).toEqual([
        "2026-09-24",
        "2026-09-25",
        "2026-09-28",
        "2026-09-29",
        "2026-09-30",
      ]);
    });

    it("returns N consecutive non-weekend dates by default", () => {
      vi.setSystemTime(new Date("2026-09-22T22:30:00Z"));
      const dates = futureWeekdays(15);
      expect(dates).toHaveLength(15);
      for (const d of dates) {
        const day = weekdayOf(d);
        // 0 = Sunday, 6 = Saturday — should not appear by default.
        expect(day === 0 || day === 6).toBe(false);
      }
    });

    it("all dates strictly increase", () => {
      vi.setSystemTime(new Date("2026-09-22T22:30:00Z"));
      const dates = futureWeekdays(10);
      for (let i = 1; i < dates.length; i += 1) {
        expect(dates[i] > dates[i - 1]).toBe(true);
      }
    });

    it("skips a Sunday tomorrow just after midnight on Saturday", () => {
      // Sat 2026-09-26 01:30 CEST — UTC still says Friday.
      vi.setSystemTime(new Date("2026-09-25T23:30:00Z"));
      expect(futureWeekdays(2)).toEqual(["2026-09-28", "2026-09-29"]);
      expect(futureWeekdays(2, { includeSunday: true })).toEqual([
        "2026-09-27",
        "2026-09-28",
      ]);
    });

    it("includeSaturday=true allows Saturdays", () => {
      // Fri 2026-09-25 00:30 CEST — UTC still says Thursday.
      vi.setSystemTime(new Date("2026-09-24T22:30:00Z"));
      const ds = futureWeekdays(3, { includeSaturday: true });
      expect(ds).toEqual(["2026-09-26", "2026-09-28", "2026-09-29"]);
      expect(weekdayOf(ds[0])).toBe(6);
    });

    it("uses CET in winter (00:30 on 2027-01-01 is still 2026 in UTC)", () => {
      // Fri 2027-01-01 00:30 CET
      vi.setSystemTime(new Date("2026-12-31T23:30:00Z"));
      expect(futureWeekdays(2)).toEqual(["2027-01-04", "2027-01-05"]);
    });

    it("steps across a DST change without skipping or repeating a day", () => {
      // Sat 2026-10-24 12:00 CEST; clocks go back on Sun 2026-10-25.
      vi.setSystemTime(new Date("2026-10-24T10:00:00Z"));
      expect(
        futureWeekdays(3, { includeSaturday: true, includeSunday: true })
      ).toEqual(["2026-10-25", "2026-10-26", "2026-10-27"]);
    });
  });

  describe("nextNDates", () => {
    it("starts at Warsaw today at 00:30 CEST", () => {
      vi.setSystemTime(new Date("2026-09-22T22:30:00Z"));
      expect(nextNDates(3)).toEqual(["2026-09-23", "2026-09-24", "2026-09-25"]);
    });

    it("honours fromDaysOffset and keeps weekends", () => {
      vi.setSystemTime(new Date("2026-09-25T23:30:00Z"));
      expect(nextNDates(2, 1)).toEqual(["2026-09-27", "2026-09-28"]);
    });

    it("starts at Warsaw today late in the Warsaw evening", () => {
      // Wed 2026-09-23 23:30 CEST
      vi.setSystemTime(new Date("2026-09-23T21:30:00Z"));
      expect(nextNDates(1)).toEqual(["2026-09-23"]);
    });
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
