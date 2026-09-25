import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  clientFor,
  currentSession,
  decodeSession,
  dietlyMessage,
  encodeSession,
  isAuthError,
} from "@/lib/dietly-account";
import { BasketError } from "@/lib/dietly-basket";
import { sendBasket } from "@/lib/dietly-basket-send";
import { HttpError } from "@/scraper/api";

export const dynamic = "force-dynamic";

const dateRe = /^\d{4}-\d{2}-\d{2}$/u;

const bodySchema = z.object({
  city_id: z.number().int().positive(),
  company_id: z.string().min(1),
  days: z
    .array(
      z.object({
        date: z.string().regex(dateRe),
        offer_id: z.string().min(1),
        picks: z.array(
          z.object({
            meal_id: z.number().int().positive(),
            slot_name: z.string().min(1),
          })
        ),
      })
    )
    .min(1),
  promo_codes: z.array(z.string().min(1)).default([]),
  /** Overwrite a basket that holds another catering or the user's own picks. */
  replace: z.boolean().default(false),
});

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Next.js route handler signature requires NextRequest; cannot be made deeply readonly
export const POST = async (request: NextRequest) => {
  const session = decodeSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (session === null) {
    return NextResponse.json(
      { error: "Zaloguj się do dietly." },
      { status: 401 }
    );
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Nieprawidłowy wybór." },
      { status: 400 }
    );
  }
  const input = parsed.data;
  const client = clientFor(session);
  const { email } = session;

  const respond = (data: unknown, status = 200) => {
    const res = NextResponse.json(data, { status });
    const next = currentSession(client, email);
    if (next !== null && next.sessionCookie !== session.sessionCookie) {
      res.cookies.set(SESSION_COOKIE, encodeSession(next), {
        httpOnly: true,
        maxAge: SESSION_MAX_AGE_S,
        path: "/",
        sameSite: "strict",
        secure: request.nextUrl.protocol === "https:",
      });
    }
    return res;
  };

  try {
    const result = await sendBasket(client, email, {
      cityId: input.city_id,
      companyId: input.company_id,
      days: input.days,
      promoCodes: input.promo_codes,
      replace: input.replace,
    });
    if (result.kind === "conflict") {
      return respond({ error: "conflict", existing: result.existing }, 409);
    }
    if (result.kind === "not_stored") {
      return respond(
        { error: "dietly wyceniło koszyk, ale go nie zapisało." },
        502
      );
    }
    const { kind: _kind, ...sent } = result;
    return respond(sent);
  } catch (error) {
    if (error instanceof BasketError) {
      return respond({ error: error.message }, 422);
    }
    if (isAuthError(error)) {
      const res = NextResponse.json(
        { error: "Sesja dietly wygasła — zaloguj się ponownie." },
        { status: 401 }
      );
      res.cookies.delete(SESSION_COOKIE);
      return res;
    }
    console.error("[dietly/basket] handoff failed", error);
    return respond(
      { error: dietlyMessage(error) },
      error instanceof HttpError && error.status < 500 ? 422 : 502
    );
  }
};
