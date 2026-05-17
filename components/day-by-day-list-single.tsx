"use client";

import * as React from "react";

import { DishDetailsPopover } from "@/components/meal-swap-popover";
import { OfferScatter } from "@/components/offer-scatter";
import { formatPriceNumber } from "@/lib/format";
import { aggregateMacros } from "@/lib/mock-match-data";
import type {
  MockDay,
  MockMealOption,
  MockOffer,
  MockPick,
} from "@/lib/mock-match-data";
import { getMetric } from "@/lib/scatter-metrics";
import type { MetricId } from "@/lib/scatter-metrics";
import { getSortOption, rankOffers } from "@/lib/sort-metrics";
import type { SortId } from "@/lib/sort-metrics";
import { usePersistedState } from "@/lib/use-persisted-state";
import { cn } from "@/lib/utils";

// ── Formatting helpers (mirrors day-by-day-list.tsx) ────────────────────────

const formatScore = (value: number): string => {
  if (Math.abs(value) < 0.05) {
    return "0,0";
  }
  const sign = value > 0 ? "+" : "−";
  return `${sign}${Math.abs(value).toFixed(1).replace(".", ",")}`;
};

const formatDayMonth = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00`);
  return new Intl.DateTimeFormat("pl-PL", {
    day: "numeric",
    month: "short",
  }).format(d);
};

// ── Slot ordering for picks table ───────────────────────────────────────────

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
    if (k === SLOT_ORDER[i]) {
      return i;
    }
  }
  return SLOT_ORDER.length;
};

// ── Per-offer state ─────────────────────────────────────────────────────────

/** slot_name → swapped option */
type SwapMap = Readonly<Record<string, MockMealOption>>;
/** `${date}::${offer_id}` → SwapMap */
type AllSwaps = Readonly<Record<string, SwapMap>>;

const applySwaps = (offer: MockOffer, swaps: SwapMap): MockOffer => {
  const keys = Object.keys(swaps);
  if (keys.length === 0) {
    return offer;
  }
  const newPicks: MockPick[] = offer.picks.map((p) => {
    const swap = swaps[p.slot_name];
    if (swap === undefined) {
      return p;
    }
    return { ...p, ...swap, alternates: p.alternates };
  });
  const scoreBest = Number(
    newPicks.reduce((acc, p) => acc + p.meal_score, 0).toFixed(2)
  );
  const totals = aggregateMacros(newPicks);
  return {
    ...offer,
    picks: newPicks,
    score_best: scoreBest,
    total_carbs_g: totals.carbs_g,
    total_fat_g: totals.fat_g,
    total_fiber_g: totals.fiber_g,
    total_kcal: totals.kcal,
    total_protein_g: totals.protein_g,
    total_sugar_g: totals.sugar_g,
  };
};

// ── Picks breakdown (mirrors day-by-day-list.tsx) ───────────────────────────

interface PicksTableProps {
  readonly picks: readonly MockPick[];
  readonly isMenuConfig: boolean;
  readonly onSwap: (slot: string, option: MockMealOption) => void;
}

const PicksTable = ({
  isMenuConfig,
  onSwap,
  picks,
}: Readonly<PicksTableProps>) => {
  const sorted = [...picks].toSorted(
    (a, b) => slotRank(a.slot_name) - slotRank(b.slot_name)
  );
  return (
    <div className="mt-3 border-t border-[var(--color-bone)] pt-3">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
            <th className="text-left font-medium py-1 pr-3 w-[80px]">slot</th>
            <th className="text-left font-medium py-1 pr-3">posiłek</th>
            <th className="text-right font-medium py-1 pr-3 w-[60px]">score</th>
            <th className="text-right font-medium py-1 pr-3 w-[60px]">
              białko
            </th>
            <th className="text-right font-medium py-1 w-[60px]">kcal</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => {
            const swapHandler = isMenuConfig
              ? (opt: MockMealOption) => {
                  onSwap(p.slot_name, opt);
                }
              : undefined;
            return (
              <tr
                className="align-top border-t border-[var(--color-bone)]/60"
                key={`${p.slot_name}-${p.meal_name}`}
              >
                <td className="py-1.5 pr-3 text-[var(--color-ink-3)] uppercase tracking-wide text-[10px] pt-2">
                  {p.slot_name}
                </td>
                <td className="py-1.5 pr-3 text-[var(--color-ink)]">
                  <DishDetailsPopover onSwap={swapHandler} pick={p} />
                </td>
                <td
                  className={cn(
                    "py-1.5 pr-3 text-right tnum",
                    p.meal_score > 0.05 && "text-[var(--color-olive)]",
                    p.meal_score < -0.05 && "text-[var(--color-clay)]",
                    Math.abs(p.meal_score) <= 0.05 &&
                      "text-[var(--color-ink-3)]"
                  )}
                >
                  {formatScore(p.meal_score)}
                </td>
                <td className="py-1.5 pr-3 text-right tnum text-[var(--color-ink-2)]">
                  {Math.round(p.protein_g)} g
                </td>
                <td className="py-1.5 text-right tnum text-[var(--color-ink-2)]">
                  {Math.round(p.kcal)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

// ── Single offer row ────────────────────────────────────────────────────────

interface SingleRowProps {
  readonly day: MockDay;
  readonly offer: MockOffer;
  /** Rank of this offer within day.all_offers under the active sort (1-based). */
  readonly rank: number;
  readonly totalForDay: number;
  /** Tight metric label (e.g. "białko/zł"). */
  readonly metricLabel: string;
  /** Formats the active sort metric for the chosen offer (right-rail badge). */
  readonly formatMetric: (o: MockOffer) => string;
  readonly open: boolean;
  readonly onToggle: () => void;
  /** All offers for the day (after swaps), passed to the scatter. */
  readonly allOffers: readonly MockOffer[];
  /** Offer id of the cheapest-by-price for visual anchoring in the scatter. */
  readonly cheapestId: string;
  readonly xId: MetricId;
  readonly yId: MetricId;
  readonly onChangeX: (id: MetricId) => void;
  readonly onChangeY: (id: MetricId) => void;
  readonly onSwapMeal: (slot: string, option: MockMealOption) => void;
  readonly onPickFromScatter: (offerId: string) => void;
}

const ScoreChip = ({ score }: Readonly<{ score: number }>) => {
  const isPositive = score > 0.05;
  const isNegative = score < -0.05;
  const magnitude = Math.abs(score);
  const heavy = magnitude >= 3;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
        score
      </span>
      <span
        className={cn(
          "tnum text-[14px]",
          heavy ? "font-semibold" : "font-normal",
          isPositive && "text-[var(--color-olive)]",
          isNegative && "text-[var(--color-clay)]",
          !isPositive && !isNegative && "text-[var(--color-ink-2)]"
        )}
      >
        {formatScore(score)}
      </span>
    </span>
  );
};

interface ScatterPanelProps {
  readonly offers: readonly MockOffer[];
  readonly cheapestId: string;
  readonly selectedId: string;
  readonly onPick: (offerId: string) => void;
  readonly xId: MetricId;
  readonly yId: MetricId;
  readonly onChangeX: (id: MetricId) => void;
  readonly onChangeY: (id: MetricId) => void;
  readonly altsCount: number;
}

const ScatterPanel = ({
  altsCount,
  cheapestId,
  offers,
  onChangeX,
  onChangeY,
  onPick,
  selectedId,
  xId,
  yId,
}: Readonly<ScatterPanelProps>) => {
  if (offers.length === 0) {
    return (
      <div className="mt-3 border-t border-[var(--color-bone)] pt-3 text-[12px] text-[var(--color-ink-3)] italic">
        brak innych ofert w tym dniu
      </div>
    );
  }
  return (
    <div>
      <OfferScatter
        cheapestId={cheapestId}
        filterLabel={
          <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
            alternatywy ({altsCount})
          </span>
        }
        offers={offers}
        onChangeX={onChangeX}
        onChangeY={onChangeY}
        onPick={onPick}
        selectedId={selectedId}
        xMetric={getMetric(xId)}
        yMetric={getMetric(yId)}
      />
    </div>
  );
};

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React synthetic events carry DOM refs; cannot be deeply readonly
const stopRowClick = (e: React.MouseEvent | React.KeyboardEvent): void => {
  e.stopPropagation();
};

const SingleRow = ({
  allOffers,
  cheapestId,
  day,
  formatMetric,
  metricLabel,
  offer,
  onChangeX,
  onChangeY,
  onPickFromScatter,
  onSwapMeal,
  onToggle,
  open,
  rank,
  totalForDay,
  xId,
  yId,
}: Readonly<SingleRowProps>) => {
  const metricValue = formatMetric(offer);
  const altsCount = Math.max(allOffers.length - 1, 0);

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React synthetic events carry DOM refs; cannot be deeply readonly
  const handleHeaderKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggle();
    }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-[110px_1fr] gap-x-8 gap-y-4 py-7 border-t border-[var(--color-bone)] first:border-t-0">
      {/* Date column */}
      <div className="md:pt-1">
        <div className="text-[12px] uppercase tracking-[0.1em] text-[var(--color-ink-3)]">
          {day.weekday_short_pl}
        </div>
        <div className="font-display text-[22px] leading-tight text-[var(--color-ink)] tnum">
          {formatDayMonth(day.date)}
        </div>
        {totalForDay > 0 && (
          <div className="text-[11px] text-[var(--color-ink-3)] mt-2">
            {totalForDay} wariantów
          </div>
        )}
      </div>

      {/* Offer column */}
      <div className="flex flex-col -mx-2 px-2 rounded-sm">
        {/* Clickable header — toggles the expansion */}
        <div
          aria-expanded={open}
          className={cn(
            "flex flex-col gap-1.5 py-1 -mx-2 px-2 rounded-sm cursor-pointer",
            "hover:bg-[var(--color-oat)]/60 transition-colors",
            open && "bg-[var(--color-oat)]/40"
          )}
          onClick={onToggle}
          onKeyDown={handleHeaderKey}
          role="button"
          tabIndex={0}
        >
          {/* Rank + active metric tagline */}
          <div className="flex items-baseline justify-between gap-3">
            <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-ink-3)]">
              #{rank} wg {metricLabel}
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
                {metricLabel}
              </span>
              <span className="font-display tnum text-[18px] leading-none text-[var(--color-ink)]">
                {metricValue}
              </span>
              <span
                aria-hidden
                className={cn(
                  "ml-1 text-[12px] text-[var(--color-ink-3)] inline-block transition-transform",
                  open && "rotate-180"
                )}
              >
                ▾
              </span>
            </div>
          </div>

          {/* Identity */}
          <div className="text-[13px] text-[var(--color-ink-2)]">
            <a
              className={cn(
                "text-[var(--color-ink)] font-medium",
                "underline decoration-[var(--color-bone)] decoration-1 underline-offset-[3px]",
                "hover:decoration-[var(--color-amber)] hover:text-[var(--color-amber-deep)]",
                "transition-colors"
              )}
              href={`https://dietly.pl/catering-dietetyczny-firma/${encodeURIComponent(offer.company_name)}`}
              onClick={stopRowClick}
              onKeyDown={stopRowClick}
              rel="noopener noreferrer"
              target="_blank"
              title={`Otwórz ${offer.company_name} na dietly.pl`}
            >
              {offer.company_name}
            </a>
            <span className="text-[var(--color-ink-3)]"> · </span>
            <span>{offer.diet_name}</span>
            {offer.tier_name !== null && offer.tier_name !== "" && (
              <>
                <span className="text-[var(--color-ink-3)]"> · </span>
                <span>{offer.tier_name}</span>
              </>
            )}
            <span className="text-[var(--color-ink-3)]"> · </span>
            <span className="tnum">{offer.calories} kcal</span>
            {offer.is_menu_configuration && (
              <span className="ml-2 inline-block text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] border border-[var(--color-bone)] rounded-sm px-1 py-px">
                menu config
              </span>
            )}
          </div>

          {/* Price + promos + select */}
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="font-display tnum text-[22px] leading-none text-[var(--color-ink)]">
              {formatPriceNumber(offer.price_per_day)} zł
            </span>
            <span className="text-[12px] text-[var(--color-ink-3)] -ml-1">
              /dzień
            </span>
            {offer.price_per_day_before_promo !== null && (
              <span className="text-[11px] text-[var(--color-ink-3)]/70 line-through tnum">
                {formatPriceNumber(offer.price_per_day_before_promo)}
              </span>
            )}
            {offer.promos.map((p) => (
              <span
                className={cn(
                  "inline-flex items-baseline gap-1 rounded-sm px-1 py-px",
                  "text-[10px] uppercase tracking-[0.04em] tnum leading-none",
                  "bg-[var(--color-amber-tint)] text-[var(--color-amber-deep)]"
                )}
                key={p.code}
                title={
                  p.ends_at === undefined
                    ? "kod bezterminowy"
                    : `kod ważny do ${p.ends_at}`
                }
              >
                <span className="font-medium">{p.code}</span>
                <span>−{p.discount_percent}%</span>
              </span>
            ))}
          </div>

          {/* Score + macros + alts hint */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-0.5">
            <ScoreChip score={offer.score_best} />
            <span className="text-[12px] text-[var(--color-ink-2)] tnum">
              <span className="text-[var(--color-ink-3)]">B </span>
              {Math.round(offer.total_protein_g)} g
              <span className="text-[var(--color-ink-3)]"> · T </span>
              {Math.round(offer.total_fat_g)} g
              <span className="text-[var(--color-ink-3)]"> · W </span>
              {Math.round(offer.total_carbs_g)} g
              <span className="text-[var(--color-ink-3)]"> · błonnik </span>
              {Math.round(offer.total_fiber_g)} g
            </span>
            {altsCount > 0 && (
              <span className="ml-auto text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
                {open ? "zwiń" : `${altsCount} alternatyw`}
              </span>
            )}
          </div>
        </div>

        {/* Expansion panel — menu on the left, scatter on the right */}
        <div
          className="row-expand"
          data-open={open}
          onClick={stopRowClick}
          onKeyDown={stopRowClick}
          role="presentation"
        >
          <div className="row-expand-inner">
            <div className="mt-3 border-t border-[var(--color-bone)] pt-4 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-x-8 gap-y-6">
              <div>
                <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] mb-1">
                  menu na dzień
                </div>
                <PicksTable
                  isMenuConfig={offer.is_menu_configuration}
                  onSwap={onSwapMeal}
                  picks={offer.picks}
                />
              </div>
              <ScatterPanel
                altsCount={altsCount}
                cheapestId={cheapestId}
                offers={allOffers}
                onChangeX={onChangeX}
                onChangeY={onChangeY}
                onPick={onPickFromScatter}
                selectedId={offer.offer_id}
                xId={xId}
                yId={yId}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ── Selection summary (mirrors day-by-day-list.tsx) ─────────────────────────

interface ResolvedSelection {
  readonly date: string;
  readonly weekday: string;
  readonly company_name: string;
  readonly price_per_day: number;
}

const OrderSummary = ({
  resolved,
}: Readonly<{ resolved: readonly ResolvedSelection[] }>) => {
  const [ordered, setOrdered] = React.useState(false);
  if (resolved.length === 0) {
    return null;
  }
  const total = resolved.reduce((acc, r) => acc + r.price_per_day, 0);
  const companies = [...new Set(resolved.map((r) => r.company_name))];
  return (
    <div className="sticky bottom-0 z-20 -mx-5 sm:-mx-8 lg:-mx-14 border-t-2 border-[var(--color-amber)] bg-[var(--color-cream)] shadow-[0_-12px_24px_-12px_oklch(22%_0.018_60_/_0.18)]">
      <div className="px-5 sm:px-8 lg:px-14 py-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="flex items-baseline gap-3">
            <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
              podsumowanie
            </span>
            <span className="text-[13px] text-[var(--color-ink-2)] tnum">
              {resolved.length} {resolved.length === 1 ? "dzień" : "dni"} ·{" "}
              {companies.length}{" "}
              {companies.length === 1 ? "catering" : "cateringi"}
            </span>
          </div>
          <div className="text-[12px] text-[var(--color-ink-3)] truncate max-w-[60vw]">
            {companies.join(" · ")}
          </div>
        </div>
        <div className="flex items-baseline gap-4">
          <div className="flex flex-col items-end">
            <span className="font-display tnum text-[24px] leading-none text-[var(--color-ink)]">
              {formatPriceNumber(total)} zł
            </span>
            <span className="text-[11px] text-[var(--color-ink-3)] mt-0.5">
              łącznie · {formatPriceNumber(total / resolved.length)} zł/dzień
              śr.
            </span>
          </div>
          <button
            className={cn(
              "inline-flex items-center gap-2 px-5 py-2.5 rounded-sm tnum text-[14px]",
              "transition-colors",
              ordered
                ? "bg-[var(--color-olive)] text-[var(--color-cream)]"
                : "bg-[var(--color-amber)] text-[var(--color-cream)] hover:bg-[var(--color-amber-deep)]"
            )}
            onClick={() => {
              setOrdered(true);
              window.setTimeout(() => {
                setOrdered(false);
              }, 2500);
            }}
            type="button"
          >
            {ordered ? (
              <>
                <span aria-hidden>✓</span>
                <span>zamówione (mock)</span>
              </>
            ) : (
              <>
                <span>zamów</span>
                <span aria-hidden>→</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Top-level list ──────────────────────────────────────────────────────────

export interface DayByDaySingleProps {
  readonly days: readonly MockDay[];
  readonly sortId: SortId;
  readonly prefer: readonly string[];
  readonly avoid: readonly string[];
}

type Overrides = Readonly<Record<string, string>>;
/** Date of the currently-expanded row, or null. Only one row open at a time. */
type Expansion = string | null;

export const DayByDayListSingle = ({
  avoid,
  days,
  prefer,
  sortId,
}: Readonly<DayByDaySingleProps>) => {
  const [expansion, setExpansion] = React.useState<Expansion>(null);
  const [swaps, setSwaps] = React.useState<AllSwaps>({});
  /** Per-day manual override of which offer is "the pick" for that day. */
  const [overrides, setOverrides] = React.useState<Overrides>({});
  // Scatter axes — share storage keys with /match so axis choice carries over.
  const [xId, setXId] = usePersistedState<MetricId>("match.scatter.x", "price");
  const [yId, setYId] = usePersistedState<MetricId>("match.scatter.y", "score");

  const sortOpt = getSortOption(sortId);

  // Reset overrides when the sort changes — the user picked a new ranking
  // criterion, so previous manual picks no longer reflect intent.
  React.useEffect(() => {
    setOverrides({});
  }, [sortId]);

  const handleSwap = React.useCallback(
    (date: string, offerId: string, slot: string, opt: MockMealOption) => {
      const key = `${date}::${offerId}`;
      setSwaps((prev) => {
        const existing = prev[key] ?? {};
        return { ...prev, [key]: { ...existing, [slot]: opt } };
      });
    },
    []
  );

  const handlePickFromScatter = React.useCallback(
    (date: string, offerId: string) => {
      setOverrides((prev) => ({ ...prev, [date]: offerId }));
    },
    []
  );

  // Auto-resolve: every day with at least one offer contributes its current
  // chosen offer (rank-1 by sort, or override) to the order. There is no
  // explicit "wybierz" — selection is implicit.
  const resolved = React.useMemo<readonly ResolvedSelection[]>(() => {
    const out: ResolvedSelection[] = [];
    for (const day of days) {
      if (day.all_offers.length === 0) {
        continue;
      }
      const swapped = day.all_offers.map((o) =>
        applySwaps(o, swaps[`${day.date}::${o.offer_id}`] ?? {})
      );
      const ranked = rankOffers(swapped, sortId);
      const overrideId = overrides[day.date];
      const chosen =
        overrideId === undefined
          ? ranked[0]
          : (ranked.find((o) => o.offer_id === overrideId) ?? ranked[0]);
      out.push({
        company_name: chosen.company_name,
        date: day.date,
        price_per_day: chosen.price_per_day,
        weekday: day.weekday_short_pl,
      });
    }
    return out;
  }, [days, overrides, sortId, swaps]);

  return (
    <div className="px-5 sm:px-8 lg:px-14 pt-3 pb-6">
      {/* Mock banner */}
      <div className="py-3 text-[12px] italic text-[var(--color-ink-3)]">
        mock · jedna oferta na dzień · sort: {sortOpt.label} · prefer:{" "}
        {prefer.join(", ") || "—"} · avoid: {avoid.join(", ") || "—"}
      </div>

      <div>
        {days.map((day) => {
          if (day.all_offers.length === 0) {
            return (
              <div
                className="grid grid-cols-1 md:grid-cols-[110px_1fr] gap-x-8 gap-y-4 py-7 border-t border-[var(--color-bone)] first:border-t-0"
                key={day.date}
              >
                <div className="md:pt-1">
                  <div className="text-[12px] uppercase tracking-[0.1em] text-[var(--color-ink-3)]">
                    {day.weekday_short_pl}
                  </div>
                  <div className="font-display text-[22px] leading-tight text-[var(--color-ink)] tnum">
                    {formatDayMonth(day.date)}
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-ink-3)]">
                    brak danych
                  </div>
                  <div className="text-[13px] text-[var(--color-ink-3)] italic">
                    menu na ten dzień nie zostało jeszcze opublikowane przez
                    cateringi
                  </div>
                </div>
              </div>
            );
          }

          // Apply swaps to each offer, then rank.
          const swapped: readonly MockOffer[] = day.all_offers.map((o) =>
            applySwaps(o, swaps[`${day.date}::${o.offer_id}`] ?? {})
          );
          const ranked = rankOffers(swapped, sortId);
          const overrideId = overrides[day.date];
          const chosen =
            overrideId === undefined
              ? ranked[0]
              : (ranked.find((o) => o.offer_id === overrideId) ?? ranked[0]);
          const chosenRank = ranked.findIndex(
            (o) => o.offer_id === chosen.offer_id
          );
          // Cheapest by price — anchors the scatter even if it's not the pick.
          const [cheapest] = [...swapped].toSorted(
            (a, b) => a.price_per_day - b.price_per_day
          );

          const open = expansion === day.date;

          return (
            <SingleRow
              allOffers={swapped}
              cheapestId={cheapest.offer_id}
              day={day}
              formatMetric={sortOpt.format}
              key={day.date}
              metricLabel={sortOpt.short}
              offer={chosen}
              onChangeX={setXId}
              onChangeY={setYId}
              onPickFromScatter={(offerId) => {
                handlePickFromScatter(day.date, offerId);
              }}
              onSwapMeal={(slot, opt) => {
                handleSwap(day.date, chosen.offer_id, slot, opt);
              }}
              onToggle={() => {
                setExpansion(open ? null : day.date);
              }}
              open={open}
              rank={chosenRank + 1}
              totalForDay={day.total_considered}
              xId={xId}
              yId={yId}
            />
          );
        })}
      </div>

      <OrderSummary resolved={resolved} />
    </div>
  );
};
