// Polish-locale formatting helpers.

const plnFormatter = new Intl.NumberFormat("pl-PL", {
  style: "currency",
  currency: "PLN",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const plnNumberFormatter = new Intl.NumberFormat("pl-PL", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const intFormatter = new Intl.NumberFormat("pl-PL", {
  maximumFractionDigits: 0,
});

const plDate = new Intl.DateTimeFormat("pl-PL", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

const plDateShort = new Intl.DateTimeFormat("pl-PL", {
  month: "short",
  day: "numeric",
});

export function formatPLN(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (!Number.isFinite(n)) return "—";
  return plnFormatter.format(n);
}

export function formatPriceNumber(
  value: number | string | null | undefined
): string {
  if (value === null || value === undefined) return "—";
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (!Number.isFinite(n)) return "—";
  return plnNumberFormatter.format(n);
}

export function formatInt(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (!Number.isFinite(n)) return "—";
  return intFormatter.format(n);
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return plDate.format(d);
}

export function formatDateShort(
  value: string | Date | null | undefined
): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return plDateShort.format(d);
}

/**
 * Returns the abs delta as Polish-formatted decimal, plus a kind tag.
 * kind: "down" => cheaper, "up" => pricier, "flat" => same / missing.
 */
export function formatDelta(
  current: number | string | null | undefined,
  previous: number | string | null | undefined
): { kind: "down" | "up" | "flat"; text: string } {
  if (
    current === null ||
    current === undefined ||
    previous === null ||
    previous === undefined
  ) {
    return { kind: "flat", text: "—" };
  }
  const c = typeof current === "string" ? parseFloat(current) : current;
  const p = typeof previous === "string" ? parseFloat(previous) : previous;
  if (!Number.isFinite(c) || !Number.isFinite(p)) {
    return { kind: "flat", text: "—" };
  }
  const delta = c - p;
  if (Math.abs(delta) < 0.005) return { kind: "flat", text: "—" };
  const abs = Math.abs(delta);
  const text = plnNumberFormatter.format(abs);
  return { kind: delta < 0 ? "down" : "up", text };
}
