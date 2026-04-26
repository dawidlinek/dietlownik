import * as React from "react";
import { type CampaignRow } from "@/lib/queries";
import { formatDate } from "@/lib/format";

export function PromoStrip({
  campaigns,
}: {
  campaigns: CampaignRow[];
}) {
  if (campaigns.length === 0) {
    return (
      <div className="px-5 sm:px-8 lg:px-14">
        <div className="flex flex-wrap items-baseline justify-between gap-4 bg-[var(--color-linen)] border border-[var(--color-bone)] px-4 py-3 text-[14px] text-[var(--color-ink-2)]">
          <p>
            Brak aktywnych promocji w bazie. Scraper kampanii jeszcze nie zbierał
            danych.
          </p>
          <p className="text-[12px] text-[var(--color-ink-3)] tnum">—</p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-5 sm:px-8 lg:px-14">
      <div className="flex gap-2 overflow-x-auto py-1">
        {campaigns.map((c) => (
          <CampaignChip key={c.id} c={c} />
        ))}
      </div>
    </div>
  );
}

function CampaignChip({ c }: { c: CampaignRow }) {
  const discount = c.discount_percent ? parseFloat(c.discount_percent) : null;
  return (
    <div className="shrink-0 bg-[var(--color-amber-tint)] text-[var(--color-ink)] px-3 py-2 border border-[var(--color-bone)] rounded-md min-w-[180px]">
      <div className="flex items-baseline gap-2">
        <span
          className="font-display text-[15px] uppercase"
          style={{ fontVariantCaps: "small-caps", fontWeight: 500 }}
        >
          {c.code ?? "—"}
        </span>
        {discount !== null && (
          <span className="tnum text-[14px] text-[var(--color-amber-deep)]">
            -{discount.toFixed(0)}%
          </span>
        )}
      </div>
      {c.ends_at && (
        <p className="text-[11px] text-[var(--color-ink-3)] mt-0.5">
          ważne do {formatDate(c.ends_at)}
        </p>
      )}
    </div>
  );
}
