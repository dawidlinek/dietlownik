/**
 * Two-letter abbreviation of a catering name, used as a logo placeholder
 * when the catering has no image. Tries to be conservative — uppercase, no
 * punctuation, never wider than 2 glyphs.
 *
 * Splits on whitespace AND on camelCase boundaries (a lowercase letter
 * immediately followed by an uppercase one) so:
 *   "Robin Food" → "RF"
 *   "UrbanFits"  → "UF"   (not "UR")
 *   "Lite & Co"  → "LC"   (the "&" is dropped)
 *   "ABCFoods"   → "AB"   (no lowercase→uppercase transition → single token)
 *   "iPhone"     → "IP"   (i + Phone)
 *
 * Falls back to the first two letters of the cleaned input when the name
 * doesn't yield ≥1 word, and to "?" when nothing letter-like survives.
 */
export const cateringInitials = (name: string): string => {
  const cleaned = name.replaceAll(/[^\p{L}\d\s&]/gu, " ").trim();
  if (cleaned === "") {
    return "?";
  }
  const words = cleaned
    .split(/\s+|(?<=\p{Ll})(?=\p{Lu})/u)
    .filter((w) => w.length > 0 && w !== "&" && w !== "-");
  if (words.length === 0) {
    return cleaned.slice(0, 2).toUpperCase();
  }
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return (words[0][0] + words[1][0]).toUpperCase();
};

/** Deterministic hue (0–359) derived from the catering name. Stable across
 *  sessions — same name → same hue always. */
const hueFor = (name: string): number => {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) {
    h = (h * 31 + (name.codePointAt(i) ?? 0)) % 360;
  }
  return h;
};

/** Background + foreground OKLCH colors for the placeholder bubble. Soft
 *  warm-leaning tints — chroma is intentionally low so the colors stay
 *  inside the cream/oat brand palette and don't shout. */
export const cateringPlaceholderColor = (
  name: string
): { readonly bg: string; readonly fg: string } => {
  const hue = hueFor(name);
  return {
    bg: `oklch(78% 0.06 ${hue})`,
    fg: `oklch(28% 0.04 ${hue})`,
  };
};

/** True when the URL is something we can actually render — non-null, not
 *  blank, and starts with an http(s) scheme. Catches the empty-string and
 *  whitespace cases the scraper sometimes leaves behind, so the
 *  placeholder kicks in instead of rendering a blank circle. */
export const hasRenderableLogo = (
  logoUrl: string | null | undefined
): logoUrl is string => {
  if (logoUrl === null || logoUrl === undefined) {
    return false;
  }
  const trimmed = logoUrl.trim();
  if (trimmed === "") {
    return false;
  }
  return trimmed.startsWith("http://") || trimmed.startsWith("https://");
};

/**
 * URLs whose image element threw `onError` at least once during this
 * session. Module-level so the same URL doesn't retry endlessly when the
 * dot scrolls back into view, and so the picker list and the scatter
 * agree about which logos are dead. Cleared automatically on full page
 * reload — fine since the scraper updates logo URLs over time.
 */
const failedLogoUrls = new Set<string>();

export const markLogoFailed = (url: string): void => {
  failedLogoUrls.add(url);
};

export const isLogoFailed = (url: string): boolean => failedLogoUrls.has(url);
