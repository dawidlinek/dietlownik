import { get } from "../api";
import { q } from "../db";
import type { DietTag } from "../types";

export const scrapeDietTags = async (): Promise<void> => {
  console.log("[diet_tags] fetching...");
  const raw = await get<Record<string, DietTag>>("/api/open/diet-tag-info/all");
  const tags = Object.values(raw);

  for (const tag of tags) {
    await q(
      `INSERT INTO diet_tags (tag_code, label, description, image_url)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (tag_code) DO UPDATE SET
         label     = EXCLUDED.label,
         image_url = EXCLUDED.image_url`,
      [tag.dietTagId, tag.name ?? null, null, tag.imageUrl ?? null]
    );
  }

  console.log(`[diet_tags] ✓ ${tags.length} tags stored`);
};
