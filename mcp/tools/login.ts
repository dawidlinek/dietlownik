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
        .describe("Position in the account's address list."),
      label: z.string().describe("Human-readable summary of street + city."),
    })
  ),
  authenticated: z.boolean(),
  default_address_index: z
    .number()
    .int()
    .describe("The account's default delivery address."),
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
    "Log into the user's dietly account so `send_to_basket` can fill its " +
    "basket. The session lives in this MCP connection's memory only — the " +
    "password is not stored — and ends after 30 idle minutes or a server " +
    "restart. Returns the account's delivery addresses. Only call it with " +
    "credentials the user gave you for this purpose.",
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
          : "Logged in. send_to_basket can now fill this account's dietly basket.",
    };
  },
  inputSchema,
  name: "login",
  outputSchema,
});
