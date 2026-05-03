"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

import { PriceHistoryChart } from "@/components/price-history-chart";
import type { HistoryPoint } from "@/components/price-history-chart";
import {
  formatDate,
  formatDelta,
  formatInt,
  formatPriceNumber,
} from "@/lib/format";
import type {
  CampaignRow,
  CateringTile,
  LeafRow,
  VariantMealRow,
} from "@/lib/queries";
import { cn } from "@/lib/utils";

// Canonical daily order (lowercased compare). Anything unknown sorts last.
const SLOT_ORDER: readonly string[] = [
  "śniadanie",
  "i śniadanie",
  "ii śniadanie",
  "drugie śniadanie",
  "obiad",
  "podwieczorek",
  "przekąska",
  "kolacja",
];

const slotRank = (name: string): number => {
  const k = name.trim().toLowerCase();
  for (let i = 0; i < SLOT_ORDER.length; i += 1) {
    const needle = SLOT_ORDER[i];
    if (
      k === needle ||
      k.startsWith(`${needle} `) ||
      k.startsWith(`${needle}-`)
    ) {
      return i;
    }
  }
  return SLOT_ORDER.length;
};

const groupMealsBySlot = (
  meals: VariantMealRow[]
): { slot: string; meals: VariantMealRow[] }[] => {
  const buckets = new Map<string, VariantMealRow[]>();
  for (const m of meals) {
    const list = buckets.get(m.slot_name) ?? [];
    list.push(m);
    buckets.set(m.slot_name, list);
  }
  const slots = [...buckets.keys()];
  slots.sort((a, b) => {
    const ra = slotRank(a);
    const rb = slotRank(b);
    if (ra !== rb) {
      return ra - rb;
    }
    return a.localeCompare(b, "pl");
  });
  return slots.map((slot) => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- slot was just iterated from buckets.keys()
    const slotMeals = buckets.get(slot)!;
    return { meals: slotMeals, slot };
  });
};

const DEFAULT_VISIBLE_COLLAPSED = 5;

interface PromoChip {
  code: string;
  discountPct: number | null;
  scope: "company" | "global";
}

// Polish pluralization (1 / 2..4 / 5+).
const plural = (n: number, one: string, few: string, many: string): string => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (n === 1) {
    return one;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) {
    return few;
  }
  return many;
};

const leafKey = (l: LeafRow): string =>
  `${l.diet_calories_id}::${l.tier_id ?? "x"}::${l.diet_option_id ?? "x"}`;

// ── small leaf renderers ─────────────────────────────────────────────────────

const Th = ({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) => (
  <th
    className={cn(
      "text-left text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] font-medium py-2 px-3",
      className
    )}
  >
    {children}
  </th>
);

const Chip = ({ chip }: { chip: PromoChip }) => {
  const isCompany = chip.scope === "company";
  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-1 px-2 py-0.5 rounded text-[12px] tnum",
        isCompany
          ? "bg-[var(--color-amber-tint)] text-[var(--color-ink)]"
          : "border border-[var(--color-bone)] text-[var(--color-ink-2)]"
      )}
      title={isCompany ? "Kod firmowy" : "Kod globalny"}
    >
      <span
        className="font-display"
        style={{ fontVariantCaps: "small-caps", fontWeight: 500 }}
      >
        {chip.code}
      </span>
      {chip.discountPct !== null && (
        <span className="text-[var(--color-amber-deep)]">
          −{chip.discountPct.toFixed(0)}%
        </span>
      )}
    </span>
  );
};

const MealLine = ({ meal }: { meal: VariantMealRow }) => {
  const fullTitle =
    meal.label === null || meal.label === ""
      ? meal.name
      : `${meal.name} — ${meal.label}`;
  return (
    <li className="py-1.5 flex items-baseline gap-3">
      <span
        className="flex-1 min-w-0 truncate text-[13px] text-[var(--color-ink)]"
        title={fullTitle}
      >
        {meal.name}
      </span>
      {meal.kcal != null && (
        <span className="tnum text-[12px] text-[var(--color-ink-2)] whitespace-nowrap">
          {Math.round(meal.kcal)}
          <span className="ml-0.5 text-[var(--color-ink-3)]">kcal</span>
        </span>
      )}
      {meal.occurrences > 1 && (
        <span
          className="tnum text-[11px] text-[var(--color-ink-3)] whitespace-nowrap"
          title={`Pojawia się w ${meal.occurrences} dniach`}
        >
          ×{meal.occurrences}
        </span>
      )}
      <span
        className="tnum text-[11px] text-[var(--color-ink-3)]/80 whitespace-nowrap"
        title="Ostatnio widziane"
      >
        {meal.last_seen_date.slice(5)}
      </span>
    </li>
  );
};

type MealsState =
  | { kind: "loading" }
  | { kind: "ready"; meals: VariantMealRow[] }
  | { kind: "error" };

const MealsBySlot = ({ state }: { state: MealsState | undefined }) => {
  if (state === undefined || state.kind === "loading") {
    return (
      <div className="space-y-2">
        <div className="h-3 w-1/3 rounded bg-[var(--color-oat)]/60" />
        <div className="h-3 w-2/3 rounded bg-[var(--color-oat)]/60" />
        <div className="h-3 w-1/2 rounded bg-[var(--color-oat)]/60" />
        <div className="h-3 w-2/3 rounded bg-[var(--color-oat)]/60" />
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <p className="text-[12px] text-[var(--color-ink-3)]">
        Nie udało się pobrać menu — spróbuj ponownie.
      </p>
    );
  }
  if (state.meals.length === 0) {
    return (
      <p className="text-[12px] text-[var(--color-ink-3)]">
        Brak menu w bazie dla tego wariantu (jeszcze nie zescrapowane).
      </p>
    );
  }
  const groups = groupMealsBySlot(state.meals);
  return (
    <div className="space-y-4">
      {groups.map(({ meals, slot }) => (
        <div key={slot}>
          <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] font-medium mb-1.5">
            {slot}
            <span className="ml-1.5 tnum text-[var(--color-ink-3)]/70">
              · {meals.length}
            </span>
          </p>
          <ul className="divide-y divide-[var(--color-bone)]">
            {meals.map((m) => (
              <MealLine key={`${slot}-${m.meal_id}`} meal={m} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
};

const LeafMealsInline = ({ state }: { state: MealsState | undefined }) => {
  if (state === undefined || state.kind === "loading") {
    return (
      <div className="space-y-2">
        <div className="h-3 w-1/3 rounded bg-[var(--color-oat)]/60" />
        <div className="h-3 w-2/3 rounded bg-[var(--color-oat)]/60" />
        <div className="h-3 w-1/2 rounded bg-[var(--color-oat)]/60" />
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <p className="text-[12px] text-[var(--color-ink-3)]">
        Nie udało się pobrać menu — spróbuj ponownie.
      </p>
    );
  }
  return <MealsBySlot state={state} />;
};

const LeafRowDisplay = ({
  highlight,
  leaf,
  onToggle,
  open,
}: {
  leaf: LeafRow;
  highlight: boolean;
  open: boolean;
  onToggle: () => void;
}) => {
  const dietLine = [leaf.diet_name, leaf.tier_name, leaf.diet_option_name]
    .filter(Boolean)
    .join(" · ");
  return (
    <tr
      aria-expanded={open}
      className={cn(
        "border-t border-[var(--color-bone)] cursor-pointer hover:bg-[var(--color-oat)]/40 transition-colors",
        highlight && !open && "bg-[var(--color-amber-tint)]/35",
        open && "bg-[var(--color-amber-tint)]/55"
      )}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <td className="py-2 px-3">
        <span
          aria-hidden
          className={cn(
            "inline-block w-3 mr-1 text-[var(--color-ink-3)] tnum text-[10px] transition-transform",
            open && "rotate-90"
          )}
        >
          ›
        </span>
        <span>{dietLine || "—"}</span>
      </td>
      <td className="py-2 px-3 tnum text-[var(--color-ink-2)]">
        {leaf.calories == null ? "—" : formatInt(leaf.calories)}
      </td>
      <td className="py-2 px-3 text-right tnum pr-3">
        {formatPriceNumber(leaf.effective_per_day)}
        <span className="ml-1 text-[var(--color-ink-3)]">zł</span>
      </td>
    </tr>
  );
};

// ── pagination ───────────────────────────────────────────────────────────────

const PageLink = ({
  active,
  ariaLabel,
  children,
  disabled,
  href,
}: {
  href: string;
  children: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
}) => {
  if (disabled === true) {
    return (
      <span
        aria-disabled="true"
        aria-label={ariaLabel}
        className="px-2.5 py-1 rounded-full text-[var(--color-ink-3)]/40"
      >
        {children}
      </span>
    );
  }
  return (
    <Link
      aria-current={active === true ? "page" : undefined}
      aria-label={ariaLabel}
      className={cn(
        "px-2.5 py-1 rounded-full transition-colors",
        active === true
          ? "bg-[var(--color-amber-tint)] text-[var(--color-ink)]"
          : "text-[var(--color-ink-2)] hover:bg-[var(--color-oat)]"
      )}
      href={href}
    >
      {children}
    </Link>
  );
};

const Pagination = ({
  page,
  totalPages,
}: {
  page: number;
  totalPages: number;
}) => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const hrefFor = React.useCallback(
    (n: number) => {
      const sp = new URLSearchParams(searchParams.toString());
      if (n <= 1) {
        sp.delete("page");
      } else {
        sp.set("page", String(n));
      }
      const qs = sp.toString();
      return qs ? `${pathname}?${qs}` : pathname;
    },
    [pathname, searchParams]
  );

  React.useEffect(() => {
    // Prefetch neighbours so paging feels instant.
    if (page > 1) {
      router.prefetch(hrefFor(page - 1));
    }
    if (page < totalPages) {
      router.prefetch(hrefFor(page + 1));
    }
  }, [page, totalPages, hrefFor, router]);

  if (totalPages <= 1) {
    return null;
  }

  const items: number[] = [];
  // Compact bar: 1 … (page-1) page (page+1) … last
  const push = (n: number) => {
    if (n >= 1 && n <= totalPages && !items.includes(n)) {
      items.push(n);
    }
  };
  push(1);
  push(page - 1);
  push(page);
  push(page + 1);
  push(totalPages);
  items.sort((a, b) => a - b);

  return (
    <nav
      aria-label="Paginacja firm"
      className="mt-10 flex items-center gap-2 text-[13px] tnum"
    >
      <PageLink
        ariaLabel="Poprzednia strona"
        disabled={page <= 1}
        href={hrefFor(page - 1)}
      >
        ‹
      </PageLink>
      {items.map((n, i) => (
        <React.Fragment key={n}>
          {i > 0 && items[i] > items[i - 1] + 1 && (
            <span className="text-[var(--color-ink-3)]">…</span>
          )}
          <PageLink active={n === page} href={hrefFor(n)}>
            {n}
          </PageLink>
        </React.Fragment>
      ))}
      <PageLink
        ariaLabel="Następna strona"
        disabled={page >= totalPages}
        href={hrefFor(page + 1)}
      >
        ›
      </PageLink>
    </nav>
  );
};

// ── expanded panel ───────────────────────────────────────────────────────────

const isAbortError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const named = error as { name?: unknown };
  return named.name === "AbortError";
};

const CateringDrilldown = ({
  cityId,
  days,
  dietlyUrl,
  id,
  tile,
}: {
  id: string;
  tile: CateringTile;
  cityId: number;
  days: number;
  dietlyUrl: string;
}) => {
  // Always-visible: the leaf table. Lazy-loaded: history for the cheapest leaf.
  const [historyState, setHistoryState] = React.useState<{
    history: HistoryPoint[] | null;
    loading: boolean;
  }>({ history: null, loading: true });

  const { cheapest } = tile;
  const abortRef = React.useRef<AbortController | null>(null);

  React.useEffect(() => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setHistoryState({ history: null, loading: true });
    void (async () => {
      try {
        const u = new URL("/api/price-history", window.location.origin);
        u.searchParams.set("company_id", cheapest.company_id);
        u.searchParams.set(
          "diet_calories_id",
          String(cheapest.diet_calories_id)
        );
        u.searchParams.set("city_id", String(cityId));
        u.searchParams.set("days", String(days));
        const res = await fetch(u.toString(), { signal: ctrl.signal });
        if (ctrl.signal.aborted) {
          return;
        }
        const data = res.ok
          ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- API contract enforced by /api/price-history route
            ((await res.json()) as { history: HistoryPoint[] })
          : { history: [] };
        if (!ctrl.signal.aborted) {
          setHistoryState({ history: data.history, loading: false });
        }
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }
        setHistoryState({ history: [], loading: false });
      }
    })();
    return () => {
      ctrl.abort();
    };
  }, [cheapest.company_id, cheapest.diet_calories_id, cityId, days]);

  // Per-leaf meals cache, keyed by leafKey. Single in-flight controller so a
  // rapid second click cancels the first request.
  const [mealsCache, setMealsCache] = React.useState<Map<string, MealsState>>(
    () => new Map()
  );
  const mealsAbortRef = React.useRef<AbortController | null>(null);
  const requestedRef = React.useRef<Set<string>>(new Set());

  const requestMeals = React.useCallback((leaf: LeafRow) => {
    const key = leafKey(leaf);
    if (requestedRef.current.has(key)) {
      // already loading or loaded
      return;
    }
    requestedRef.current.add(key);
    mealsAbortRef.current?.abort();
    const ctrl = new AbortController();
    mealsAbortRef.current = ctrl;
    setMealsCache((prev) => new Map([...prev, [key, { kind: "loading" }]]));
    void (async () => {
      try {
        const u = new URL("/api/variant-meals", window.location.origin);
        u.searchParams.set("company_id", leaf.company_id);
        u.searchParams.set("diet_calories_id", String(leaf.diet_calories_id));
        if (leaf.tier_id != null) {
          u.searchParams.set("tier_id", String(leaf.tier_id));
        }
        const res = await fetch(u.toString(), { signal: ctrl.signal });
        if (ctrl.signal.aborted) {
          return;
        }
        const data = res.ok
          ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- API contract enforced by /api/variant-meals route
            ((await res.json()) as { meals: VariantMealRow[] })
          : { meals: [] };
        if (ctrl.signal.aborted) {
          return;
        }
        setMealsCache(
          (prev) =>
            new Map([...prev, [key, { kind: "ready", meals: data.meals }]])
        );
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }
        setMealsCache((prev) => new Map([...prev, [key, { kind: "error" }]]));
        // Allow retry on error.
        requestedRef.current.delete(key);
      }
    })();
  }, []);

  // Pre-fetch the cheapest leaf so the right column lights up immediately.
  React.useEffect(() => {
    requestMeals(cheapest);
  }, [cheapest, requestMeals]);

  // Which leaf row is open in the table. null = none expanded.
  const [expandedKey, setExpandedKey] = React.useState<string | null>(null);
  const onLeafClick = React.useCallback(
    (leaf: LeafRow) => {
      const key = leafKey(leaf);
      setExpandedKey((cur) => {
        if (cur === key) {
          return null;
        }
        return key;
      });
      requestMeals(leaf);
    },
    [requestMeals]
  );

  React.useEffect(
    () => () => {
      mealsAbortRef.current?.abort();
    },
    []
  );

  // Show 8 leaves by default; expand to all on demand.
  const [showAllLeaves, setShowAllLeaves] = React.useState(false);
  const visible = showAllLeaves ? tile.leaves : tile.leaves.slice(0, 8);
  const hidden = tile.leaves.length - visible.length;

  // The leaf whose meals show on the right: the expanded one if any, else cheapest.
  const focusedLeaf: LeafRow = React.useMemo(() => {
    if (expandedKey === null || expandedKey === "") {
      return cheapest;
    }
    return tile.leaves.find((l) => leafKey(l) === expandedKey) ?? cheapest;
  }, [expandedKey, cheapest, tile.leaves]);
  const focusedMeals = mealsCache.get(leafKey(focusedLeaf));
  const focusedDietLine = [
    focusedLeaf.diet_name,
    focusedLeaf.tier_name,
    focusedLeaf.diet_option_name,
  ]
    .filter(Boolean)
    .join(" · ");
  const focusedHeader =
    expandedKey === null || expandedKey === ""
      ? "Najtańszy wariant"
      : "Posiłki w tym wariancie";

  const hasHistory =
    historyState.history !== null && historyState.history.length > 0;

  let historyBlock: React.ReactNode;
  if (historyState.loading) {
    historyBlock = (
      <div className="h-[200px] bg-[var(--color-oat)]/60 rounded-sm" />
    );
  } else if (hasHistory && historyState.history !== null) {
    historyBlock = <PriceHistoryChart history={historyState.history} />;
  } else {
    historyBlock = (
      <p className="text-[13px] text-[var(--color-ink-3)]">
        Za mało danych historycznych — rusz tę cenę przez kilka dni.
      </p>
    );
  }

  return (
    <div
      className="bg-[var(--color-cream)] border-l-2 border-[var(--color-amber-tint)] pl-6 pr-4 py-6 my-2"
      id={id}
    >
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-8">
        {/* left: all variants table */}
        <div>
          <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] font-medium mb-3">
            Wszystkie warianty w zakresie
          </p>
          <div className="overflow-hidden rounded-sm border border-[var(--color-bone)]">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-[var(--color-oat)]/60">
                  <Th className="w-[68%]">Dieta · Tier · Wariant</Th>
                  <Th className="w-[14%]">Kcal</Th>
                  <Th className="w-[18%] text-right pr-3">Cena / dzień</Th>
                </tr>
              </thead>
              <tbody>
                {visible.map((l, idx) => {
                  const k = leafKey(l);
                  const isOpen = expandedKey === k;
                  return (
                    <React.Fragment key={k}>
                      <LeafRowDisplay
                        highlight={idx === 0}
                        leaf={l}
                        onToggle={() => {
                          onLeafClick(l);
                        }}
                        open={isOpen}
                      />
                      {isOpen && (
                        <tr className="border-t border-[var(--color-bone)] bg-[var(--color-cream)]">
                          <td className="px-3 py-3" colSpan={3}>
                            <LeafMealsInline state={mealsCache.get(k)} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {hidden > 0 && (
            <button
              className="mt-3 text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] transition-colors"
              onClick={() => {
                setShowAllLeaves(true);
              }}
              type="button"
            >
              Pokaż jeszcze {hidden}{" "}
              {plural(hidden, "wariant", "warianty", "wariantów")} →
            </button>
          )}

          <div className="mt-6 flex items-center gap-3">
            <a
              className={cn(
                "text-[13px] tnum inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full",
                "border border-[var(--color-bone)] hover:border-[var(--color-amber)]",
                "text-[var(--color-ink-2)] hover:text-[var(--color-ink)]",
                "hover:bg-[var(--color-amber-tint)] transition-colors"
              )}
              href={dietlyUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              Zamów na dietly.pl
              <span aria-hidden>↗</span>
            </a>
            {tile.feedback_value !== null &&
            tile.feedback_value !== "" &&
            tile.feedback_number !== null &&
            tile.feedback_number !== 0 ? (
              <span className="text-[12px] text-[var(--color-ink-3)] tnum">
                {Number.parseFloat(tile.feedback_value).toFixed(2)} ★ (
                {tile.feedback_number}{" "}
                {plural(tile.feedback_number, "ocena", "oceny", "ocen")})
              </span>
            ) : null}
          </div>
        </div>

        {/* right: history chart + meals for the focused leaf */}
        <div>
          <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] font-medium mb-3">
            Historia ceny najtańszego wariantu
          </p>
          {historyBlock}

          <div className="mt-6">
            <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] font-medium">
              {focusedHeader}
            </p>
            {focusedDietLine && (
              <p className="mt-1 text-[13px] text-[var(--color-ink-2)] truncate">
                {focusedDietLine}
              </p>
            )}
            <div className="mt-3">
              <MealsBySlot state={focusedMeals} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ── tile row + drilldown ─────────────────────────────────────────────────────

const pickPrimaryChip = (
  appliedCode: string | null,
  chips: PromoChip[]
): PromoChip | null => {
  if (appliedCode !== null && appliedCode !== "") {
    const match = chips.find((x) => x.code === appliedCode);
    if (match) {
      return match;
    }
    // Applied code may not be in the campaigns table (e.g. no `separate`
    // info). Synthesize a chip so the user still sees what unlocked the
    // displayed price.
    return { code: appliedCode, discountPct: null, scope: "company" };
  }
  if (chips.length === 0) {
    return null;
  }
  return [...chips].toSorted(
    (a, b) =>
      (b.discountPct ?? 0) - (a.discountPct ?? 0) ||
      a.code.localeCompare(b.code, "pl")
  )[0];
};

const CateringTileRow = ({
  chips,
  cityId,
  days,
  initiallyOpen,
  rank,
  tile,
}: {
  tile: CateringTile;
  rank: number;
  chips: PromoChip[];
  cityId: number;
  days: number;
  initiallyOpen: boolean;
}) => {
  const [open, setOpen] = React.useState(initiallyOpen);
  const c = tile.cheapest;
  const isTop = rank === 1;
  const dietLine = [c.diet_name, c.tier_name, c.diet_option_name]
    .filter(Boolean)
    .join(" · ");
  const delta = formatDelta(c.effective_per_day, c.prev_per_day);
  const dietlyUrl = `https://dietly.pl/catering-dietetyczny-firma/${tile.company_id}`;
  const appliedCode =
    c.applied_promo_codes && c.applied_promo_codes.length > 0
      ? c.applied_promo_codes[0]
      : null;

  // Pick a single chip to show: prefer the code that's actually applied to
  // the displayed price; otherwise fall back to the company's primary chip
  // (most discount %, ties broken alphabetically). If neither exists, show
  // nothing — keeps the column reserved by the grid for alignment.
  const primaryChip: PromoChip | null = pickPrimaryChip(appliedCode, chips);

  return (
    <li
      className={cn("border-b border-[var(--color-bone)]", isTop && "relative")}
    >
      {isTop && (
        <span
          aria-hidden
          className="absolute -left-3 top-3 bottom-3 w-[2px] bg-[var(--color-amber)]"
        />
      )}
      <button
        aria-controls={`tile-${tile.company_id}`}
        aria-expanded={open}
        className={cn(
          "w-full text-left grid items-center gap-x-6 gap-y-2 py-4 px-1 -mx-1 rounded-sm",
          // rank | company+diet | promo chip | price | expand-indicator
          "grid-cols-[auto_1fr] lg:grid-cols-[auto_minmax(0,1fr)_auto_auto_auto]",
          "hover:bg-[var(--color-oat)] transition-colors"
        )}
        onClick={() => {
          setOpen((v) => !v);
        }}
        type="button"
      >
        {/* rank */}
        <span
          className={cn(
            "tnum text-[12px] w-5 text-right row-span-2 lg:row-span-1 self-start lg:self-center pt-1 lg:pt-0",
            isTop
              ? "text-[var(--color-amber-deep)]"
              : "text-[var(--color-ink-3)]"
          )}
        >
          {rank}
        </span>

        {/* company + diet line */}
        <div className="min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[15px] text-[var(--color-ink)] font-medium">
              {tile.company_name ?? tile.company_id}
            </span>
            {tile.awarded === true && (
              <span
                className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-amber-deep)]"
                title="Wyróżnione przez dietly"
              >
                ★
              </span>
            )}
            <span className="text-[12px] text-[var(--color-ink-3)] tnum">
              {tile.leaves.length}{" "}
              {plural(tile.leaves.length, "wariant", "warianty", "wariantów")}
            </span>
          </div>
          <div className="mt-0.5 text-[13px] text-[var(--color-ink-3)] truncate">
            {dietLine || "—"}
            {c.calories != null && (
              <>
                {" · "}
                <span className="tnum">{formatInt(c.calories)} kcal</span>
              </>
            )}
          </div>
          {primaryChip && (
            <div className="mt-1.5 flex lg:hidden">
              <Chip chip={primaryChip} />
            </div>
          )}
        </div>

        {/* promo chip — single, sits left of the price column on desktop */}
        <div className="hidden lg:flex justify-end">
          {primaryChip ? <Chip chip={primaryChip} /> : null}
        </div>

        {/* price — final per-day with delivery folded in, right-aligned */}
        <div className="text-right tnum whitespace-nowrap">
          <span className="text-[18px] text-[var(--color-ink)]">
            {formatPriceNumber(c.effective_per_day)}
          </span>
          <span className="ml-1 text-[12px] text-[var(--color-ink-3)]">
            zł / dzień
          </span>
          {delta.kind !== "flat" && (
            <span
              className={cn(
                "ml-2 text-[12px] tnum",
                delta.kind === "down" && "text-[var(--color-olive)]",
                delta.kind === "up" && "text-[var(--color-clay)]"
              )}
            >
              {delta.kind === "down" ? "↓" : "↑"}
              {delta.text}
            </span>
          )}
        </div>

        {/* expand indicator */}
        <span
          aria-hidden
          className={cn(
            "justify-self-end text-[var(--color-ink-3)] transition-transform",
            open && "rotate-180"
          )}
        >
          ▾
        </span>
      </button>

      {/* drilldown */}
      <div className="row-expand" data-open={open ? "true" : "false"}>
        <div className="row-expand-inner">
          {open && (
            <CateringDrilldown
              cityId={cityId}
              days={days}
              dietlyUrl={dietlyUrl}
              id={`tile-${tile.company_id}`}
              tile={tile}
            />
          )}
        </div>
      </div>
    </li>
  );
};

const buildPromoMaps = (
  campaigns: CampaignRow[]
): { byCompany: Map<string, PromoChip[]>; globals: PromoChip[] } => {
  const byCompany = new Map<string, PromoChip[]>();
  const globals: PromoChip[] = [];
  for (const c of campaigns) {
    if (c.code === null || c.code === "") {
      continue;
    }
    const chip: PromoChip = {
      code: c.code,
      discountPct:
        c.discount_percent === null || c.discount_percent === ""
          ? null
          : Number.parseFloat(c.discount_percent),
      scope:
        c.company_id !== null && c.company_id !== "" ? "company" : "global",
    };
    if (c.company_id !== null && c.company_id !== "") {
      const list = byCompany.get(c.company_id) ?? [];
      if (!list.some((x) => x.code === chip.code)) {
        list.push(chip);
      }
      byCompany.set(c.company_id, list);
    } else if (!globals.some((x) => x.code === chip.code)) {
      globals.push(chip);
    }
  }
  return { byCompany, globals };
};

export const CateringList = ({
  campaigns,
  cityId,
  cityName,
  days,
  kcalMax,
  kcalMin,
  latestCaptureAt,
  page,
  pageSize,
  rangeMax,
  rangeMin,
  tiles,
  total,
}: {
  tiles: CateringTile[];
  total: number;
  page: number;
  pageSize: number;
  campaigns: CampaignRow[];
  cityId: number;
  days: number;
  kcalMin: number;
  kcalMax: number;
  cityName: string;
  rangeMin: number | null;
  rangeMax: number | null;
  latestCaptureAt: string | null;
}) => {
  // Build per-company promo chips and the global chips list once.
  const { byCompany, globals } = React.useMemo(
    () => buildPromoMaps(campaigns),
    [campaigns]
  );

  if (tiles.length === 0) {
    return (
      <section className="px-5 sm:px-8 lg:px-14 py-16">
        <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] font-medium">
          Najtaniej dziś · {cityName} ·{" "}
          {kcalMin === kcalMax ? `${kcalMin}` : `${kcalMin}–${kcalMax}`} kcal ·{" "}
          {days} dni
        </p>
        <p className="mt-4 text-[var(--color-ink-2)]">
          Brak ofert dla wybranego zakresu. Spróbuj poszerzyć kalorie albo
          zmienić długość zamówienia.
        </p>
      </section>
    );
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const startIdx = (page - 1) * pageSize + 1;
  const endIdx = Math.min(total, startIdx + tiles.length - 1);
  const rangeLabel =
    kcalMin === kcalMax ? `${kcalMin} kcal` : `${kcalMin}–${kcalMax} kcal`;

  return (
    <section className="px-5 sm:px-8 lg:px-14 pt-12 pb-10">
      {/* Header */}
      <div className="mb-10 flex flex-col gap-3 lg:flex-row lg:items-baseline lg:justify-between lg:gap-8">
        <div>
          <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] font-medium">
            Najtaniej · {cityName} · {rangeLabel} · {days} dni
          </p>
          <p className="mt-3 text-[15px] text-[var(--color-ink-2)] max-w-[64ch]">
            {total} {plural(total, "firma", "firmy", "firm")} w tym przedziale.
            Pokazujemy {startIdx}
            {startIdx === endIdx ? "" : `–${endIdx}`} z {total}, posortowane od
            najtańszej. Kliknij firmę, żeby zobaczyć wszystkie jej diety.
          </p>
        </div>

        {rangeMin !== null && rangeMax !== null && (
          <div className="text-[12px] text-[var(--color-ink-3)] tnum whitespace-nowrap">
            {formatPriceNumber(rangeMin)} – {formatPriceNumber(rangeMax)} zł /
            dzień
          </div>
        )}
      </div>

      {/* Tiles */}
      <ol>
        {tiles.map((tile, i) => (
          <CateringTileRow
            chips={byCompany.get(tile.company_id) ?? []}
            cityId={cityId}
            days={days}
            initiallyOpen={page === 1 && i === 0}
            key={tile.company_id}
            rank={(page - 1) * pageSize + i + 1}
            tile={tile}
          />
        ))}
      </ol>

      <Pagination page={page} totalPages={totalPages} />

      {globals.length > 0 && (
        <div className="mt-14 pt-6 border-t border-[var(--color-bone)]">
          <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] font-medium">
            Kody globalne (dotyczą wszystkich firm)
          </p>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
            {globals.map((c) => (
              <span
                className="text-[13px] text-[var(--color-ink-2)] tnum"
                key={c.code}
              >
                <span
                  className="font-display"
                  style={{ fontVariantCaps: "small-caps", fontWeight: 500 }}
                >
                  {c.code}
                </span>
                {c.discountPct !== null && (
                  <span className="ml-1.5 text-[var(--color-amber-deep)]">
                    −{c.discountPct.toFixed(0)}%
                  </span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      {latestCaptureAt !== null && latestCaptureAt !== "" && (
        <p className="mt-10 text-[12px] text-[var(--color-ink-3)]">
          Dane: {formatDate(latestCaptureAt)}
        </p>
      )}
    </section>
  );
};

// silence the unused var warning — DEFAULT_VISIBLE_COLLAPSED kept as a doc tag
void DEFAULT_VISIBLE_COLLAPSED;
