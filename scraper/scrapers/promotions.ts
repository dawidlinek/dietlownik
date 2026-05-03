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
// Each observation goes into promo_observations (append-only time-series) and
// upserts into campaigns (the SCD that says "this code is currently
// known"). Validity from banners and promoDeadline from API both feed in so we
// can answer "is X still active?" without touching the API.

import { get, HttpError } from "../api.js";
import { q } from "../db.js";
import type {
  ActivePromotionInfo,
  Banner,
  CompanySearchItem,
  ConstantResponse,
  RecommendedDiet,
} from "../types.js";

interface PromoObservation {
  code: string;
  /** constant | awarded-and-top | banner | recommended-diets */
  source: string;
  company_id: string | null;
  city_id: number | null;
  discount_percents: number | null;
  promo_text: string | null;
  /** YYYY-MM-DD */
  deadline: string | null;
  separate: boolean | null;
  /** ISO 8601 */
  valid_from: string | null;
  valid_to: string | null;
  raw: unknown;
}

const isBanner = (raw: unknown): raw is Banner => {
  if (raw === null || typeof raw !== "object") {
    return false;
  }
  return "code" in raw && "validTo" in raw;
};

const fromActivePromo = (
  source: string,
  company_id: string | null,
  city_id: number | null,
  info: ActivePromotionInfo | null | undefined,
  raw: unknown
): PromoObservation | null => {
  if (info == null) {
    return null;
  }
  const { code } = info;
  if (code === null || code === undefined || code === "") {
    return null;
  }
  return {
    city_id,
    code,
    company_id,
    deadline: info.promoDeadline ?? null,
    discount_percents: info.discountPercents ?? null,
    promo_text: info.promoText ?? null,
    raw,
    separate: info.separate ?? null,
    source,
    valid_from: null,
    valid_to: null,
  };
};

const fromBanner = (
  banner: Banner,
  city_id: number
): PromoObservation | null => {
  if (banner.code === "" || banner.code === null || banner.code === undefined) {
    return null;
  }
  return {
    city_id,
    code: banner.code,
    company_id: null,
    deadline: null,
    discount_percents: null,
    promo_text: banner.name ?? null,
    raw: banner,
    separate: null,
    source: "banner",
    valid_from: banner.validFrom ?? null,
    valid_to: banner.validTo ?? null,
  };
};

const insertObservation = async (o: PromoObservation): Promise<void> => {
  // promo_observations.company_id has an FK to companies(company_id).
  // awarded-and-top can run ahead of catalog during a partial scrape,
  // pointing at a company we haven't catalogued yet. Drop the link rather
  // than blow up the batch — we still want the observation persisted.
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
    `INSERT INTO promo_observations
       (code, source, company_id, city_id, discount_percents, promo_text,
        deadline, separate, valid_from, valid_to, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      o.code,
      o.source,
      companyId,
      o.city_id,
      o.discount_percents,
      o.promo_text,
      o.deadline,
      o.separate,
      o.valid_from,
      o.valid_to,
      JSON.stringify(o.raw ?? null),
    ]
  );
};

/**
 * Upsert into campaigns (the SCD). One row per (code, source, company_id|'').
 * `company_id` NULL means "global / cross-company". The composite unique
 * index in v4 lets us conflict-update.
 */
const upsertCampaign = async (o: PromoObservation): Promise<void> => {
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
  const bannerRaw = isBanner(o.raw) ? o.raw : null;
  await q(
    `INSERT INTO campaigns
       (code, source, company_id, discount_percent, title, deadline,
        valid_from, valid_to, separate, target, deep_link, banner_image_url,
        is_active, first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,TRUE,NOW(),NOW())
     ON CONFLICT (code, source, COALESCE(company_id, '')) DO UPDATE SET
       discount_percent = COALESCE(EXCLUDED.discount_percent, campaigns.discount_percent),
       title            = COALESCE(EXCLUDED.title, campaigns.title),
       deadline         = COALESCE(EXCLUDED.deadline, campaigns.deadline),
       valid_from       = COALESCE(EXCLUDED.valid_from, campaigns.valid_from),
       valid_to         = COALESCE(EXCLUDED.valid_to, campaigns.valid_to),
       separate         = COALESCE(EXCLUDED.separate, campaigns.separate),
       target           = COALESCE(EXCLUDED.target, campaigns.target),
       deep_link        = COALESCE(EXCLUDED.deep_link, campaigns.deep_link),
       banner_image_url = COALESCE(EXCLUDED.banner_image_url, campaigns.banner_image_url),
       is_active        = TRUE,
       last_seen_at     = NOW(),
       updated_at       = NOW()`,
    [
      o.code,
      o.source,
      companyId,
      o.discount_percents,
      o.promo_text,
      o.deadline,
      o.valid_from,
      o.valid_to,
      o.separate,
      // banner-specific fields (mostly null when source != banner)
      bannerRaw?.target ?? null,
      bannerRaw?.deepLink ?? null,
      bannerRaw?.url ?? null,
    ]
  );
};

const persist = async (observations: PromoObservation[]): Promise<void> => {
  for (const o of observations) {
    await insertObservation(o);
    await upsertCampaign(o);
  }
};

// ── source loaders ────────────────────────────────────────────────────────────

const fromAwardedAndTop = (
  cityId: number,
  companies: CompanySearchItem[]
): PromoObservation[] => {
  const out: PromoObservation[] = [];
  for (const c of companies) {
    const obs = fromActivePromo(
      "awarded-and-top",
      c.companyId ?? c.name ?? null,
      cityId,
      c.activePromotionInfo,
      {
        activePromotionInfo: c.activePromotionInfo,
        companyId: c.companyId ?? c.name,
      }
    );
    if (obs) {
      out.push(obs);
    }
  }
  return out;
};

const fromConstantHeaders = (
  cityId: number,
  companies: CompanySearchItem[]
): PromoObservation[] => {
  // We don't want to refetch /constant for every company — catalog already
  // ran. Instead, surface promos from the awarded-and-top response as the
  // primary signal. This loader exists so callers can pass already-fetched
  // ConstantResponse objects when they happen to have them.
  // Returns [] when no constant data is supplied via the optional helper below.
  void cityId;
  void companies;
  return [];
};

/**
 * Optional — pass already-fetched constant responses (from the catalog pass)
 * to also pull promo info from companyHeader.activePromotionInfo. Most useful
 * when separate=true codes (e.g. MG30) aren't surfaced by awarded-and-top.
 */
export const recordPromosFromConstants = async (
  cityId: number,
  entries: { companyId: string; constant: ConstantResponse }[]
): Promise<void> => {
  const obs: PromoObservation[] = [];
  for (const { companyId, constant } of entries) {
    const info = constant.companyHeader.activePromotionInfo ?? null;
    const o = fromActivePromo("constant", companyId, cityId, info, info);
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
    return (banners ?? [])
      .map((b) => fromBanner(b, cityId))
      .filter((b): b is PromoObservation => b !== null);
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
      const o = fromActivePromo(
        "recommended-diets",
        cid,
        cityId,
        r.activePromotion ?? null,
        r
      );
      if (o) {
        out.push(o);
      }
    }
    return out;
  } catch (error) {
    if (error instanceof HttpError) {
      // Server has been observed returning 500 here intermittently — log+skip.
      console.warn(`[promotions] /recommended-diets failed: ${error.status}`);
      return [];
    }
    throw error;
  }
};

// ── main export ───────────────────────────────────────────────────────────────

export const scrapePromotions = async (
  cityId: number,
  companies: CompanySearchItem[]
): Promise<void> => {
  const t0 = Date.now();
  console.log(
    `[promotions] city=${cityId} from ${companies.length} companies + banners + recommended`
  );

  const awarded = fromAwardedAndTop(cityId, companies);
  const [banners, recommended] = await Promise.all([
    fetchBanners(cityId),
    fetchRecommended(cityId),
  ]);
  // constant-header pass needs already-fetched data; left as optional helper.
  fromConstantHeaders(cityId, companies);

  const all = [...awarded, ...banners, ...recommended];
  await persist(all);

  // Mark previously-active campaigns that we didn't see this run as inactive.
  // Conservative: only flip codes whose deadline already passed OR which haven't
  // been observed for >24h. Avoids churn on transient API hiccups.
  await q(
    `UPDATE campaigns
        SET is_active = FALSE,
            updated_at = NOW()
      WHERE is_active = TRUE
        AND last_seen_at < NOW() - INTERVAL '24 hours'
        AND COALESCE(deadline, CURRENT_DATE) < CURRENT_DATE`
  );

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
