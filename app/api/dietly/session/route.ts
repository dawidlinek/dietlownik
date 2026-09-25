import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  decodeSession,
  dietlyMessage,
  encodeSession,
  isAuthError,
} from "@/lib/dietly-account";
import { DietlyClient } from "@/mcp/client";
import { HttpError } from "@/scraper/api";

export const dynamic = "force-dynamic";

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Next.js route handler signature requires NextRequest; cannot be made deeply readonly
const cookieOptions = (request: NextRequest) => ({
  httpOnly: true,
  maxAge: SESSION_MAX_AGE_S,
  path: "/",
  sameSite: "strict" as const,
  // `secure` only when actually served over https — the Docker image is often
  // reached over plain http on a LAN, where a secure cookie would never stick.
  secure: request.nextUrl.protocol === "https:",
});

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Next.js route handler signature requires NextRequest; cannot be made deeply readonly
export const GET = (request: NextRequest) => {
  const session = decodeSession(request.cookies.get(SESSION_COOKIE)?.value);
  return NextResponse.json(
    session === null
      ? { email: null, logged_in: false }
      : { email: session.email, logged_in: true }
  );
};

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Next.js route handler signature requires NextRequest; cannot be made deeply readonly
export const POST = async (request: NextRequest) => {
  const parsed = loginSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Podaj email i hasło." },
      { status: 400 }
    );
  }
  const { email, password } = parsed.data;

  try {
    const { rememberMe, sessionCookie } = await new DietlyClient().login(
      email,
      password
    );
    const res = NextResponse.json({ email, logged_in: true });
    res.cookies.set(
      SESSION_COOKIE,
      encodeSession({ email, rememberMe, sessionCookie }),
      cookieOptions(request)
    );
    return res;
  } catch (error) {
    if (
      isAuthError(error) ||
      (error instanceof HttpError && error.status === 400)
    ) {
      return NextResponse.json(
        { error: "dietly nie przyjęło tego emaila i hasła." },
        { status: 401 }
      );
    }
    console.error("[dietly/session] login failed", error);
    return NextResponse.json({ error: dietlyMessage(error) }, { status: 502 });
  }
};

export const DELETE = () => {
  const res = NextResponse.json({ email: null, logged_in: false });
  res.cookies.delete(SESSION_COOKIE);
  return res;
};
