import { z } from "zod";
import { authGet } from "@/mcp/api";

export const getProfileInputSchema = z.object({
  email: z.string().email(),
});

export type GetProfileInput = z.infer<typeof getProfileInputSchema>;

function normalizeProfileResponse(raw: unknown) {
  const root = (raw as { profile?: unknown } | null)?.profile ?? raw;
  const profile = (root ?? {}) as {
    profileAddresses?: Array<{ profileAddressId?: number }>;
  };

  const profileAddressIds = (profile.profileAddresses ?? [])
    .map((item) => item?.profileAddressId)
    .filter((id): id is number => Number.isFinite(id));

  return { profile: root, profileAddressIds };
}

export async function getProfileTool(input: GetProfileInput) {
  const profileResponse = await authGet<unknown>(input.email, "/api/mobile/profile");
  const normalized = normalizeProfileResponse(profileResponse);

  return {
    email: input.email,
    profile: normalized.profile,
    profile_address_ids: normalized.profileAddressIds,
  };
}
