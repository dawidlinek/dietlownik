"use client";

import * as React from "react";
import { PriceTable } from "@/components/price-table";
import { type DashboardRow } from "@/lib/queries";

export function AllOffersDisclosure({
  rows,
  cityId,
  days,
  latestCaptureAt,
}: {
  rows: DashboardRow[];
  cityId: number;
  days: number;
  latestCaptureAt: string | null;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <section className="border-t border-[var(--color-bone)] mt-4">
      <div className="px-5 sm:px-8 lg:px-14 py-8">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-[13px] text-[var(--color-ink-2)] hover:text-[var(--color-ink)] transition-colors inline-flex items-center gap-2"
          aria-expanded={open}
        >
          <span>
            {open ? "Schowaj pełną tabelę" : `Pokaż wszystkie ${rows.length} ofert`}
          </span>
          <span aria-hidden className="tnum">
            {open ? "↑" : "↓"}
          </span>
        </button>
        <p className="mt-2 text-[12px] text-[var(--color-ink-3)] max-w-[60ch]">
          Pełna tabela: każda dieta × tier × pakiet z każdej firmy. Klik w wiersz
          rozwija historię ceny i rachunek.
        </p>
      </div>

      {open && (
        <PriceTable
          rows={rows}
          cityId={cityId}
          days={days}
          latestCaptureAt={latestCaptureAt}
        />
      )}
    </section>
  );
}
