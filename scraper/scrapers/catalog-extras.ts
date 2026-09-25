// Catalog data beyond the diet tree: catering contact and capability flags,
// per-city delivery windows, advertised per-diet prices and paid side orders
// — each kept as history (spans, see "History model" in db/schema.sql).
//
// Split out of catalog.ts, which owns the tree and the current-state rows;
// catalog.ts calls into this after each upsert.

import { parsePrice } from "../api";
import { q } from "../db";
import { recordSpan } from "../spans";
import type { SpanTable } from "../spans";
import type {
  CityResponse,
  CompanySearchItem,
  ConstantResponse,
  DeepReadonly,
  DietPriceInfo,
  SideOrder,
} from "../types";

/**
 * Columns of company_history, in the order recordCompanyHistory reads them
 * back from the upserted companies row. Ratings are not here: they have their
 * own timeline (company_ratings_history).
 */
export const COMPANY_HISTORY_COLUMNS = [
  ["name", "text"],
  ["logo_url", "text"],
  ["awarded", "boolean"],
  ["price_category", "text"],
  ["delivery_on_saturday", "boolean"],
  ["delivery_on_sunday", "boolean"],
  ["menu_enabled", "boolean"],
  ["menu_days_ahead", "int"],
  ["orders_enabled", "boolean"],
  ["delivery_enabled", "boolean"],
  ["delivery_info_text", "text"],
  ["delivery_info_date", "date"],
  ["dietly_delivery", "boolean"],
  ["recently_added", "boolean"],
  ["invite_code_discount_percent", "numeric(5,2)"],
  ["nutrition_visible", "boolean"],
  ["ingredients_visible", "boolean"],
  ["description", "text"],
  ["email", "text"],
  ["phone", "text"],
  ["address", "jsonb"],
  ["delivery_cities_count", "int"],
  ["params", "jsonb"],
  ["positive_meals_review_percent", "int"],
] as const;

const COMPANY_SPAN: SpanTable = {
  key: [["company_id", "text"]],
  table: "company_history",
  values: COMPANY_HISTORY_COLUMNS,
};

/**
 * Record the companies row as it stands after this run's upsert, so the
 * history holds the effective values (including ones a single-company run
 * kept from an earlier full run).
 */
export const recordCompanyHistory = async (
  companyId: string
): Promise<void> => {
  // Read back as text: recordSpan casts each value to its column type, and
  // pg would otherwise turn DATE into a local-time JS Date that can shift a
  // day on the way back in.
  const cols = COMPANY_HISTORY_COLUMNS.map(
    ([name]) => `${name}::text AS ${name}`
  ).join(", ");
  const { rows } = await q<Record<string, string | null>>(
    `SELECT ${cols} FROM companies WHERE company_id = $1`,
    [companyId]
  );
  const [row] = rows;
  if (row === undefined) {
    return;
  }
  await recordSpan(
    COMPANY_SPAN,
    [companyId],
    COMPANY_HISTORY_COLUMNS.map(([name]) => row[name] ?? null)
  );
};

/** True when the extras come from a real awarded-and-top listing (not the
 * stub a COMPANY= run builds), i.e. its search-only fields can be trusted. */
export const isSearchItem = (
  extras: DeepReadonly<CompanySearchItem> | null
): boolean => extras !== null && extras.params !== undefined;

export interface CompanyContact {
  description: string | null;
  email: string | null;
  phone: string | null;
  /** JSON text for a jsonb column, or null */
  address: string | null;
}

const parseAddress = (raw: string | null | undefined): string | null => {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return null;
  }
  try {
    // Validate and normalise; dietly serialises the object into a string.
    return JSON.stringify(JSON.parse(raw));
  } catch {
    return JSON.stringify({ raw });
  }
};

export const contactOf = (
  constant: DeepReadonly<ConstantResponse>
): CompanyContact => {
  const c = constant.contactDetails ?? null;
  return {
    address: parseAddress(c?.address),
    description: c?.description ?? null,
    email: c?.email ?? null,
    phone: c?.phoneNumber ?? null,
  };
};

/**
 * Capability flags: /constant companyParams, overlaid with the
 * awarded-and-top params when this run has a real search item. JSON text.
 */
export const paramsOf = (
  constant: DeepReadonly<ConstantResponse>,
  extras: DeepReadonly<CompanySearchItem> | null
): string =>
  JSON.stringify({
    ...constant.companyParams,
    ...(isSearchItem(extras) ? extras?.params : {}),
  });

/** Delivery windows as [{id, from, to}] sorted by id; JSON text or null. */
export const deliveryTimesOf = (
  city: DeepReadonly<CityResponse>
): string | null => {
  const times = city.citySearchResult?.deliveryTime;
  if (times === undefined) {
    return null;
  }
  return JSON.stringify(
    [...times]
      .map((t) => ({ from: t.timeFrom, id: t.deliveryTimeId, to: t.timeTo }))
      .toSorted(
        (a: Readonly<{ id: number }>, b: Readonly<{ id: number }>) =>
          a.id - b.id
      )
  );
};

const ADVERTISED_SPAN: SpanTable = {
  key: [
    ["company_id", "text"],
    ["city_id", "bigint"],
    ["diet_id", "int"],
  ],
  table: "diet_advertised_prices",
  values: [
    ["default_price", "numeric(10,2)"],
    ["discount_price", "numeric(10,2)"],
    ["in_promotion", "boolean"],
  ],
};

/**
 * Record the advertised price of every diet /city listed, and close the open
 * spans of diets it no longer lists.
 */
export const recordAdvertisedPrices = async (
  companyId: string,
  cityId: number,
  infos: readonly DeepReadonly<DietPriceInfo>[]
): Promise<void> => {
  for (const p of infos) {
    await recordSpan(
      ADVERTISED_SPAN,
      [companyId, cityId, p.dietId],
      [
        parsePrice(p.defaultPrice),
        parsePrice(p.discountPrice),
        p.dietPriceInCompanyPromotion,
      ]
    );
  }
  await q(
    `UPDATE diet_advertised_prices SET closed_at = NOW()
      WHERE company_id = $1 AND city_id = $2 AND closed_at IS NULL
        AND diet_id <> ALL ($3::int[])`,
    [companyId, cityId, infos.map((p) => p.dietId)]
  );
};

const SIDE_ORDER_SPAN: SpanTable = {
  key: [
    ["company_id", "text"],
    ["name", "text"],
  ],
  table: "company_side_orders",
  values: [
    ["price", "numeric(10,2)"],
    ["image_url", "text"],
  ],
};

/**
 * Record the catering's paid extras, and close the ones no longer offered.
 * A missing list (null) says nothing and closes nothing.
 */
export const recordSideOrders = async (
  companyId: string,
  sideOrders: readonly DeepReadonly<SideOrder>[] | null | undefined
): Promise<void> => {
  if (sideOrders === null || sideOrders === undefined) {
    return;
  }
  const names: string[] = [];
  for (const s of sideOrders) {
    const name = s.name.trim();
    if (name === "" || names.includes(name)) {
      continue;
    }
    names.push(name);
    const image = s.imageUrl ?? "";
    await recordSpan(
      SIDE_ORDER_SPAN,
      [companyId, name],
      [parsePrice(s.price), image === "" ? null : image]
    );
  }
  await q(
    `UPDATE company_side_orders SET closed_at = NOW()
      WHERE company_id = $1 AND closed_at IS NULL
        AND name <> ALL ($2::text[])`,
    [companyId, names]
  );
};
