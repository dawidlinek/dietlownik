// The text a meal variant is embedded from. Shared by the scrape-time queue
// (scraper/embed-queue.ts) and the backfill (scraper/scripts/embed-meals.ts)
// so both produce identical vectors.
//
// Bump PASSAGE_VERSION whenever buildPassage's output changes: `embed` then
// re-embeds every variant whose stored passage_version is older. Changing the
// text without bumping it silently mixes two passage formats in one index.
export const PASSAGE_VERSION = 1;

export interface PassageSource {
  readonly name: string | null;
  readonly label: string | null;
  readonly ingredients_raw: string | null;
  readonly allergens: readonly string[] | null;
}

const EMPTY_TAILS = new Set(["", "Wariant: ", "Składniki: ", "Alergeny: "]);

export const buildPassage = (m: PassageSource): string => {
  const lines = [
    m.name ?? "",
    `Wariant: ${m.label ?? ""}`,
    `Składniki: ${m.ingredients_raw ?? ""}`,
    `Alergeny: ${(m.allergens ?? []).join(", ")}`,
  ];
  // Strip trailing empty (or "Field: " with empty value) lines.
  while (lines.length > 0 && EMPTY_TAILS.has(lines.at(-1) ?? "")) {
    lines.pop();
  }
  return lines.join("\n");
};
