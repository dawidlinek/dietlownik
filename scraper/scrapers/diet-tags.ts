import { get } from "../api";
import { q } from "../db";
import type { DietTag } from "../types";

export const scrapeDietTags = async (): Promise<void> => {
  console.log("[diet-tags] fetching...");
  const raw = await get<Record<string, DietTag>>("/api/open/diet-tag-info/all");
  const tags = Object.values(raw);

  for (const tag of tags) {
    await q(
      `INSERT INTO diet_tags (tag_code, label, description)
       VALUES ($1,$2,$3)
       ON CONFLICT (tag_code) DO UPDATE SET
         label       = EXCLUDED.label,
         description = EXCLUDED.description`,
      [tag.dietTagId, tag.name ?? null, null]
    );
  }

  console.log(`[diet-tags] ✓ ${tags.length} tags stored`);
};
