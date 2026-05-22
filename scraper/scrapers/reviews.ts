// Reviews scraper.
//
// /feedback?sort=DATE walks reviews newest-first. Strategy: pull pages until
// we hit one whose every feedbackId we've already stored. That keeps steady-
// state runs to a single page while first-run still backfills the whole tail.
//
// Each review is upserted into `reviews` (canonical, keyed by (company,
// feedbackId)) and, when responseText/text/avgScore drift between captures,
// appends a `review_snapshots` row. The catering can reply to a review at
// any point, so we treat responseText specifically as drift-worthy.

import { get, HttpError } from "../api";
import { q } from "../db";
import { recordScrapeError, getCurrentRunId } from "../scrape-run";
import type { DeepReadonly, FeedbackResponse, FeedbackResult } from "../types";

const PAGE_SIZE = 50;
const MAX_PAGES = 20;

const errMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface UpsertResult {
  /** True when this scrape wrote anything (insert or drift). */
  touched: boolean;
  /** True when the (company, feedback_id) row already existed before this call. */
  existed: boolean;
}

const pickAuthor = (r: DeepReadonly<FeedbackResult>): string | null => {
  const candidate = r.author ?? r.authorName ?? r.username ?? null;
  if (candidate === null || candidate === undefined) {
    return null;
  }
  const trimmed = candidate.trim();
  return trimmed === "" ? null : trimmed;
};

interface ReviewUpsertRow {
  id: number;
  was_insert: boolean;
  prev_response_text: string | null;
  prev_text: string | null;
  prev_avg_score: number | null;
}

const detectDrift = (
  row: DeepReadonly<ReviewUpsertRow>,
  r: DeepReadonly<FeedbackResult>
): boolean => {
  if (row.was_insert) {
    return false;
  }
  if (row.prev_response_text !== (r.responseText ?? null)) {
    return true;
  }
  if (row.prev_text !== (r.text ?? null)) {
    return true;
  }
  return (row.prev_avg_score ?? null) !== (r.avgScore ?? null);
};

const upsertReview = async (
  companyId: string,
  r: DeepReadonly<FeedbackResult>
): Promise<UpsertResult> => {
  const author = pickAuthor(r);

  const res = await q<ReviewUpsertRow>(
    `WITH prev AS (
       SELECT id, response_text AS prev_response_text,
              text AS prev_text, avg_score AS prev_avg_score
       FROM reviews
       WHERE company_id = $1 AND feedback_id = $2
     )
     INSERT INTO reviews (
       company_id, feedback_id, review_date, last_delivery_date,
       avg_score, score_taste, score_aesthetics, score_ingredients_quality,
       score_packaging, score_variety, score_delivery,
       order_duration, verified, text, response_text, author,
       first_seen_at, last_seen_at, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
       NOW(), NOW(), NOW()
     )
     ON CONFLICT (company_id, feedback_id) DO UPDATE SET
       review_date              = EXCLUDED.review_date,
       last_delivery_date       = EXCLUDED.last_delivery_date,
       avg_score                = EXCLUDED.avg_score,
       score_taste              = EXCLUDED.score_taste,
       score_aesthetics         = EXCLUDED.score_aesthetics,
       score_ingredients_quality= EXCLUDED.score_ingredients_quality,
       score_packaging          = EXCLUDED.score_packaging,
       score_variety            = EXCLUDED.score_variety,
       score_delivery           = EXCLUDED.score_delivery,
       order_duration           = EXCLUDED.order_duration,
       verified                 = EXCLUDED.verified,
       text                     = EXCLUDED.text,
       response_text            = EXCLUDED.response_text,
       author                   = EXCLUDED.author,
       last_seen_at             = NOW(),
       updated_at               = CASE
         WHEN reviews.response_text IS DISTINCT FROM EXCLUDED.response_text
           OR reviews.text          IS DISTINCT FROM EXCLUDED.text
           OR reviews.avg_score     IS DISTINCT FROM EXCLUDED.avg_score
         THEN NOW()
         ELSE reviews.updated_at
       END
     RETURNING id,
               (xmax = 0) AS was_insert,
               (SELECT prev_response_text FROM prev),
               (SELECT prev_text FROM prev),
               (SELECT prev_avg_score FROM prev)`,
    [
      companyId,
      r.feedbackId,
      r.date ?? null,
      r.lastDeliveryDate ?? null,
      r.avgScore ?? null,
      r.scoreTaste ?? null,
      r.scoreAesthetics ?? null,
      r.scoreIngredientsQuality ?? null,
      r.scorePackaging ?? null,
      r.scoreVariety ?? null,
      r.scoreDelivery ?? null,
      r.orderDuration ?? null,
      r.verified ?? null,
      r.text ?? null,
      r.responseText ?? null,
      author,
    ]
  );

  const [row] = res.rows;
  if (row === undefined) {
    return { existed: false, touched: false };
  }
  const wasInsert = row.was_insert;
  const drifted = detectDrift(row, r);

  if (drifted) {
    await q(
      `INSERT INTO review_snapshots (review_id, response_text, avg_score, text)
       VALUES ($1,$2,$3,$4)`,
      [row.id, r.responseText ?? null, r.avgScore ?? null, r.text ?? null]
    );
  }

  return { existed: !wasInsert, touched: wasInsert || drifted };
};

export const scrapeReviews = async (companyId: string): Promise<void> => {
  const t0 = Date.now();
  let inserted = 0;
  let drifted = 0;
  let pagesFetched = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    let response: FeedbackResponse;
    try {
      response = await get<FeedbackResponse>(
        `/api/mobile/open/company-card/${companyId}/feedback?sort=DATE&page=${page}&pageSize=${PAGE_SIZE}`,
        { companyId }
      );
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        // Some caterings have no feedback endpoint at all.
        if (page === 0) {
          console.log(`[reviews] ${companyId}: no feedback endpoint, skipping`);
          return;
        }
        break;
      }
      await recordScrapeError(getCurrentRunId(), "reviews", {
        companyId,
        context: `feedback page=${page}`,
        error,
      });
      console.warn(`[reviews] ${companyId} p${page}: ${errMessage(error)}`);
      break;
    }
    pagesFetched += 1;

    // cf-fetch surfaces transport errors as undefined — treat as empty page
    // and break out (anything else is malformed and not worth retrying here).
    // oxlint-disable-next-line eqeqeq -- intentional == for null/undefined
    if (response == null) {
      break;
    }
    const results = response.results ?? [];
    if (results.length === 0) {
      break;
    }

    let pageHadNew = false;
    for (const r of results) {
      if (r.feedbackId == null) {
        continue;
      }
      const { touched, existed } = await upsertReview(companyId, r);
      if (touched) {
        if (existed) {
          drifted += 1;
        } else {
          inserted += 1;
        }
        pageHadNew = true;
      }
    }

    // Steady-state shortcut: if the page is entirely already-seen and un-
    // drifted, the tail behind it is too (DATE-sorted DESC). Stop.
    if (!pageHadNew) {
      break;
    }

    const totalPages = response.totalPages ?? page + 1;
    if (page + 1 >= totalPages) {
      break;
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[reviews] ✓ ${companyId}: ${inserted} new, ${drifted} drifted across ${pagesFetched} page(s) (${elapsed}s)`
  );
};
