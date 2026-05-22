"use client";

import * as React from "react";
import {
  CartesianGrid,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { MetricPicker } from "@/components/metric-picker";
import { ChartContainer } from "@/components/ui/chart";
import type { ChartConfig } from "@/components/ui/chart";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  cateringInitials,
  cateringPlaceholderColor,
  hasRenderableLogo,
  isLogoFailed,
  markLogoFailed,
} from "@/lib/catering-initials";
import { formatPriceNumber } from "@/lib/format";
import type { Offer } from "@/lib/match-types";
import type { Metric, MetricId } from "@/lib/scatter-metrics";
import { cn } from "@/lib/utils";

const chartConfig = {
  offer: { color: "var(--color-ink-2)", label: "Oferta" },
} satisfies ChartConfig;

interface ScatterPoint {
  readonly offer_id: string;
  readonly x: number;
  readonly y: number;
  readonly company_name: string;
  readonly logo_url: string | null;
  readonly diet_name: string;
  readonly tier_name: string | null;
  readonly calories: number;
  readonly is_menu_configuration: boolean;
  // Full info dump for the tooltip — every field is shown regardless of
  // which X/Y axes the user has picked.
  readonly price: number;
  readonly score: number;
  readonly review_score: number | null;
  readonly total_kcal: number;
  readonly total_protein_g: number;
  readonly total_fat_g: number;
  readonly total_carbs_g: number;
  readonly total_fiber_g: number;
}

const toPoint = (o: Offer, xM: Metric, yM: Metric): ScatterPoint => ({
  calories: o.calories,
  company_name: o.company_name,
  diet_name: o.diet_name,
  is_menu_configuration: o.is_menu_configuration,
  logo_url: o.logo_url ?? null,
  offer_id: o.offer_id,
  price: o.price_per_day,
  review_score: o.review_score ?? null,
  score: o.score_best,
  tier_name: o.tier_name,
  total_carbs_g: o.total_carbs_g,
  total_fat_g: o.total_fat_g,
  total_fiber_g: o.total_fiber_g,
  total_kcal: o.total_kcal,
  total_protein_g: o.total_protein_g,
  x: xM.accessor(o),
  y: yM.accessor(o),
});

const scoreColorClass = (v: number): string => {
  if (v > 0.05) {
    return "text-[var(--color-olive)]";
  }
  if (v < -0.05) {
    return "text-[var(--color-clay)]";
  }
  return "text-[var(--color-ink-3)]";
};

interface TooltipBodyProps {
  readonly point: ScatterPoint;
}

const formatScore = (v: number): string => {
  if (Math.abs(v) < 0.05) {
    return "0,0";
  }
  const sign = v > 0 ? "+" : "−";
  return `${sign}${Math.abs(v).toFixed(1).replace(".", ",")}`;
};

const formatReview = (v: number | null): string => {
  if (v === null) {
    return "—";
  }
  return new Intl.NumberFormat("pl-PL", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 1,
  }).format(v);
};

interface StatRowProps {
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
  readonly valueClass?: string;
}

const StatRow = ({
  label,
  unit,
  value,
  valueClass,
}: Readonly<StatRowProps>) => (
  <div className="flex items-baseline justify-between gap-3">
    <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
      {label}
    </span>
    <span
      className={cn(
        "tnum text-[12px]",
        valueClass ?? "text-[var(--color-ink)]"
      )}
    >
      {value}
      {unit !== undefined && unit !== "" && (
        <span className="text-[var(--color-ink-3)] ml-1">{unit}</span>
      )}
    </span>
  </div>
);

const TooltipBody = ({ point }: Readonly<TooltipBodyProps>) => {
  const scoreColor = scoreColorClass(point.score);
  return (
    <div className="rounded-md border border-[var(--color-bone)] bg-[var(--color-cream)] px-3 py-2 shadow-[0_8px_24px_-12px_oklch(22%_0.018_60_/_0.18)] min-w-[220px]">
      <div className="text-[13px] font-medium text-[var(--color-ink)]">
        {point.company_name}
      </div>
      <div className="text-[12px] text-[var(--color-ink-2)]">
        {point.diet_name}
        {point.tier_name !== null && point.tier_name !== "" && (
          <>
            <span className="text-[var(--color-ink-3)]"> · </span>
            <span>{point.tier_name}</span>
          </>
        )}
        <span className="text-[var(--color-ink-3)]"> · </span>
        <span className="tnum">{point.calories} kcal</span>
        {point.is_menu_configuration && (
          <span className="ml-1.5 text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
            menu config
          </span>
        )}
      </div>
      <div className="mt-1.5 flex flex-col gap-0.5">
        <StatRow
          label="cena"
          unit="zł"
          value={formatPriceNumber(point.price)}
        />
        <StatRow
          label="score"
          value={formatScore(point.score)}
          valueClass={scoreColor}
        />
        <StatRow
          label="opinia"
          unit={point.review_score === null ? "" : "★"}
          value={formatReview(point.review_score)}
        />
      </div>
      <div className="mt-1.5 pt-1.5 border-t border-[var(--color-bone)]/60 flex flex-col gap-0.5">
        <StatRow
          label="kcal"
          unit="kcal"
          value={String(Math.round(point.total_kcal))}
        />
        <StatRow
          label="białko"
          unit="g"
          value={String(Math.round(point.total_protein_g))}
        />
        <StatRow
          label="tłuszcz"
          unit="g"
          value={String(Math.round(point.total_fat_g))}
        />
        <StatRow
          label="węgle"
          unit="g"
          value={String(Math.round(point.total_carbs_g))}
        />
        <StatRow
          label="błonnik"
          unit="g"
          value={String(Math.round(point.total_fiber_g))}
        />
      </div>
      <div className="mt-1 text-[11px] italic text-[var(--color-ink-3)]">
        kliknij, aby wybrać
      </div>
    </div>
  );
};

interface TooltipShape {
  readonly active?: boolean;
  readonly payload?: readonly Readonly<{ payload?: ScatterPoint }>[];
}

const renderTooltip = ({ active, payload }: Readonly<TooltipShape>) => {
  if (active !== true || !payload || payload.length === 0) {
    return null;
  }
  const point = payload[0]?.payload;
  if (!point) {
    return null;
  }
  return <TooltipBody point={point} />;
};

// ── Logo marker shape ──────────────────────────────────────────────────────
// When a company has a logo_url we render the image clipped to a circle.
// Otherwise — or when the image fails to load at runtime (404 / CORS /
// blank response) — we fall back to a hashed-color circle stamped with
// initials. Failed URLs are remembered in the shared module-level set
// (`markLogoFailed`) so the same dot doesn't keep retrying.

interface InitialsBubbleProps {
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly companyName: string;
}

const InitialsBubble = ({
  companyName,
  cx,
  cy,
  r,
}: Readonly<InitialsBubbleProps>) => {
  const { bg, fg } = cateringPlaceholderColor(companyName);
  const initials = cateringInitials(companyName);
  const fontSize = initials.length > 1 ? r * 0.78 : r * 1;
  return (
    <>
      <circle
        cx={cx}
        cy={cy}
        fill={bg}
        r={r}
        stroke="var(--color-cream)"
        strokeWidth={1}
      />
      <text
        dominantBaseline="central"
        fill={fg}
        fontSize={fontSize}
        fontWeight={600}
        style={{ pointerEvents: "none", userSelect: "none" }}
        textAnchor="middle"
        x={cx}
        y={cy + 0.5}
      >
        {initials}
      </text>
    </>
  );
};

interface LogoMarkerProps {
  readonly cx?: number;
  readonly cy?: number;
  readonly r?: number;
  readonly ringStroke?: string;
  readonly ringWidth?: number;
  readonly payload?: ScatterPoint;
}

const LogoMarker = ({
  cx,
  cy,
  payload,
  r = 11,
  ringStroke,
  ringWidth = 0,
}: Readonly<LogoMarkerProps>) => {
  // Hooks before early return — `failedTick` re-renders this marker when an
  // image load fails, so the next render shows the initials fallback.
  const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);
  if (cx === undefined || cy === undefined || !payload) {
    return null;
  }
  const url = payload.logo_url;
  const tryImage = hasRenderableLogo(url) && !isLogoFailed(url);
  // Offer IDs encode `v1:company:dc[:tdo]` — colons inside an SVG element
  // id make `url(#...)` references unreliable across renderers (the image
  // fetches fine but gets clipped to nothing because the clipPath ID
  // doesn't resolve). Sanitize to id-safe chars before stamping into the
  // DOM.
  const clipId = `logo-clip-${payload.offer_id.replaceAll(
    /[^a-zA-Z0-9_-]/g,
    "_"
  )}`;
  const ringR = r + ringWidth - 0.5;
  return (
    <g style={{ pointerEvents: "all" }}>
      {ringStroke !== undefined && ringWidth > 0 && (
        <circle
          cx={cx}
          cy={cy}
          fill="none"
          r={ringR}
          stroke={ringStroke}
          strokeWidth={ringWidth}
        />
      )}
      {tryImage ? (
        <>
          <defs>
            <clipPath id={clipId}>
              <circle cx={cx} cy={cy} r={r} />
            </clipPath>
          </defs>
          <circle
            cx={cx}
            cy={cy}
            fill="var(--color-cream)"
            r={r}
            stroke="var(--color-bone)"
            strokeWidth={0.5}
          />
          <image
            clipPath={`url(#${clipId})`}
            height={r * 2}
            href={url}
            onError={() => {
              markLogoFailed(url);
              forceUpdate();
            }}
            preserveAspectRatio="xMidYMid slice"
            width={r * 2}
            x={cx - r}
            y={cy - r}
          />
        </>
      ) : (
        <InitialsBubble
          companyName={payload.company_name}
          cx={cx}
          cy={cy}
          r={r}
        />
      )}
    </g>
  );
};

const tooltipCursor = {
  stroke: "var(--color-bone)",
  strokeDasharray: "2 4",
};

/** Catering the user can load on demand (i.e. not yet a dot on the scatter). */
export interface UnloadedCatering {
  readonly company_id: string;
  readonly name: string;
}

export interface OfferScatterProps {
  readonly offers: readonly Offer[];
  readonly cheapestId: string;
  readonly selectedId: string;
  readonly onPick: (offerId: string) => void;
  readonly xMetric: Metric;
  readonly yMetric: Metric;
  readonly onChangeX: (id: MetricId) => void;
  readonly onChangeY: (id: MetricId) => void;
  /** Label for the filter trigger. Defaults to "filtruj firmy". */
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React.ReactNode union recursively includes mutable Iterable<ReactNode>; cannot be made deeply readonly
  readonly filterLabel?: React.ReactNode;
  /** Caterings that aren't yet loaded as dots. Shown at the bottom of the
   *  company filter popover with a "click to load" action. */
  readonly unloadedCaterings?: readonly UnloadedCatering[];
  /** Set of company_ids whose data is currently being fetched. */
  readonly loadingCateringIds?: ReadonlySet<string>;
  /** Fired when the user clicks an unloaded catering entry. */
  readonly onLoadCatering?: (companyId: string) => void;
}

const TOP_N = 5;

const topByMetric = (
  offers: readonly Offer[],
  metric: Metric,
  n: number
): readonly Offer[] => {
  const sorted = [...offers].toSorted((a, b) => {
    const av = metric.accessor(a);
    const bv = metric.accessor(b);
    return metric.higherIsBetter ? bv - av : av - bv;
  });
  return sorted.slice(0, n);
};

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- filterLabel is React.ReactNode which recursively contains mutable Iterable<ReactNode>; cannot be deeply readonly
export const OfferScatter = ({
  cheapestId,
  filterLabel,
  loadingCateringIds,
  offers,
  onChangeX,
  onChangeY,
  onLoadCatering,
  onPick,
  selectedId,
  unloadedCaterings,
  xMetric,
  yMetric,
}: Readonly<OfferScatterProps>) => {
  // User deltas relative to the mode-default (top set).
  const [addedCompanies, setAddedCompanies] = React.useState<
    ReadonlySet<string>
  >(new Set());
  const [excludedCompanies, setExcludedCompanies] = React.useState<
    ReadonlySet<string>
  >(new Set());
  const [companyQuery, setCompanyQuery] = React.useState("");

  // Distinct companies in this scatter, sorted for stable picker order.
  const companies = React.useMemo(() => {
    const seen = new Set<string>();
    for (const o of offers) {
      seen.add(o.company_name);
    }
    return [...seen].toSorted((a, b) => a.localeCompare(b, "pl"));
  }, [offers]);

  // Top set: union of top-5-by-X + top-5-by-Y, plus the cheapest and
  // currently-selected dots (always visible for context). Computed from ALL
  // offers — not from the user's filter — so it represents the natural picks.
  const topOffers = React.useMemo(() => {
    const keep = new Set<string>();
    const out: Offer[] = [];
    const push = (o: Offer) => {
      if (!keep.has(o.offer_id)) {
        keep.add(o.offer_id);
        out.push(o);
      }
    };
    for (const o of topByMetric(offers, xMetric, TOP_N)) {
      push(o);
    }
    for (const o of topByMetric(offers, yMetric, TOP_N)) {
      push(o);
    }
    for (const o of offers) {
      if (o.offer_id === cheapestId || o.offer_id === selectedId) {
        push(o);
      }
    }
    return out;
  }, [offers, xMetric, yMetric, cheapestId, selectedId]);

  // The default visible set — top-5 by X, top-5 by Y, plus cheapest +
  // currently-selected dots. User can extend or trim via the filter popover.
  const modeDefaultCompanies = React.useMemo(
    () => new Set(topOffers.map((o) => o.company_name)),
    [topOffers]
  );

  // Visible = default ∪ added − excluded.
  const visibleCompanies = React.useMemo(() => {
    const next = new Set(modeDefaultCompanies);
    for (const a of addedCompanies) {
      next.add(a);
    }
    for (const e of excludedCompanies) {
      next.delete(e);
    }
    return next;
  }, [modeDefaultCompanies, addedCompanies, excludedCompanies]);

  const visibleOffers = React.useMemo(
    () => offers.filter((o) => visibleCompanies.has(o.company_name)),
    [offers, visibleCompanies]
  );

  const toggleCompany = (name: string) => {
    const isVisible = visibleCompanies.has(name);
    const isDefault = modeDefaultCompanies.has(name);
    if (isVisible) {
      if (isDefault && !addedCompanies.has(name)) {
        setExcludedCompanies(
          // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React.SetStateAction passes prev mutably
          (prev) => new Set(prev).add(name)
        );
      } else {
        setAddedCompanies(
          // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React.SetStateAction passes prev mutably
          (prev) => {
            const n = new Set(prev);
            n.delete(name);
            return n;
          }
        );
      }
    } else if (excludedCompanies.has(name)) {
      setExcludedCompanies(
        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React.SetStateAction passes prev mutably
        (prev) => {
          const n = new Set(prev);
          n.delete(name);
          return n;
        }
      );
    } else {
      setAddedCompanies(
        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React.SetStateAction passes prev mutably
        (prev) => new Set(prev).add(name)
      );
    }
  };

  const includedCount = visibleCompanies.size;

  // True catering universe = loaded (`companies`) ∪ not-yet-loaded
  // (`unloadedCaterings`). `includedCount` can pre-add unloaded names on a
  // "zaznacz wszystkie" click, so using `companies.length` alone would let
  // the numerator outrun the denominator (e.g. "150 z 66").
  const totalAvailable = React.useMemo(() => {
    const names = new Set<string>(companies);
    for (const c of unloadedCaterings ?? []) {
      names.add(c.name);
    }
    return names.size;
  }, [companies, unloadedCaterings]);

  const points = React.useMemo(
    () => visibleOffers.map((o) => toPoint(o, xMetric, yMetric)),
    [visibleOffers, xMetric, yMetric]
  );
  const selected = points.filter((p) => p.offer_id === selectedId);
  const others = points.filter((p) => p.offer_id !== selectedId);

  // Axis padding scaled to value range.
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const xRange = Math.max(...xs) - Math.min(...xs);
  const yRange = Math.max(...ys) - Math.min(...ys);
  const xPad = Math.max(xRange * 0.05, 1);
  const yPad = Math.max(yRange * 0.05, 0.5);
  const minX = Math.min(...xs) - xPad;
  const maxX = Math.max(...xs) + xPad;
  const minY = Math.min(...ys) - yPad;
  const maxY = Math.max(...ys) + yPad;

  const handleClick = (data: Readonly<{ offer_id?: string }>) => {
    if (typeof data.offer_id === "string") {
      onPick(data.offer_id);
    }
  };

  // Loading indicator — pulsing amber dot while any per-catering fetch is
  // in flight (from clicking a single entry or from "zaznacz wszystkie").
  // Disappears the moment the last fetch resolves.
  const loadingActive = (loadingCateringIds?.size ?? 0) > 0;
  // Trigger label always shows the toggled-visible count so it matches the
  // popover's `widoczne · N`. If a caller passed `filterLabel`, render it
  // before the count.
  const triggerContent = (
    <>
      <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
        {filterLabel ?? "alternatywy"}
      </span>{" "}
      <span className="tnum">{includedCount}</span>
    </>
  );
  const companyFilter = (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "inline-flex items-baseline gap-1.5 text-[11px]",
            "text-[var(--color-ink-3)] hover:text-[var(--color-ink)]",
            "underline-offset-2 hover:underline transition-colors"
          )}
          title="Filtruj firmy"
          type="button"
        >
          {triggerContent}
          {loadingActive && (
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-amber)] animate-pulse"
            />
          )}
          <span
            aria-hidden
            className="text-[9px] text-[var(--color-ink-3)] leading-none"
          >
            ▾
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[280px] p-0">
        {/* Search */}
        <div className="p-2 border-b border-[var(--color-bone)]">
          <input
            aria-label="Szukaj firmy"
            className={cn(
              "w-full px-2 py-1 text-[12px] rounded-sm",
              "bg-[var(--color-oat)] text-[var(--color-ink)]",
              "border border-transparent focus:outline-none focus:border-[var(--color-amber)] focus:bg-white",
              "placeholder:text-[var(--color-ink-3)]/60"
            )}
            // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React.ChangeEvent has DOM refs; cannot be deeply readonly
            onChange={(e) => {
              setCompanyQuery(e.target.value);
            }}
            placeholder="szukaj firmy…"
            type="search"
            value={companyQuery}
          />
        </div>

        {(() => {
          const q = companyQuery.trim().toLowerCase();
          // Merge loaded companies and unloaded caterings into one alphabetical
          // list. Unloaded entries carry the company_id so click can fire the
          // on-demand fetch; loaded entries don't need it.
          interface ListEntry {
            readonly name: string;
            readonly loaded: boolean;
            readonly companyId: string | undefined;
          }
          const merged: ListEntry[] = [
            ...companies.map((name) => ({
              companyId: undefined,
              loaded: true,
              name,
            })),
            ...(unloadedCaterings ?? []).map((c) => ({
              companyId: c.company_id,
              loaded: false,
              name: c.name,
            })),
          ].toSorted(
            // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Array.toSorted comparator receives mutable element refs
            (a, b) => a.name.localeCompare(b.name, "pl")
          );
          const matches =
            q === ""
              ? merged
              : merged.filter((m) => m.name.toLowerCase().includes(q));
          const loadedMatches = matches
            .filter((m) => m.loaded)
            .map((m) => m.name);
          const unloadedMatches = matches.filter(
            (m): m is ListEntry & { readonly companyId: string } =>
              !m.loaded && m.companyId !== undefined
          );
          // Show "zaznacz" whenever there's anything to enable: loaded-but-hidden
          // companies OR unloaded caterings that the click will load on demand.
          const matchHasInvisible =
            loadedMatches.some((m) => !visibleCompanies.has(m)) ||
            unloadedMatches.length > 0;
          const matchHasVisible = loadedMatches.some((m) =>
            visibleCompanies.has(m)
          );
          const bulkInclude = () => {
            setExcludedCompanies(
              // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React.SetStateAction passes prev mutably
              (prev) => {
                const next = new Set(prev);
                for (const m of loadedMatches) {
                  next.delete(m);
                }
                return next;
              }
            );
            setAddedCompanies(
              // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React.SetStateAction passes prev mutably
              (prev) => {
                const next = new Set(prev);
                for (const m of loadedMatches) {
                  if (!modeDefaultCompanies.has(m)) {
                    next.add(m);
                  }
                }
                // Unloaded caterings get pre-added so their dots are visible
                // the moment each fetch resolves (same trick as a single
                // click in the merged list).
                for (const u of unloadedMatches) {
                  next.add(u.name);
                }
                return next;
              }
            );
            // Fire the per-catering fetches. Idempotent on the parent side —
            // already-loading or already-cached entries are no-ops.
            for (const u of unloadedMatches) {
              onLoadCatering?.(u.companyId);
            }
          };
          const bulkExclude = () => {
            setAddedCompanies(
              // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React.SetStateAction passes prev mutably
              (prev) => {
                const next = new Set(prev);
                for (const m of loadedMatches) {
                  next.delete(m);
                }
                return next;
              }
            );
            setExcludedCompanies(
              // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React.SetStateAction passes prev mutably
              (prev) => {
                const next = new Set(prev);
                for (const m of loadedMatches) {
                  if (modeDefaultCompanies.has(m)) {
                    next.add(m);
                  }
                }
                return next;
              }
            );
          };
          return (
            <>
              <div className="px-2 py-1 flex items-center justify-between text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] border-b border-[var(--color-bone)]/60">
                <span>
                  {q === ""
                    ? `widoczne · ${includedCount}`
                    : `pasuje ${matches.length} z ${totalAvailable}`}
                </span>
                <div className="flex items-center gap-2">
                  {matchHasInvisible && (
                    <button
                      className="text-[10px] hover:text-[var(--color-ink)] underline-offset-2 hover:underline normal-case"
                      onClick={bulkInclude}
                      type="button"
                    >
                      zaznacz
                    </button>
                  )}
                  {matchHasVisible && (
                    <button
                      className="text-[10px] hover:text-[var(--color-ink)] underline-offset-2 hover:underline normal-case"
                      onClick={bulkExclude}
                      type="button"
                    >
                      odznacz
                    </button>
                  )}
                  {q === "" &&
                    (addedCompanies.size > 0 || excludedCompanies.size > 0) && (
                      <button
                        className="text-[10px] text-[var(--color-amber-deep)] underline-offset-2 hover:underline normal-case"
                        onClick={() => {
                          setAddedCompanies(new Set());
                          setExcludedCompanies(new Set());
                        }}
                        title={`Zawęź do top: top ${TOP_N} po X + top ${TOP_N} po Y + najtańsza + wybrana`}
                        type="button"
                      >
                        top {topOffers.length}
                      </button>
                    )}
                </div>
              </div>

              <div className="max-h-[280px] overflow-auto flex flex-col p-1">
                {matches.length === 0 ? (
                  <div className="px-2 py-3 text-[12px] text-[var(--color-ink-3)] italic">
                    brak dopasowań
                  </div>
                ) : (
                  matches.map((m) => {
                    const included = m.loaded
                      ? visibleCompanies.has(m.name)
                      : addedCompanies.has(m.name);
                    const isLoading =
                      m.companyId !== undefined &&
                      (loadingCateringIds?.has(m.companyId) ?? false);
                    const onClickEntry = () => {
                      if (m.loaded) {
                        toggleCompany(m.name);
                        return;
                      }
                      if (m.companyId === undefined) {
                        return;
                      }
                      // Pre-add the name to addedCompanies so the dot is
                      // visible the moment the offer lands in `offers`.
                      // Without this the new dot would be filtered out by
                      // visibleCompanies and silently invisible.
                      setAddedCompanies(
                        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React.SetStateAction passes prev mutably
                        (prev) => new Set(prev).add(m.name)
                      );
                      onLoadCatering?.(m.companyId);
                    };
                    return (
                      <button
                        aria-pressed={included}
                        className={cn(
                          "w-full text-left px-2.5 py-1.5 rounded-sm text-[12px]",
                          "flex items-baseline justify-between gap-2 transition-colors",
                          isLoading
                            ? "opacity-60 cursor-wait"
                            : "hover:bg-[var(--color-oat)]"
                        )}
                        disabled={isLoading}
                        key={m.loaded ? m.name : `unloaded:${m.companyId}`}
                        onClick={onClickEntry}
                        type="button"
                      >
                        <span
                          className={cn(
                            included
                              ? "text-[var(--color-ink)]"
                              : "text-[var(--color-ink-3)]"
                          )}
                        >
                          {m.name}
                        </span>
                        {isLoading ? (
                          <span
                            aria-hidden
                            className="inline-block h-2 w-2 rounded-full bg-[var(--color-amber)] animate-pulse"
                          />
                        ) : (
                          <span
                            aria-hidden
                            className={cn(
                              "tnum text-[10px]",
                              included
                                ? "text-[var(--color-olive)]"
                                : "text-[var(--color-ink-3)]/50"
                            )}
                          >
                            {included ? "✓" : "—"}
                          </span>
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            </>
          );
        })()}
      </PopoverContent>
    </Popover>
  );

  return (
    <div>
      <div className="mb-2 flex items-center text-[11px] text-[var(--color-ink-3)]">
        {companyFilter}
      </div>

      <div className="relative pl-9">
        {/* Y-axis picker — rotated to read bottom-to-top, sits where Recharts' label would */}
        <div className="absolute inset-y-0 left-0 z-10 w-9 flex items-center justify-center">
          <div className="-rotate-90 whitespace-nowrap">
            <MetricPicker
              axis="Y"
              disabledId={xMetric.id}
              onChange={onChangeY}
              value={yMetric.id}
            />
          </div>
        </div>

        <ChartContainer
          className="aspect-auto h-[260px] w-full"
          config={chartConfig}
        >
          <ScatterChart margin={{ bottom: 6, left: 8, right: 12, top: 6 }}>
            <CartesianGrid stroke="var(--color-bone)" strokeDasharray="2 4" />
            <XAxis
              axisLine={false}
              dataKey="x"
              domain={[minX, maxX]}
              tickFormatter={(v: number) => xMetric.format(v)}
              tickLine={false}
              tickMargin={6}
              type="number"
            />
            <YAxis
              axisLine={false}
              dataKey="y"
              domain={[minY, maxY]}
              tickFormatter={(v: number) => yMetric.format(v)}
              tickLine={false}
              tickMargin={6}
              type="number"
              width={56}
            />
            <Tooltip content={renderTooltip} cursor={tooltipCursor} />
            <Scatter
              cursor="pointer"
              data={others}
              isAnimationActive={false}
              onClick={handleClick}
              shape={<LogoMarker r={10} />}
            />
            <Scatter
              cursor="pointer"
              data={selected}
              isAnimationActive={false}
              onClick={handleClick}
              shape={
                <LogoMarker
                  r={12}
                  ringStroke="var(--color-amber)"
                  ringWidth={2.5}
                />
              }
            />
          </ScatterChart>
        </ChartContainer>
      </div>

      {/* X-axis picker — replaces the label, centered below the chart */}
      <div className="mt-1 flex justify-center">
        <MetricPicker
          axis="X"
          disabledId={yMetric.id}
          onChange={onChangeX}
          value={xMetric.id}
        />
      </div>
    </div>
  );
};

export type { MetricId };
