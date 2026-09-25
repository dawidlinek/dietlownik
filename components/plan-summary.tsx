"use client";

import { formatPriceNumber } from "@/lib/format";
import { planMath } from "@/lib/plan";
import type { ResolvedSelection } from "@/lib/plan";
import { cn } from "@/lib/utils";

/** 1 catering · 2–4 cateringi · 5+ cateringów (12–14 stay "cateringów"). */
const cateringsWord = (n: number): string => {
  if (n === 1) {
    return "catering";
  }
  const tens = n % 100;
  const ones = n % 10;
  if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) {
    return "cateringi";
  }
  return "cateringów";
};

const daysWord = (n: number): string => (n === 1 ? "dzień" : "dni");

export interface PlanSummaryProps {
  readonly resolved: readonly ResolvedSelection[];
  /** Phase A is in flight — the resolved picks belong to the old filters. */
  readonly loading: boolean;
  /** "24–28 wrz" — the selected date span, shown in the header line. */
  readonly spanLabel: string;
  readonly orderOpen: boolean;
  readonly canOrder: boolean;
  readonly onToggleOrder: () => void;
}

/**
 * The week's plan, compact: what is actually paid, then one line going
 * per-day average → list price → what the promo codes take off it.
 * Replaces the sticky footer summary; the order button opens the dietly
 * handoff popup.
 */
export const PlanSummary = ({
  canOrder,
  loading,
  onToggleOrder,
  orderOpen,
  resolved,
  spanLabel,
}: Readonly<PlanSummaryProps>) => {
  const m = planMath(resolved);
  const hasPlan = !loading && m.days > 0;

  return (
    <aside
      aria-busy={loading}
      aria-label="Plan"
      className="border-t-2 border-[var(--color-amber)] pt-4 min-w-0"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
          plan · {spanLabel}
        </span>
        {hasPlan && (
          <span className="text-[12px] text-[var(--color-ink-2)] tnum">
            {m.days} {daysWord(m.days)} · {m.caterings.length}{" "}
            {cateringsWord(m.caterings.length)}
          </span>
        )}
      </div>

      <div
        className={cn(
          "mt-3 font-display tnum text-[44px] lg:text-[56px] leading-none tracking-[-0.01em]",
          hasPlan
            ? "text-[var(--color-ink)]"
            : "text-[var(--color-ink-3)]/60 animate-pulse"
        )}
      >
        {hasPlan ? `${formatPriceNumber(m.total)} zł` : "—"}
      </div>
      <div className="mt-2.5 min-h-[20px] flex flex-wrap gap-x-4 gap-y-1 text-[13px] tnum">
        {hasPlan && (
          <>
            <span className="text-[var(--color-ink-2)]">
              {formatPriceNumber(m.total / m.days)} zł/dzień
            </span>
            {/* One phrase — "cennik X − Y z kodami" — so the minus reads as
                an operator at word spacing, not a flex gap. */}
            <span className="text-[var(--color-ink-3)]">
              cennik {formatPriceNumber(m.listTotal)} zł
              {m.savings >= 0.005 && (
                <span
                  className="text-[var(--color-olive)]"
                  title={`kody: ${m.codes.map((c) => c.code).join(", ")}`}
                >
                  {" "}
                  − {formatPriceNumber(m.savings)} zł z kodami
                </span>
              )}
            </span>
          </>
        )}
        {!loading && m.days === 0 && (
          <span className="italic text-[var(--color-ink-3)]">
            brak ofert dla tych filtrów
          </span>
        )}
      </div>

      <button
        aria-expanded={orderOpen}
        aria-haspopup="dialog"
        className={cn(
          "mt-5 w-full flex items-center justify-between px-[18px] py-[13px] rounded-sm text-[15px] tnum transition-colors",
          "bg-[var(--color-amber)] text-[var(--color-cream)] hover:bg-[var(--color-amber-deep)]",
          "disabled:opacity-50 disabled:cursor-not-allowed"
        )}
        disabled={!hasPlan || !canOrder}
        onClick={onToggleOrder}
        type="button"
      >
        <span>zamów {hasPlan ? `${m.days} ${daysWord(m.days)}` : ""}</span>
        <span aria-hidden>→</span>
      </button>
    </aside>
  );
};
