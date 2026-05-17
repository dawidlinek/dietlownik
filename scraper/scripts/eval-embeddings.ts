/* eval-embeddings.ts — compare embedding models on a Polish-food benchmark.
 *
 * Benchmark = curated pairs ∪ DB-sampled pairs (when DATABASE_URL is set).
 * Curated pairs are hand-labelled. DB-sampled pairs use heuristic labelling:
 *   - "real-match"     : two meals from same company whose names share a
 *                        dominant Polish food token (e.g. both contain
 *                        "kurczak"). High prior that they're semantically
 *                        related — usually variants of the same dish.
 *   - "real-distractor": two meals from companies WITH DIFFERENT diet_tags
 *                        spanning macro extremes (e.g. KETO vs VEGAN /
 *                        VEGETARIAN). Very likely unrelated.
 *
 * For each model we report:
 *   - margin            = mean(match) − mean(distractor)
 *   - recall@0.30       = fraction of match pairs whose cosine ≥ 0.30
 *   - specificity@0.30  = fraction of distractor pairs whose cosine < 0.30
 *   - optimal threshold = argmax(recall + specificity)
 *   - dim, load ms, infer ms/text
 *
 * Run:  `tsx scraper/scripts/eval-embeddings.ts`
 *   - `EVAL_MODELS=bge-m3,minilm-multi` to filter
 *   - `EVAL_SKIP_DB=1` to skip DB-sampled pairs (curated only)
 *   - `EVAL_DB_LIMIT=30` to cap real pairs per channel (default 40)
 */

// oxlint-disable no-console -- this IS the script

const enum Channel {
  Match = "match",
  Distractor = "distractor",
}

interface Pair {
  readonly a: string;
  readonly b: string;
  readonly channel: Channel;
  readonly source: "curated" | "db";
  readonly note: string;
}

// ── Curated pairs (hand-labelled) ────────────────────────────────────────

const CURATED: readonly Pair[] = [
  // Should-match: synonyms / paraphrases
  { a: "shake", b: "koktajl mleczny truskawkowy", channel: Channel.Match, source: "curated", note: "EN↔PL synonym" },
  { a: "pomidor", b: "sos pomidorowy z bazylią", channel: Channel.Match, source: "curated", note: "ingredient↔derivative" },
  { a: "kurczak", b: "filet z kurczaka", channel: Channel.Match, source: "curated", note: "ingredient↔cut" },
  { a: "łosoś", b: "filet z łososia w sosie cytrynowym", channel: Channel.Match, source: "curated", note: "ingredient↔dish" },
  { a: "białko", b: "proteina", channel: Channel.Match, source: "curated", note: "macro synonym" },
  { a: "dużo białka", b: "wysokobiałkowy", channel: Channel.Match, source: "curated", note: "macro phrasing" },
  { a: "mało tłuszczu", b: "niskotłuszczowy", channel: Channel.Match, source: "curated", note: "macro phrasing" },
  { a: "makaron", b: "spaghetti carbonara", channel: Channel.Match, source: "curated", note: "pasta family" },
  { a: "ryż", b: "ryż jaśminowy z warzywami", channel: Channel.Match, source: "curated", note: "rice family" },
  { a: "ostry", b: "papryczka chili", channel: Channel.Match, source: "curated", note: "flavour↔source" },
  { a: "pieczony", b: "z pieca", channel: Channel.Match, source: "curated", note: "cooking method phrasing" },
  { a: "gotowany", b: "z wody", channel: Channel.Match, source: "curated", note: "cooking method phrasing" },
  { a: "smażony", b: "z patelni", channel: Channel.Match, source: "curated", note: "cooking method phrasing" },
  { a: "deser", b: "ciasto czekoladowe", channel: Channel.Match, source: "curated", note: "category↔example" },
  { a: "śniadanie", b: "owsianka z owocami", channel: Channel.Match, source: "curated", note: "meal-time↔dish" },

  // Should-match: taxonomy category ↔ member
  { a: "psiankowate", b: "pomidor", channel: Channel.Match, source: "curated", note: "category↔member (nightshade)" },
  { a: "psiankowate", b: "papryka", channel: Channel.Match, source: "curated", note: "category↔member" },
  { a: "psiankowate", b: "bakłażan", channel: Channel.Match, source: "curated", note: "category↔member" },
  { a: "strączkowe", b: "ciecierzyca", channel: Channel.Match, source: "curated", note: "category↔member (legume)" },
  { a: "strączkowe", b: "soczewica", channel: Channel.Match, source: "curated", note: "category↔member" },
  { a: "strączkowe", b: "fasola", channel: Channel.Match, source: "curated", note: "category↔member" },
  { a: "nabiał", b: "jogurt naturalny", channel: Channel.Match, source: "curated", note: "category↔member (dairy)" },
  { a: "nabiał", b: "twaróg", channel: Channel.Match, source: "curated", note: "category↔member" },
  { a: "nabiał", b: "ser feta", channel: Channel.Match, source: "curated", note: "category↔member" },

  // Should-match: within-family / variants
  { a: "kurczak", b: "drób", channel: Channel.Match, source: "curated", note: "species↔family" },
  { a: "łosoś", b: "pstrąg", channel: Channel.Match, source: "curated", note: "fish↔fish" },
  { a: "ziemniak", b: "ziemniaki pieczone", channel: Channel.Match, source: "curated", note: "ingredient↔dish" },
  { a: "mleko", b: "jogurt naturalny", channel: Channel.Match, source: "curated", note: "dairy family" },
  { a: "chleb", b: "bułka pszenna", channel: Channel.Match, source: "curated", note: "baked-goods family" },

  // Should-match: ASCII fallback (no diacritics)
  { a: "łosoś", b: "losos", channel: Channel.Match, source: "curated", note: "diacritic-stripped form" },
  { a: "białko", b: "bialko", channel: Channel.Match, source: "curated", note: "diacritic-stripped form" },
  { a: "śmietana", b: "smietana", channel: Channel.Match, source: "curated", note: "diacritic-stripped form" },
  { a: "żurawina", b: "zurawina", channel: Channel.Match, source: "curated", note: "diacritic-stripped form" },

  // Should-NOT-match: cross-domain
  { a: "pomidor", b: "owsianka z malinami", channel: Channel.Distractor, source: "curated", note: "veg↔porridge" },
  { a: "kurczak", b: "ciasto czekoladowe", channel: Channel.Distractor, source: "curated", note: "meat↔dessert" },
  { a: "łosoś", b: "ziemniaki gotowane", channel: Channel.Distractor, source: "curated", note: "fish↔starch side" },
  { a: "mleko", b: "surowy tuńczyk", channel: Channel.Distractor, source: "curated", note: "dairy↔raw fish" },
  { a: "białko", b: "cukier", channel: Channel.Distractor, source: "curated", note: "protein↔sugar" },
  { a: "wegański", b: "stek wołowy", channel: Channel.Distractor, source: "curated", note: "vegan vs meat" },
  { a: "keto", b: "naleśniki z dżemem", channel: Channel.Distractor, source: "curated", note: "low-carb vs sugar" },
  { a: "śniadanie", b: "stek z rib eye", channel: Channel.Distractor, source: "curated", note: "meal-time mismatch" },
  { a: "dieta lekkostrawna", b: "ostry kebab", channel: Channel.Distractor, source: "curated", note: "easy↔heavy" },
  { a: "psiankowate", b: "jogurt naturalny", channel: Channel.Distractor, source: "curated", note: "cross-category" },
] as const;

// ── Heuristic token-overlap for DB pair generation ───────────────────────

const POLISH_STOP = new Set<string>([
  "z", "ze", "w", "we", "i", "na", "po", "do", "od", "od", "się", "z", "a", "o", "u",
  "to", "tylko", "też", "tak", "nie", "lub", "albo", "z", "bez", "dla", "jak", "co",
]);

const significantTokens = (name: string): readonly string[] => {
  const normalized = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining marks
    .replace(/ł/g, "l")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/);
  return normalized.filter((t) => t.length >= 5 && !POLISH_STOP.has(t));
};

// Curated list of "dominant Polish food tokens" — these reliably identify
// a dish's main ingredient. Used to pair meals from same company.
const FOOD_ANCHORS: readonly string[] = [
  "kurczak", "indyk", "wolowin", "wieprzow", "schab", "boczek", "kielbas",
  "losos", "dorsz", "tunczyk", "pstrag", "krewetk",
  "pomidor", "papryk", "ogorek", "marchew", "buraczk", "ziemniak", "brokul",
  "kalafior", "cukini", "baklazan", "szpinak", "kapust", "saskat",
  "ciecier", "soczewic", "fasol", "groch",
  "makaron", "spaghetti", "ryz", "kasz", "komos",
  "twarog", "jogurt", "mleko", "smietan", "serow",
  "owsiank", "naleSnik", "placek", "platki",
  "czekolad", "truskawk", "malin", "banan", "jablk",
];

// ── DB pair generation ───────────────────────────────────────────────────

interface DbMealRow {
  readonly id: number;
  readonly company_id: string;
  readonly name: string;
  readonly diet_tag: string | null;
  readonly kcal: number | null;
}

const fetchDbPairs = async (
  limitPerChannel: number,
): Promise<{ readonly pairs: readonly Pair[]; readonly source: "db" | "skipped"; readonly reason?: string }> => {
  try {
    const { default: pg } = await import("pg");
    await import("dotenv/config");
    const url = process.env.DATABASE_URL;
    if (url === undefined || url === "") {
      return { pairs: [], reason: "DATABASE_URL not set", source: "skipped" };
    }
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      // Pull all meals + their diet_tag (via daily_menu → diet_calories → diet_options → tiers → diets).
      // Cheap because the join chain is over indexed PKs.
      const meals = await client.query<DbMealRow>(
        `
        SELECT DISTINCT
          m.id, m.company_id, m.name, d.diet_tag, m.kcal::float AS kcal
        FROM meals m
        LEFT JOIN daily_menu dm ON dm.meal_id = m.id
        LEFT JOIN diet_calories dc ON dc.diet_calories_id = dm.diet_calories_id
        LEFT JOIN diets d ON d.company_id = dc.company_id AND d.diet_id = dc.diet_id
        ORDER BY m.id
        `,
      );
      const rows = meals.rows;
      if (rows.length < 20) {
        return { pairs: [], reason: `only ${rows.length} meals in DB`, source: "skipped" };
      }

      // Build token index over meals.
      const tokensFor = new Map<number, ReadonlySet<string>>();
      for (const r of rows) {
        tokensFor.set(r.id, new Set(significantTokens(r.name)));
      }

      // ── Real-match: same company + meals share a food-anchor token ─────
      const matches: Pair[] = [];
      const groupByAnchor = new Map<string, Map<string, DbMealRow[]>>(); // anchor → company → meals
      for (const r of rows) {
        const ts = tokensFor.get(r.id);
        if (ts === undefined) continue;
        for (const anchor of FOOD_ANCHORS) {
          let hit = false;
          for (const t of ts) {
            if (t.startsWith(anchor)) {
              hit = true;
              break;
            }
          }
          if (!hit) continue;
          let byCompany = groupByAnchor.get(anchor);
          if (byCompany === undefined) {
            byCompany = new Map();
            groupByAnchor.set(anchor, byCompany);
          }
          let bucket = byCompany.get(r.company_id);
          if (bucket === undefined) {
            bucket = [];
            byCompany.set(r.company_id, bucket);
          }
          bucket.push(r);
        }
      }

      const seen = new Set<string>(); // pair key to dedup
      for (const [anchor, byCompany] of groupByAnchor) {
        for (const [, bucket] of byCompany) {
          if (bucket.length < 2) continue;
          // Pick a stable pair (lowest two IDs) to keep runs deterministic.
          bucket.sort((x, y) => x.id - y.id);
          const a = bucket[0];
          const b = bucket[1];
          if (a.name === b.name) continue;
          const key = `${a.id}-${b.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          matches.push({
            a: a.name,
            b: b.name,
            channel: Channel.Match,
            note: `same-company "${anchor}" anchor`,
            source: "db",
          });
          if (matches.length >= limitPerChannel) break;
        }
        if (matches.length >= limitPerChannel) break;
      }

      // ── Real-distractor: meals from diet_tags on opposite macro extremes
      const MACRO_EXTREMES: ReadonlyArray<readonly [string, string]> = [
        ["KETO", "VEGAN"],
        ["KETO", "WEIGHT LOSS"],
        ["SPORT", "FODMAP"],
        ["VEGETARIAN", "STANDARD"],
        ["GLUTEN LACTOSE FREE", "STANDARD"],
        ["LOW IG", "SPORT"],
      ];
      const byTag = new Map<string, DbMealRow[]>();
      for (const r of rows) {
        if (r.diet_tag === null) continue;
        let bucket = byTag.get(r.diet_tag);
        if (bucket === undefined) {
          bucket = [];
          byTag.set(r.diet_tag, bucket);
        }
        bucket.push(r);
      }
      const distractors: Pair[] = [];
      for (const [tagA, tagB] of MACRO_EXTREMES) {
        const A = byTag.get(tagA);
        const B = byTag.get(tagB);
        if (A === undefined || B === undefined || A.length === 0 || B.length === 0) continue;
        // Take pairs (A[i], B[i]) for i = 0..min(N, limit) — deterministic.
        const n = Math.min(A.length, B.length, Math.ceil(limitPerChannel / MACRO_EXTREMES.length) + 1);
        for (let i = 0; i < n; i += 1) {
          const a = A[i];
          const b = B[i];
          if (a.name === b.name) continue;
          // Skip if names share food anchor (might be coincidentally similar).
          const ta = tokensFor.get(a.id);
          const tb = tokensFor.get(b.id);
          let overlap = false;
          if (ta !== undefined && tb !== undefined) {
            for (const t of ta) {
              if (tb.has(t) && FOOD_ANCHORS.some((anchor) => t.startsWith(anchor))) {
                overlap = true;
                break;
              }
            }
          }
          if (overlap) continue;
          distractors.push({
            a: a.name,
            b: b.name,
            channel: Channel.Distractor,
            note: `${tagA} vs ${tagB}`,
            source: "db",
          });
          if (distractors.length >= limitPerChannel) break;
        }
        if (distractors.length >= limitPerChannel) break;
      }

      return { pairs: [...matches, ...distractors], source: "db" };
    } finally {
      await client.end();
    }
  } catch (e) {
    return { pairs: [], reason: `DB error: ${String((e as Error).message ?? e)}`, source: "skipped" };
  }
};

// ── Model candidates ─────────────────────────────────────────────────────

interface Candidate {
  readonly id: string;
  readonly model: string;
  readonly prefix?: string;
  readonly quantized: boolean;
}

const CANDIDATES: readonly Candidate[] = [
  // Round 1 (already-measured baseline).
  { id: "bge-m3", model: "Xenova/bge-m3", quantized: true },
  { id: "e5-small", model: "Xenova/multilingual-e5-small", prefix: "query: ", quantized: true },
  { id: "e5-base", model: "Xenova/multilingual-e5-base", prefix: "query: ", quantized: true },
  { id: "minilm-multi", model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2", quantized: true },
  { id: "mpnet-multi", model: "Xenova/paraphrase-multilingual-mpnet-base-v2", quantized: true },
  // Round 2 (new this run).
  { id: "e5-large", model: "Xenova/multilingual-e5-large", prefix: "query: ", quantized: true },
  { id: "labse", model: "Xenova/LaBSE", quantized: true },
  { id: "distiluse-multi", model: "Xenova/distiluse-base-multilingual-cased-v2", quantized: true },
] as const;

// ── Evaluation ───────────────────────────────────────────────────────────

const cosine = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) {
    s += a[i] * b[i];
  }
  return s;
};

interface ModelResult {
  readonly candidate: Candidate;
  readonly dim: number;
  readonly loadMs: number;
  readonly inferAvgMs: number;
  readonly matchAvg: number;
  readonly matchMedian: number;
  readonly distractorAvg: number;
  readonly distractorMedian: number;
  readonly margin: number;
  readonly recallAt30: number;
  readonly specificityAt30: number;
  readonly optThreshold: number;
  readonly recallAtOpt: number;
  readonly specificityAtOpt: number;
  readonly perPair: ReadonlyArray<{
    readonly a: string;
    readonly b: string;
    readonly channel: Channel;
    readonly source: "curated" | "db";
    readonly sim: number;
  }>;
}

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const computeOptimalThreshold = (
  matches: readonly number[],
  distractors: readonly number[],
): { threshold: number; recall: number; specificity: number } => {
  const candidates = new Set<number>();
  for (const s of matches) candidates.add(s);
  for (const s of distractors) candidates.add(s);
  let best = { recall: 0, specificity: 0, threshold: 0 };
  let bestSum = -1;
  for (const t of candidates) {
    const recall =
      matches.filter((s) => s >= t).length / Math.max(1, matches.length);
    const specificity =
      distractors.filter((s) => s < t).length / Math.max(1, distractors.length);
    if (recall + specificity > bestSum) {
      bestSum = recall + specificity;
      best = { recall, specificity, threshold: t };
    }
  }
  return best;
};

const evalCandidate = async (
  candidate: Candidate,
  pairs: readonly Pair[],
): Promise<ModelResult | { readonly candidate: Candidate; readonly error: string }> => {
  const t0 = Date.now();
  let pipeline: unknown;
  try {
    const tx = await import("@xenova/transformers");
    const pipelineFn = (tx as { pipeline: (...args: readonly unknown[]) => Promise<unknown> }).pipeline;
    pipeline = await pipelineFn("feature-extraction", candidate.model, {
      quantized: candidate.quantized,
    });
  } catch (e) {
    return { candidate, error: `load failed: ${String((e as Error).message ?? e)}` };
  }
  const loadMs = Date.now() - t0;

  const wrap = (s: string): string =>
    candidate.prefix !== undefined ? `${candidate.prefix}${s}` : s;
  const texts = new Set<string>();
  for (const p of pairs) {
    texts.add(wrap(p.a));
    texts.add(wrap(p.b));
  }
  const textList = [...texts];

  // Batch through the pipeline. For e5-large + ~80 unique texts, this might
  // hit memory limits; chunk into batches of 32 to be safe.
  const BATCH = 32;
  const vectors = new Map<string, Float32Array>();
  const inferStart = Date.now();
  for (let i = 0; i < textList.length; i += BATCH) {
    const slice = textList.slice(i, i + BATCH);
    const tensor = (await (pipeline as unknown as (input: readonly string[], opts: object) => Promise<unknown>)(
      slice,
      { normalize: true, pooling: "mean" },
    )) as { data: Float32Array; dims: readonly number[] };
    const dim = tensor.dims[tensor.dims.length - 1];
    for (let j = 0; j < slice.length; j += 1) {
      const offset = j * dim;
      vectors.set(slice[j], tensor.data.slice(offset, offset + dim));
    }
  }
  const inferMs = Date.now() - inferStart;

  const sampleVec = vectors.get(textList[0]);
  const dim = sampleVec === undefined ? 0 : sampleVec.length;

  const perPair: Array<{ a: string; b: string; channel: Channel; source: "curated" | "db"; sim: number }> = [];
  const matchSims: number[] = [];
  const distSims: number[] = [];
  for (const p of pairs) {
    const va = vectors.get(wrap(p.a));
    const vb = vectors.get(wrap(p.b));
    if (va === undefined || vb === undefined) continue;
    const sim = cosine(va, vb);
    perPair.push({ a: p.a, b: p.b, channel: p.channel, sim, source: p.source });
    if (p.channel === Channel.Match) matchSims.push(sim);
    else distSims.push(sim);
  }

  const matchAvg = matchSims.reduce((a, b) => a + b, 0) / Math.max(1, matchSims.length);
  const distractorAvg = distSims.reduce((a, b) => a + b, 0) / Math.max(1, distSims.length);
  const margin = matchAvg - distractorAvg;
  const recallAt30 = matchSims.filter((s) => s >= 0.3).length / Math.max(1, matchSims.length);
  const specificityAt30 = distSims.filter((s) => s < 0.3).length / Math.max(1, distSims.length);
  const opt = computeOptimalThreshold(matchSims, distSims);

  // Release ORT session if possible.
  try {
    const p = pipeline as { dispose?: () => Promise<void> };
    if (typeof p.dispose === "function") await p.dispose();
  } catch {
    /* ignore */
  }

  return {
    candidate,
    dim,
    distractorAvg,
    distractorMedian: median(distSims),
    inferAvgMs: inferMs / Math.max(1, textList.length),
    loadMs,
    margin,
    matchAvg,
    matchMedian: median(matchSims),
    optThreshold: opt.threshold,
    perPair,
    recallAt30,
    recallAtOpt: opt.recall,
    specificityAt30,
    specificityAtOpt: opt.specificity,
  };
};

const pad = (s: string, n: number): string =>
  s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);

const main = async (): Promise<void> => {
  const filter = process.env.EVAL_MODELS;
  const selected: readonly Candidate[] = filter
    ? CANDIDATES.filter((c) => filter.split(",").map((s) => s.trim()).includes(c.id))
    : CANDIDATES;

  if (selected.length === 0) {
    console.error("No candidates selected.");
    process.exit(1);
  }

  // ── Build the benchmark ─────────────────────────────────────────────
  const skipDb = process.env.EVAL_SKIP_DB === "1";
  const dbLimit = Number.parseInt(process.env.EVAL_DB_LIMIT ?? "40", 10);
  let pairs: readonly Pair[];
  if (skipDb) {
    pairs = CURATED;
  } else {
    const dbResult = await fetchDbPairs(dbLimit);
    if (dbResult.source === "skipped") {
      console.log(`(db pairs skipped: ${dbResult.reason ?? "unknown"})`);
      pairs = CURATED;
    } else {
      pairs = [...CURATED, ...dbResult.pairs];
    }
  }

  const matchCount = pairs.filter((p) => p.channel === Channel.Match).length;
  const distCount = pairs.filter((p) => p.channel === Channel.Distractor).length;
  console.log(`Evaluating ${selected.length} models on ${pairs.length} pairs:`);
  console.log(`  curated:           ${CURATED.length} (${CURATED.filter((p) => p.channel === Channel.Match).length}m / ${CURATED.filter((p) => p.channel === Channel.Distractor).length}d)`);
  console.log(`  db-sampled:        ${pairs.length - CURATED.length} (${matchCount - CURATED.filter((p) => p.channel === Channel.Match).length}m / ${distCount - CURATED.filter((p) => p.channel === Channel.Distractor).length}d)`);
  console.log(`  total:             ${pairs.length} (${matchCount}m / ${distCount}d)`);
  console.log();

  // ── Run candidates ──────────────────────────────────────────────────
  const results: Array<ModelResult | { readonly candidate: Candidate; readonly error: string }> = [];
  for (const candidate of selected) {
    console.log(`▶ ${candidate.id} (${candidate.model})  prefix=${candidate.prefix ?? "(none)"}`);
    const r = await evalCandidate(candidate, pairs);
    if ("error" in r) {
      console.log(`  ✗ ${r.error}`);
    } else {
      console.log(
        `  ✓ dim=${r.dim}  load=${(r.loadMs / 1000).toFixed(1)}s  infer=${r.inferAvgMs.toFixed(1)}ms/text  margin=${r.margin.toFixed(3)}  recall@.30=${(r.recallAt30 * 100).toFixed(0)}%  spec@.30=${(r.specificityAt30 * 100).toFixed(0)}%  opt-t=${r.optThreshold.toFixed(3)} (r=${(r.recallAtOpt * 100).toFixed(0)}% s=${(r.specificityAtOpt * 100).toFixed(0)}%)`,
      );
    }
    results.push(r);
  }

  const succeeded = results.filter((r): r is ModelResult => !("error" in r));
  const sorted = [...succeeded].sort((a, b) => b.margin - a.margin);

  // ── Summary table ───────────────────────────────────────────────────
  console.log();
  console.log("┌─ Summary, sorted by margin ─────────────────────────────────────────────────────────────────────────────┐");
  console.log("│ MODEL                 DIM   LOAD     INFER   MARGIN  R@.30   S@.30   OPT-T   R@OPT   S@OPT                │");
  console.log("├──────────────────────────────────────────────────────────────────────────────────────────────────────────┤");
  for (let i = 0; i < sorted.length; i += 1) {
    const r = sorted[i];
    console.log(
      `│ ${pad(`#${i + 1} ${r.candidate.id}`, 22)}${pad(String(r.dim), 6)}${pad(`${(r.loadMs / 1000).toFixed(1)}s`, 9)}${pad(`${r.inferAvgMs.toFixed(1)}ms`, 8)}${pad(r.margin.toFixed(3), 8)}${pad(`${(r.recallAt30 * 100).toFixed(0)}%`, 8)}${pad(`${(r.specificityAt30 * 100).toFixed(0)}%`, 8)}${pad(r.optThreshold.toFixed(3), 8)}${pad(`${(r.recallAtOpt * 100).toFixed(0)}%`, 8)}${pad(`${(r.specificityAtOpt * 100).toFixed(0)}%`, 8)}     │`,
    );
  }
  console.log("└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘");

  // ── Top model spot-checks ───────────────────────────────────────────
  if (sorted.length > 0) {
    const best = sorted[0];
    console.log();
    console.log(`Hardest match pairs for top model (${best.candidate.id}) — lowest similarities among should-match:`);
    const matchPairs = [...best.perPair.filter((p) => p.channel === Channel.Match)].sort((x, y) => x.sim - y.sim).slice(0, 8);
    for (const p of matchPairs) {
      const tag = p.source === "curated" ? "cur" : "db ";
      console.log(`  ${tag} ${p.sim.toFixed(3)}   ${pad(p.a, 30)}↔  ${p.b}`);
    }
    console.log();
    console.log(`Worst false-positives for top model (${best.candidate.id}) — highest similarities among distractors:`);
    const distPairs = [...best.perPair.filter((p) => p.channel === Channel.Distractor)].sort((x, y) => y.sim - x.sim).slice(0, 8);
    for (const p of distPairs) {
      const tag = p.source === "curated" ? "cur" : "db ";
      console.log(`  ${tag} ${p.sim.toFixed(3)}   ${pad(p.a, 30)}↔  ${p.b}`);
    }
  }

  // ── Failures ───────────────────────────────────────────────────────
  const failed = results.filter((r): r is { readonly candidate: Candidate; readonly error: string } => "error" in r);
  if (failed.length > 0) {
    console.log();
    console.log("Failed to load:");
    for (const r of failed) {
      console.log(`  ${r.candidate.id} (${r.candidate.model}): ${r.error}`);
    }
  }
};

main().catch((e) => {
  console.error("eval-embeddings failed:", e);
  process.exit(1);
});
