import { z } from "zod";

import { defineTool } from "@/mcp/tool";

const inputSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

const outputSchema = z.object({
  authenticated: z.boolean(),
  email: z.string(),
  profile: z.unknown(),
  profile_address_ids: z.array(z.number()),
});

interface ProfileShape {
  profileAddresses?: { profileAddressId?: number }[];
}

const hasProfileField = (value: unknown): value is { profile?: unknown } =>
  value !== null && typeof value === "object" && "profile" in value;

const normalizeProfileResponse = (raw: unknown) => {
  const root = hasProfileField(raw) ? (raw.profile ?? raw) : raw;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- structural shape; unknown fields fall back to undefined and are guarded below
  const profile = (root ?? {}) as ProfileShape;
  const profile_address_ids = (profile.profileAddresses ?? [])
    .map((item) => item.profileAddressId)
    .filter((id): id is number => Number.isFinite(id));
  return { profile: root, profile_address_ids };
};

export const login = defineTool({
  annotations: { idempotentHint: true, openWorldHint: true },
  description:
    "Log in as a Dietly user with email + password. Caches the session " +
    "server-side keyed by email. Returns profile data with " +
    "`profileAddressId` values needed by `place_order`. Skip if you " +
    "have already called this in the current process.",
  execute: async (input, { client }) => {
    await client.login(input.email, input.password);
    const profileResponse = await client.authGet<unknown>(
      input.email,
      "/api/profile"
    );
    const normalized = normalizeProfileResponse(profileResponse);
    return {
      authenticated: true,
      email: input.email,
      profile: normalized.profile,
      profile_address_ids: normalized.profile_address_ids,
    };
  },
  inputSchema,
  name: "login",
  outputSchema,
});
