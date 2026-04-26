"use client";

import * as React from "react";
import {
  PriceHistoryChart,
  type HistoryPoint,
} from "@/components/price-history-chart";
import { type DashboardRow } from "@/lib/queries";
import {
  formatPriceNumber,
  formatDelta,
  formatInt,
  formatDate,
} from "@/lib/format";
import { cn } from "@/lib/utils";

// Display order: STANDARD first, then alpha. Nulls last as "Inne".
const TAG_PRIORITY: Record<string, number> = {
  STANDARD: 0,
};

function tagSort(a: string | null, b: string | null) {
  const aKey = a ?? "ZZZ_NULL";
  const bKey = b ?? "ZZZ_NULL";
  const ap = TAG_PRIORITY[aKey] ?? 1;
  const bp = TAG_PRIORITY[bKey] ?? 1;
  if (ap !== bp) return ap - bp;
  return aKey.localeCompare(bKey, "pl");
}

function tagLabel(tag: string | null): string {
  if (!tag) return "Inne";
  return tag.toLowerCase();
}

interface RowKey {
  companyId: string;
  dietCaloriesId: number;
}
function rowKey(r: DashboardRow): string {
  return `${r.company_id}::${r.diet_calories_id}`;
}

export interface PriceTableProps {
  rows: DashboardRow[];
  cityId: number;
  days: number;
  latestCaptureAt: string | null;
}

export function PriceTable({
  rows,
  cityId,
  days,
  latestCaptureAt,
}: PriceTableProps) {
  // Group by diet_tag.
  const grouped = React.useMemo(() => {
    const groups = new Map<string | null, DashboardRow[]>();
    for (const r of rows) {
      const t = r.diet_tag ?? null;
      const existing = groups.get(t);
      if (existing) existing.push(r);
      else groups.set(t, [r]);
    }
    const ordered = Array.from(groups.entries()).sort(([a], [b]) =>
      tagSort(a, b)
    );
    // For each group, identify cheapest row.
    return ordered.map(([tag, items]) => {
      const cheapest = items.reduce<DashboardRow | null>((acc, cur) => {
        const v = parseFloat(cur.per_day_cost_with_discounts ?? "");
        if (!Number.isFinite(v)) return acc;
        if (!acc) return cur;
        const a = parseFloat(acc.per_day_cost_with_discounts ?? "");
        return v < a ? cur : acc;
      }, null);
      return { tag, items, cheapestKey: cheapest ? rowKey(cheapest) : null };
    });
  }, [rows]);

  if (rows.length === 0) {
    return (
      <div className="px-5 sm:px-8 lg:px-14 py-12">
        <p className="text-[var(--color-ink-2)]">
          Brak ofert pasujących do wybranych filtrów.
        </p>
      </div>
    );
  }

  return (
    <div className="px-5 sm:px-8 lg:px-14 pb-24">
      <table className="w-full caption-bottom text-sm">
        <thead>
          <tr className="border-b border-[var(--color-bone)]">
            <Th className="w-[20%]">Firma</Th>
            <Th className="w-[34%]">Dieta / Tier</Th>
            <Th className="w-[10%]">Kcal</Th>
            <Th className="w-[14%] text-right">Cena / dzień</Th>
            <Th className="w-[12%] text-right">Δ</Th>
            <Th className="w-[10%] text-right pr-1">Promo</Th>
          </tr>
        </thead>

        <tbody>
          {grouped.map(({ tag, items, cheapestKey }) => (
            <GroupBlock
              key={tag ?? "null"}
              tag={tag}
              items={items}
              cheapestKey={cheapestKey}
              cityId={cityId}
              days={days}
            />
          ))}
        </tbody>
      </table>

      <p className="mt-12 text-[12px] text-[var(--color-ink-3)]">
        Dane: {latestCaptureAt ? formatDate(latestCaptureAt) : "—"} ·{" "}
        {rows.length} pozycji
      </p>
    </div>
  );
}

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={cn(
        "text-left text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] font-medium pb-3 pt-0",
        className
      )}
    >
      {children}
    </th>
  );
}

function GroupBlock({
  tag,
  items,
  cheapestKey,
  cityId,
  days,
}: {
  tag: string | null;
  items: DashboardRow[];
  cheapestKey: string | null;
  cityId: number;
  days: number;
}) {
  return (
    <>
      <tr>
        <td colSpan={6} className="pt-12 pb-3 border-b border-[var(--color-bone)]">
          <span className="text-[13px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] font-medium">
            {tagLabel(tag)}
          </span>
          <span className="ml-2 text-[12px] text-[var(--color-ink-3)]">
            ({items.length})
          </span>
        </td>
      </tr>
      {items.map((row) => (
        <RowWithExpand
          key={rowKey(row)}
          row={row}
          isCheapest={rowKey(row) === cheapestKey}
          cityId={cityId}
          days={days}
        />
      ))}
    </>
  );
}

function RowWithExpand({
  row,
  isCheapest,
  cityId,
  days,
}: {
  row: DashboardRow;
  isCheapest: boolean;
  cityId: number;
  days: number;
}) {
  const [open, setOpen] = React.useState(false);
  const [history, setHistory] = React.useState<HistoryPoint[] | null>(null);
  const [loading, setLoading] = React.useState(false);

  const abortRef = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const onToggle = React.useCallback(async () => {
    const next = !open;
    setOpen(next);
    if (next && history === null && !loading) {
      setLoading(true);
      const ctrl = new AbortController();
      abortRef.current?.abort();
      abortRef.current = ctrl;
      try {
        const u = new URL("/api/price-history", window.location.origin);
        u.searchParams.set("company_id", row.company_id);
        u.searchParams.set("diet_calories_id", String(row.diet_calories_id));
        u.searchParams.set("city_id", String(cityId));
        u.searchParams.set("days", String(days));
        const res = await fetch(u.toString(), { signal: ctrl.signal });
        if (ctrl.signal.aborted) return;
        if (res.ok) {
          const data = (await res.json()) as { history: HistoryPoint[] };
          if (!ctrl.signal.aborted) setHistory(data.history);
        } else {
          if (!ctrl.signal.aborted) setHistory([]);
        }
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        setHistory([]);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }
  }, [open, history, loading, row, cityId, days]);

  const delta = formatDelta(
    row.per_day_cost_with_discounts,
    row.prev_per_day
  );

  const hasPromo =
    Array.isArray(row.promo_codes) && row.promo_codes.length > 0;

  return (
    <>
      <tr
        className="border-b border-[var(--color-bone)] hover:bg-[var(--color-oat)] cursor-pointer transition-colors h-[52px]"
        onClick={onToggle}
        aria-expanded={open}
      >
        {/* FIRMA */}
        <td className="align-middle">
          <span className="text-[15px] font-medium text-[var(--color-ink)] group">
            <span className="group-hover:underline group-hover:decoration-[var(--color-amber)] group-hover:decoration-1 group-hover:underline-offset-4">
              {row.company_id}
            </span>
          </span>
        </td>

        {/* DIETA / TIER */}
        <td className="align-middle py-2">
          <div className="text-[15px] text-[var(--color-ink)] leading-tight">
            {row.diet_name ?? "—"}
          </div>
          {row.tier_name && (
            <div className="text-[12px] text-[var(--color-ink-3)] mt-0.5 leading-tight">
              {row.tier_name}
            </div>
          )}
        </td>

        {/* KCAL */}
        <td className="align-middle">
          <span className="tnum text-[14px] text-[var(--color-ink-2)]">
            {formatInt(row.calories)} <span className="text-[var(--color-ink-3)]">kcal</span>
          </span>
        </td>

        {/* CENA / DZIEŃ */}
        <td className="align-middle text-right relative">
          {isCheapest && (
            <span
              aria-hidden
              className="absolute left-0 top-2 bottom-2 w-[2px] bg-[var(--color-amber)]"
            />
          )}
          <span className="tnum text-[16px] text-[var(--color-ink)]">
            {formatPriceNumber(row.per_day_cost_with_discounts)}
          </span>
          <span className="ml-1 text-[12px] text-[var(--color-ink-3)]">zł</span>
        </td>

        {/* DELTA */}
        <td className="align-middle text-right">
          <span
            className={cn(
              "tnum text-[14px]",
              delta.kind === "down" && "text-[var(--color-olive)]",
              delta.kind === "up" && "text-[var(--color-clay)]",
              delta.kind === "flat" && "text-[var(--color-ink-3)]"
            )}
          >
            {delta.kind === "flat" ? (
              "—"
            ) : (
              <>
                <span aria-hidden className="mr-0.5">
                  {delta.kind === "down" ? "↓" : "↑"}
                </span>
                {delta.text}
              </>
            )}
          </span>
        </td>

        {/* PROMO */}
        <td className="align-middle text-right pr-1">
          {hasPromo ? (
            <span className="inline-flex items-center bg-[var(--color-amber-tint)] text-[var(--color-ink)] text-[12px] tnum px-2 py-0.5 rounded">
              {(row.promo_codes ?? []).join(",")}
            </span>
          ) : (
            <span className="text-[var(--color-ink-3)]">—</span>
          )}
        </td>
      </tr>

      <tr aria-hidden={!open} className="border-b border-transparent">
        <td colSpan={6} className="p-0">
          <div className="row-expand" data-open={open ? "true" : "false"}>
            <div className="row-expand-inner">
              {open && (
                <ExpandPanel
                  row={row}
                  history={history}
                  loading={loading}
                />
              )}
            </div>
          </div>
        </td>
      </tr>
    </>
  );
}

function ExpandPanel({
  row,
  history,
  loading,
}: {
  row: DashboardRow;
  history: HistoryPoint[] | null;
  loading: boolean;
}) {
  return (
    <div className="bg-[var(--color-cream)] border-l-2 border-[var(--color-amber-tint)] pl-6 pr-4 py-6 my-2">
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-8">
        <div>
          <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] font-medium mb-2">
            Opis
          </p>
          <p className="text-[14px] text-[var(--color-ink-2)] max-w-[60ch] leading-relaxed">
            {row.diet_description ?? "Brak opisu w bazie."}
          </p>

          <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] font-medium mt-6 mb-2">
            Rachunek
          </p>
          <ul className="text-[13px] text-[var(--color-ink-2)] space-y-1 tnum">
            <li>
              <span className="inline-block w-44 text-[var(--color-ink-3)]">
                Cena bez rabatów
              </span>
              {formatPriceNumber(row.per_day_cost)} zł / dzień
            </li>
            <li>
              <span className="inline-block w-44 text-[var(--color-ink-3)]">
                Po rabatach
              </span>
              {formatPriceNumber(row.per_day_cost_with_discounts)} zł / dzień
            </li>
            <li>
              <span className="inline-block w-44 text-[var(--color-ink-3)]">
                Suma za zamówienie
              </span>
              {formatPriceNumber(row.total_cost)} zł
            </li>
            {row.total_order_length_discount &&
              parseFloat(row.total_order_length_discount) > 0 && (
                <li>
                  <span className="inline-block w-44 text-[var(--color-ink-3)]">
                    Rabat za długość
                  </span>
                  −{formatPriceNumber(row.total_order_length_discount)} zł
                </li>
              )}
          </ul>
        </div>

        <div>
          <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] font-medium mb-2">
            Historia ceny
          </p>
          {loading ? (
            <div className="h-[200px] bg-[var(--color-oat)]/60 rounded-sm" />
          ) : history && history.length > 0 ? (
            <>
              <PriceHistoryChart history={history} />
              <HistoryStats history={history} />
            </>
          ) : (
            <p className="text-[13px] text-[var(--color-ink-3)]">
              Brak danych historycznych.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function HistoryStats({ history }: { history: HistoryPoint[] }) {
  if (history.length === 0) return null;
  const prices = history.map((h) => h.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const avg = prices.reduce((s, v) => s + v, 0) / prices.length;
  const first = history[0];
  return (
    <div className="mt-4 grid grid-cols-4 border-t border-[var(--color-bone)]">
      <Stat label="Pierwszy pomiar" value={formatDate(first.bucket)} />
      <Stat
        label="Najniższa"
        value={`${formatPriceNumber(min)} zł`}
        emphasize
      />
      <Stat label="Najwyższa" value={`${formatPriceNumber(max)} zł`} />
      <Stat label="Średnia" value={`${formatPriceNumber(avg)} zł`} />
    </div>
  );
}

function Stat({
  label,
  value,
  emphasize,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
}) {
  return (
    <div className="border-r border-[var(--color-bone)] last:border-r-0 px-3 py-3">
      <div className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] font-medium">
        {label}
      </div>
      <div
        className={cn(
          "tnum text-[14px] mt-1",
          emphasize ? "text-[var(--color-ink)]" : "text-[var(--color-ink-2)]"
        )}
      >
        {value}
      </div>
    </div>
  );
}
