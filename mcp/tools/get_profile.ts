import { z } from "zod";

import { defineTool } from "@/mcp/tool";

const inputSchema = z.object({
  email: z.email(),
});

const outputSchema = z.object({
  email: z.string(),
  profile: z.unknown(),
  profile_address_ids: z.array(z.number()),
});

interface ProfileShape {
  profileAddresses?: { profileAddressId?: number }[];
}

function normalizeProfileResponse(raw: unknown) {
  const root = (raw as { profile?: unknown } | null)?.profile ?? raw;
  const profile = (root ?? {}) as ProfileShape;
  const profile_address_ids = (profile.profileAddresses ?? [])
    .map((item) => item.profileAddressId)
    .filter((id): id is number => Number.isFinite(id));
  return { profile: root, profile_address_ids };
}

export const get_profile = defineTool({
  annotations: { openWorldHint: true, readOnlyHint: true },
  description:
    "Fetch profile details (incl. `profileAddressId` values) for an " +
    "already-logged-in email. Use this when the cached session is still " +
    "valid; if the email isn't logged in yet, call `login` first.",
  execute: async (input, { client }) => {
    const profileResponse = await client.authGet<unknown>(
      input.email,
      "/api/profile"
    );
    const normalized = normalizeProfileResponse(profileResponse);
    return {
      email: input.email,
      profile: normalized.profile,
      profile_address_ids: normalized.profile_address_ids,
    };
  },
  inputSchema,
  name: "get_profile",
  outputSchema,
});
