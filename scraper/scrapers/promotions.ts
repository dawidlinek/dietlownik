// Promotions / promo-code aggregator.
//
// /api/profile/coupons-search needs login (401 anon), so we collect codes from
// the four anonymous sources the mobile app already exposes:
//
//   1. companyHeader.activePromotionInfo               — per company (richest)
//   2. awarded-and-top.searchData[].activePromotionInfo — bulk per city
//   3. /api/open/mobile/banners?cId=...                — campaign-typed marketing
//   4. /api/open/content-management/recommended-diets  — featured-promo carousel
//
// In the new schema the `campaigns` table is mutable, no history: one row per
// (company_id, code) UNIQUE. We upsert title / discount_percent / starts_at /
// ends_at / is_active / last_seen_at on observation. There is no
// promo_observations event log — that table was dropped.

import { get, HttpError } from "../api";
import { q } from "../db";
import { recordSpan } from "../spans";
import type { SpanTable } from "../spans";
import type {
  ActivePromotionInfo,
  Banner,
  CompanySearchItem,
  ConstantResponse,
  DeepReadonly,
  RecommendedDiet,
} from "../types";

interface PromoObservation {
  code: string;
  company_id: string | null;
  discount_percent: number | null;
  title: string | null;
  // YYYY-MM-DD
  starts_at: string | null;
  // YYYY-MM-DD
  ends_at: string | null;
  // ISO timestamps, UTC — exact validity when awarded-and-top gives it
  valid_from: string | null;
  valid_to: string | null;
  // code must be typed at checkout; advertised prices exclude it
  separate: boolean | null;
}

type ExactPromotion = DeepReadonly<
  NonNullable<CompanySearchItem["activePromotion"]>
>;

/** dietly sends these without an offset; they are UTC (…T21:59 = 23:59 CEST). */
const utc = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value === ""
    ? null
    : `${value.replace(/Z$/u, "")}Z`;

const fromActivePromo = (
  company_id: string | null,
  info: DeepReadonly<ActivePromotionInfo> | null | undefined,
  exact: ExactPromotion | null = null
): PromoObservation | null => {
  if (info == null) {
    return null;
  }
  const { code } = info;
  if (code === null || code === undefined || code === "") {
    return null;
  }
  const same = exact !== null && exact.code === code;
  return {
    code,
    company_id,
    discount_percent: info.discountPercents ?? null,
    ends_at: info.promoDeadline ?? null,
    separate: info.separate ?? null,
    starts_at: null,
    title: info.promoText ?? null,
    valid_from: same ? utc(exact.dateFrom) : null,
    valid_to: same ? utc(exact.dateTo) : null,
  };
};

/**
 * `/banners` no longer exposes redeemable promo codes.
 *
 * It used to return a `code` field alongside `name`, and this channel mapped
 * it straight to a campaign. Verified live on 2026-09-21: every entry now
 * carries only
 * `name, url, validFrom, validTo, deepLink, targets, priority, type,
 * isOpenLoyalty` — 6 banners for Wrocław, 0 with a code. `name` is a campaign
 * label ("PACZKI1", "PROMO_LISTING", "[zdrowaszama][21.09-27.09][2D,2LD,2LC]"),
 * not something a user can redeem, so promoting it to `code` would fabricate
 * discounts that don't exist.
 *
 * The old guard returned null on the missing field, so this channel degraded
 * to zero silently. `fetchBanners` now says so out loud instead.
 */
const bannersCarryNoCodes = (
  banners: readonly DeepReadonly<Banner>[]
): void => {
  if (banners.length > 0) {
    console.warn(
      `[promotions] /banners returned ${banners.length} entries but the endpoint no longer exposes promo codes — contributing 0 campaigns`
    );
  }
};

const CAMPAIGN_SPAN: SpanTable = {
  key: [
    ["company_id", "text", "nullable"],
    ["code", "text"],
  ],
  table: "campaign_history",
  values: [
    ["title", "text"],
    ["discount_percent", "numeric(5,2)"],
    ["starts_at", "date"],
    ["ends_at", "date"],
    ["valid_from", "timestamptz"],
    ["valid_to", "timestamptz"],
    ["separate", "boolean"],
    ["is_active", "boolean"],
  ],
};

/**
 * Record the campaigns row as it stands now (after COALESCE merges and
 * expiry) into campaign_history. Read back as text so dates round-trip
 * without JS Date timezone shifts.
 */
const recordCampaignHistory = async (
  companyId: string | null,
  code: string
): Promise<void> => {
  const cols = CAMPAIGN_SPAN.values
    .map(([name]) => `${name}::text AS ${name}`)
    .join(", ");
  const { rows } = await q<Record<string, string | null>>(
    `SELECT ${cols} FROM campaigns
      WHERE company_id IS NOT DISTINCT FROM $1 AND code = $2`,
    [companyId, code]
  );
  const [row] = rows;
  if (row === undefined) {
    return;
  }
  await recordSpan(
    CAMPAIGN_SPAN,
    [companyId, code],
    CAMPAIGN_SPAN.values.map(([name]) => row[name] ?? null)
  );
};

const upsertCampaign = async (
  o: DeepReadonly<PromoObservation>
): Promise<void> => {
  // FK-safe: drop the company link if the company hasn't been catalogued yet
  // (awarded-and-top runs ahead of catalog during a partial scrape).
  let companyId = o.company_id;
  if (companyId !== null && companyId !== "") {
    const exists = await q<{ exists: boolean }>(
      `SELECT TRUE AS exists FROM companies WHERE company_id = $1 LIMIT 1`,
      [companyId]
    );
    if (exists.rowCount === 0) {
      companyId = null;
    }
  }
  await q(
    `INSERT INTO campaigns
       (company_id, code, title, discount_percent, starts_at, ends_at,
        valid_from, valid_to, separate, is_active, last_seen_at)
     VALUES ($1,$2,$3,$4,
             COALESCE($5::date, ($7::timestamptz AT TIME ZONE 'Europe/Warsaw')::date),
             $6,$7,$8,$9,TRUE,NOW())
     ON CONFLICT (company_id, code) DO UPDATE SET
       title            = COALESCE(EXCLUDED.title, campaigns.title),
       discount_percent = COALESCE(EXCLUDED.discount_percent, campaigns.discount_percent),
       starts_at        = COALESCE(EXCLUDED.starts_at, campaigns.starts_at),
       ends_at          = COALESCE(EXCLUDED.ends_at, campaigns.ends_at),
       valid_from       = COALESCE(EXCLUDED.valid_from, campaigns.valid_from),
       valid_to         = COALESCE(EXCLUDED.valid_to, campaigns.valid_to),
       separate         = COALESCE(EXCLUDED.separate, campaigns.separate),
       is_active        = TRUE,
       last_seen_at     = NOW()`,
    [
      companyId,
      o.code,
      o.title,
      o.discount_percent,
      o.starts_at,
      o.ends_at,
      o.valid_from,
      o.valid_to,
      o.separate,
    ]
  );
  await recordCampaignHistory(companyId, o.code);
};

const persist = async (
  observations: readonly DeepReadonly<PromoObservation>[]
): Promise<void> => {
  // Deduplicate by (company_id, code) to avoid pointless re-upserts within
  // one run.
  const dedup = new Map<string, PromoObservation>();
  for (const o of observations) {
    const key = `${o.company_id ?? ""}|${o.code}`;
    const existing = dedup.get(key);
    if (existing === undefined) {
      dedup.set(key, { ...o });
    } else {
      // Merge: keep the richest non-null field per slot.
      dedup.set(key, {
        code: existing.code,
        company_id: existing.company_id,
        discount_percent: existing.discount_percent ?? o.discount_percent,
        ends_at: existing.ends_at ?? o.ends_at,
        separate: existing.separate ?? o.separate,
        starts_at: existing.starts_at ?? o.starts_at,
        title: existing.title ?? o.title,
        valid_from: existing.valid_from ?? o.valid_from,
        valid_to: existing.valid_to ?? o.valid_to,
      });
    }
  }
  for (const o of dedup.values()) {
    await upsertCampaign(o);
  }
};

// ── source loaders ────────────────────────────────────────────────────────────

const fromAwardedAndTop = (
  companies: readonly DeepReadonly<CompanySearchItem>[]
): PromoObservation[] => {
  const out: PromoObservation[] = [];
  for (const c of companies) {
    const obs = fromActivePromo(
      c.companyId ?? c.name ?? null,
      c.activePromotionInfo,
      c.activePromotion ?? null
    );
    if (obs) {
      out.push(obs);
    }
  }
  return out;
};

/**
 * Pass already-fetched constant responses (from the catalog pass) to also
 * pull promo info from companyHeader.activePromotionInfo. Useful when
 * separate=true codes (e.g. MG30) aren't surfaced by awarded-and-top.
 */
export const recordPromosFromConstants = async (
  cityId: number,
  entries: readonly Readonly<{
    companyId: string;
    constant: DeepReadonly<ConstantResponse>;
  }>[]
): Promise<void> => {
  // kept for call-site symmetry; not used by the new schema.
  void cityId;
  const obs: PromoObservation[] = [];
  for (const { companyId, constant } of entries) {
    const info = constant.companyHeader.activePromotionInfo ?? null;
    const o = fromActivePromo(companyId, info);
    if (o) {
      obs.push(o);
    }
  }
  await persist(obs);
};

const fetchBanners = async (cityId: number): Promise<PromoObservation[]> => {
  try {
    const banners = await get<Banner[]>(
      `/api/open/mobile/banners?cId=${cityId}`
    );
    bannersCarryNoCodes(banners ?? []);
    return [];
  } catch (error) {
    if (error instanceof HttpError) {
      console.warn(`[promotions] /banners failed: ${error.status}`);
      return [];
    }
    throw error;
  }
};

const fetchRecommended = async (
  cityId: number
): Promise<PromoObservation[]> => {
  try {
    const recs = await get<RecommendedDiet[]>(
      `/api/open/content-management/recommended-diets?cId=${cityId}&page=0&pageSize=20`
    );
    const out: PromoObservation[] = [];
    for (const r of recs ?? []) {
      const cid = r.companyData.companyId ?? null;
      const o = fromActivePromo(cid, r.activePromotion ?? null);
      if (o) {
        out.push(o);
      }
    }
    return out;
  } catch (error) {
    if (error instanceof HttpError) {
      console.warn(`[promotions] /recommended-diets failed: ${error.status}`);
      return [];
    }
    throw error;
  }
};

/**
 * Retire a promo code dietly rejected at checkout ("Nie znaleziono takiego
 * kodu rabatowego"). The listing can keep advertising a code, and its
 * `ends_at` can still be in the future, so the expiry sweep never retires
 * it: in the first national run four such codes cost 713 rejected quotes.
 * A later listing that still advertises the code reactivates it; the next
 * run then spends one quote, not hundreds, before retiring it again.
 * Returns true when the code was active.
 */
export const retirePromoCode = async (
  companyId: string,
  code: string
): Promise<boolean> => {
  const { rowCount } = await q(
    `UPDATE campaigns SET is_active = FALSE, last_seen_at = NOW()
      WHERE company_id = $1 AND code = $2 AND is_active`,
    [companyId, code]
  );
  if ((rowCount ?? 0) === 0) {
    return false;
  }
  await recordCampaignHistory(companyId, code);
  return true;
};

// ── main export ───────────────────────────────────────────────────────────────

export const scrapePromotions = async (
  cityId: number,
  companies: readonly DeepReadonly<CompanySearchItem>[]
): Promise<void> => {
  const t0 = Date.now();
  console.log(
    `[promotions] city=${cityId} from ${companies.length} companies + banners + recommended`
  );

  const awarded = fromAwardedAndTop(companies);
  const [banners, recommended] = await Promise.all([
    fetchBanners(cityId),
    fetchRecommended(cityId),
  ]);

  const all = [...awarded, ...banners, ...recommended];
  await persist(all);

  // Mark previously-active campaigns whose ends_at already passed AND which
  // we didn't observe this run. Conservative; avoids churn on transient API
  // hiccups.
  const expired = await q<{ company_id: string | null; code: string }>(
    `UPDATE campaigns
        SET is_active = FALSE
      WHERE is_active = TRUE
        AND last_seen_at < NOW() - INTERVAL '24 hours'
        AND COALESCE(ends_at, CURRENT_DATE) < CURRENT_DATE
      RETURNING company_id, code`
  );
  for (const e of expired.rows) {
    await recordCampaignHistory(e.company_id, e.code);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const counts = {
    awardedAndTop: awarded.length,
    banners: banners.length,
    recommended: recommended.length,
  };
  console.log(
    `[promotions] ✓ persisted ${all.length} observations (awarded=${counts.awardedAndTop}, banners=${counts.banners}, recommended=${counts.recommended}) in ${elapsed}s`
  );
};
