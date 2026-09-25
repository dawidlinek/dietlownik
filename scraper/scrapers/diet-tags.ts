import { get } from "../api";
import { q } from "../db";
import type { DeepReadonly, DietTag } from "../types";

/** dietDescriptions as "title\n\ndescription" blocks, or null. */
const describeTag = (tag: DeepReadonly<DietTag>): string | null => {
  const blocks = (tag.dietDescriptions ?? []).map((d) =>
    [d.title, d.description].filter((x) => x !== "").join("\n\n")
  );
  return blocks.length > 0 ? blocks.join("\n\n") : null;
};

export const scrapeDietTags = async (): Promise<void> => {
  console.log("[diet-tags] fetching...");
  const raw = await get<Record<string, DietTag>>("/api/open/diet-tag-info/all");
  const tags = Object.values(raw);

  for (const tag of tags) {
    await q(
      `INSERT INTO diet_tags (tag_code, label, description, similar_tags)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (tag_code) DO UPDATE SET
         label        = EXCLUDED.label,
         description  = EXCLUDED.description,
         similar_tags = EXCLUDED.similar_tags`,
      [
        tag.dietTagId,
        tag.name ?? null,
        describeTag(tag),
        [...(tag.dietTagSimilarDiets ?? [])],
      ]
    );
  }

  console.log(`[diet-tags] ✓ ${tags.length} tags stored`);
};
