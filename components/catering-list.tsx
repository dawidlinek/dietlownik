"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  PriceHistoryChart,
  type HistoryPoint,
} from "@/components/price-history-chart";
import {
  type CateringTile,
  type CampaignRow,
  type LeafRow,
} from "@/lib/queries";
import {
  formatPriceNumber,
  formatDelta,
  formatInt,
  formatDate,
} from "@/lib/format";
import { cn } from "@/lib/utils";

const DEFAULT_VISIBLE_COLLAPSED = 5;

interface PromoChip {
  code: string;
  discountPct: number | null;
  scope: "company" | "global";
}

export function CateringList({
  tiles,
  total,
  page,
  pageSize,
  campaigns,
  cityId,
  days,
  kcalMin,
  kcalMax,
  cityName,
  rangeMin,
  rangeMax,
  latestCaptureAt,
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
}) {
  // Build per-company promo chips and the global chips list once.
  const { byCompany, globals } = React.useMemo(() => {
    const byCompany = new Map<string, PromoChip[]>();
    const globals: PromoChip[] = [];
    for (const c of campaigns) {
      if (!c.code) continue;
      const chip: PromoChip = {
        code: c.code,
        discountPct: c.discount_percent ? parseFloat(c.discount_percent) : null,
        scope: c.company_id ? "company" : "global",
      };
      if (c.company_id) {
        const list = byCompany.get(c.company_id) ?? [];
        if (!list.some((x) => x.code === chip.code)) list.push(chip);
        byCompany.set(c.company_id, list);
      } else if (!globals.some((x) => x.code === chip.code)) {
        globals.push(chip);
      }
    }
    return { byCompany, globals };
  }, [campaigns]);

  if (tiles.length === 0) {
    return (
      <section className="px-5 sm:px-8 lg:px-14 py-16">
        <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] font-medium">
          Najtaniej dziś · {cityName} · {kcalMin === kcalMax ? `${kcalMin}` : `${kcalMin}–${kcalMax}`} kcal · {days} dni
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
            Pokazujemy {startIdx}{startIdx !== endIdx ? `–${endIdx}` : ""} z {total},
            posortowane od najtańszej. Kliknij firmę, żeby zobaczyć wszystkie jej diety.
          </p>
        </div>

        {rangeMin !== null && rangeMax !== null && (
          <div className="text-[12px] text-[var(--color-ink-3)] tnum whitespace-nowrap">
            {formatPriceNumber(rangeMin)} – {formatPriceNumber(rangeMax)} zł / dzień
          </div>
        )}
      </div>

      {/* Tiles */}
      <ol>
        {tiles.map((tile, i) => (
          <CateringTileRow
            key={tile.company_id}
            tile={tile}
            rank={(page - 1) * pageSize + i + 1}
            chips={byCompany.get(tile.company_id) ?? []}
            cityId={cityId}
            days={days}
            initiallyOpen={page === 1 && i === 0}
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
                key={c.code}
                className="text-[13px] text-[var(--color-ink-2)] tnum"
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

      {latestCaptureAt && (
        <p className="mt-10 text-[12px] text-[var(--color-ink-3)]">
          Dane: {formatDate(latestCaptureAt)}
        </p>
      )}
    </section>
  );
}

// ── tile row + drilldown ─────────────────────────────────────────────────────

function CateringTileRow({
  tile,
  rank,
  chips,
  cityId,
  days,
  initiallyOpen,
}: {
  tile: CateringTile;
  rank: number;
  chips: PromoChip[];
  cityId: number;
  days: number;
  initiallyOpen: boolean;
}) {
  const [open, setOpen] = React.useState(initiallyOpen);
  const c = tile.cheapest;
  const isTop = rank === 1;
  const dietLine = [c.diet_name, c.tier_name, c.diet_option_name]
    .filter(Boolean)
    .join(" · ");
  const delta = formatDelta(c.per_day_cost_with_discounts, c.prev_per_day);
  const dietlyUrl = `https://dietly.pl/catering-dietetyczny-firma/${tile.company_id}`;

  return (
    <li
      className={cn(
        "border-b border-[var(--color-bone)]",
        isTop && "relative"
      )}
    >
      {isTop && (
        <span
          aria-hidden
          className="absolute -left-3 top-3 bottom-3 w-[2px] bg-[var(--color-amber)]"
        />
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={`tile-${tile.company_id}`}
        className={cn(
          "w-full text-left grid items-center gap-x-6 gap-y-2 py-4 px-1 -mx-1 rounded-sm",
          "grid-cols-[auto_1fr] lg:grid-cols-[auto_minmax(0,2.4fr)_minmax(0,1fr)_auto_auto]",
          "hover:bg-[var(--color-oat)] transition-colors"
        )}
      >
        {/* rank */}
        <span
          className={cn(
            "tnum text-[12px] w-5 text-right row-span-2 lg:row-span-1 self-start lg:self-center pt-1 lg:pt-0",
            isTop ? "text-[var(--color-amber-deep)]" : "text-[var(--color-ink-3)]"
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
            {tile.awarded && (
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
          {chips.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5 lg:hidden">
              {chips.map((x) => (
                <Chip key={x.code} chip={x} />
              ))}
            </div>
          )}
        </div>

        {/* price */}
        <div className="lg:text-right tnum whitespace-nowrap">
          <span className="text-[18px] text-[var(--color-ink)]">
            {formatPriceNumber(c.per_day_cost_with_discounts)}
          </span>
          <span className="ml-1 text-[12px] text-[var(--color-ink-3)]">zł / dzień</span>
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
          {chips.map((x) => (
            <Chip key={x.code} chip={x} />
          ))}
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
              id={`tile-${tile.company_id}`}
              tile={tile}
              cityId={cityId}
              days={days}
              dietlyUrl={dietlyUrl}
            />
          )}
        </div>
      </div>
    </li>
  );
}

// ── expanded panel ───────────────────────────────────────────────────────────

function CateringDrilldown({
  id,
  tile,
  cityId,
  days,
  dietlyUrl,
}: {
  id: string;
  tile: CateringTile;
  cityId: number;
  days: number;
  dietlyUrl: string;
}) {
  // Always-visible: the leaf table. Lazy-loaded: history for the cheapest leaf.
  const [historyState, setHistoryState] = React.useState<{
    history: HistoryPoint[] | null;
    loading: boolean;
  }>({ history: null, loading: true });

  const cheapest = tile.cheapest;
  const abortRef = React.useRef<AbortController | null>(null);

  React.useEffect(() => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setHistoryState({ history: null, loading: true });
    (async () => {
      try {
        const u = new URL("/api/price-history", window.location.origin);
        u.searchParams.set("company_id", cheapest.company_id);
        u.searchParams.set("diet_calories_id", String(cheapest.diet_calories_id));
        u.searchParams.set("city_id", String(cityId));
        u.searchParams.set("days", String(days));
        const res = await fetch(u.toString(), { signal: ctrl.signal });
        if (ctrl.signal.aborted) return;
        const data = res.ok
          ? ((await res.json()) as { history: HistoryPoint[] })
          : { history: [] };
        if (!ctrl.signal.aborted) {
          setHistoryState({ history: data.history, loading: false });
        }
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        setHistoryState({ history: [], loading: false });
      }
    })();
    return () => ctrl.abort();
  }, [cheapest.company_id, cheapest.diet_calories_id, cityId, days]);

  // Show 8 leaves by default; expand to all on demand.
  const [showAllLeaves, setShowAllLeaves] = React.useState(false);
  const visible = showAllLeaves ? tile.leaves : tile.leaves.slice(0, 8);
  const hidden = tile.leaves.length - visible.length;

  return (
    <div
      id={id}
      className="bg-[var(--color-cream)] border-l-2 border-[var(--color-amber-tint)] pl-6 pr-4 py-6 my-2"
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
                  <Th className="w-[44%]">Dieta · Tier · Wariant</Th>
                  <Th className="w-[16%]">Kcal</Th>
                  <Th className="w-[20%] text-right">Cena / dzień</Th>
                  <Th className="w-[20%] text-right pr-3">Suma</Th>
                </tr>
              </thead>
              <tbody>
                {visible.map((l, idx) => (
                  <LeafRowDisplay key={leafKey(l)} leaf={l} highlight={idx === 0} />
                ))}
              </tbody>
            </table>
          </div>
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setShowAllLeaves(true)}
              className="mt-3 text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] transition-colors"
            >
              Pokaż jeszcze {hidden} {plural(hidden, "wariant", "warianty", "wariantów")} →
            </button>
          )}

          <div className="mt-6 flex items-center gap-3">
            <a
              href={dietlyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                "text-[13px] tnum inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full",
                "border border-[var(--color-bone)] hover:border-[var(--color-amber)]",
                "text-[var(--color-ink-2)] hover:text-[var(--color-ink)]",
                "hover:bg-[var(--color-amber-tint)] transition-colors"
              )}
            >
              Zamów na dietly.pl
              <span aria-hidden>↗</span>
            </a>
            {tile.feedback_value && tile.feedback_number ? (
              <span className="text-[12px] text-[var(--color-ink-3)] tnum">
                {parseFloat(tile.feedback_value).toFixed(2)} ★ ({tile.feedback_number}{" "}
                {plural(tile.feedback_number, "ocena", "oceny", "ocen")})
              </span>
            ) : null}
          </div>
        </div>

        {/* right: history chart for the cheapest leaf */}
        <div>
          <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] font-medium mb-3">
            Historia ceny najtańszego wariantu
          </p>
          {historyState.loading ? (
            <div className="h-[200px] bg-[var(--color-oat)]/60 rounded-sm" />
          ) : historyState.history && historyState.history.length > 0 ? (
            <PriceHistoryChart history={historyState.history} />
          ) : (
            <p className="text-[13px] text-[var(--color-ink-3)]">
              Za mało danych historycznych — rusz tę cenę przez kilka dni.
            </p>
          )}

          {cheapest.diet_description && (
            <>
              <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] font-medium mt-6 mb-2">
                Opis najtańszej diety
              </p>
              <p className="text-[13px] text-[var(--color-ink-2)] leading-relaxed">
                {cheapest.diet_description}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function LeafRowDisplay({ leaf, highlight }: { leaf: LeafRow; highlight: boolean }) {
  const dietLine = [leaf.diet_name, leaf.tier_name, leaf.diet_option_name]
    .filter(Boolean)
    .join(" · ");
  return (
    <tr
      className={cn(
        "border-t border-[var(--color-bone)]",
        highlight && "bg-[var(--color-amber-tint)]/35"
      )}
    >
      <td className="py-2 px-3">{dietLine || "—"}</td>
      <td className="py-2 px-3 tnum text-[var(--color-ink-2)]">
        {leaf.calories != null ? `${formatInt(leaf.calories)}` : "—"}
      </td>
      <td className="py-2 px-3 text-right tnum">
        {formatPriceNumber(leaf.per_day_cost_with_discounts)}
        <span className="ml-1 text-[var(--color-ink-3)]">zł</span>
      </td>
      <td className="py-2 px-3 text-right tnum pr-3 text-[var(--color-ink-2)]">
        {formatPriceNumber(leaf.total_cost)}
        <span className="ml-1 text-[var(--color-ink-3)]">zł</span>
      </td>
    </tr>
  );
}

function leafKey(l: LeafRow): string {
  return `${l.diet_calories_id}::${l.tier_id ?? "x"}::${l.diet_option_id ?? "x"}`;
}

// ── pagination ───────────────────────────────────────────────────────────────

function Pagination({ page, totalPages }: { page: number; totalPages: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const hrefFor = React.useCallback(
    (n: number) => {
      const sp = new URLSearchParams(searchParams.toString());
      if (n <= 1) sp.delete("page");
      else sp.set("page", String(n));
      const qs = sp.toString();
      return qs ? `${pathname}?${qs}` : pathname;
    },
    [pathname, searchParams]
  );

  React.useEffect(() => {
    // Prefetch neighbours so paging feels instant.
    if (page > 1) router.prefetch(hrefFor(page - 1));
    if (page < totalPages) router.prefetch(hrefFor(page + 1));
  }, [page, totalPages, hrefFor, router]);

  if (totalPages <= 1) return null;

  const items: number[] = [];
  // Compact bar: 1 … (page-1) page (page+1) … last
  const push = (n: number) => {
    if (n >= 1 && n <= totalPages && !items.includes(n)) items.push(n);
  };
  push(1);
  push(page - 1);
  push(page);
  push(page + 1);
  push(totalPages);
  items.sort((a, b) => a - b);

  return (
    <nav
      className="mt-10 flex items-center gap-2 text-[13px] tnum"
      aria-label="Paginacja firm"
    >
      <PageLink
        href={hrefFor(page - 1)}
        disabled={page <= 1}
        ariaLabel="Poprzednia strona"
      >
        ‹
      </PageLink>
      {items.map((n, i) => (
        <React.Fragment key={n}>
          {i > 0 && items[i] > items[i - 1] + 1 && (
            <span className="text-[var(--color-ink-3)]">…</span>
          )}
          <PageLink href={hrefFor(n)} active={n === page}>
            {n}
          </PageLink>
        </React.Fragment>
      ))}
      <PageLink
        href={hrefFor(page + 1)}
        disabled={page >= totalPages}
        ariaLabel="Następna strona"
      >
        ›
      </PageLink>
    </nav>
  );
}

function PageLink({
  href,
  children,
  active,
  disabled,
  ariaLabel,
}: {
  href: string;
  children: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  if (disabled) {
    return (
      <span
        className="px-2.5 py-1 rounded-full text-[var(--color-ink-3)]/40"
        aria-disabled="true"
        aria-label={ariaLabel}
      >
        {children}
      </span>
    );
  }
  return (
    <Link
      href={href}
      aria-label={ariaLabel}
      aria-current={active ? "page" : undefined}
      className={cn(
        "px-2.5 py-1 rounded-full transition-colors",
        active
          ? "bg-[var(--color-amber-tint)] text-[var(--color-ink)]"
          : "text-[var(--color-ink-2)] hover:bg-[var(--color-oat)]"
      )}
    >
      {children}
    </Link>
  );
}

// ── chrome ───────────────────────────────────────────────────────────────────

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
        "text-left text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] font-medium py-2 px-3",
        className
      )}
    >
      {children}
    </th>
  );
}

function Chip({ chip }: { chip: PromoChip }) {
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

// Polish pluralization (1 / 2..4 / 5+).
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (n === 1) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

// silence the unused var warning — DEFAULT_VISIBLE_COLLAPSED kept as a doc tag
void DEFAULT_VISIBLE_COLLAPSED;
