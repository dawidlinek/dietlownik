// Builds the body dietly's `shopping-cart/calculate-price` expects from a
// dashboard selection. Posted to the *profile* variant of that endpoint, the
// body is also persisted as the account's basket — dietly.pl restores it on
// the next page load, which is how the "zamów" handoff works.
//
// One basket holds exactly one catering (dietly answers 490 to a mixed cart),
// so callers build one body per company. Within a company each distinct offer
// becomes its own `simpleOrders[]` entry carrying only the dates it covers.

import { randomUUID } from "node:crypto";

import { query } from "@/lib/db";
import { parseOfferId, tierIdOfOffer } from "@/mcp/offer";
import type { OfferParts } from "@/mcp/offer";

export interface BasketPick {
  readonly slot_name: string;
  readonly meal_id: number;
}

export interface BasketDay {
  readonly date: string;
  readonly offer_id: string;
  /** Chosen meal per slot after the user's swaps. Only menu-configuration
   *  offers need it — fixed diets have nothing to choose. */
  readonly picks: readonly BasketPick[];
}

/** One current `menu_items` row, narrowed to what the handoff needs. */
export interface MenuSlotRow {
  readonly menu_date: string;
  readonly slot_name: string;
  readonly meal_id: number;
  readonly api_meal_slot_id: number;
  readonly is_default: boolean;
}

interface DeliveryMeal {
  readonly amount: 1;
  readonly dietCaloriesMealId: number;
}

export interface SimpleOrder {
  readonly itemId: string;
  readonly deliveryDates: readonly string[];
  readonly deliveryMeals: readonly DeliveryMeal[];
  readonly customDeliveryMeals?: Readonly<
    Record<string, readonly DeliveryMeal[]>
  >;
  readonly dietCaloriesId: number;
  readonly tierDietOptionId?: string;
  readonly paymentType: "ONLINE";
  readonly sideOrders: readonly never[];
  readonly testOrder: false;
}

export interface BasketBody {
  readonly companyId: string;
  readonly cityId: number;
  readonly promoCodes: readonly string[];
  readonly loyaltyProgramPoints: 0;
  readonly loyaltyProgramPointsGlobal: 0;
  readonly simpleOrders: readonly SimpleOrder[];
}

/** Every basket item we write starts with this, so a re-send can tell our own
 *  basket apart from one the user assembled on dietly.pl. */
export const ITEM_ID_PREFIX = "dlw";

export const newItemId = (): string =>
  `${ITEM_ID_PREFIX}${randomUUID().replaceAll("-", "").slice(0, 17)}`;

export class BasketError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "BasketError";
  }
}

const toMeals = (ids: readonly number[]): DeliveryMeal[] =>
  ids.map((id) => ({ amount: 1 as const, dietCaloriesMealId: id }));

const sortedIds = (ids: readonly number[]): number[] =>
  [...ids].toSorted((a, b) => a - b);

const sameIds = (a: readonly number[], b: readonly number[]): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  const sa = sortedIds(a);
  const sb = sortedIds(b);
  return sa.every((v, i) => v === sb[i]);
};

/**
 * Resolve a pick to dietly's `dietCaloriesMealId`. That id names a slot
 * option for the day, not a dish, and one dish can sit in several slots on the
 * same day — so match on (date, slot, meal) first and only fall back to
 * (date, meal) when the slot label drifted.
 */
const resolveSlotId = (
  rows: readonly MenuSlotRow[],
  date: string,
  pick: Readonly<BasketPick>
): number | undefined => {
  const onDate = rows.filter(
    (r) => r.menu_date === date && r.meal_id === pick.meal_id
  );
  const exact = onDate.find((r) => r.slot_name === pick.slot_name);
  return (exact ?? onDate[0])?.api_meal_slot_id;
};

/**
 * Pure assembly of one `simpleOrders[]` entry. `deliveryMeals` is the first
 * date's default lineup, mirroring what dietly.pl sends; any date whose chosen
 * lineup differs — a swap, or a catering whose defaults move day to day — is
 * spelled out under `customDeliveryMeals`.
 */
export const assembleSimpleOrder = (
  offer: Readonly<OfferParts>,
  days: readonly BasketDay[],
  rows: readonly MenuSlotRow[],
  itemId: string
): SimpleOrder => {
  const dates = [...new Set(days.map((d) => d.date))].toSorted();
  if (dates.length === 0) {
    throw new BasketError("Brak dni do wysłania.");
  }
  const defaultsOn = (date: string): number[] => [
    ...new Set(
      rows
        .filter((r) => r.menu_date === date && r.is_default)
        .map((r) => r.api_meal_slot_id)
    ),
  ];
  const base = defaultsOn(dates[0]);

  const custom: Record<string, DeliveryMeal[]> = {};
  if (offer.is_menu_configuration) {
    for (const day of days) {
      const chosen: number[] = [];
      for (const pick of day.picks) {
        const id = resolveSlotId(rows, day.date, pick);
        if (id === undefined) {
          throw new BasketError(
            `${day.date}: nie znam id dietly dla „${pick.slot_name}” — menu mogło się zmienić od ostatniego scrapu.`
          );
        }
        chosen.push(id);
      }
      if (!sameIds(chosen, base)) {
        custom[day.date] = toMeals(chosen);
      }
    }
  }

  return {
    deliveryDates: dates,
    deliveryMeals: toMeals(base),
    dietCaloriesId: offer.diet_calories_id,
    itemId,
    paymentType: "ONLINE",
    sideOrders: [],
    testOrder: false,
    ...(Object.keys(custom).length > 0 ? { customDeliveryMeals: custom } : {}),
    ...(offer.is_menu_configuration && offer.tier_diet_option_id !== undefined
      ? { tierDietOptionId: offer.tier_diet_option_id }
      : {}),
  };
};

// Menus are national (see CLAUDE.md "City scope"), so no city filter: the
// same dish rows are written once per scraped city and are identical.
const loadMenuSlots = async (
  offer: Readonly<OfferParts>,
  dates: readonly string[]
): Promise<MenuSlotRow[]> => {
  const rows = await query<MenuSlotRow>(
    `SELECT DISTINCT
       menu_date::text        AS menu_date,
       slot_name,
       meal_id::int           AS meal_id,
       api_meal_slot_id::int  AS api_meal_slot_id,
       COALESCE(is_default, false) AS is_default
     FROM menu_items
     WHERE company_id = $1
       AND diet_calories_id = $2
       AND ($3::int IS NULL OR tier_id = $3)
       AND menu_date = ANY($4::date[])
       AND closed_at IS NULL`,
    [offer.company_id, offer.diet_calories_id, tierIdOfOffer(offer), dates]
  );
  return rows;
};

export interface BuiltBasket {
  readonly body: BasketBody;
  /** itemId → the offer and dates it carries, for labelling dietly's reply. */
  readonly items: Readonly<
    Record<string, { readonly offer_id: string; readonly dates: string[] }>
  >;
}

export const buildBasket = async (
  companyId: string,
  cityId: number,
  days: readonly BasketDay[]
): Promise<BuiltBasket> => {
  const byOffer = new Map<string, BasketDay[]>();
  for (const day of days) {
    const list = byOffer.get(day.offer_id) ?? [];
    list.push(day);
    byOffer.set(day.offer_id, list);
  }

  const simpleOrders: SimpleOrder[] = [];
  const items: Record<string, { offer_id: string; dates: string[] }> = {};
  for (const [offerId, offerDays] of byOffer) {
    const offer = parseOfferId(offerId);
    if (offer.company_id !== companyId) {
      throw new BasketError(
        `Oferta ${offerId} nie należy do ${companyId} — koszyk dietly mieści jeden catering.`
      );
    }
    const dates = [...new Set(offerDays.map((d) => d.date))].toSorted();
    const rows = await loadMenuSlots(offer, dates);
    const itemId = newItemId();
    simpleOrders.push(assembleSimpleOrder(offer, offerDays, rows, itemId));
    items[itemId] = { dates, offer_id: offerId };
  }

  return {
    body: {
      cityId,
      companyId,
      loyaltyProgramPoints: 0,
      loyaltyProgramPointsGlobal: 0,
      promoCodes: [],
      simpleOrders,
    },
    items,
  };
};
