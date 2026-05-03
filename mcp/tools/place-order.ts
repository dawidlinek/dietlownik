import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { DietlyClient } from "@/mcp/client";
import type { OfferParts } from "@/mcp/offer";
import { parseOfferId } from "@/mcp/offer";
import { defineTool } from "@/mcp/tool";
import type { DeepReadonly } from "@/mcp/types";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

const inputSchema = z.object({
  address_index: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      "Index into the profile's address list (0 = first/default address from `login`)."
    ),
  city: z
    .string()
    .min(1)
    .describe("City name (Polish). Same one used in find_diets."),
  confirmed: z
    .boolean()
    .default(false)
    .describe("Set to true to skip the in-tool confirmation step."),
  dates: z
    .array(z.string().regex(dateRegex))
    .min(1)
    .describe("ISO yyyy-mm-dd delivery dates."),
  email: z
    .string()
    .optional()
    .describe(
      "Account email. Defaults to the last email used with `login` in this MCP session."
    ),
  offer_id: z.string().describe("Opaque token from find_diets."),
  picks: z
    .record(z.string().regex(dateRegex), z.array(z.string().min(1)))
    .optional()
    .describe(
      "Per-date arrays of pick_ids from get_menu. If omitted, the server uses each slot's default_pick_id (recommended for fixed diets)."
    ),
  promo_codes: z.array(z.string().min(1)).optional(),
  test_order: z
    .boolean()
    .optional()
    .describe(
      "True = no charge, dietly returns a fake confirmation. Use this for end-to-end testing."
    ),
});

type PlaceOrderInput = z.infer<typeof inputSchema>;

interface DeliveryMealPayload {
  amount: 1;
  dietCaloriesMealId: number;
}

interface ProfileAddressShape {
  readonly profileAddressId?: number;
}

interface ProfileShape {
  readonly profileAddresses?: readonly ProfileAddressShape[];
}

interface PlaceOrderResponse {
  orders?: { orderId?: number }[];
  paymentUrl?: {
    paymentUrl?: string;
    paymentUrlWithCost?: { url?: string };
  };
}

const hasProfileField = (value: unknown): value is { profile?: unknown } =>
  value !== null && typeof value === "object" && "profile" in value;

const extractProfile = (raw: unknown): ProfileShape => {
  const root = hasProfileField(raw) ? (raw.profile ?? raw) : raw;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- structural extraction; missing fields are read as undefined and guarded at use sites
  return (root ?? {}) as ProfileShape;
};

const summarizeOrder = (
  input: DeepReadonly<PlaceOrderInput>,
  offer: Readonly<OfferParts>,
  resolvedEmail: string,
  totalPicks: number
): string => {
  const days = input.dates.length;
  const lines = [
    `Company: ${offer.company_id}`,
    `Diet calories ID: ${offer.diet_calories_id}`,
    ...(offer.is_menu_configuration && offer.tier_diet_option_id !== undefined
      ? [`Tier diet option: ${offer.tier_diet_option_id}`]
      : []),
    `Email: ${resolvedEmail}`,
    `City: ${input.city}`,
    `Address index: ${input.address_index}`,
    `Delivery: ${days} day${days === 1 ? "" : "s"} (${input.dates[0]} → ${input.dates[days - 1]})`,
    ...(totalPicks > 0
      ? [`Total picks: ${totalPicks}`]
      : ["Picks: defaults (server-chosen for each slot)"]),
    ...(input.promo_codes !== undefined && input.promo_codes.length > 0
      ? [`Promo codes: ${input.promo_codes.join(", ")}`]
      : []),
    `Test order: ${input.test_order === true ? "YES (no charge)" : "no — REAL CHARGE"}`,
  ];
  return lines.join("\n");
};

const jsonResult = (data: unknown): CallToolResult => ({
  content: [{ text: JSON.stringify(data), type: "text" }],
  structuredContent:
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed by the object/!array guard above
        (data as Record<string, unknown>)
      : undefined,
});

const buildCustomDeliveryMeals = (
  picks: DeepReadonly<Record<string, readonly string[]>> | undefined,
  dates: readonly string[]
): Record<string, DeliveryMealPayload[]> => {
  const out: Record<string, DeliveryMealPayload[]> = {};
  if (picks === undefined) {
    return out;
  }
  for (const date of dates) {
    const ids = picks[date];
    if (ids === undefined || ids.length === 0) {
      continue;
    }
    const meals: DeliveryMealPayload[] = [];
    for (const pickId of ids) {
      const numeric = Number(pickId);
      if (!Number.isInteger(numeric) || numeric <= 0) {
        throw new Error(
          `Invalid pick_id "${pickId}" for ${date}. pick_ids from get_menu must be positive integers (passed as strings).`
        );
      }
      meals.push({ amount: 1 as const, dietCaloriesMealId: numeric });
    }
    out[date] = meals;
  }
  return out;
};

const executeOrder = async (
  input: DeepReadonly<PlaceOrderInput>,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- DietlyClient is a class with public methods (authPost) intentionally invoked here
  client: DietlyClient,
  offer: Readonly<OfferParts>,
  resolvedEmail: string,
  profileAddressId: number
) => {
  const customDeliveryMeals = buildCustomDeliveryMeals(
    input.picks,
    input.dates
  );
  const hasCustomMeals = Object.keys(customDeliveryMeals).length > 0;
  const defaultMeals: DeliveryMealPayload[] = hasCustomMeals
    ? (customDeliveryMeals[input.dates[0]] ?? [])
    : [];

  const simpleOrder: Record<string, unknown> = {
    addressId: null,
    deliveryDates: input.dates,
    deliveryMeals: defaultMeals,
    dietCaloriesId: offer.diet_calories_id,
    hourPreference: "",
    invoice: false,
    itemId: crypto.randomUUID().replaceAll("-", "").slice(0, 20),
    note: "",
    paymentNote: "",
    paymentType: "ONLINE",
    pickupPointDiscount: null,
    pickupPointId: null,
    profileAddressId,
    sideOrders: [],
    testOrder: input.test_order ?? false,
    utmMap: {},
    ...(hasCustomMeals ? { customDeliveryMeals } : {}),
    ...(offer.is_menu_configuration && offer.tier_diet_option_id !== undefined
      ? { tierDietOptionId: offer.tier_diet_option_id }
      : {}),
  };

  const payload: Record<string, unknown> = {
    clientPreferences: [],
    companyId: offer.company_id,
    invoiceData: null,
    lang: "pl",
    loyaltyProgramPoints: 0,
    loyaltyProgramPointsGlobal: 0,
    newPassword: null,
    newProfile: null,
    newProfileAddress: null,
    originId: null,
    paymentRedirectUrl: {
      defaultUrl: "dietly://mobile/payment-default",
      failureUrl: "dietly://mobile/payment-failure",
      successUrl: "dietly://mobile/payment-successful",
    },
    profilePreferences: [],
    promoCodes: input.promo_codes ?? [],
    signUp: false,
    simpleOrders: [simpleOrder],
  };

  const response = await client.authPost<PlaceOrderResponse>(
    resolvedEmail,
    "/api/mobile/profile/shopping-cart/order",
    payload,
    offer.company_id
  );

  const payment_url =
    response.paymentUrl?.paymentUrl ??
    response.paymentUrl?.paymentUrlWithCost?.url ??
    null;
  const order_id = response.orders?.[0]?.orderId ?? null;

  return { order_id, payment_url, raw: response };
};

const countPicks = (
  picks: DeepReadonly<Record<string, readonly string[]>> | undefined
): number => {
  if (picks === undefined) {
    return 0;
  }
  let total = 0;
  for (const arr of Object.values(picks)) {
    total += arr.length;
  }
  return total;
};

export const place_order = defineTool({
  annotations: {
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  description:
    "Place a real Dietly order from an `offer_id` (from `find_diets`). " +
    "IRREVERSIBLE — incurs a charge unless `test_order: true`. " +
    "For menu-configuration diets, `picks` (from `get_menu`) is required; " +
    "fixed diets accept defaults when `picks` is omitted. First call shows " +
    "a summary and asks for confirmation; re-call with `confirmed: true` to submit.",
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ctx (ToolContext) embeds the DietlyClient class instance and the SDK Server (used for elicitation); tool only invokes their public methods
  execute: async (input, ctx) => {
    const offer = parseOfferId(input.offer_id);

    // Resolve email: explicit input wins, else MCP-session default.
    const requestedEmail =
      input.email !== undefined && input.email !== ""
        ? input.email
        : ctx.client.getDefaultEmail();
    if (requestedEmail === undefined || requestedEmail === "") {
      throw new Error(
        "No email provided and no prior `login` in this MCP session. Call `login` first or pass `email` explicitly."
      );
    }
    const resolvedEmail = requestedEmail;

    // Menu-configuration diets need explicit per-day picks; fixed diets may
    // omit picks and let dietly choose defaults.
    if (offer.is_menu_configuration) {
      const totalPicks = countPicks(input.picks);
      if (totalPicks === 0) {
        throw new Error(
          "This offer is a menu-configuration diet — `picks` is required. " +
            "Call `get_menu` for each delivery date and pass the chosen `pick_id`s under `picks: { '<date>': ['<pick_id>', ...] }`."
        );
      }
    }

    // Resolve city (validates the agent passed a known city; same one used in find_diets).
    await ctx.client.cities.resolve(input.city);

    // Resolve profile address by index.
    const profileRaw = await ctx.client.authGet<unknown>(
      resolvedEmail,
      "/api/profile"
    );
    const profile = extractProfile(profileRaw);
    const addresses = profile.profileAddresses ?? [];
    if (input.address_index >= addresses.length) {
      throw new Error(
        `address_index ${input.address_index} is out of range — profile has ${addresses.length} address${addresses.length === 1 ? "" : "es"}. Rerun \`login\` to see them.`
      );
    }
    const { profileAddressId } = addresses[input.address_index];
    if (profileAddressId === undefined || !Number.isFinite(profileAddressId)) {
      throw new Error(
        `Profile address at index ${input.address_index} has no profileAddressId. Rerun \`login\` to refresh address list.`
      );
    }

    if (!input.confirmed) {
      const totalPicks = countPicks(input.picks);
      const summary = summarizeOrder(input, offer, resolvedEmail, totalPicks);
      // Try elicitation if the host advertises support; otherwise return a
      // text fallback that asks the agent to re-call with confirmed:true.
      if (ctx.server?.getClientCapabilities()?.elicitation) {
        const r = await ctx.server.elicitInput({
          message: `Place this order?\n\n${summary}`,
          requestedSchema: {
            properties: {
              confirm: {
                title:
                  input.test_order === true
                    ? "Place test order"
                    : "Place real order (will charge)",
                type: "boolean",
              },
            },
            required: ["confirm"],
            type: "object",
          },
        });
        if (
          r.action !== "accept" ||
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- elicitation result content is freeform per MCP spec; we expect { confirm: boolean }
          (r.content as { confirm?: boolean } | undefined)?.confirm !== true
        ) {
          return jsonResult({ reason: r.action, status: "cancelled", summary });
        }
      } else {
        return jsonResult({
          next: "Show the user this summary. If they agree, re-call place_order with `confirmed: true`.",
          status: "confirmation_required",
          summary,
        });
      }
    }

    return executeOrder(
      input,
      ctx.client,
      offer,
      resolvedEmail,
      profileAddressId
    );
  },
  inputSchema,
  name: "place_order",
  // No outputSchema: success returns { order_id, payment_url, raw }; the
  // confirmation/cancellation paths return raw CallToolResults. A
  // discriminated-union output schema isn't worth the complexity.
});
