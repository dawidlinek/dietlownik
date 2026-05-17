"use client";

import * as React from "react";

import { DishDetailsPopover } from "@/components/meal-swap-popover";
import { OfferScatter } from "@/components/offer-scatter";
import { formatPriceNumber } from "@/lib/format";
import { aggregateMacros } from "@/lib/mock-match-data";
import type {
  MockDay,
  MockHit,
  MockMealOption,
  MockOffer,
  MockPick,
} from "@/lib/mock-match-data";
import { getMetric } from "@/lib/scatter-metrics";
import type { MetricId } from "@/lib/scatter-metrics";
import { usePersistedState } from "@/lib/use-persisted-state";
import { cn } from "@/lib/utils";

// ── Axis context (shared metric pickers across all scatter panels) ──────────

interface AxisContextValue {
  readonly xId: MetricId;
  readonly yId: MetricId;
  readonly setX: (id: MetricId) => void;
  readonly setY: (id: MetricId) => void;
}

const AxisContext = React.createContext<AxisContextValue | null>(null);

const useAxis = (): AxisContextValue => {
  const ctx = React.useContext(AxisContext);
  if (!ctx) {
    throw new Error("useAxis must be used within AxisContext.Provider");
  }
  return ctx;
};

// ── Formatting helpers ──────────────────────────────────────────────────────

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

// ── State types ─────────────────────────────────────────────────────────────

/** slot_name → swapped option */
type SwapMap = Readonly<Record<string, MockMealOption>>;
/** `${date}::${offer_id}` → SwapMap */
type AllSwaps = Readonly<Record<string, SwapMap>>;
/** date → override offer_id */
type Overrides = Readonly<Record<string, string>>;

type ExpandMode = "picks" | "scatter";
interface Expansion {
  readonly date: string;
  readonly cell: "cheap" | "best";
  readonly mode: ExpandMode;
}

// ── Effective offer (with mealswaps applied) ────────────────────────────────

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
    // Carry the alternates field forward (it's stripped from MockMealOption).
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

// ── Small UI atoms ──────────────────────────────────────────────────────────

const HitGlyph = ({ channel }: Readonly<{ channel: MockHit["channel"] }>) => (
  <span
    aria-hidden
    className={cn(
      "inline-block w-3 text-center",
      channel === "prefer"
        ? "text-[var(--color-olive)]"
        : "text-[var(--color-clay)]"
    )}
  >
    {channel === "prefer" ? "✓" : "⚠"}
  </span>
);

const InlineHits = ({
  hits,
  limit = 2,
}: Readonly<{ hits: readonly MockHit[]; limit?: number }>) => {
  if (hits.length === 0) {
    return (
      <span className="text-[12px] text-[var(--color-ink-3)]/70 italic">
        bez dopasowań
      </span>
    );
  }
  const top = [...hits]
    .toSorted((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, limit);
  const extra = hits.length - top.length;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-[var(--color-ink-2)]">
      {top.map((h, i) => (
        <span
          className="inline-flex items-center gap-1"
          // oxlint-disable-next-line react/no-array-index-key -- hits in mock data are not stably keyable; index is fine for static render
          key={`${h.keyword}-${i}`}
        >
          <HitGlyph channel={h.channel} />
          <span>{h.keyword}</span>
        </span>
      ))}
      {extra > 0 && <span className="text-[var(--color-ink-3)]">+{extra}</span>}
    </span>
  );
};

const ScoreBadge = ({
  onToggle,
  open,
  score,
}: Readonly<{
  score: number;
  open: boolean;
  onToggle: () => void;
}>) => {
  const isPositive = score > 0.05;
  const isNegative = score < -0.05;
  const magnitude = Math.abs(score);
  const heavy = magnitude >= 3;
  return (
    <button
      aria-expanded={open}
      className={cn(
        "inline-flex items-center gap-1.5 px-1.5 py-0.5 -ml-1.5 rounded-sm",
        "hover:bg-[var(--color-oat)] transition-colors text-left"
      )}
      onClick={onToggle}
      title="Pokaż rozkład wyniku per posiłek"
      type="button"
    >
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
      <span
        aria-hidden
        className={cn(
          "text-[10px] text-[var(--color-ink-3)] transition-transform",
          open && "rotate-180"
        )}
      >
        ↓
      </span>
    </button>
  );
};

// ── Picks breakdown (the expand panel) ──────────────────────────────────────

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
            <th className="text-left font-medium py-1">dopasowania</th>
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
                  {p.is_default && (
                    <span className="ml-2 text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
                      default
                    </span>
                  )}
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
                <td className="py-1.5">
                  <InlineHits hits={p.hits} limit={4} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

// ── Cell label (clickable when scatter is enabled) ─────────────────────────

interface CellLabelProps {
  readonly label: string;
  readonly canExploreScatter: boolean;
  readonly scatterOpen: boolean;
  readonly onToggleScatter: () => void;
  readonly overrideActive: boolean;
  readonly onClearOverride: () => void;
}

const CellLabel = ({
  canExploreScatter,
  label,
  onClearOverride,
  onToggleScatter,
  overrideActive,
  scatterOpen,
}: Readonly<CellLabelProps>) => {
  if (!canExploreScatter) {
    return (
      <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-ink-3)]">
        {label}
      </div>
    );
  }
  return (
    <div className="flex items-baseline gap-2">
      <button
        aria-expanded={scatterOpen}
        className={cn(
          "text-[10px] uppercase tracking-[0.1em]",
          "text-[var(--color-ink-3)] hover:text-[var(--color-ink)]",
          "transition-colors -ml-0.5 px-0.5 rounded-sm",
          scatterOpen && "text-[var(--color-ink)] bg-[var(--color-oat)]"
        )}
        onClick={onToggleScatter}
        type="button"
      >
        {label}
        <span
          aria-hidden
          className={cn(
            "ml-1 text-[9px] inline-block transition-transform",
            scatterOpen && "rotate-180"
          )}
        >
          ▾
        </span>
      </button>
      {overrideActive && (
        <button
          className="text-[10px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] underline-offset-2 hover:underline"
          onClick={onClearOverride}
          type="button"
        >
          wróć do auto
        </button>
      )}
    </div>
  );
};

// ── Scatter panel (the expand contents) ─────────────────────────────────────

interface ScatterPanelProps {
  readonly day: MockDay;
  readonly selectedId: string;
  readonly onPick: (offerId: string) => void;
}

const ScatterPanel = ({
  day,
  onPick,
  selectedId,
}: Readonly<ScatterPanelProps>) => {
  const { setX, setY, xId, yId } = useAxis();
  if (day.cheapest === null || day.all_offers.length === 0) {
    return null;
  }
  const xMetric = getMetric(xId);
  const yMetric = getMetric(yId);
  return (
    <div className="mt-3 border-t border-[var(--color-bone)] pt-4">
      <OfferScatter
        cheapestId={day.cheapest.offer_id}
        offers={day.all_offers}
        onChangeX={setX}
        onChangeY={setY}
        onPick={onPick}
        selectedId={selectedId}
        xMetric={xMetric}
        yMetric={yMetric}
      />
    </div>
  );
};

// ── Offer cell ──────────────────────────────────────────────────────────────

interface OfferCellProps {
  readonly offer: MockOffer;
  readonly label: string;
  readonly picksOpen: boolean;
  readonly onTogglePicks: () => void;
  readonly canExploreScatter: boolean;
  readonly scatterOpen: boolean;
  readonly onToggleScatter: () => void;
  readonly overrideActive: boolean;
  readonly onClearOverride: () => void;
  readonly onSwapMeal: (slot: string, option: MockMealOption) => void;
  readonly scatterDay: MockDay | null;
  readonly onPickFromScatter: (offerId: string) => void;
  /** True when this offer is the day's committed selection. */
  readonly selected: boolean;
  readonly onToggleSelect: () => void;
}

const SelectButton = ({
  onClick,
  selected,
}: Readonly<{ selected: boolean; onClick: () => void }>) => (
  <button
    aria-pressed={selected}
    className={cn(
      "text-[12px] underline-offset-2 hover:underline transition-colors",
      selected
        ? "text-[var(--color-olive)] hover:text-[var(--color-ink)]"
        : "text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
    )}
    onClick={onClick}
    type="button"
  >
    {selected ? "✓ wybrane" : "+ wybierz"}
  </button>
);

const OfferCell = ({
  canExploreScatter,
  label,
  offer,
  onClearOverride,
  onPickFromScatter,
  onSwapMeal,
  onTogglePicks,
  onToggleScatter,
  onToggleSelect,
  overrideActive,
  picksOpen,
  scatterDay,
  scatterOpen,
  selected,
}: Readonly<OfferCellProps>) => (
  <div
    className={cn(
      "flex flex-col gap-1.5 -mx-2 px-2 py-1 rounded-sm",
      "transition-colors",
      selected && "bg-[var(--color-amber-tint)]/30"
    )}
  >
    <CellLabel
      canExploreScatter={canExploreScatter}
      label={label}
      onClearOverride={onClearOverride}
      onToggleScatter={onToggleScatter}
      overrideActive={overrideActive}
      scatterOpen={scatterOpen}
    />

    {/* Identity line */}
    <div className="text-[13px] text-[var(--color-ink-2)]">
      <span className="text-[var(--color-ink)] font-medium">
        {offer.company_name}
      </span>
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

    {/* Price + select */}
    {/* Price · pre-promo strike · promo chip · select */}
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
      <SelectButton onClick={onToggleSelect} selected={selected} />
    </div>

    {/* Score */}
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-0.5">
      <ScoreBadge
        onToggle={onTogglePicks}
        open={picksOpen}
        score={offer.score_best}
      />
    </div>

    {/* Picks expand */}
    <div className="row-expand" data-open={picksOpen}>
      <div className="row-expand-inner">
        <PicksTable
          isMenuConfig={offer.is_menu_configuration}
          onSwap={onSwapMeal}
          picks={offer.picks}
        />
      </div>
    </div>

    {/* Scatter expand */}
    <div className="row-expand" data-open={scatterOpen}>
      <div className="row-expand-inner">
        {scatterDay && (
          <ScatterPanel
            day={scatterDay}
            onPick={onPickFromScatter}
            selectedId={offer.offer_id}
          />
        )}
      </div>
    </div>
  </div>
);

// ── Empty cell (no menus captured) ──────────────────────────────────────────

const EmptyCell = () => (
  <div className="flex flex-col gap-1.5">
    <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-ink-3)]">
      brak danych
    </div>
    <div className="text-[13px] text-[var(--color-ink-3)] italic">
      menu na ten dzień nie zostało jeszcze opublikowane przez cateringi
    </div>
  </div>
);

// ── Day row helpers ─────────────────────────────────────────────────────────

interface OpenFlags {
  readonly cheapPicks: boolean;
  readonly cheapScatter: boolean;
  readonly bestPicks: boolean;
  readonly bestScatter: boolean;
}

const makeOpenFlags = (
  expansion: Expansion | null,
  date: string
): OpenFlags => {
  const matches = expansion !== null && expansion.date === date;
  return {
    bestPicks:
      matches && expansion.cell === "best" && expansion.mode === "picks",
    bestScatter:
      matches && expansion.cell === "best" && expansion.mode === "scatter",
    cheapPicks:
      matches && expansion.cell === "cheap" && expansion.mode === "picks",
    cheapScatter:
      matches && expansion.cell === "cheap" && expansion.mode === "scatter",
  };
};

interface DayRowProps {
  readonly day: MockDay;
  readonly expansion: Expansion | null;
  readonly onToggle: (next: Expansion | null) => void;
  readonly overrideId: string | undefined;
  readonly onOverride: (offerId: string | null) => void;
  readonly swaps: AllSwaps;
  readonly onSwap: (offerId: string, slot: string, opt: MockMealOption) => void;
  readonly selectedId: string | undefined;
  readonly onToggleSelect: (offerId: string) => void;
}

const DayOffers = ({
  day,
  expansion,
  onOverride,
  onSwap,
  onToggle,
  onToggleSelect,
  overrideId,
  selectedId,
  swaps,
}: Readonly<DayRowProps>) => {
  if (day.cheapest === null || day.best_fit === null) {
    return (
      <div className="md:col-span-2">
        <EmptyCell />
      </div>
    );
  }

  // Resolve the "best" offer after applying any user override.
  const overriddenBest =
    overrideId === undefined
      ? day.best_fit
      : (day.all_offers.find((o) => o.offer_id === overrideId) ?? day.best_fit);
  const overrideActive =
    overrideId !== undefined && overrideId !== day.best_fit.offer_id;

  // Apply per-offer mealswaps.
  const effCheap = applySwaps(
    day.cheapest,
    swaps[`${day.date}::${day.cheapest.offer_id}`] ?? {}
  );
  const effBest = applySwaps(
    overriddenBest,
    swaps[`${day.date}::${overriddenBest.offer_id}`] ?? {}
  );

  const isCollapsed = effCheap.offer_id === effBest.offer_id;
  const open = makeOpenFlags(expansion, day.date);

  const toggle = (
    cell: "cheap" | "best",
    mode: ExpandMode,
    currentlyOpen: boolean
  ) => {
    onToggle(currentlyOpen ? null : { cell, date: day.date, mode });
  };

  if (isCollapsed) {
    // Single cell — clickable scatter, no override-reset link needed.
    return (
      <div className="md:col-span-2">
        <OfferCell
          canExploreScatter
          label={
            overrideActive ? "twój wybór" : "najtańsza · najlepsze dopasowanie"
          }
          offer={effBest}
          onClearOverride={() => {
            onOverride(null);
          }}
          onPickFromScatter={(id) => {
            onOverride(id);
          }}
          onSwapMeal={(slot, opt) => {
            onSwap(effBest.offer_id, slot, opt);
          }}
          onToggleScatter={() => {
            toggle("best", "scatter", open.bestScatter);
          }}
          onTogglePicks={() => {
            toggle("best", "picks", open.bestPicks);
          }}
          onToggleSelect={() => {
            onToggleSelect(effBest.offer_id);
          }}
          overrideActive={overrideActive}
          picksOpen={open.bestPicks}
          scatterDay={day}
          scatterOpen={open.bestScatter}
          selected={selectedId === effBest.offer_id}
        />
      </div>
    );
  }

  return (
    <>
      <OfferCell
        canExploreScatter={false}
        label="najtańsza"
        offer={effCheap}
        onClearOverride={() => {
          /* no-op */
        }}
        onPickFromScatter={() => {
          /* no-op */
        }}
        onSwapMeal={(slot, opt) => {
          onSwap(effCheap.offer_id, slot, opt);
        }}
        onToggleScatter={() => {
          /* no-op */
        }}
        onTogglePicks={() => {
          toggle("cheap", "picks", open.cheapPicks);
        }}
        onToggleSelect={() => {
          onToggleSelect(effCheap.offer_id);
        }}
        overrideActive={false}
        picksOpen={open.cheapPicks}
        scatterDay={null}
        scatterOpen={open.cheapScatter}
        selected={selectedId === effCheap.offer_id}
      />
      <OfferCell
        canExploreScatter
        label={overrideActive ? "twój wybór" : "najlepsze dopasowanie"}
        offer={effBest}
        onClearOverride={() => {
          onOverride(null);
        }}
        onPickFromScatter={(id) => {
          onOverride(id);
        }}
        onSwapMeal={(slot, opt) => {
          onSwap(effBest.offer_id, slot, opt);
        }}
        onToggleScatter={() => {
          toggle("best", "scatter", open.bestScatter);
        }}
        onTogglePicks={() => {
          toggle("best", "picks", open.bestPicks);
        }}
        onToggleSelect={() => {
          onToggleSelect(effBest.offer_id);
        }}
        overrideActive={overrideActive}
        picksOpen={open.bestPicks}
        scatterDay={day}
        scatterOpen={open.bestScatter}
        selected={selectedId === effBest.offer_id}
      />
    </>
  );
};

const DayRow = (props: Readonly<DayRowProps>) => (
  <div className="grid grid-cols-1 md:grid-cols-[110px_1fr_1fr] gap-x-8 gap-y-4 py-7 border-t border-[var(--color-bone)] first:border-t-0">
    {/* Date column */}
    <div className="md:pt-1">
      <div className="text-[12px] uppercase tracking-[0.1em] text-[var(--color-ink-3)]">
        {props.day.weekday_short_pl}
      </div>
      <div className="font-display text-[22px] leading-tight text-[var(--color-ink)] tnum">
        {formatDayMonth(props.day.date)}
      </div>
      {props.day.total_considered > 0 && (
        <div className="text-[11px] text-[var(--color-ink-3)] mt-2">
          {props.day.total_considered} wariantów
        </div>
      )}
    </div>

    {/* Offer columns */}
    <DayOffers {...props} />
  </div>
);

// ── Top-level list ──────────────────────────────────────────────────────────

export interface DayByDayListProps {
  readonly days: readonly MockDay[];
  readonly prefer: readonly string[];
  readonly avoid: readonly string[];
}

type Selections = Readonly<Record<string, string>>;

interface ResolvedSelection {
  readonly date: string;
  readonly weekday: string;
  readonly company_name: string;
  readonly price_per_day: number;
}

const findOffer = (day: MockDay, offerId: string): MockOffer | null => {
  if (day.cheapest !== null && day.cheapest.offer_id === offerId) {
    return day.cheapest;
  }
  if (day.best_fit !== null && day.best_fit.offer_id === offerId) {
    return day.best_fit;
  }
  return day.all_offers.find((o) => o.offer_id === offerId) ?? null;
};

const resolveSelections = (
  days: readonly MockDay[],
  selections: Selections
): readonly ResolvedSelection[] => {
  const resolved: ResolvedSelection[] = [];
  for (const day of days) {
    const offerId = selections[day.date];
    if (offerId === undefined) {
      continue;
    }
    const offer = findOffer(day, offerId);
    if (offer === null) {
      continue;
    }
    resolved.push({
      company_name: offer.company_name,
      date: day.date,
      price_per_day: offer.price_per_day,
      weekday: day.weekday_short_pl,
    });
  }
  return resolved;
};

const SelectionSummary = ({
  onClear,
  resolved,
}: Readonly<{
  resolved: readonly ResolvedSelection[];
  onClear: () => void;
}>) => {
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
              twoje zamówienie
            </span>
            <span className="text-[13px] text-[var(--color-ink-2)] tnum">
              {resolved.length} {resolved.length === 1 ? "dzień" : "dni"}
            </span>
            <button
              className="text-[11px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] underline-offset-2 hover:underline"
              onClick={onClear}
              type="button"
            >
              wyczyść
            </button>
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

export const DayByDayList = ({
  avoid,
  days,
  prefer,
}: Readonly<DayByDayListProps>) => {
  const [expansion, setExpansion] = React.useState<Expansion | null>(null);
  const [overrides, setOverrides] = React.useState<Overrides>({});
  const [swaps, setSwaps] = React.useState<AllSwaps>({});
  const [selections, setSelections] = React.useState<Selections>({});
  const [xId, setX] = usePersistedState<MetricId>("match.scatter.x", "price");
  const [yId, setY] = usePersistedState<MetricId>("match.scatter.y", "score");

  const axisValue = React.useMemo<AxisContextValue>(
    () => ({ setX, setY, xId, yId }),
    [xId, yId]
  );

  const handleOverride = React.useCallback(
    (date: string, offerId: string | null) => {
      setOverrides((prev) => {
        if (offerId === null) {
          const { [date]: _omit, ...rest } = prev;
          return rest;
        }
        return { ...prev, [date]: offerId };
      });
    },
    []
  );

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

  const handleToggleSelect = React.useCallback(
    (date: string, offerId: string) => {
      setSelections((prev) => {
        if (prev[date] === offerId) {
          const { [date]: _omit, ...rest } = prev;
          return rest;
        }
        return { ...prev, [date]: offerId };
      });
    },
    []
  );

  const resolved = React.useMemo(
    () => resolveSelections(days, selections),
    [days, selections]
  );

  return (
    <AxisContext.Provider value={axisValue}>
      <div className="px-5 sm:px-8 lg:px-14 pt-3 pb-6">
        {/* Mock banner */}
        <div className="py-3 text-[12px] italic text-[var(--color-ink-3)]">
          mock · dane fikcyjne, do projektowania widoku · prefer:{" "}
          {prefer.join(", ") || "—"} · avoid: {avoid.join(", ") || "—"}
        </div>

        <div>
          {days.map((d) => (
            <DayRow
              day={d}
              expansion={expansion}
              key={d.date}
              onOverride={(offerId) => {
                handleOverride(d.date, offerId);
              }}
              onSwap={(offerId, slot, opt) => {
                handleSwap(d.date, offerId, slot, opt);
              }}
              onToggle={setExpansion}
              onToggleSelect={(offerId) => {
                handleToggleSelect(d.date, offerId);
              }}
              overrideId={overrides[d.date]}
              selectedId={selections[d.date]}
              swaps={swaps}
            />
          ))}
        </div>

        <SelectionSummary
          onClear={() => {
            setSelections({});
          }}
          resolved={resolved}
        />
      </div>
    </AxisContext.Provider>
  );
};
