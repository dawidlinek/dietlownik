// Writes a selection into the user's dietly account basket — the dashboard's
// "zamów" handoff, shared by `app/api/dietly/basket/route.ts` and the MCP
// `send_to_basket` tool. Nothing is ordered or paid: the user finishes
// checkout on dietly.pl, where the basket shows up on the next page load.

import {
  BASKET_CALCULATE_PATH,
  BASKET_RESTORE_PATH,
  basketUrl,
  dietlyMessage,
  isAuthError,
} from "@/lib/dietly-account";
import { ITEM_ID_PREFIX, buildBasket } from "@/lib/dietly-basket";
import type { BasketBody, BasketDay } from "@/lib/dietly-basket";
import type { DietlyClient } from "@/mcp/client";
import { HttpError } from "@/scraper/api";

interface RestoreResponse {
  readonly companyName?: string | null;
  readonly items?: readonly { readonly itemId?: string }[];
}

interface CalculateResponse {
  readonly cart?: {
    readonly totalCostToPay?: number;
    readonly totalDeliveryCost?: number;
  };
  readonly items?: readonly {
    readonly itemId?: string;
    readonly perDayDietWithDiscountsCost?: number;
    readonly totalDietWithDiscountsAndSideOrdersCost?: number;
  }[];
}

export interface BasketClash {
  readonly company_id: string | null;
  readonly diets: number;
  /** Every item in it was written by us (dashboard or MCP). */
  readonly ours: boolean;
}

export interface SentBasket {
  readonly basket_url: string;
  readonly company_id: string;
  readonly delivery: number | null;
  readonly diets: readonly {
    readonly dates: readonly string[];
    readonly offer_id: string | null;
    readonly per_day: number | null;
    readonly total: number | null;
  }[];
  /** dietly's reason when it refused the promo codes; written without them. */
  readonly promo_dropped: string | null;
  readonly total: number | null;
}

export type SendResult =
  | { readonly kind: "conflict"; readonly existing: BasketClash }
  | { readonly kind: "not_stored" }
  | ({ readonly kind: "ok" } & SentBasket);

const restore = async (
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- DietlyClient is a class instance; only authGet is called
  client: DietlyClient,
  email: string
): Promise<{ company: string | null; itemIds: string[] }> => {
  const r = await client.authGet<RestoreResponse | null>(
    email,
    BASKET_RESTORE_PATH
  );
  const itemIds = [
    ...new Set(
      (r?.items ?? [])
        .map((i) => i.itemId)
        .filter((id): id is string => id !== undefined)
    ),
  ];
  return { company: r?.companyName ?? null, itemIds };
};

/** Write the basket; if dietly refuses a promo code (min-days rules and the
 *  like), write it again without codes rather than failing the handoff. */
const writeBasket = async (
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- DietlyClient is a class instance; only authPost is called
  client: DietlyClient,
  email: string,
  body: Readonly<BasketBody>,
  promoCodes: readonly string[]
): Promise<{ promoDropped: string | null; res: CalculateResponse }> => {
  const post = async (codes: readonly string[]) => {
    const res = await client.authPost<CalculateResponse>(
      email,
      BASKET_CALCULATE_PATH,
      { ...body, promoCodes: codes },
      body.companyId
    );
    return res;
  };
  if (promoCodes.length === 0) {
    return { promoDropped: null, res: await post([]) };
  }
  try {
    return { promoDropped: null, res: await post(promoCodes) };
  } catch (error) {
    if (error instanceof HttpError && !isAuthError(error)) {
      return { promoDropped: dietlyMessage(error), res: await post([]) };
    }
    throw error;
  }
};

/**
 * Writing replaces whatever is in the account basket. Re-sending our own
 * basket for the same catering is fine; another catering, or a basket the
 * user put together on dietly.pl, needs an explicit yes.
 */
const clashWith = (
  existing: Readonly<{ company: string | null; itemIds: readonly string[] }>,
  companyId: string
): BasketClash | null => {
  if (existing.itemIds.length === 0) {
    return null;
  }
  const ours = existing.itemIds.every((id) => id.startsWith(ITEM_ID_PREFIX));
  return existing.company === companyId && ours
    ? null
    : { company_id: existing.company, diets: existing.itemIds.length, ours };
};

/**
 * Build, write and read back one catering's basket. Throws `BasketError` for
 * a selection that can't be mapped to dietly ids and `HttpError` for dietly
 * failures (401/403 = session gone).
 */
export const sendBasket = async (
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- DietlyClient is a class instance; only its request methods are called
  client: DietlyClient,
  email: string,
  args: Readonly<{
    companyId: string;
    cityId: number;
    days: readonly BasketDay[];
    promoCodes: readonly string[];
    replace: boolean;
  }>
): Promise<SendResult> => {
  const built = await buildBasket(args.companyId, args.cityId, args.days);

  const clash = clashWith(await restore(client, email), args.companyId);
  if (clash !== null && !args.replace) {
    return { existing: clash, kind: "conflict" };
  }

  const { promoDropped, res } = await writeBasket(
    client,
    email,
    built.body,
    args.promoCodes
  );

  // calculate-price answering 200 is not proof it was stored — read it back.
  const after = await restore(client, email);
  const stored =
    after.company === args.companyId &&
    Object.keys(built.items).every((id) => after.itemIds.includes(id));
  if (!stored) {
    return { kind: "not_stored" };
  }

  return {
    basket_url: basketUrl(args.companyId),
    company_id: args.companyId,
    delivery: res.cart?.totalDeliveryCost ?? null,
    diets: (res.items ?? []).map((item) => ({
      dates: built.items[item.itemId ?? ""]?.dates ?? [],
      offer_id: built.items[item.itemId ?? ""]?.offer_id ?? null,
      per_day: item.perDayDietWithDiscountsCost ?? null,
      total: item.totalDietWithDiscountsAndSideOrdersCost ?? null,
    })),
    kind: "ok",
    promo_dropped: promoDropped,
    total: res.cart?.totalCostToPay ?? null,
  };
};
