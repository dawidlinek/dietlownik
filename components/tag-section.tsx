"use client";

import * as React from "react";
import { type DashboardRow } from "@/lib/queries";
import { formatPriceNumber, formatDelta } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface PromoChip {
  code: string;
  discountPct: number | null;
  scope: "company" | "global";
}

export interface SummaryEntry {
  row: DashboardRow;
  chips: PromoChip[];
}

const VISIBLE = 3;

export function TagSection({
  label,
  entries,
}: {
  label: string;
  entries: SummaryEntry[];
}) {
  const [expanded, setExpanded] = React.useState(false);
  const visible = expanded ? entries : entries.slice(0, VISIBLE);
  const hidden = entries.length - VISIBLE;

  return (
    <div>
      <div className="flex items-baseline justify-between border-b border-[var(--color-bone)] pb-3 mb-1">
        <h2 className="font-display text-[var(--color-ink)] text-[var(--text-xl)] leading-none">
          {label}
        </h2>
        <span className="text-[12px] text-[var(--color-ink-3)] tnum">
          {entries.length}{" "}
          {entries.length === 1 ? "firma" : entries.length < 5 ? "firmy" : "firm"}
        </span>
      </div>

      <ol>
        {visible.map((e, i) => (
          <Row key={`${e.row.company_id}::${e.row.diet_calories_id}`} entry={e} rank={i + 1} />
        ))}
      </ol>

      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-4 text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] transition-colors"
        >
          {expanded
            ? "Pokaż mniej"
            : `Pokaż jeszcze ${hidden} ${hidden === 1 ? "firmę" : hidden < 5 ? "firmy" : "firm"} →`}
        </button>
      )}
    </div>
  );
}

function Row({ entry, rank }: { entry: SummaryEntry; rank: number }) {
  const { row, chips } = entry;
  const delta = formatDelta(
    row.per_day_cost_with_discounts,
    row.prev_per_day
  );
  const isTop = rank === 1;
  const dietlyUrl = `https://dietly.pl/catering-dietetyczny-firma/${row.company_id}`;

  const dietLine = [row.diet_name, row.tier_name].filter(Boolean).join(" · ");

  return (
    <li
      className={cn(
        "relative grid items-center gap-x-6 gap-y-2 py-4 border-b border-[var(--color-bone)]",
        // 12-col grid on lg; stacked on mobile
        "grid-cols-[auto_1fr] lg:grid-cols-[auto_minmax(0,2.4fr)_minmax(0,1fr)_auto_auto]"
      )}
    >
      {isTop && (
        <span
          aria-hidden
          className="absolute -left-3 top-3 bottom-3 w-[2px] bg-[var(--color-amber)]"
        />
      )}

      {/* rank */}
      <span
        className={cn(
          "tnum text-[12px] w-5 text-right row-span-2 lg:row-span-1 self-start lg:self-center pt-1 lg:pt-0",
          isTop ? "text-[var(--color-amber-deep)]" : "text-[var(--color-ink-3)]"
        )}
      >
        {rank}
      </span>

      {/* company + diet */}
      <div className="min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[15px] text-[var(--color-ink)] font-medium">
            {row.company_id}
          </span>
          {dietLine && (
            <span className="text-[13px] text-[var(--color-ink-3)] truncate">
              {dietLine}
            </span>
          )}
        </div>
        {chips.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5 lg:hidden">
            {chips.map((c) => (
              <Chip key={c.code} chip={c} />
            ))}
          </div>
        )}
      </div>

      {/* price */}
      <div className="lg:text-right tnum whitespace-nowrap">
        <span className="text-[18px] text-[var(--color-ink)]">
          {formatPriceNumber(row.per_day_cost_with_discounts)}
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

      {/* promo chips (desktop only) */}
      <div className="hidden lg:flex flex-wrap justify-end gap-1.5 max-w-[280px]">
        {chips.map((c) => (
          <Chip key={c.code} chip={c} />
        ))}
      </div>

      {/* CTA */}
      <a
        href={dietlyUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          "justify-self-end col-span-2 lg:col-span-1 text-[13px] tnum",
          "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full",
          "border border-[var(--color-bone)] hover:border-[var(--color-amber)]",
          "text-[var(--color-ink-2)] hover:text-[var(--color-ink)]",
          "hover:bg-[var(--color-amber-tint)] transition-colors"
        )}
      >
        Zamów
        <span aria-hidden>↗</span>
      </a>
    </li>
  );
}

function Chip({ chip }: { chip: PromoChip }) {
  // company-scoped = filled chip; global = outlined.
  // (Global chips don't actually appear here in practice — we render globals
  // in the page footer — but keep the branch for safety.)
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
}
