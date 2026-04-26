import { z } from "zod";
import { authGet, loginRequest } from "@/mcp/api";
import { setSession } from "@/mcp/session";

export const loginInputSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export type LoginInput = z.infer<typeof loginInputSchema>;

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

export async function loginTool(input: LoginInput) {
  const session = await loginRequest(input.email, input.password);
  setSession(input.email, session.rememberMe, session.sessionCookie);

  const profileResponse = await authGet<unknown>(input.email, "/api/mobile/profile");
  const normalized = normalizeProfileResponse(profileResponse);

  return {
    email: input.email,
    authenticated: true,
    profile: normalized.profile,
    profile_address_ids: normalized.profileAddressIds,
  };
}
