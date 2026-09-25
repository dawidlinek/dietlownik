// Date defaults shared by the planning tools — the same rule the dashboard
// uses (`app/page.tsx`): caterings need lead time, so nothing earlier than
// two calendar days out (Europe/Warsaw) can still be ordered.

const ORDER_LEAD_DAYS = 2;

const warsawDatePlus = (offsetDays: number): string =>
  new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Warsaw",
    year: "numeric",
  }).format(new Date(Date.now() + offsetDays * 86_400_000));

/** First date dietly still accepts an order for. */
export const orderableFrom = (): string => warsawDatePlus(ORDER_LEAD_DAYS);

export const dateSchemaNote =
  "ISO yyyy-mm-dd. Defaults to every orderable date that has menus (see get_context).";
