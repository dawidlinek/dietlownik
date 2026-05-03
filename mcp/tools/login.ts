import { z } from "zod";

import { defineTool } from "@/mcp/tool";

const inputSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

const outputSchema = z.object({
  addresses: z.array(
    z.object({
      address_index: z
        .number()
        .int()
        .describe("Pass to place_order's `address_index` (0 = default)."),
      label: z.string().describe("Human-readable summary of street + city."),
    })
  ),
  authenticated: z.boolean(),
  default_address_index: z
    .number()
    .int()
    .describe("Index used when place_order's address_index is omitted."),
  email: z.string(),
  hint: z.string(),
});

interface AddressShape {
  readonly profileAddressId?: number;
  readonly street?: string | null;
  readonly streetNumber?: string | null;
  readonly flatNumber?: string | null;
  readonly postalCode?: string | null;
  readonly city?: string | null;
  readonly addressName?: string | null;
}

interface ProfileShape {
  readonly profileAddresses?: readonly AddressShape[];
  readonly defaultProfileAddressId?: number | null;
}

const hasProfileField = (value: unknown): value is { profile?: unknown } =>
  value !== null && typeof value === "object" && "profile" in value;

const labelOf = (a: Readonly<AddressShape>): string => {
  const parts: string[] = [];
  if (
    a.addressName !== undefined &&
    a.addressName !== null &&
    a.addressName !== ""
  ) {
    parts.push(a.addressName);
  }
  const street = [a.street, a.streetNumber]
    .filter((s): s is string => s !== undefined && s !== null && s !== "")
    .join(" ");
  const flat =
    a.flatNumber !== undefined && a.flatNumber !== null && a.flatNumber !== ""
      ? `/${a.flatNumber}`
      : "";
  if (street !== "") {
    parts.push(`${street}${flat}`);
  }
  const cityPart = [a.postalCode, a.city]
    .filter((s): s is string => s !== undefined && s !== null && s !== "")
    .join(" ");
  if (cityPart !== "") {
    parts.push(cityPart);
  }
  return parts.length > 0 ? parts.join(", ") : "Address (no street info)";
};

export const login = defineTool({
  annotations: { idempotentHint: true, openWorldHint: true },
  description:
    "Log into Dietly with email + password. Caches the session for the rest " +
    "of this MCP conversation so other tools (place_order, etc.) can omit the " +
    "email argument. Returns the user's delivery addresses with stable " +
    "`address_index` slots. Call once per conversation.",
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ctx (ToolContext) embeds the DietlyClient class instance; tool only invokes its public methods
  execute: async (input, ctx) => {
    await ctx.client.login(input.email, input.password);
    const profileResponse = await ctx.client.authGet<unknown>(
      input.email,
      "/api/profile"
    );
    const root = hasProfileField(profileResponse)
      ? (profileResponse.profile ?? profileResponse)
      : profileResponse;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- structural shape; unknown fields fall back to undefined and are guarded below
    const profile = (root ?? {}) as ProfileShape;
    const rawAddresses = profile.profileAddresses ?? [];
    interface AddressRow {
      readonly address_index: number;
      readonly id: number | undefined;
      readonly label: string;
    }
    const addresses: readonly AddressRow[] = rawAddresses
      .map(
        (a, idx): AddressRow => ({
          address_index: idx,
          id: a.profileAddressId,
          label: labelOf(a),
        })
      )
      .filter((a: Readonly<AddressRow>) => Number.isFinite(a.id));
    const defaultId = profile.defaultProfileAddressId;
    const defaultIdx = addresses.findIndex(
      (a: Readonly<AddressRow>) => a.id === defaultId
    );
    const default_address_index = Math.max(0, defaultIdx);
    return {
      addresses: addresses.map(
        ({ address_index, label }: Readonly<AddressRow>) => ({
          address_index,
          label,
        })
      ),
      authenticated: true,
      default_address_index,
      email: input.email,
      hint:
        addresses.length === 0
          ? "No addresses on this account — set one in the Dietly app before placing orders."
          : `Use find_diets to discover offers, then quote_order for pricing or place_order to buy. address_index defaults to ${default_address_index}.`,
    };
  },
  inputSchema,
  name: "login",
  outputSchema,
});
