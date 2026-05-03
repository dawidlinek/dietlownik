// Polish-locale formatting helpers.

const plnFormatter = new Intl.NumberFormat("pl-PL", {
  currency: "PLN",
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: "currency",
});

const plnNumberFormatter = new Intl.NumberFormat("pl-PL", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

const intFormatter = new Intl.NumberFormat("pl-PL", {
  maximumFractionDigits: 0,
});

const plDate = new Intl.DateTimeFormat("pl-PL", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

const plDateShort = new Intl.DateTimeFormat("pl-PL", {
  day: "numeric",
  month: "short",
});

export const formatPLN = (
  value: number | string | null | undefined
): string => {
  if (value === null || value === undefined) {
    return "—";
  }
  const n = typeof value === "string" ? Number.parseFloat(value) : value;
  if (!Number.isFinite(n)) {
    return "—";
  }
  return plnFormatter.format(n);
};

export const formatPriceNumber = (
  value: number | string | null | undefined
): string => {
  if (value === null || value === undefined) {
    return "—";
  }
  const n = typeof value === "string" ? Number.parseFloat(value) : value;
  if (!Number.isFinite(n)) {
    return "—";
  }
  return plnNumberFormatter.format(n);
};

export const formatInt = (
  value: number | string | null | undefined
): string => {
  if (value === null || value === undefined) {
    return "—";
  }
  const n = typeof value === "string" ? Number.parseFloat(value) : value;
  if (!Number.isFinite(n)) {
    return "—";
  }
  return intFormatter.format(n);
};

export const formatDate = (
  value: string | Readonly<Date> | null | undefined
): string => {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) {
    return "—";
  }
  return plDate.format(d);
};

export const formatDateShort = (
  value: string | Readonly<Date> | null | undefined
): string => {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) {
    return "—";
  }
  return plDateShort.format(d);
};

/**
 * Returns the abs delta as Polish-formatted decimal, plus a kind tag.
 * kind: "down" => cheaper, "up" => pricier, "flat" => same / missing.
 */
export const formatDelta = (
  current: number | string | null | undefined,
  previous: number | string | null | undefined
): { kind: "down" | "up" | "flat"; text: string } => {
  if (
    current === null ||
    current === undefined ||
    previous === null ||
    previous === undefined
  ) {
    return { kind: "flat", text: "—" };
  }
  const c = typeof current === "string" ? Number.parseFloat(current) : current;
  const p =
    typeof previous === "string" ? Number.parseFloat(previous) : previous;
  if (!Number.isFinite(c) || !Number.isFinite(p)) {
    return { kind: "flat", text: "—" };
  }
  const delta = c - p;
  if (Math.abs(delta) < 0.005) {
    return { kind: "flat", text: "—" };
  }
  const abs = Math.abs(delta);
  const text = plnNumberFormatter.format(abs);
  return { kind: delta < 0 ? "down" : "up", text };
};
