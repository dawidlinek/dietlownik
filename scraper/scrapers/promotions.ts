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

import { get, HttpError } from '../api.js';
import { q } from '../db.js';
import type {
  ActivePromotionInfo,
  Banner,
  CompanySearchItem,
  ConstantResponse,
  RecommendedDiet,
} from '../types.js';

interface PromoObservation {
  code: string;
  source: string;                   // constant | awarded-and-top | banner | recommended-diets
  company_id: string | null;
  city_id: number | null;
  discount_percents: number | null;
  promo_text: string | null;
  deadline: string | null;          // YYYY-MM-DD
  separate: boolean | null;
  valid_from: string | null;        // ISO 8601
  valid_to: string | null;
  raw: unknown;
}

function fromActivePromo(
  source: string,
  company_id: string | null,
  city_id: number | null,
  info: ActivePromotionInfo | null | undefined,
  raw: unknown,
): PromoObservation | null {
  if (!info?.code) return null;
  return {
    code: info.code,
    source,
    company_id,
    city_id,
    discount_percents: info.discountPercents ?? null,
    promo_text: info.promoText ?? null,
    deadline: info.promoDeadline ?? null,
    separate: info.separate ?? null,
    valid_from: null,
    valid_to: null,
    raw,
  };
}

function fromBanner(banner: Banner, city_id: number): PromoObservation | null {
  if (!banner?.code) return null;
  return {
    code: banner.code,
    source: 'banner',
    company_id: null,
    city_id,
    discount_percents: null,
    promo_text: banner.name ?? null,
    deadline: null,
    separate: null,
    valid_from: banner.validFrom ?? null,
    valid_to: banner.validTo ?? null,
    raw: banner,
  };
}

async function insertObservation(o: PromoObservation): Promise<void> {
  await q(
    `INSERT INTO promo_observations
       (code, source, company_id, city_id, discount_percents, promo_text,
        deadline, separate, valid_from, valid_to, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      o.code, o.source, o.company_id, o.city_id, o.discount_percents,
      o.promo_text, o.deadline, o.separate, o.valid_from, o.valid_to,
      JSON.stringify(o.raw ?? null),
    ],
  );
}

/**
 * Upsert into campaigns (the SCD). One row per (code, source, company_id|'').
 * `company_id` NULL means "global / cross-company". The composite unique
 * index in v4 lets us conflict-update.
 */
async function upsertCampaign(o: PromoObservation): Promise<void> {
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
      o.company_id,
      o.discount_percents,
      o.promo_text,
      o.deadline,
      o.valid_from,
      o.valid_to,
      o.separate,
      // banner-specific fields (mostly null when source != banner)
      isBanner(o.raw) ? o.raw.target : null,
      isBanner(o.raw) ? o.raw.deepLink : null,
      isBanner(o.raw) ? o.raw.url : null,
    ],
  );
}

function isBanner(raw: unknown): raw is Banner {
  return !!raw && typeof raw === 'object' && 'code' in (raw as Banner) && 'validTo' in (raw as Banner);
}

async function persist(observations: PromoObservation[]): Promise<void> {
  for (const o of observations) {
    await insertObservation(o);
    await upsertCampaign(o);
  }
}

// ── source loaders ────────────────────────────────────────────────────────────

async function fromAwardedAndTop(cityId: number, companies: CompanySearchItem[]): Promise<PromoObservation[]> {
  const out: PromoObservation[] = [];
  for (const c of companies) {
    const obs = fromActivePromo('awarded-and-top', c.companyId ?? c.name ?? null, cityId, c.activePromotionInfo, {
      companyId: c.companyId ?? c.name,
      activePromotionInfo: c.activePromotionInfo,
    });
    if (obs) out.push(obs);
  }
  return out;
}

async function fromConstantHeaders(cityId: number, companies: CompanySearchItem[]): Promise<PromoObservation[]> {
  // We don't want to refetch /constant for every company — catalog already
  // ran. Instead, surface promos from the awarded-and-top response as the
  // primary signal. This loader exists so callers can pass already-fetched
  // ConstantResponse objects when they happen to have them.
  // Returns [] when no constant data is supplied via the optional helper below.
  void cityId;
  void companies;
  return [];
}

/**
 * Optional — pass already-fetched constant responses (from the catalog pass)
 * to also pull promo info from companyHeader.activePromotionInfo. Most useful
 * when separate=true codes (e.g. MG30) aren't surfaced by awarded-and-top.
 */
export async function recordPromosFromConstants(
  cityId: number,
  entries: Array<{ companyId: string; constant: ConstantResponse }>,
): Promise<void> {
  const obs: PromoObservation[] = [];
  for (const { companyId, constant } of entries) {
    const info = constant?.companyHeader?.activePromotionInfo ?? null;
    const o = fromActivePromo('constant', companyId, cityId, info, info);
    if (o) obs.push(o);
  }
  await persist(obs);
}

async function fetchBanners(cityId: number): Promise<PromoObservation[]> {
  try {
    const banners = await get<Banner[]>(`/api/open/mobile/banners?cId=${cityId}`);
    return (banners ?? [])
      .map(b => fromBanner(b, cityId))
      .filter((b): b is PromoObservation => b !== null);
  } catch (err) {
    if (err instanceof HttpError) {
      console.warn(`[promotions] /banners failed: ${err.status}`);
      return [];
    }
    throw err;
  }
}

async function fetchRecommended(cityId: number): Promise<PromoObservation[]> {
  try {
    const recs = await get<RecommendedDiet[]>(
      `/api/open/content-management/recommended-diets?cId=${cityId}&page=0&pageSize=20`,
    );
    const out: PromoObservation[] = [];
    for (const r of recs ?? []) {
      const cid = r?.companyData?.companyId ?? null;
      const o = fromActivePromo('recommended-diets', cid, cityId, r?.activePromotion ?? null, r);
      if (o) out.push(o);
    }
    return out;
  } catch (err) {
    if (err instanceof HttpError) {
      // Server has been observed returning 500 here intermittently — log+skip.
      console.warn(`[promotions] /recommended-diets failed: ${err.status}`);
      return [];
    }
    throw err;
  }
}

// ── main export ───────────────────────────────────────────────────────────────

export async function scrapePromotions(
  cityId: number,
  companies: CompanySearchItem[],
): Promise<void> {
  const t0 = Date.now();
  console.log(`[promotions] city=${cityId} from ${companies.length} companies + banners + recommended`);

  const [awarded, banners, recommended] = await Promise.all([
    fromAwardedAndTop(cityId, companies),
    fetchBanners(cityId),
    fetchRecommended(cityId),
  ]);
  // constant-header pass needs already-fetched data; left as optional helper.
  await fromConstantHeaders(cityId, companies);

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
        AND COALESCE(deadline, CURRENT_DATE) < CURRENT_DATE`,
  );

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const counts = {
    awardedAndTop: awarded.length,
    banners: banners.length,
    recommended: recommended.length,
  };
  console.log(`[promotions] ✓ persisted ${all.length} observations (awarded=${counts.awardedAndTop}, banners=${counts.banners}, recommended=${counts.recommended}) in ${elapsed}s`);
}
