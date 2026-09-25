import { describe, expect, it } from "vitest";

import { BasketError, assembleSimpleOrder } from "@/lib/dietly-basket";
import type { BasketDay, BasketPick, MenuSlotRow } from "@/lib/dietly-basket";
import { parseOfferId } from "@/mcp/offer";

// Shapes taken from a live robinfood basket (2026-09-22): default slot ids
// 302/304/314/316/323 recur every day, a swap picks another slot id (328).
const MENU = "v1:robinfood:67:6-15";
const FIXED = "v1:robinfood:202";

const row = (
  menu_date: string,
  slot_name: string,
  meal_id: number,
  api_meal_slot_id: number,
  is_default: boolean
): MenuSlotRow => ({
  api_meal_slot_id,
  is_default,
  meal_id,
  menu_date,
  slot_name,
});

const DEFAULTS = [
  ["Śniadanie", 302],
  ["II Śniadanie", 304],
  ["Obiad", 314],
  ["Podwieczorek", 316],
  ["Kolacja", 323],
] as const;

// meal_id = slot id + 1000 on 28.09, + 2000 on 29.09 — distinct dishes daily.
const menuFor = (date: string, offset: number): MenuSlotRow[] => [
  ...DEFAULTS.map(([slot, id]) => row(date, slot, id + offset, id, true)),
  row(date, "Śniadanie", 9999 + offset, 328, false),
];

const ROWS = [...menuFor("2026-09-28", 1000), ...menuFor("2026-09-29", 2000)];

const defaultPicks = (offset: number): readonly BasketPick[] =>
  DEFAULTS.map(([slot_name, id]) => ({ meal_id: id + offset, slot_name }));

describe("assembleSimpleOrder", () => {
  it("sends only the base lineup when nothing was swapped", () => {
    const days: BasketDay[] = [
      { date: "2026-09-29", offer_id: MENU, picks: defaultPicks(2000) },
      { date: "2026-09-28", offer_id: MENU, picks: defaultPicks(1000) },
    ];
    const order = assembleSimpleOrder(parseOfferId(MENU), days, ROWS, "dlwX");

    expect(order.deliveryDates).toEqual(["2026-09-28", "2026-09-29"]);
    expect(order.deliveryMeals.map((m) => m.dietCaloriesMealId)).toEqual([
      302, 304, 314, 316, 323,
    ]);
    expect(order.customDeliveryMeals).toBeUndefined();
    expect(order.tierDietOptionId).toBe("6-15");
    expect(order.dietCaloriesId).toBe(67);
  });

  it("spells out a swapped day under customDeliveryMeals", () => {
    const swapped = defaultPicks(1000).map((p) =>
      p.slot_name === "Śniadanie" ? { ...p, meal_id: 10_999 } : p
    );
    const days: BasketDay[] = [
      { date: "2026-09-28", offer_id: MENU, picks: swapped },
      { date: "2026-09-29", offer_id: MENU, picks: defaultPicks(2000) },
    ];
    const order = assembleSimpleOrder(parseOfferId(MENU), days, ROWS, "dlwX");

    expect(Object.keys(order.customDeliveryMeals ?? {})).toEqual([
      "2026-09-28",
    ]);
    expect(
      order.customDeliveryMeals?.["2026-09-28"]?.map(
        (m) => m.dietCaloriesMealId
      )
    ).toEqual([328, 304, 314, 316, 323]);
  });

  it("prefers the pick's own slot when a dish sits in two slots", () => {
    const rows = [
      ...ROWS,
      // Same dish also offered as II Śniadanie under a different slot id.
      row("2026-09-28", "II Śniadanie", 10_999, 341, false),
    ];
    const picks = defaultPicks(1000).map((p) =>
      p.slot_name === "II Śniadanie" ? { ...p, meal_id: 10_999 } : p
    );
    const order = assembleSimpleOrder(
      parseOfferId(MENU),
      [{ date: "2026-09-28", offer_id: MENU, picks }],
      rows,
      "dlwX"
    );

    expect(
      order.customDeliveryMeals?.["2026-09-28"]?.map(
        (m) => m.dietCaloriesMealId
      )
    ).toContain(341);
  });

  it("refuses a pick it cannot map rather than sending a wrong meal", () => {
    const picks = [{ meal_id: 424_242, slot_name: "Obiad" }];
    expect(() =>
      assembleSimpleOrder(
        parseOfferId(MENU),
        [{ date: "2026-09-28", offer_id: MENU, picks }],
        ROWS,
        "dlwX"
      )
    ).toThrow(BasketError);
  });

  it("ignores picks on fixed diets and omits tierDietOptionId", () => {
    const order = assembleSimpleOrder(
      parseOfferId(FIXED),
      [{ date: "2026-09-28", offer_id: FIXED, picks: [] }],
      [],
      "dlwX"
    );

    expect(order.deliveryMeals).toEqual([]);
    expect(order.customDeliveryMeals).toBeUndefined();
    expect(order.tierDietOptionId).toBeUndefined();
  });
});
