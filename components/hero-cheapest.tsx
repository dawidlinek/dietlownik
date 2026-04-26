import * as React from "react";
import { type DashboardRow } from "@/lib/queries";
import { formatDelta } from "@/lib/format";
import { cn } from "@/lib/utils";

export function HeroCheapest({
  rows,
  kcal,
  days,
  cityName,
}: {
  rows: DashboardRow[];
  kcal: number;
  days: number;
  cityName: string;
}) {
  const cheapest = pickCheapest(rows);

  if (!cheapest) {
    return (
      <section className="px-5 sm:px-8 lg:px-14 py-24 lg:py-28">
        <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] font-medium">
          Najtaniej dziś
        </p>
        <p className="mt-6 text-[var(--color-ink-2)]">
          Brak ofert dla {cityName} · {kcal} kcal · {days} dni.
        </p>
      </section>
    );
  }

  const price = parseFloat(cheapest.per_day_cost_with_discounts ?? "0");
  const delta = formatDelta(
    cheapest.per_day_cost_with_discounts,
    cheapest.prev_per_day
  );

  // Polish decimal split — render integer + comma + decimals as separate spans
  // to preserve hero typographic rhythm.
  const [intPart, decPart] = price.toFixed(2).split(".");

  return (
    <section className="px-5 sm:px-8 lg:px-14 py-24 lg:py-28">
      <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-8">
        <div>
          <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] font-medium">
            Najtaniej dziś · {cityName} · {kcal} kcal · {days} dni
          </p>

          <div className="mt-5 flex items-end gap-3">
            <span
              className="font-display text-[var(--color-ink)] tnum leading-[0.95]"
              style={{
                fontSize: "var(--text-hero)",
                fontWeight: 380,
              }}
            >
              {intPart}
              <span className="text-[var(--color-ink-3)]">,</span>
              {decPart}
            </span>
            <span
              className="pb-3 text-[var(--color-ink-2)]"
              style={{ fontSize: "var(--text-base)" }}
            >
              zł / dzień
            </span>
          </div>

          <p className="mt-4 text-[var(--color-ink-2)] text-[15px]">
            <span className="text-[var(--color-ink)] font-medium">
              {cheapest.company_id}
            </span>
            <span className="mx-2 text-[var(--color-bone)]">·</span>
            <span>{cheapest.diet_name ?? "—"}</span>
            {cheapest.tier_name && (
              <>
                <span className="mx-2 text-[var(--color-bone)]">·</span>
                <span className="text-[var(--color-ink-3)]">
                  {cheapest.tier_name}
                </span>
              </>
            )}
          </p>
        </div>

        <div className="lg:text-right">
          <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] font-medium mb-1.5">
            Δ od ostatniego pomiaru
          </p>
          <p
            className={cn(
              "text-[15px] tnum",
              delta.kind === "down" && "text-[var(--color-olive)]",
              delta.kind === "up" && "text-[var(--color-clay)]",
              delta.kind === "flat" && "text-[var(--color-ink-3)]"
            )}
          >
            {delta.kind === "flat" ? (
              <>—</>
            ) : (
              <>
                <span aria-hidden className="mr-1">
                  {delta.kind === "down" ? "↓" : "↑"}
                </span>
                {delta.text} zł
              </>
            )}
          </p>
        </div>
      </div>
    </section>
  );
}

function pickCheapest(rows: DashboardRow[]): DashboardRow | null {
  let best: DashboardRow | null = null;
  let bestVal = Number.POSITIVE_INFINITY;
  for (const r of rows) {
    const v = parseFloat(r.per_day_cost_with_discounts ?? "");
    if (!Number.isFinite(v)) continue;
    if (v < bestVal) {
      bestVal = v;
      best = r;
    }
  }
  return best;
}

