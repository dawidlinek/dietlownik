import * as React from "react";
import { type DashboardRow, type CampaignRow } from "@/lib/queries";
import { TagSection, type SummaryEntry, type PromoChip } from "./tag-section";

const TAG_PRIORITY: Record<string, number> = { STANDARD: 0 };

function tagSort(a: string | null, b: string | null) {
  const aKey = a ?? "ZZZ_NULL";
  const bKey = b ?? "ZZZ_NULL";
  const ap = TAG_PRIORITY[aKey] ?? 1;
  const bp = TAG_PRIORITY[bKey] ?? 1;
  if (ap !== bp) return ap - bp;
  return aKey.localeCompare(bKey, "pl");
}

function tagLabel(tag: string | null): string {
  if (!tag) return "inne";
  return tag.toLowerCase();
}

function dedupeChips(chips: PromoChip[]): PromoChip[] {
  const seen = new Set<string>();
  const out: PromoChip[] = [];
  for (const c of chips) {
    const k = `${c.code}::${c.discountPct ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

export function CheapestSummary({
  rows,
  campaigns,
  cityName,
  kcal,
  days,
}: {
  rows: DashboardRow[];
  campaigns: CampaignRow[];
  cityName: string;
  kcal: number;
  days: number;
}) {
  const byCompany = new Map<string, PromoChip[]>();
  const globalChips: PromoChip[] = [];
  for (const c of campaigns) {
    if (!c.code) continue;
    const chip: PromoChip = {
      code: c.code,
      discountPct: c.discount_percent ? parseFloat(c.discount_percent) : null,
      scope: c.company_id ? "company" : "global",
    };
    if (c.company_id) {
      const list = byCompany.get(c.company_id) ?? [];
      list.push(chip);
      byCompany.set(c.company_id, list);
    } else {
      globalChips.push(chip);
    }
  }

  // Group rows by tag → company; within each (tag, company) keep cheapest.
  const tagMap = new Map<string | null, Map<string, DashboardRow>>();
  for (const r of rows) {
    const v = parseFloat(r.per_day_cost_with_discounts ?? "");
    if (!Number.isFinite(v)) continue;
    const tag = r.diet_tag ?? null;
    let comps = tagMap.get(tag);
    if (!comps) {
      comps = new Map();
      tagMap.set(tag, comps);
    }
    const existing = comps.get(r.company_id);
    if (
      !existing ||
      parseFloat(existing.per_day_cost_with_discounts ?? "0") > v
    ) {
      comps.set(r.company_id, r);
    }
  }

  const sections = Array.from(tagMap.entries())
    .sort(([a], [b]) => tagSort(a, b))
    .map(([tag, comps]) => {
      const entries: SummaryEntry[] = Array.from(comps.values())
        .sort(
          (a, b) =>
            parseFloat(a.per_day_cost_with_discounts ?? "0") -
            parseFloat(b.per_day_cost_with_discounts ?? "0")
        )
        .map((row) => ({
          row,
          chips: dedupeChips(byCompany.get(row.company_id) ?? []),
        }));
      return { tag, label: tagLabel(tag), entries };
    });

  if (sections.length === 0) {
    return (
      <section className="px-5 sm:px-8 lg:px-14 py-16">
        <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] font-medium">
          Najtaniej dziś · {cityName} · {kcal} kcal · {days} dni
        </p>
        <p className="mt-4 text-[var(--color-ink-2)]">
          Brak ofert dla tych filtrów.
        </p>
      </section>
    );
  }

  const globalDeduped = dedupeChips(globalChips);

  return (
    <section className="px-5 sm:px-8 lg:px-14 pt-14 pb-10">
      <div className="mb-12 lg:mb-14">
        <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] font-medium">
          Najtaniej dziś · {cityName} · {kcal} kcal · {days} dni
        </p>
        <p className="mt-3 text-[15px] text-[var(--color-ink-2)] max-w-[60ch]">
          Po jednej najtańszej ofercie z każdej firmy w ramach diety. Kliknij{" "}
          <span className="text-[var(--color-ink)]">Zamów</span>, żeby przejść
          prosto na dietly.pl.
        </p>
      </div>

      <div className="space-y-14">
        {sections.map((s) => (
          <TagSection
            key={s.tag ?? "null"}
            label={s.label}
            entries={s.entries}
          />
        ))}
      </div>

      {globalDeduped.length > 0 && (
        <div className="mt-16 pt-6 border-t border-[var(--color-bone)]">
          <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] font-medium">
            Kody globalne (dotyczą wszystkich firm)
          </p>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
            {globalDeduped.map((c) => (
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
    </section>
  );
}
