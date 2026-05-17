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
import type { MockOffer } from "@/lib/mock-match-data";
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
  /** Raw price + score kept for the tooltip body, even when off-axis. */
  readonly price: number;
  readonly score: number;
}

const toPoint = (o: MockOffer, xM: Metric, yM: Metric): ScatterPoint => ({
  calories: o.calories,
  company_name: o.company_name,
  diet_name: o.diet_name,
  is_menu_configuration: o.is_menu_configuration,
  logo_url: o.logo_url ?? null,
  offer_id: o.offer_id,
  price: o.price_per_day,
  score: o.score_best,
  tier_name: o.tier_name,
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
  readonly xMetric: Metric;
  readonly yMetric: Metric;
}

const TooltipBody = ({
  point,
  xMetric,
  yMetric,
}: Readonly<TooltipBodyProps>) => {
  const scoreColor = scoreColorClass(point.score);
  return (
    <div className="rounded-md border border-[var(--color-bone)] bg-[var(--color-cream)] px-3 py-2 shadow-[0_8px_24px_-12px_oklch(22%_0.018_60_/_0.18)]">
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
      <div className="mt-1.5 flex flex-col gap-0.5 text-[12px]">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
            {xMetric.label}
          </span>
          <span className="tnum text-[var(--color-ink)]">
            {xMetric.format(point.x)}
            {xMetric.unit && (
              <span className="text-[var(--color-ink-3)] ml-1">
                {xMetric.unit}
              </span>
            )}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
            {yMetric.label}
          </span>
          <span
            className={`tnum ${yMetric.id === "score" || yMetric.id === "score_default" ? scoreColor : "text-[var(--color-ink)]"}`}
          >
            {yMetric.format(point.y)}
            {yMetric.unit && (
              <span className="text-[var(--color-ink-3)] ml-1">
                {yMetric.unit}
              </span>
            )}
          </span>
        </div>
      </div>
      <div className="mt-1 text-[11px] italic text-[var(--color-ink-3)]">
        kliknij, aby wybrać
      </div>
    </div>
  );
};

// ── Logo marker shape ──────────────────────────────────────────────────────
// When a company has a logo_url we render the image clipped to a circle.
// Otherwise we fall back to a hashed-color circle stamped with initials.

const hueFor = (name: string): number => {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) {
    h = (h * 31 + (name.codePointAt(i) ?? 0)) % 360;
  }
  return h;
};

const fallbackColor = (name: string): { bg: string; fg: string } => {
  const hue = hueFor(name);
  return {
    bg: `oklch(78% 0.06 ${hue})`,
    fg: `oklch(28% 0.04 ${hue})`,
  };
};

const initialsFor = (name: string): string => {
  const cleaned = name.replaceAll(/[^\p{L}\d\s&]/gu, " ").trim();
  if (cleaned === "") {
    return "?";
  }
  const words = cleaned
    .split(/\s+/)
    .filter((w) => w.length > 0 && w !== "&" && w !== "-");
  if (words.length === 0) {
    return cleaned.slice(0, 2).toUpperCase();
  }
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return (words[0][0] + words[1][0]).toUpperCase();
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
  if (cx === undefined || cy === undefined || !payload) {
    return null;
  }
  const clipId = `logo-clip-${payload.offer_id}`;
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
      {payload.logo_url === null ? (
        (() => {
          const { bg, fg } = fallbackColor(payload.company_name);
          const initials = initialsFor(payload.company_name);
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
        })()
      ) : (
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
            href={payload.logo_url}
            preserveAspectRatio="xMidYMid slice"
            width={r * 2}
            x={cx - r}
            y={cy - r}
          />
        </>
      )}
    </g>
  );
};

const tooltipCursor = {
  stroke: "var(--color-bone)",
  strokeDasharray: "2 4",
};

export interface OfferScatterProps {
  readonly offers: readonly MockOffer[];
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
}

const TOP_N = 5;

const topByMetric = (
  offers: readonly MockOffer[],
  metric: Metric,
  n: number
): readonly MockOffer[] => {
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
  offers,
  onChangeX,
  onChangeY,
  onPick,
  selectedId,
  xMetric,
  yMetric,
}: Readonly<OfferScatterProps>) => {
  const [showAll, setShowAll] = React.useState(false);
  // User deltas relative to the mode-default (top set or all companies).
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
    const out: MockOffer[] = [];
    const push = (o: MockOffer) => {
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

  // The mode default set — the company-filter is pre-checked to this.
  const modeDefaultCompanies = React.useMemo(() => {
    if (showAll) {
      return new Set(companies);
    }
    return new Set(topOffers.map((o) => o.company_name));
  }, [showAll, companies, topOffers]);

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

  const setShowAllAndReset = (next: boolean) => {
    setShowAll(next);
    setAddedCompanies(new Set());
    setExcludedCompanies(new Set());
  };

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

  const renderTooltip = ({
    active,
    payload,
  }: Readonly<{
    active?: boolean;
    payload?: readonly Readonly<{ payload?: ScatterPoint }>[];
  }>) => {
    if (active !== true || !payload || payload.length === 0) {
      return null;
    }
    const point = payload[0]?.payload;
    if (!point) {
      return null;
    }
    return <TooltipBody point={point} xMetric={xMetric} yMetric={yMetric} />;
  };

  const filterActive = addedCompanies.size > 0 || excludedCompanies.size > 0;
  const triggerContent =
    filterLabel === undefined ? (
      <>
        filtruj firmy ·{" "}
        <span className="tnum">
          {includedCount} z {companies.length}
        </span>
      </>
    ) : (
      filterLabel
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
          {filterActive && (
            <span aria-hidden className="text-[var(--color-amber-deep)]">
              ●
            </span>
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
          const matches =
            q === ""
              ? companies
              : companies.filter((c) => c.toLowerCase().includes(q));
          const matchHasInvisible = matches.some(
            (m) => !visibleCompanies.has(m)
          );
          const matchHasVisible = matches.some((m) => visibleCompanies.has(m));
          const bulkInclude = () => {
            setExcludedCompanies(
              // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React.SetStateAction passes prev mutably
              (prev) => {
                const next = new Set(prev);
                for (const m of matches) {
                  next.delete(m);
                }
                return next;
              }
            );
            setAddedCompanies(
              // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React.SetStateAction passes prev mutably
              (prev) => {
                const next = new Set(prev);
                for (const m of matches) {
                  if (!modeDefaultCompanies.has(m)) {
                    next.add(m);
                  }
                }
                return next;
              }
            );
          };
          const bulkExclude = () => {
            setAddedCompanies(
              // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React.SetStateAction passes prev mutably
              (prev) => {
                const next = new Set(prev);
                for (const m of matches) {
                  next.delete(m);
                }
                return next;
              }
            );
            setExcludedCompanies(
              // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React.SetStateAction passes prev mutably
              (prev) => {
                const next = new Set(prev);
                for (const m of matches) {
                  if (modeDefaultCompanies.has(m)) {
                    next.add(m);
                  }
                }
                return next;
              }
            );
          };
          const showingAllPresets = q === "";
          return (
            <>
              <div className="px-2 py-1 flex items-center justify-between text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] border-b border-[var(--color-bone)]/60">
                <span>
                  {q === ""
                    ? `widoczne · ${includedCount} z ${companies.length}`
                    : `pasuje ${matches.length} z ${companies.length}`}
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
                  {showingAllPresets && (
                    <button
                      className={cn(
                        "text-[10px] underline-offset-2 hover:underline normal-case",
                        showAll
                          ? "text-[var(--color-amber-deep)]"
                          : "text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
                      )}
                      onClick={() => {
                        setShowAllAndReset(!showAll);
                      }}
                      title={
                        showAll
                          ? `Zawęź do top: top ${TOP_N} po X + top ${TOP_N} po Y + najtańsza + wybrana`
                          : "Pokaż wszystkie firmy"
                      }
                      type="button"
                    >
                      {showAll ? `top ${topOffers.length}` : "wszystkie"}
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
                  matches.map((name) => {
                    const included = visibleCompanies.has(name);
                    return (
                      <button
                        aria-pressed={included}
                        className={cn(
                          "w-full text-left px-2.5 py-1.5 rounded-sm text-[12px]",
                          "flex items-baseline justify-between gap-2 transition-colors",
                          "hover:bg-[var(--color-oat)]"
                        )}
                        key={name}
                        onClick={() => {
                          toggleCompany(name);
                        }}
                        type="button"
                      >
                        <span
                          className={cn(
                            included
                              ? "text-[var(--color-ink)]"
                              : "text-[var(--color-ink-3)]"
                          )}
                        >
                          {name}
                        </span>
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
