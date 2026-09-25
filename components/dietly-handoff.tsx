"use client";

import * as React from "react";

import { formatPriceNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

// Hands the day-by-day selection to the user's dietly account basket via
// /api/dietly/basket. dietly's basket holds one catering at a time, so the
// selection is split per catering and sent one by one — each send replaces
// the basket, which is why a clash with another catering asks first.

export interface HandoffDay {
  readonly date: string;
  readonly weekday: string;
  readonly offer_id: string;
  readonly price_per_day: number;
  readonly picks: readonly {
    readonly slot_name: string;
    readonly meal_id: number;
  }[];
}

export interface HandoffGroup {
  readonly company_id: string;
  readonly company_name: string;
  readonly promo_codes: readonly string[];
  readonly days: readonly HandoffDay[];
}

interface Session {
  readonly logged_in: boolean;
  readonly email: string | null;
}

interface SentBasket {
  readonly basket_url: string;
  readonly total: number | null;
  readonly delivery: number | null;
  readonly promo_dropped: string | null;
}

type SendState =
  | { readonly kind: "idle" }
  | { readonly kind: "sending" }
  | { readonly kind: "sent"; readonly basket: SentBasket }
  | { readonly kind: "conflict"; readonly company: string | null }
  | { readonly kind: "error"; readonly message: string };

const IDLE: SendState = { kind: "idle" };

const dayLabel = (d: Readonly<HandoffDay>): string =>
  `${d.weekday} ${Number(d.date.slice(8, 10))}.${d.date.slice(5, 7)}`;

/** Up to three days read fine as a list; longer runs collapse to a range. */
const datesLabel = (days: readonly HandoffDay[]): string => {
  const sorted = days.toSorted((a, b) => a.date.localeCompare(b.date));
  if (sorted.length <= 3) {
    return sorted.map(dayLabel).join(" · ");
  }
  return `${dayLabel(sorted[0])} → ${dayLabel(sorted.at(-1) ?? sorted[0])} · ${sorted.length} dni`;
};

const dietWord = (n: number): string => {
  if (n === 1) {
    return "dieta";
  }
  return n >= 2 && n <= 4 ? "diety" : "diet";
};

const errorOf = (data: unknown, fallback: string): string =>
  data !== null &&
  typeof data === "object" &&
  "error" in data &&
  typeof data.error === "string"
    ? data.error
    : fallback;

// ── Login ───────────────────────────────────────────────────────────────────

const LoginForm = ({
  onLoggedIn,
}: Readonly<{ onLoggedIn: (s: Session) => void }>) => {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/dietly/session", {
        body: JSON.stringify({ email, password }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setError(errorOf(data, "Logowanie nie powiodło się."));
        return;
      }
      setPassword("");
      onLoggedIn({ email, logged_in: true });
    } finally {
      setBusy(false);
    }
  };

  const field =
    "h-8 min-w-0 flex-1 rounded-sm border border-[var(--color-border)] bg-[var(--color-linen)] px-2.5 text-[13px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-3)] focus:outline-none focus:border-[var(--color-amber)]";

  return (
    <form
      className="flex flex-col gap-1.5"
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React.SubmitEvent has DOM refs (target/currentTarget) that cannot be deeply readonly
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <input
          autoComplete="username"
          className={field}
          // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React.ChangeEvent has DOM refs (target/currentTarget) that cannot be deeply readonly
          onChange={(e) => {
            setEmail(e.target.value);
          }}
          placeholder="email w dietly"
          required
          type="email"
          value={email}
        />
        <input
          autoComplete="current-password"
          className={field}
          // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React.ChangeEvent has DOM refs (target/currentTarget) that cannot be deeply readonly
          onChange={(e) => {
            setPassword(e.target.value);
          }}
          placeholder="hasło"
          required
          type="password"
          value={password}
        />
        <button
          className="h-8 px-3.5 rounded-sm text-[13px] border border-[var(--color-ink-2)] text-[var(--color-ink)] hover:bg-[var(--color-oat)] disabled:opacity-50"
          disabled={busy}
          type="submit"
        >
          {busy ? "loguję…" : "zaloguj"}
        </button>
      </div>
      <p className="text-[11px] text-[var(--color-ink-3)]">
        {error ?? (
          <>
            Hasło idzie tylko do dietly. Zostaje ciasteczko sesji w tej
            przeglądarce.
          </>
        )}
      </p>
    </form>
  );
};

// ── One catering row ────────────────────────────────────────────────────────

const GroupRow = ({
  group,
  loggedIn,
  onSend,
  state,
}: Readonly<{
  group: HandoffGroup;
  loggedIn: boolean;
  onSend: (replace: boolean) => void;
  state: SendState;
}>) => {
  const estimate = group.days.reduce((acc, d) => acc + d.price_per_day, 0);
  const diets = new Set(group.days.map((d) => d.offer_id)).size;

  const action = (() => {
    if (state.kind === "sending") {
      return (
        <span className="text-[13px] text-[var(--color-ink-3)]">wysyłam…</span>
      );
    }
    if (state.kind === "sent") {
      return (
        <a
          className="text-[13px] text-[var(--color-olive)] underline decoration-[var(--color-olive)]/40 underline-offset-4 hover:decoration-[var(--color-olive)]"
          href={state.basket.basket_url}
          rel="noreferrer"
          target="_blank"
        >
          otwórz koszyk ↗
        </a>
      );
    }
    if (state.kind === "conflict") {
      return (
        <button
          className="text-[13px] text-[var(--color-clay)] underline decoration-[var(--color-clay)]/40 underline-offset-4 hover:decoration-[var(--color-clay)]"
          onClick={() => {
            onSend(true);
          }}
          type="button"
        >
          zastąp
        </button>
      );
    }
    return (
      <button
        className="h-7 px-3 rounded-sm text-[13px] border border-[var(--color-amber)] text-[var(--color-amber-deep)] hover:bg-[var(--color-amber-tint)] disabled:opacity-40 disabled:hover:bg-transparent"
        disabled={!loggedIn}
        onClick={() => {
          onSend(false);
        }}
        type="button"
      >
        {state.kind === "error" ? "ponów" : "do koszyka"}
      </button>
    );
  })();

  const note = (() => {
    if (state.kind === "sent") {
      const { delivery, promo_dropped, total } = state.basket;
      return (
        <span className="text-[var(--color-olive)]">
          w koszyku dietly
          {total === null ? "" : ` · ${formatPriceNumber(total)} zł`}
          {delivery !== null && delivery > 0
            ? ` (w tym dostawa ${formatPriceNumber(delivery)} zł)`
            : ""}
          {promo_dropped === null ? "" : ` · bez kodu: ${promo_dropped}`}
        </span>
      );
    }
    if (state.kind === "conflict") {
      return (
        <span className="text-[var(--color-clay)]">
          {state.company !== null && state.company !== group.company_id
            ? `w koszyku dietly jest ${state.company} — wysłanie go zastąpi`
            : "koszyk dietly ma twoje zmiany — wysłanie je zastąpi"}
        </span>
      );
    }
    if (state.kind === "error") {
      return <span className="text-[var(--color-clay)]">{state.message}</span>;
    }
    return null;
  })();

  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-5 gap-y-0.5 py-2.5 border-t border-[var(--color-border)] first:border-t-0">
      <div className="min-w-0">
        <span className="font-display text-[16px] text-[var(--color-ink)]">
          {group.company_name}
        </span>
        <span className="ml-3 text-[12px] text-[var(--color-ink-3)] tnum">
          {datesLabel(group.days)}
          {diets > 1 ? ` · ${diets} ${dietWord(diets)}` : ""}
        </span>
      </div>
      <span className="text-[13px] text-[var(--color-ink-2)] tnum text-right">
        {formatPriceNumber(estimate)} zł
      </span>
      <div className="text-right min-w-[7.5rem]">{action}</div>
      {note === null ? null : (
        <div className="col-span-3 text-[12px] leading-snug">{note}</div>
      )}
    </li>
  );
};

// ── Panel ───────────────────────────────────────────────────────────────────

export const DietlyHandoff = ({
  cityId,
  groups,
}: Readonly<{ cityId: number; groups: readonly HandoffGroup[] }>) => {
  const [session, setSession] = React.useState<Session | null>(null);
  const [states, setStates] = React.useState<
    Readonly<Record<string, SendState>>
  >({});

  React.useEffect(() => {
    const ctrl = new AbortController();
    const load = async () => {
      try {
        const res = await fetch("/api/dietly/session", { signal: ctrl.signal });
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape set by /api/dietly/session GET
        setSession((await res.json()) as Session);
      } catch {
        // Aborted on unmount, or the route is down.
        setSession({ email: null, logged_in: false });
      }
    };
    void load();
    return () => {
      ctrl.abort();
    };
  }, []);

  // A sent basket reflects the selection at send time; once the user changes
  // a day, its row goes back to "do koszyka".
  const fingerprint = React.useMemo(
    () =>
      Object.fromEntries(
        groups.map((g) => [g.company_id, JSON.stringify(g.days)])
      ),
    [groups]
  );
  const sentFor = React.useRef<Record<string, string>>({});
  React.useEffect(() => {
    setStates((prev) => {
      let changed = false;
      const next: Record<string, SendState> = { ...prev };
      for (const [company, state] of Object.entries(prev)) {
        if (
          state.kind !== "idle" &&
          sentFor.current[company] !== fingerprint[company]
        ) {
          next[company] = IDLE;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [fingerprint]);

  const setState = (company: string, state: SendState) => {
    setStates((prev) => ({ ...prev, [company]: state }));
  };

  const send = async (group: Readonly<HandoffGroup>, replace: boolean) => {
    sentFor.current[group.company_id] = fingerprint[group.company_id] ?? "";
    setState(group.company_id, { kind: "sending" });
    try {
      const res = await fetch("/api/dietly/basket", {
        body: JSON.stringify({
          city_id: cityId,
          company_id: group.company_id,
          days: group.days.map((d) => ({
            date: d.date,
            offer_id: d.offer_id,
            picks: d.picks,
          })),
          promo_codes: group.promo_codes,
          replace,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const data: unknown = await res.json().catch(() => null);
      if (
        res.status === 409 &&
        data !== null &&
        typeof data === "object" &&
        "existing" in data
      ) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape set by /api/dietly/basket's 409 branch
        const existing = data.existing as { company_id: string | null };
        setState(group.company_id, {
          company: existing.company_id,
          kind: "conflict",
        });
        return;
      }
      if (res.status === 401) {
        setSession({ email: null, logged_in: false });
      }
      if (!res.ok) {
        setState(group.company_id, {
          kind: "error",
          message: errorOf(data, `błąd ${res.status}`),
        });
        return;
      }
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- success shape set by /api/dietly/basket
      const basket = data as SentBasket;
      // Every other catering's "sent" is now stale: the basket holds this one.
      setStates((prev) => {
        const next: Record<string, SendState> = {};
        for (const [company, state] of Object.entries(prev)) {
          next[company] = state.kind === "sent" ? IDLE : state;
        }
        next[group.company_id] = { basket, kind: "sent" };
        return next;
      });
    } catch {
      setState(group.company_id, {
        kind: "error",
        message: "Brak połączenia z serwerem.",
      });
    }
  };

  const logout = async () => {
    await fetch("/api/dietly/session", { method: "DELETE" }).catch(() => null);
    setSession({ email: null, logged_in: false });
    setStates({});
  };

  const loggedIn = session?.logged_in === true;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
          do koszyka dietly
        </span>
        {loggedIn ? (
          <span className="text-[12px] text-[var(--color-ink-3)] truncate">
            {session.email} ·{" "}
            <button
              className="underline underline-offset-4 decoration-[var(--color-ink-3)]/40 hover:text-[var(--color-ink-2)]"
              onClick={() => {
                void logout();
              }}
              type="button"
            >
              wyloguj
            </button>
          </span>
        ) : null}
      </div>

      {session !== null && !loggedIn ? (
        <LoginForm onLoggedIn={setSession} />
      ) : null}

      <ul className={cn(!loggedIn && "opacity-60")}>
        {groups.map((g) => (
          <GroupRow
            group={g}
            key={g.company_id}
            loggedIn={loggedIn}
            onSend={(replace) => {
              void send(g, replace);
            }}
            state={states[g.company_id] ?? IDLE}
          />
        ))}
      </ul>

      {groups.length > 1 ? (
        <p className="text-[11px] text-[var(--color-ink-3)] sm:whitespace-nowrap">
          Koszyk dietly mieści jeden catering naraz. Wyślij, zapłać w dietly,
          wróć po następny — kolejne wysłanie zastępuje koszyk.
        </p>
      ) : null}
    </div>
  );
};

// ── Popup ───────────────────────────────────────────────────────────────────

/**
 * `zamów` opens the handoff as a modal. Native `<dialog>`: `showModal()`
 * gives the focus trap, Esc-to-close and top-layer stacking for free, so no
 * dialog dependency is needed. The handoff stays mounted while closed, which
 * keeps each catering's "w koszyku" state across close and reopen.
 */
export const DietlyHandoffDialog = ({
  cityId,
  groups,
  onClose,
  open,
}: Readonly<{
  cityId: number;
  groups: readonly HandoffGroup[];
  onClose: () => void;
  open: boolean;
}>) => {
  const ref = React.useRef<HTMLDialogElement>(null);

  React.useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      aria-label="Zamówienie"
      className="m-auto w-[min(760px,calc(100vw-32px))] max-h-[85vh] p-0 rounded-sm border border-[var(--color-bone)] bg-[var(--color-cream)] text-[var(--color-ink)] shadow-[0_24px_48px_-16px_oklch(22%_0.018_60_/_0.35)] backdrop:bg-[oklch(22%_0.018_60_/_0.35)]"
      // The dialog box has no padding of its own, so a click whose target is
      // the <dialog> itself landed on the backdrop.
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React.MouseEvent has DOM refs (target/currentTarget) that cannot be deeply readonly
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      // Route Esc through React state too, so `open` never drifts from the
      // element: the browser's own cancel path, plus a keydown fallback for
      // the cases where Chrome's close-watcher swallows a repeated Esc.
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React.SyntheticEvent has DOM refs (target/currentTarget) that cannot be deeply readonly
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClose={onClose}
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React.KeyboardEvent has DOM refs (target/currentTarget) that cannot be deeply readonly
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
      ref={ref}
    >
      <div className="px-6 pt-5 pb-6 flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="font-display text-[22px] leading-none">Zamówienie</h2>
          <button
            className="text-[13px] text-[var(--color-ink-3)] underline underline-offset-4 decoration-[var(--color-ink-3)]/40 hover:text-[var(--color-ink-2)]"
            onClick={onClose}
            type="button"
          >
            zamknij
          </button>
        </div>
        <DietlyHandoff cityId={cityId} groups={groups} />
      </div>
    </dialog>
  );
};
