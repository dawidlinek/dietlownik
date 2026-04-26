import { get } from '../api.js';
import { q } from '../db.js';
import type { Campaign } from '../types.js';

export async function scrapeCampaigns(): Promise<Campaign | null> {
  console.log('[campaigns] fetching active campaign...');
  let campaign: Campaign;
  try {
    campaign = await get<Campaign>('/api/open/campaign-settings/active-campaign');
  } catch (err) {
    console.log(`[campaigns] no active campaign (${(err as Error).message})`);
    return null;
  }

  if (!campaign?.code) {
    console.log('[campaigns] empty response — no active campaign');
    return null;
  }

  await q(`UPDATE campaigns SET is_active = FALSE WHERE code != $1 AND is_active = TRUE`, [
    campaign.code,
  ]);

  await q(
    `INSERT INTO campaigns
       (code, title, starts_at, ends_at, discount_percent, banner_image_url, is_active, first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,TRUE,NOW(),NOW())
     ON CONFLICT (code) WHERE is_active = TRUE DO UPDATE SET
       title            = EXCLUDED.title,
       starts_at        = EXCLUDED.starts_at,
       ends_at          = EXCLUDED.ends_at,
       discount_percent = EXCLUDED.discount_percent,
       banner_image_url = EXCLUDED.banner_image_url,
       last_seen_at     = NOW(),
       updated_at       = NOW()`,
    [
      campaign.code,
      campaign.title ?? null,
      campaign.startsAt ?? campaign.startDate ?? null,
      campaign.endsAt ?? campaign.endDate ?? null,
      campaign.discountPercent ?? campaign.discount ?? null,
      campaign.bannerImageUrl ?? campaign.imageUrl ?? null,
    ],
  );

  console.log(`[campaigns] ✓ active: ${campaign.code}`);
  return campaign;
}
