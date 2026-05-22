"use client";

import * as React from "react";

import { DayRowSkeleton } from "@/components/day-row-skeleton";
import type { CateringChoice } from "@/components/exclude-filter";
import { DishDetailsPopover } from "@/components/meal-swap-popover";
import { OfferScatter } from "@/components/offer-scatter";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatPriceNumber } from "@/lib/format";
import { aggregateMacros } from "@/lib/match-types";
import type { Day, Hit, MealOption, Offer, Pick } from "@/lib/match-types";
import { getMetric } from "@/lib/scatter-metrics";
import type { MetricId } from "@/lib/scatter-metrics";
import { getSortOption, rankOffers } from "@/lib/sort-metrics";
import type { SortId } from "@/lib/sort-metrics";
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
type SwapMap = Readonly<Record<string, MealOption>>;
/** `${date}::${offer_id}` → SwapMap */
type AllSwaps = Readonly<Record<string, SwapMap>>;

const applySwaps = (offer: Offer, swaps: SwapMap): Offer => {
  const keys = Object.keys(swaps);
  if (keys.length === 0) {
    return offer;
  }
  const newPicks: Pick[] = offer.picks.map((p) => {
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

const scoreToneClass = (v: number): string => {
  if (v > 0.05) {
    return "text-[var(--color-olive)]";
  }
  if (v < -0.05) {
    return "text-[var(--color-clay)]";
  }
  return "text-[var(--color-ink-3)]";
};

// ── Score breakdown tooltip bodies ──────────────────────────────────────────

const MealHitRow = ({ hit }: Readonly<{ hit: Hit }>) => (
  <div className="flex items-baseline justify-between gap-3 py-0.5">
    <span className="text-[11px] text-[var(--color-ink-2)] leading-snug">
      {hit.reason}
    </span>
    <span
      className={cn(
        "tnum text-[11px] shrink-0",
        scoreToneClass(hit.contribution)
      )}
    >
      {formatScore(hit.contribution)}
    </span>
  </div>
);

const MealScoreBreakdown = ({ pick }: Readonly<{ pick: Pick }>) => {
  // Drop zero-contribution hits — typically embedding matches that landed
  // exactly at the cutoff (sim = 0.80, rescaled to 0). They take up space
  // without telling the user anything new.
  const meaningful = pick.hits.filter((h) => Math.abs(h.contribution) >= 0.05);
  if (meaningful.length === 0) {
    return (
      <div className="text-[11px] text-[var(--color-ink-3)] italic">
        brak dopasowań — żadna z preferencji nie trafiła w ten posiłek.
      </div>
    );
  }
  return (
    <div className="min-w-[220px] flex flex-col gap-0.5">
      {meaningful.map((h) => (
        <MealHitRow
          hit={h}
          key={`${h.source}:${h.keyword}:${h.channel}:${h.reason}`}
        />
      ))}
    </div>
  );
};

// ── Picks breakdown (mirrors day-by-day-list.tsx) ───────────────────────────

interface PicksTableProps {
  readonly picks: readonly Pick[];
  readonly isMenuConfig: boolean;
  readonly onSwap: (slot: string, option: MealOption) => void;
}

const PicksTable = ({
  isMenuConfig,
  onSwap,
  picks,
}: Readonly<PicksTableProps>) => {
  const sorted = [...picks].toSorted(
    (a, b) => slotRank(a.slot_name) - slotRank(b.slot_name)
  );
  // Drop dead columns: when no pick has a non-zero score (no prefer/avoid
  // filters matched, or none set at all) the score column is pure noise; same
  // story for ocena when none of the meals carry a per-meal rating.
  const showScore = sorted.some(
    (p) =>
      Math.abs(p.meal_score) > 0.05 ||
      p.hits.some((h) => Math.abs(h.contribution) >= 0.05)
  );
  const showReview = sorted.some((p) => p.review_score !== null);
  return (
    <div className="mt-3 border-t border-[var(--color-bone)] pt-3">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
            <th className="text-left font-medium py-1 pr-3 w-[80px]">slot</th>
            <th className="text-left font-medium py-1 pr-3">posiłek</th>
            {showScore && (
              <th className="text-right font-medium py-1 pr-3 w-[60px]">
                score
              </th>
            )}
            {showReview && (
              <th className="text-right font-medium py-1 pr-3 w-[60px]">
                ocena
              </th>
            )}
            <th className="text-right font-medium py-1 pr-3 w-[60px]">
              białko
            </th>
            <th className="text-right font-medium py-1 w-[60px]">kcal</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => {
            const swapHandler = isMenuConfig
              ? (opt: MealOption) => {
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
                {showScore && (
                  <td
                    className={cn(
                      "py-1.5 pr-3 text-right tnum",
                      p.meal_score > 0.05 && "text-[var(--color-olive)]",
                      p.meal_score < -0.05 && "text-[var(--color-clay)]",
                      Math.abs(p.meal_score) <= 0.05 &&
                        "text-[var(--color-ink-3)]"
                    )}
                  >
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className={cn(
                            "cursor-help border-b border-dotted",
                            p.hits.some((h) => Math.abs(h.contribution) >= 0.05)
                              ? "border-[var(--color-bone)]"
                              : "border-transparent"
                          )}
                        >
                          {formatScore(p.meal_score)}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent align="end" side="left">
                        <MealScoreBreakdown pick={p} />
                      </TooltipContent>
                    </Tooltip>
                  </td>
                )}
                {showReview && (
                  <td className="py-1.5 pr-3 text-right tnum text-[var(--color-ink-2)]">
                    {p.review_score === null
                      ? "—"
                      : `${p.review_score.toFixed(2).replace(".", ",")} ★`}
                  </td>
                )}
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
  readonly day: Day;
  readonly offer: Offer;
  /** Rank of this offer within day.all_offers under the active sort (1-based). */
  readonly rank: number;
  readonly totalForDay: number;
  /** Tight metric label (e.g. "białko/zł"). */
  readonly metricLabel: string;
  /** Formats the active sort metric for the chosen offer (right-rail badge). */
  readonly formatMetric: (o: Offer) => string;
  readonly open: boolean;
  readonly onToggle: () => void;
  /** All offers for the day (after swaps), passed to the scatter. */
  readonly allOffers: readonly Offer[];
  /** Offer id of the cheapest-by-price for visual anchoring in the scatter. */
  readonly cheapestId: string;
  readonly xId: MetricId;
  readonly yId: MetricId;
  readonly onChangeX: (id: MetricId) => void;
  readonly onChangeY: (id: MetricId) => void;
  readonly onSwapMeal: (slot: string, option: MealOption) => void;
  readonly onPickFromScatter: (offerId: string) => void;
  /** True while the per-day full-pool fetch is in flight. Passed through to
   *  ScatterPanel which swaps to a pulsing placeholder. */
  readonly poolLoading: boolean;
  /** Caterings the user can add to the scatter on demand — already-loaded
   *  ones are filtered out by the parent. */
  readonly unloadedCaterings: readonly CateringChoice[];
  /** Set of `${date}::${companyId}` keys currently loading. */
  readonly loadingCaterings: ReadonlySet<string>;
  /** Fired when the user clicks an unloaded catering chip. */
  readonly onLoadCatering: (companyId: string) => void;
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
  readonly offers: readonly Offer[];
  readonly cheapestId: string;
  readonly selectedId: string;
  readonly onPick: (offerId: string) => void;
  readonly xId: MetricId;
  readonly yId: MetricId;
  readonly onChangeX: (id: MetricId) => void;
  readonly onChangeY: (id: MetricId) => void;
  /** True while the per-day full-pool fetch is in flight. Renders a pulsing
   *  placeholder block instead of the chart so the axis scales don't jump
   *  when the Phase-A single point gets replaced by the Phase-B pool. */
  readonly poolLoading: boolean;
  /** Caterings the user can load on demand via the Alternatywy popover. */
  readonly unloadedCaterings: readonly CateringChoice[];
  /** Set of company_ids currently loading for this day. */
  readonly loadingCateringIds: ReadonlySet<string>;
  /** Fired by the popover entry click; parent triggers the per-catering fetch. */
  readonly onLoadCatering: (companyId: string) => void;
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- props include a ReadonlySet (loadingCateringIds) which already conveys read-only intent
const ScatterPanel = ({
  cheapestId,
  loadingCateringIds,
  offers,
  onChangeX,
  onChangeY,
  onLoadCatering,
  onPick,
  poolLoading,
  selectedId,
  unloadedCaterings,
  xId,
  yId,
}: Readonly<ScatterPanelProps>) => {
  if (poolLoading) {
    return (
      <div className="flex flex-col gap-2">
        <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
          alternatywy
        </span>
        <div className="h-[260px] rounded-sm border border-dashed border-[var(--color-bone)] flex items-center justify-center text-[12px] text-[var(--color-ink-3)] italic animate-pulse">
          ładowanie alternatyw…
        </div>
      </div>
    );
  }
  if (offers.length === 0) {
    return (
      <div className="mt-3 border-t border-[var(--color-bone)] pt-3 text-[12px] text-[var(--color-ink-3)] italic">
        brak innych ofert w tym dniu
      </div>
    );
  }
  return (
    <div className="animate-in fade-in duration-300">
      <OfferScatter
        cheapestId={cheapestId}
        loadingCateringIds={loadingCateringIds}
        offers={offers}
        onChangeX={onChangeX}
        onChangeY={onChangeY}
        onLoadCatering={onLoadCatering}
        onPick={onPick}
        selectedId={selectedId}
        unloadedCaterings={unloadedCaterings}
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

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- props include a ReadonlySet (loadingCaterings) which already conveys read-only intent
const SingleRow = ({
  allOffers,
  cheapestId,
  day,
  formatMetric,
  loadingCaterings,
  metricLabel,
  offer,
  onChangeX,
  onChangeY,
  onLoadCatering,
  onPickFromScatter,
  onSwapMeal,
  onToggle,
  open,
  poolLoading,
  rank,
  totalForDay,
  unloadedCaterings,
  xId,
  yId,
}: Readonly<SingleRowProps>) => {
  // Narrow the global `${date}::${companyId}` loading set to just this row's
  // date. The OfferScatter popover wants a flat Set<companyId>.
  const loadingCateringIds = React.useMemo(() => {
    const prefix = `${day.date}::`;
    const out = new Set<string>();
    for (const key of loadingCaterings) {
      if (key.startsWith(prefix)) {
        out.add(key.slice(prefix.length));
      }
    }
    return out;
  }, [day.date, loadingCaterings]);
  const metricValue = formatMetric(offer);

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
              href={`https://dietly.pl/catering-dietetyczny-firma/${offer.company_id}`}
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
            {open && (
              <span className="ml-auto text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
                zwiń
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
                cheapestId={cheapestId}
                loadingCateringIds={loadingCateringIds}
                offers={allOffers}
                onChangeX={onChangeX}
                onChangeY={onChangeY}
                onLoadCatering={onLoadCatering}
                onPick={onPickFromScatter}
                poolLoading={poolLoading}
                selectedId={offer.offer_id}
                unloadedCaterings={unloadedCaterings}
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
  readonly days: readonly Day[];
  /** When non-null, render shimmer placeholders for these dates instead of
   *  the real days. Set during Phase A after a config change. */
  readonly skeletonDates?: readonly string[] | null;
  /** Full-pool offers per date, populated lazily on row expand by the parent.
   *  When a date is missing here, the row falls back to `day.all_offers`
   *  (which after Phase A is just the top-1 winner). */
  readonly poolByDate?: Readonly<Record<string, readonly Offer[]>>;
  /** Dates whose per-day pool fetch is currently in flight. While a date
   *  is in this set the row's scatter renders the placeholder so axis
   *  scales don't jump when the pool replaces the Phase-A single point. */
  readonly loadingPoolDates?: ReadonlySet<string>;
  /** Fired when the user opens a row. Parent triggers the per-day pool
   *  fetch. Not called on collapse. */
  readonly onExpandDate?: (date: string) => void;
  /** All caterings available for the city (from getCaterings). Used by the
   *  per-row picker to list caterings the user can add to the scatter on
   *  demand. */
  readonly availableCaterings?: readonly CateringChoice[];
  /** Per-(date, catering) loading state. Keyed by `${date}::${companyId}`. */
  readonly loadingCaterings?: ReadonlySet<string>;
  /** Fired when the user clicks a catering chip in the expanded-row picker. */
  readonly onLoadCatering?: (date: string, companyId: string) => void;
  readonly sortId: SortId;
  readonly xId: MetricId;
  readonly yId: MetricId;
  readonly onChangeX: (id: MetricId) => void;
  readonly onChangeY: (id: MetricId) => void;
}

type Overrides = Readonly<Record<string, string>>;
/** Date of the currently-expanded row, or null. Only one row open at a time. */
type Expansion = string | null;

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- props carry a ReadonlySet which the lint already treats as readonly
export const DayByDayListSingle = ({
  availableCaterings,
  days,
  loadingCaterings,
  loadingPoolDates,
  onChangeX,
  onChangeY,
  onExpandDate,
  onLoadCatering,
  poolByDate,
  skeletonDates,
  sortId,
  xId,
  yId,
}: Readonly<DayByDaySingleProps>) => {
  const [expansion, setExpansion] = React.useState<Expansion>(null);
  const [swaps, setSwaps] = React.useState<AllSwaps>({});
  /** Per-day manual override of which offer is "the pick" for that day. */
  const [overrides, setOverrides] = React.useState<Overrides>({});

  const sortOpt = getSortOption(sortId);

  const toggleExpansion = React.useCallback(
    (date: string, currentlyOpen: boolean) => {
      const next = currentlyOpen ? null : date;
      setExpansion(next);
      if (next !== null && onExpandDate) {
        onExpandDate(next);
      }
    },
    [onExpandDate]
  );

  // Reset overrides when the sort changes — the user picked a new ranking
  // criterion, so previous manual picks no longer reflect intent.
  React.useEffect(() => {
    setOverrides({});
  }, [sortId]);

  const handleSwap = React.useCallback(
    (date: string, offerId: string, slot: string, opt: MealOption) => {
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
  // explicit "wybierz" — selection is implicit. Uses the lazily-loaded pool
  // when present so a scatter-dot click (which can target any catering in
  // `poolByDate[date]`) actually finds its offer; without this fallback the
  // override id would be invisible to `ranked.find()` and the summary would
  // silently snap back to the row's default winner.
  const resolved = React.useMemo<readonly ResolvedSelection[]>(() => {
    const out: ResolvedSelection[] = [];
    for (const day of days) {
      const base = poolByDate?.[day.date] ?? day.all_offers;
      if (base.length === 0) {
        continue;
      }
      const swapped = base.map((o) =>
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
  }, [days, overrides, poolByDate, sortId, swaps]);

  // Phase A is in flight after a config change — show shimmer placeholders
  // for every selected date. Inputs above stay live; debounce + abort in
  // the parent handles successive changes.
  if (skeletonDates && skeletonDates.length > 0) {
    return (
      <TooltipProvider delayDuration={120} skipDelayDuration={200}>
        <div className="px-5 sm:px-8 lg:px-14 pt-3 pb-6">
          <div>
            {skeletonDates.map((d) => (
              <DayRowSkeleton date={d} key={d} />
            ))}
          </div>
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={120} skipDelayDuration={200}>
      <div className="px-5 sm:px-8 lg:px-14 pt-3 pb-6">
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

            // Prefer the lazily-fetched full pool when present; fall back to
            // the day's own offers (which after Phase A is just top-1). This
            // lets the row header render instantly off Phase A data while
            // the scatter waits for the per-day pool.
            const pool = poolByDate?.[day.date];
            const baseOffers = pool ?? day.all_offers;
            const swapped: readonly Offer[] = baseOffers.map((o) =>
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
            const poolLoading =
              open &&
              pool === undefined &&
              (loadingPoolDates?.has(day.date) ?? false);

            // Caterings that aren't yet represented as dots on the scatter.
            // The picker chip list lets the user click any of these to load
            // its data on demand.
            const loadedCompanyIds = new Set(
              baseOffers.map((o) => o.company_id)
            );
            const unloadedCaterings = (availableCaterings ?? []).filter(
              (c) => !loadedCompanyIds.has(c.company_id)
            );

            return (
              <SingleRow
                allOffers={swapped}
                cheapestId={cheapest.offer_id}
                day={day}
                formatMetric={sortOpt.format}
                key={day.date}
                loadingCaterings={loadingCaterings ?? new Set()}
                metricLabel={sortOpt.short}
                offer={chosen}
                onChangeX={onChangeX}
                onChangeY={onChangeY}
                onLoadCatering={(companyId) => {
                  onLoadCatering?.(day.date, companyId);
                }}
                onPickFromScatter={(offerId) => {
                  handlePickFromScatter(day.date, offerId);
                }}
                onSwapMeal={(slot, opt) => {
                  handleSwap(day.date, chosen.offer_id, slot, opt);
                }}
                onToggle={() => {
                  toggleExpansion(day.date, open);
                }}
                open={open}
                poolLoading={poolLoading}
                rank={chosenRank + 1}
                totalForDay={day.total_considered}
                unloadedCaterings={unloadedCaterings}
                xId={xId}
                yId={yId}
              />
            );
          })}
        </div>

        <OrderSummary resolved={resolved} />
      </div>
    </TooltipProvider>
  );
};
