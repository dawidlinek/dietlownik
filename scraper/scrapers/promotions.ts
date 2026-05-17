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
}

// Convert ISO 8601 (banner valid_from / valid_to) to YYYY-MM-DD; pass through
// already-date strings.
const isoToDate = (s: string | null | undefined): string | null => {
  if (s === null || s === undefined || s === "") {
    return null;
  }
  // Already in YYYY-MM-DD?
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return s;
  }
  const ts = Date.parse(s);
  if (Number.isNaN(ts)) {
    return null;
  }
  const d = new Date(ts);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const fromActivePromo = (
  company_id: string | null,
  info: DeepReadonly<ActivePromotionInfo> | null | undefined
): PromoObservation | null => {
  if (info == null) {
    return null;
  }
  const { code } = info;
  if (code === null || code === undefined || code === "") {
    return null;
  }
  return {
    code,
    company_id,
    discount_percent: info.discountPercents ?? null,
    ends_at: info.promoDeadline ?? null,
    starts_at: null,
    title: info.promoText ?? null,
  };
};

const fromBanner = (banner: DeepReadonly<Banner>): PromoObservation | null => {
  if (banner.code === "" || banner.code === null || banner.code === undefined) {
    return null;
  }
  return {
    code: banner.code,
    company_id: null,
    discount_percent: null,
    ends_at: isoToDate(banner.validTo),
    starts_at: isoToDate(banner.validFrom),
    title: banner.name ?? null,
  };
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
        is_active, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,TRUE,NOW())
     ON CONFLICT (company_id, code) DO UPDATE SET
       title            = COALESCE(EXCLUDED.title, campaigns.title),
       discount_percent = COALESCE(EXCLUDED.discount_percent, campaigns.discount_percent),
       starts_at        = COALESCE(EXCLUDED.starts_at, campaigns.starts_at),
       ends_at          = COALESCE(EXCLUDED.ends_at, campaigns.ends_at),
       is_active        = TRUE,
       last_seen_at     = NOW()`,
    [companyId, o.code, o.title, o.discount_percent, o.starts_at, o.ends_at]
  );
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
        starts_at: existing.starts_at ?? o.starts_at,
        title: existing.title ?? o.title,
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
      c.activePromotionInfo
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
    return (banners ?? [])
      .map((b: DeepReadonly<Banner>) => fromBanner(b))
      .filter(
        (b: Readonly<PromoObservation> | null): b is PromoObservation =>
          b !== null
      );
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
  await q(
    `UPDATE campaigns
        SET is_active = FALSE
      WHERE is_active = TRUE
        AND last_seen_at < NOW() - INTERVAL '24 hours'
        AND COALESCE(ends_at, CURRENT_DATE) < CURRENT_DATE`
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
