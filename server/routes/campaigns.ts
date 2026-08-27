import { type Express, type Request, type Response } from "express";
import { storage } from "../storage";
import { db, pool } from "../db";
import { sql } from "drizzle-orm";
import { zeroDupSendGuardEnabled } from "../config/send-guard";
import { insertCampaignSchema, insertCampaignDraftSchema, updateCampaignDraftSchema, campaigns, campaignSegments, campaignJobs, errorLogs } from "@shared/schema";
import { extractBrand } from "@shared/brand";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { isMemoryPressure } from "../workers";
import { SNOWBALL_THROTTLE_CONFIG } from "../services/campaign-sender";
import { logger } from "../logger";
import { classifyDbError } from "../db-errors";
import { emitServiceBusy } from "../middleware/service-busy";
import { buildCampaignsListCacheKey, getCampaignsListCached, publishCampaignsListInvalidation } from "../repositories/campaigns-list-cache";
import { messageQueue } from "../message-queue";
import { withAdvisoryLock, LOCK_KEYS } from "../bootstrap-lock";
import { sanitizeCampaignHtml, generateBase62, mapWithConcurrency } from "../utils";
import { processHtmlImages, normalizeImageHostingDomain } from "../services/html-image-processor";
import {
  extractCampaignBrand,
  likePattern,
  resolveHistoricalBrand,
  suggestSegmentsFromRecentHistory,
  suggestTagsFromHistory,
} from "../services/tag-suggestions";
import { isCampaignNameUnaccentIndexReady } from "../repositories/campaign-repository";
import type { RateLimitRequestHandler } from "express-rate-limit";

// Brand-unsubscribe safeguard (Task #209). Two configurable thresholds gate the
// campaign wizard's Content -> Tracking step based on how many DISTINCT
// subscribers have unsubscribed from the subject's brand over a rolling window:
//   count <= warn            -> "ok"      (silent)
//   warn < count <= limit    -> "warn"    (non-blocking alert in the wizard)
//   count > limit            -> "blocked" (wizard refuses to advance)
// envInt allows an explicit "0" (unlike `parseInt(...) || default`) and rejects
// values below `min` / non-numeric input by falling back to the default.
function envInt(name: string, def: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : def;
}
const BRAND_UNSUB_LIMIT = envInt("BRAND_UNSUB_LIMIT", 2000, 0);
// Warn threshold can never exceed the hard limit (otherwise the warn tier would
// be unreachable); clamp defensively.
const BRAND_UNSUB_WARN_THRESHOLD = Math.min(envInt("BRAND_UNSUB_WARN_THRESHOLD", 1500, 0), BRAND_UNSUB_LIMIT);
const BRAND_UNSUB_WINDOW_DAYS = envInt("BRAND_UNSUB_WINDOW_DAYS", 10, 1);


// Bootstrap: add auto_retry_count column to campaigns if upgrading from older schema.
/**
 * Task #138 — install the FK on campaigns.exclude_segment_id under an
 * advisory lock so concurrent web/worker boots don't race on
 * ALTER TABLE ... ADD CONSTRAINT (which takes a brief AccessExclusive
 * lock on campaigns). Idempotent: skips if the constraint already exists.
 */
async function ensureCampaignExcludeSegmentForeignKey(): Promise<void> {
  try {
    const existing = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname = 'campaigns_exclude_segment_id_fkey'
       ) AS exists`,
    );
    if (existing.rows[0]?.exists) return;
  } catch (err: any) {
    logger.warn(`[CAMPAIGN_EXCLUDE_SEGMENT] FK existence probe failed: ${err?.message || err}`);
    return;
  }
  const result = await withAdvisoryLock(
    LOCK_KEYS.CAMPAIGN_EXCLUDE_SEGMENT,
    "CAMPAIGN_EXCLUDE_SEGMENT",
    async (lockClient) => {
      // Re-check under lock to keep the operation strictly idempotent.
      const recheck = await lockClient.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conname = 'campaigns_exclude_segment_id_fkey'
         ) AS exists`,
      );
      if (recheck.rows[0]?.exists) return;
      await lockClient.query(
        `ALTER TABLE campaigns
           ADD CONSTRAINT campaigns_exclude_segment_id_fkey
           FOREIGN KEY (exclude_segment_id) REFERENCES segments(id)
           ON DELETE SET NULL`,
      );
    },
  );
  if (result === "ran") {
    logger.info("[CAMPAIGN_EXCLUDE_SEGMENT] FK installed (ON DELETE SET NULL)");
  } else if (result === "skipped") {
    logger.info("[CAMPAIGN_EXCLUDE_SEGMENT] FK install skipped — another process is handling it");
  }
}

(async () => {
  try {
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS auto_retry_count integer NOT NULL DEFAULT 0`);
    // Cached engagement counters for fast /campaigns list rendering.
    // Maintained by server/tracking-buffer.ts (live txn-bumped) and
    // server/workers/counter-reconciler.ts (15-min reconciliation).
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS unique_opens_count  integer NOT NULL DEFAULT 0`);
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS total_opens_count   integer NOT NULL DEFAULT 0`);
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS unique_clicks_count integer NOT NULL DEFAULT 0`);
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS total_clicks_count  integer NOT NULL DEFAULT 0`);
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS unsubscribes_count  integer NOT NULL DEFAULT 0`);
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS complaints_count    integer NOT NULL DEFAULT 0`);
    // Auto-resend to openers (Task #56). All five columns are nullable / have
    // safe defaults so existing campaigns become "no follow-up" rows without
    // any data backfill required. See shared/schema.ts campaigns block for the
    // full design notes.
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS parent_campaign_id     varchar`);
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS follow_up_enabled      boolean NOT NULL DEFAULT false`);
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS follow_up_delay_hours  integer NOT NULL DEFAULT 36`);
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS follow_up_subject      text`);
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS follow_up_scheduled_at timestamp`);
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS follow_up_campaign_id  varchar`);
    // Exclusion segment (Task #138). Nullable; existing campaigns become
    // "no exclusion" without any backfill. The FK + ON DELETE SET NULL is
    // installed below under an advisory lock so that only one process
    // attempts the ALTER TABLE ... ADD CONSTRAINT (which takes a brief
    // AccessExclusive on campaigns) and so re-runs on existing
    // deployments are idempotent.
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS exclude_segment_id varchar`);
    // Snowball auto-throttle counter (Task #156). Lifetime tally of throttle
    // engagements per campaign — surfaced on the campaign detail page so
    // operators can see at a glance that the system has been auto-regulating
    // this campaign rather than silently stalling.
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS snowball_throttled_count integer NOT NULL DEFAULT 0`);
    await ensureCampaignExcludeSegmentForeignKey();
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS campaigns_parent_campaign_unique_idx
      ON campaigns (parent_campaign_id)
      WHERE parent_campaign_id IS NOT NULL
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS campaigns_follow_up_schedule_idx
      ON campaigns (follow_up_scheduled_at)
      WHERE follow_up_enabled = true
        AND follow_up_campaign_id IS NULL
        AND follow_up_scheduled_at IS NOT NULL
    `);
    // Self-FK on parent_campaign_id with ON DELETE RESTRICT — declared in
    // shared/schema.ts via `.references((): any => campaigns.id, {
    // onDelete: "restrict" })`. We do NOT add it here at runtime: ALTER
    // TABLE ADD CONSTRAINT FOREIGN KEY on a self-reference takes an
    // AccessExclusive lock and would wedge boot if any other session
    // touches campaigns. The schema declaration is the canonical contract
    // applied via `npm run db:push`; the application-level
    // FollowUpPendingError check in deleteCampaignWithFollowUpCleanup
    // enforces RESTRICT semantics in the meantime.
    // Step-by-step sending (Task #242).
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS step_send_limit      integer`);
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS step_processed_count integer NOT NULL DEFAULT 0`);
    await db.execute(sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS step_cursor_id       varchar(36)`);
    logger.info("[CAMPAIGNS] Bootstrap migration: auto_retry_count + cached engagement counters + auto-resend + step-send ready");
  } catch (err: any) {
    logger.error(`[CAMPAIGNS] Bootstrap migration FAILED: ${err?.message || err}`);
  }
})();

/**
 * Custom error thrown by the auto-resend (Task #56) delete guard when the
 * target campaign is a parent with a pending (scheduled / sending) follow-up
 * child. Per spec the user must cancel/delete the child first — blind
 * cascade would silently throw away a queued send.
 */
class FollowUpPendingError extends Error {
  constructor(public readonly childId: string, public readonly childStatus: string) {
    super(`Cannot delete campaign with a ${childStatus} follow-up (child ${childId})`);
    this.name = "FollowUpPendingError";
  }
}

/**
 * Auto-resend (Task #56) cleanup. Used by both the single-id and bulk DELETE
 * routes so they apply the SAME safety behavior:
 *   - If the target is a PARENT with a pending follow-up child (status =
 *     scheduled/sending/draft) we BLOCK the delete and surface a 409 to the
 *     UI. The user must cancel or delete the child first.
 *   - If the parent's child is already in a terminal state (completed/
 *     failed/cancelled) we cascade-delete it because there's nothing
 *     destructive to lose.
 *   - If the target is a CHILD, we clear the parent's follow_up_campaign_id
 *     pointer so the UI stops showing a broken link. parent.followUpEnabled
 *     is intentionally left alone — the spawner will re-spawn on the next
 *     poll if appropriate.
 */
const PENDING_CHILD_STATUSES = new Set(["draft", "scheduled", "sending", "paused"]);

// Cap on simultaneous delete transactions in the bulk route so a large
// selection can't open dozens of concurrent cascades and starve the
// connection pool against the live sender (Task #211). Override via env.
const BULK_DELETE_CONCURRENCY = envInt("CAMPAIGN_BULK_DELETE_CONCURRENCY", 4, 1);

async function deleteCampaignWithFollowUpCleanup(id: string): Promise<void> {
  const target = await storage.getCampaign(id);
  if (target?.followUpCampaignId) {
    const child = await storage.getCampaign(target.followUpCampaignId);
    if (child && PENDING_CHILD_STATUSES.has(child.status)) {
      throw new FollowUpPendingError(child.id, child.status);
    }
    if (child) {
      await storage.deleteCampaign(child.id).catch((err: any) =>
        logger.warn(`[CAMPAIGN_DELETE] Cascade child delete failed: ${err?.message || err}`),
      );
    }
  }
  if (target?.parentCampaignId) {
    // Sticky cancel: also disable follow_up_enabled on the parent so the
    // spawner does not immediately recreate the child on its next poll
    // (the candidate predicate is enabled=true AND child_id IS NULL).
    await db.execute(sql`
      UPDATE campaigns
      SET follow_up_campaign_id = NULL,
          follow_up_enabled = false,
          follow_up_scheduled_at = NULL
      WHERE id = ${target.parentCampaignId}
    `).catch((err: any) =>
      logger.warn(`[CAMPAIGN_DELETE] Parent unlink failed: ${err?.message || err}`),
    );
  }
  await storage.deleteCampaign(id);
}

export function registerCampaignRoutes(app: Express, helpers: {
  parsePagination: (query: any) => { page: number; limit: number };
  validateId: (id: string) => boolean;
  sanitizeCampaignHtml: (html: string) => string;
}, campaignLimiter: RateLimitRequestHandler) {
  const { validateId } = helpers;

  app.post("/api/campaigns/test", async (req: Request, res: Response) => {
    try {
      const {
        email,
        mtaId,
        fromName,
        fromEmail,
        subject,
        preheader,
        htmlContent,
        companyAddress,
        unsubscribeText,
        trackOpens,
        trackClicks,
        // Task #185 opt-in: when true the test send is funneled through
        // `prepareTrackedHtml` so the preview includes the open pixel and
        // rewritten click URLs the real recipient would receive. Default
        // false keeps the legacy "preview only — no tracking" behaviour
        // so developer test sends don't pollute analytics. Requires a
        // saved `campaignId` + a real `subscriberId` because tracking
        // events insert into `campaign_stats` with NOT NULL FKs.
        trackInTest,
        campaignId,
        subscriberId,
      } = req.body;

      if (!email || !fromEmail || !subject || !htmlContent) {
        return res.status(400).json({ error: "Missing required fields (email, fromEmail, subject, htmlContent)" });
      }

      let mta = null;
      if (mtaId) {
        mta = await storage.getMta(mtaId);
      }

      const headers: Record<string, string> = {
        "X-Test-Email": "true",
      };

      const defaultHeaders = await storage.getDefaultHeaders();
      const trackingDomain = mta?.trackingDomain || undefined;
      const rawTrackingDomain = trackingDomain || "";
      const normalizedDomain = rawTrackingDomain
        ? (/^https?:\/\//i.test(rawTrackingDomain) ? rawTrackingDomain : `https://${rawTrackingDomain}`).replace(/\/$/, "")
        : "";
      const testUnsubscribeUrl = normalizedDomain
        ? `${normalizedDomain}/api/unsubscribe/test-campaign/test-subscriber`
        : "#unsubscribe-placeholder";

      for (const header of defaultHeaders) {
        const resolvedValue = header.value.replace(/\{UNSUBSCRIBE\}/gi, testUnsubscribeUrl);
        headers[header.name] = resolvedValue;
      }

      // Build the optional tracking context. Requires resolvable
      // campaign+subscriber rows for downstream FK satisfaction. If the
      // caller didn't provide a subscriberId, fall back to looking up
      // the recipient email in the subscribers table — convenient for
      // the wizard UI where a developer just types their own address.
      let trackingContext: import("../email-service").TestEmailTrackingContext | undefined;
      if (trackInTest) {
        if (!campaignId) {
          return res.status(400).json({
            error: "trackInTest requires a saved campaignId so tracking events satisfy the campaign_stats FK constraint.",
          });
        }
        const campaignRow = await storage.getCampaign(campaignId);
        let subRow = subscriberId ? await storage.getSubscriber(subscriberId) : undefined;
        if (!subRow) {
          subRow = await storage.getSubscriberByEmail(email);
        }
        if (!campaignRow || !subRow) {
          return res.status(404).json({
            error: "Cannot enable trackInTest: campaignId not found, or the test recipient's email is not a known subscriber (tracking events require valid FKs).",
          });
        }
        trackingContext = {
          campaign: {
            ...campaignRow,
            // Use the request-body HTML/subject/etc so the preview reflects
            // unsaved edits the user is iterating on in the wizard.
            htmlContent,
            subject,
            preheader: preheader ?? campaignRow.preheader,
            unsubscribeText: unsubscribeText ?? campaignRow.unsubscribeText,
            companyAddress: companyAddress ?? campaignRow.companyAddress,
          },
          subscriber: subRow,
          tracking: {
            trackOpens: trackOpens !== false,
            trackClicks: trackClicks !== false,
            trackingDomain: trackingDomain,
            openTrackingDomain: mta?.openTrackingDomain || undefined,
            openTag: campaignRow.openTag || undefined,
            clickTag: campaignRow.clickTag || undefined,
          },
        };
      }

      if (mta) {
        logger.info(`[TEST EMAIL] Sending via MTA SMTP (${mta.name}) to: ${email}${trackingContext ? " [tracked]" : ""}`);
        const { sendTestEmailViaSMTP } = await import("../email-service");

        const result = await sendTestEmailViaSMTP(
          mta,
          {
            to: email,
            fromName: fromName || "Test",
            fromEmail,
            subject,
            htmlContent,
            preheader,
            companyAddress,
            unsubscribeText,
            trackingDomain,
            headers,
          },
          trackingContext,
        );

        if (result.success) {
          res.json({ success: true, messageId: result.messageId, tracked: !!trackingContext });
        } else {
          res.status(500).json({ error: result.error || "Failed to send test email via SMTP" });
        }
        return;
      }

      logger.info(`[TEST EMAIL] No MTA selected, using Resend API to: ${email}${trackingContext ? " [tracked]" : ""}`);
      const { sendTestEmailViaResend } = await import("../resend-client");

      const result = await sendTestEmailViaResend(
        {
          to: email,
          fromName: fromName || "Test",
          fromEmail,
          subject,
          htmlContent,
          preheader,
          companyAddress,
          unsubscribeText,
          trackingDomain,
          headers,
        },
        trackingContext,
      );
      
      if (result.success) {
        // Normalize the response shape with the SMTP branch above so the
        // UI can reliably show a "tracked" indicator regardless of which
        // transport actually delivered the test send.
        res.json({ success: true, messageId: result.messageId, tracked: !!trackingContext });
      } else {
        res.status(500).json({ error: result.error || "Failed to send test email" });
      }
    } catch (error: any) {
      logger.error("Error sending test email:", error);
      res.status(500).json({ error: "Failed to send test email" });
    }
  });
  
  app.get("/api/campaigns", async (req: Request, res: Response) => {
    try {
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
      const search = (req.query.search as string)?.trim() || undefined;
      const originalsOnly = req.query.originalsOnly === "true";

      // Task #188: optional scheduled-date filter (Today / Yesterday / Custom).
      // Both bounds are ISO timestamps; the frontend computes them from the
      // browser's local clock when a preset is picked. Invalid timestamps are
      // dropped (treated as if the bound were absent) rather than 400-ing so
      // a stale URL never blocks the list from rendering. Bounds are inclusive
      // start / exclusive end (matches the [from, to) convention).
      const parseBound = (v: unknown): Date | undefined => {
        if (typeof v !== "string" || !v) return undefined;
        const d = new Date(v);
        return Number.isFinite(d.getTime()) ? d : undefined;
      };
      const scheduledFrom = parseBound(req.query.scheduledFrom);
      const scheduledTo = parseBound(req.query.scheduledTo);

      // Task #199: serve from a short in-process cache (default 3 min,
      // CAMPAIGNS_LIST_CACHE_TTL_MS) to stop this heavy read (count + join +
      // aggregate over campaign_sends) from saturating the web DB pool and
      // tripping the 503 load-shed. The cache is invalidated cross-process on
      // every campaign state transition; live counters keep flowing via SSE.
      // `?refresh=true` bypasses the cache for a forced re-read.
      const forceRefresh = req.query.refresh === "true" || req.query.refresh === "1";
      const cacheKey = buildCampaignsListCacheKey({ page, limit, search, originalsOnly, scheduledFrom, scheduledTo });
      const payload = await getCampaignsListCached(
        cacheKey,
        async () => {
          const result = await storage.getCampaignsPaginated({ page, limit, search, originalsOnly, scheduledFrom, scheduledTo });
          return {
            campaigns: result.campaigns,
            total: result.total,
            page,
            totalPages: Math.ceil(result.total / limit),
          };
        },
        forceRefresh,
      );
      res.json(payload);
    } catch (error) {
      const classified = classifyDbError(error);
      if (classified.transient) {
        // Task #148: every transient 503 now flows through emitServiceBusy
        // → structured log + per-source counter + ring buffer entry. The
        // helper coalesces bursts so a sustained DB outage doesn't spam
        // the logs (replaces the prior 60s manual throttle).
        emitServiceBusy(req, res, {
          source: "handler_transient",
          kind: classified.kind,
          code: classified.code,
          errorMessage: classified.message,
        });
        return;
      }
      logger.error("Error fetching campaigns:", error);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to fetch campaigns",
      });
    }
  });

  type LowOpenAlertPayload = { campaigns: Awaited<ReturnType<typeof storage.getRecentLowOpenCampaignAlerts>> };
  const LOW_OPEN_ALERT_CACHE_TTL_MS = 60_000;
  let lowOpenAlertCache: { ts: number; data: LowOpenAlertPayload } | null = null;
  let lowOpenAlertInflight: Promise<LowOpenAlertPayload> | null = null;

  app.get("/api/campaigns/low-open-alerts", async (req: Request, res: Response) => {
    try {
      const now = Date.now();
      if (lowOpenAlertCache && now - lowOpenAlertCache.ts < LOW_OPEN_ALERT_CACHE_TTL_MS) {
        return res.json(lowOpenAlertCache.data);
      }
      if (!lowOpenAlertInflight) {
        lowOpenAlertInflight = storage.getRecentLowOpenCampaignAlerts()
          .then((campaigns) => {
            const data = { campaigns };
            lowOpenAlertCache = { ts: Date.now(), data };
            return data;
          })
          .finally(() => {
            lowOpenAlertInflight = null;
          });
      }
      res.json(await lowOpenAlertInflight);
    } catch (error) {
      const classified = classifyDbError(error);
      if (classified.transient) {
        emitServiceBusy(req, res, {
          source: "handler_transient",
          kind: classified.kind,
          code: classified.code,
          errorMessage: classified.message,
        });
        return;
      }
      logger.error("Error fetching low-open campaign alerts:", error);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to fetch low-open campaign alerts",
      });
    }
  });

  // Phase-1 perf fix (audit 2026-05-26): 5s in-memory cache. /api/campaigns/stats
  // is polled in parallel with /api/campaigns on every page render, but it
  // scans ALL rows in `campaigns` to build the global stats map. The data
  // moves slowly (cached counters updated by the tracking-buffer flush
  // every few seconds), so a 5s TTL is invisible to users and cuts DB
  // hits to this endpoint by ~90% under multi-tab / multi-user load —
  // the main cause of pool-saturation 503s on /campaigns.
  type StatsMap = Record<string, { opens: number; clicks: number; unsubscribes: number; complaints: number }>;
  const STATS_CACHE_TTL_MS = 5_000;
  let statsCache: { ts: number; data: StatsMap } | null = null;
  let statsInflight: Promise<StatsMap> | null = null;

  async function loadCampaignStats(): Promise<StatsMap> {
    const result = await pool.query(`
      SELECT id,
             unique_opens_count,
             unique_clicks_count,
             unsubscribes_count,
             complaints_count
        FROM campaigns
    `);
    const out: StatsMap = {};
    for (const row of result.rows as Array<{
      id: string;
      unique_opens_count: number | string;
      unique_clicks_count: number | string;
      unsubscribes_count: number | string;
      complaints_count: number | string;
    }>) {
      out[row.id] = {
        opens: Number(row.unique_opens_count) || 0,
        clicks: Number(row.unique_clicks_count) || 0,
        unsubscribes: Number(row.unsubscribes_count) || 0,
        complaints: Number(row.complaints_count) || 0,
      };
    }
    return out;
  }

  app.get("/api/campaigns/stats", async (_req: Request, res: Response) => {
    try {
      const now = Date.now();
      if (statsCache && now - statsCache.ts < STATS_CACHE_TTL_MS) {
        return res.json(statsCache.data);
      }
      // Coalesce concurrent misses onto a single DB query so a thundering
      // herd of polls at cache-expiry doesn't fan out to N parallel scans.
      if (!statsInflight) {
        statsInflight = loadCampaignStats()
          .then((data) => {
            statsCache = { ts: Date.now(), data };
            return data;
          })
          .finally(() => {
            statsInflight = null;
          });
      }
      const data = await statsInflight;
      res.json(data);
    } catch (error) {
      logger.error("Error fetching campaign stats:", error);
      res.status(500).json({ error: "Failed to fetch campaign stats" });
    }
  });

  // Tag suggestions (Tasks #237 / #245). Given a campaign name, finds every
  // historical campaign with the same exact brand signature and returns the
  // most frequent open/click/unsubscribe tags across ALL MTAs. The MTA is
  // deliberately neither selected nor filtered here.
  //
  // The indexed ILIKE clauses only pre-filter candidates. Pure, unit-tested
  // logic then rejects partial-token and multi-brand false positives.
  // No response cache is used: an explicit operator click always sees the
  // latest complete history.
  app.get("/api/campaigns/tag-suggestions", async (req: Request, res: Response) => {
    try {
      const name = typeof req.query.name === "string" ? req.query.name.trim() : "";
      if (!name) {
        return res.status(400).json({ error: "name query parameter required" });
      }
      const excludeId = typeof req.query.excludeId === "string" ? req.query.excludeId : null;
      const brand = extractCampaignBrand(name);
      if (!brand) {
        return res.json({ brand: null, matches: 0, suggestions: null });
      }

      // f_unaccent(name) has a dedicated trigram GIN index (provisioned by
      // ensureCampaignNameUnaccentTrigramIndex at boot, CONCURRENTLY, under
      // an advisory lock); fallback plain `name` uses campaign_name_trgm_idx.
      const nameExpr = isCampaignNameUnaccentIndexReady() ? "f_unaccent(name)" : "name";
      // LIKE wildcards in tokens are escaped; values are parameterized. The
      // dynamic SQL fragments only interpolate server-generated indexes.
      // Query by the first token only. Text may follow the actual brand before
      // the first dash ("Kiabi 20-30/08 Critads"), so requiring every request
      // token here would hide the historical "#... Kiabi - ..." anchor.
      // Exact prefix resolution below prevents this wider indexed candidate
      // query from mixing brands that merely share their first word.
      const params: any[] = [likePattern(brand.tokens[0])];
      let excludeClause = "";
      if (excludeId) {
        params.push(excludeId);
        excludeClause = ` AND id != $${params.length}`;
      }

      // No MTA predicate and no LIMIT: every historical row for this brand is
      // considered, regardless of which delivery infrastructure sent it.
      const result = await pool.query(
        `SELECT name, open_tag, click_tag, unsubscribe_tag
           FROM campaigns
          WHERE ${nameExpr} ILIKE $1${excludeClause}
          ORDER BY created_at DESC`,
        params,
      );
      const resolvedBrand = resolveHistoricalBrand(brand, result.rows);
      if (!resolvedBrand) {
        return res.json({ brand: null, matches: 0, suggestions: null });
      }
      const suggestion = suggestTagsFromHistory(resolvedBrand, result.rows);
      res.json({ brand: resolvedBrand.label, ...suggestion });
    } catch (error) {
      logger.error("Error computing tag suggestions:", error);
      res.status(500).json({ error: "Failed to compute tag suggestions" });
    }
  });

  // Segment suggestions use the same strict brand resolver as tag suggestions,
  // then rank the segments used by only the ten most recently sent campaigns.
  // The client presents these as optional buttons; this route never selects a
  // segment or changes a campaign on its own.
  app.get("/api/campaigns/segment-suggestions", async (req: Request, res: Response) => {
    try {
      const name = typeof req.query.name === "string" ? req.query.name.trim() : "";
      if (!name) {
        return res.status(400).json({ error: "name query parameter required" });
      }
      const requestedBrand = extractCampaignBrand(name);
      if (!requestedBrand) {
        return res.json({ brand: null, campaignsConsidered: 0, suggestions: [] });
      }

      const excludeId = typeof req.query.excludeId === "string" ? req.query.excludeId : null;
      const candidates = await storage.getSegmentPerformanceHistoryCandidates(
        likePattern(requestedBrand.tokens[0]),
        excludeId,
      );
      const resolvedBrand = resolveHistoricalBrand(requestedBrand, candidates);
      if (!resolvedBrand) {
        return res.json({ brand: null, campaignsConsidered: 0, suggestions: [] });
      }

      const result = suggestSegmentsFromRecentHistory(resolvedBrand, candidates);
      res.json({ brand: resolvedBrand.label, ...result });
    } catch (error) {
      const classified = classifyDbError(error);
      if (classified.transient) {
        emitServiceBusy(req, res, {
          source: "handler_transient",
          kind: classified.kind,
          code: classified.code,
          errorMessage: classified.message,
        });
        return;
      }
      logger.error("Error computing segment suggestions:", error);
      res.status(500).json({ error: "Failed to compute segment suggestions" });
    }
  });

  // Brand-unsubscribe safeguard (Task #209). Authenticated read used by the
  // campaign wizard before advancing from Content (step 3) to Tracking (step 4).
  // MUST be registered BEFORE "/api/campaigns/:id" so the literal path isn't
  // captured as an :id. Fail-open is the client's job: a 500 here lets the
  // wizard advance rather than trapping the operator.
  app.get("/api/campaigns/brand-unsub-check", async (req: Request, res: Response) => {
    try {
      const subject = typeof req.query.subject === "string" ? req.query.subject : "";
      const brand = extractBrand(subject);
      const base = {
        warnThreshold: BRAND_UNSUB_WARN_THRESHOLD,
        limit: BRAND_UNSUB_LIMIT,
        windowDays: BRAND_UNSUB_WINDOW_DAYS,
      };
      if (!brand) {
        return res.json({ brand: null, count: 0, status: "ok", ...base });
      }
      const count = await storage.countBrandUnsubscribes(brand, BRAND_UNSUB_WINDOW_DAYS);
      const status =
        count > BRAND_UNSUB_LIMIT ? "blocked" : count > BRAND_UNSUB_WARN_THRESHOLD ? "warn" : "ok";
      res.json({ brand, count, status, ...base });
    } catch (error) {
      logger.error("Error checking brand unsubscribes:", error);
      res.status(500).json({ error: "Failed to check brand unsubscribes" });
    }
  });

  app.get("/api/campaigns/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const campaign = await storage.getCampaign(req.params.id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      res.json(campaign);
    } catch (error) {
      logger.error("Error fetching campaign:", error);
      res.status(500).json({ error: "Failed to fetch campaign" });
    }
  });

  // Snowball auto-throttle status (Task #156). Returns the live deferred/
  // processed ratio for this campaign + the configured threshold + lifetime
  // throttle engagements, so the campaign detail page can surface a clear
  // "Auto-throttled by pressure guard" banner instead of leaving the
  // engagement invisible (logs / Prometheus only).
  app.get("/api/campaigns/:id/snowball-status", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const campaignId = req.params.id;
      // Same query the sender uses to make the throttle decision, so the
      // UI shows the exact value the engine is reading. Cheap: hits the
      // per-campaign partial index on campaign_sends + a single PK lookup
      // on campaigns for the cached counters.
      const r = await db.execute(sql`
        SELECT
          (SELECT COUNT(*)::bigint
             FROM campaign_sends
             WHERE campaign_id = ${campaignId}
               AND status = 'pending'
               AND eligible_at IS NOT NULL) AS deferred,
          (SELECT COALESCE(sent_count, 0) + COALESCE(failed_count, 0)
             FROM campaigns WHERE id = ${campaignId}) AS processed,
          (SELECT COALESCE(snowball_throttled_count, 0)
             FROM campaigns WHERE id = ${campaignId}) AS throttled_count,
          (SELECT 1 FROM campaigns WHERE id = ${campaignId}) AS exists_flag
      `);
      const row = r.rows[0] as { deferred?: string | number; processed?: string | number; throttled_count?: string | number; exists_flag?: number | null } | undefined;
      if (!row || row.exists_flag == null) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      const deferred = Number(row.deferred ?? 0);
      const processed = Number(row.processed ?? 0);
      const throttledCount = Number(row.throttled_count ?? 0);
      const denom = deferred + processed;
      const ratio = denom > 0 ? deferred / denom : 0;
      const { disabled, threshold, minDeferred, sleepMs } = SNOWBALL_THROTTLE_CONFIG;
      const isThrottling = !disabled && deferred >= minDeferred && ratio > threshold;
      res.json({
        deferred,
        processed,
        ratio,
        threshold,
        minDeferred,
        sleepMs,
        disabled,
        throttledCount,
        isThrottling,
      });
    } catch (error: any) {
      logger.error(`[SNOWBALL_STATUS] failed for ${req.params.id}: ${error?.message || error}`);
      res.status(500).json({ error: "Failed to fetch snowball status" });
    }
  });

  app.post("/api/campaign-assets/session", async (_req: Request, res: Response) => {
    const sessionId = `draft-${generateBase62(12)}`;
    res.json({ sessionId });
  });

  app.post("/api/campaigns/:id/process-html", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const campaignId = req.params.id;
      const { html, mtaId: bodyMtaId } = req.body;
      
      if (!html || typeof html !== "string") {
        return res.status(400).json({ error: "HTML content is required" });
      }
      
      const validIdPattern = /^[a-zA-Z0-9_-]+$/;
      if (!validIdPattern.test(campaignId) || campaignId.length > 100) {
        return res.status(400).json({ error: "Invalid campaign ID format" });
      }
      
      // Resolve image hosting domain: prefer mtaId from request body (current form selection),
      // fall back to the saved campaign's MTA, then fall back to the request's own origin
      // so images are always stored with absolute URLs even when no domain is configured on the MTA.
      let imageHostingDomain: string | null = null;
      const campaign = await storage.getCampaign(campaignId);
      const effectiveMtaId = bodyMtaId || campaign?.mtaId;
      if (effectiveMtaId) {
        const mta = await storage.getMta(effectiveMtaId);
        imageHostingDomain = normalizeImageHostingDomain(mta?.imageHostingDomain);
      }
      // Fallback: derive absolute origin from the incoming request so images are never
      // stored as relative paths — relative paths break email clients and iframe previews.
      if (!imageHostingDomain) {
        const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0].trim() || req.protocol || "https";
        const host = req.headers["x-forwarded-host"] as string | undefined || req.headers.host;
        if (host) {
          imageHostingDomain = `${proto}://${host}`;
        }
      }

      const useSSE = (req.headers.accept || "").includes("text/event-stream");
      let clientDisconnected = false;
      if (useSSE) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        req.on("close", () => { clientDisconnected = true; });
      }

      const processedResult = await processHtmlImages({
        html,
        campaignId,
        imageHostingDomain,
        createdAt: campaign?.createdAt ?? null,
        isCancelled: () => clientDisconnected,
        onProgress: (processed, total) => {
          if (useSSE && !clientDisconnected) {
            res.write(`event: progress\ndata: ${JSON.stringify({ processed, total })}\n\n`);
          }
        },
      });

      const result = {
        html: processedResult.html,
        downloaded: processedResult.downloaded,
        failed: processedResult.failed,
        failedUrls: processedResult.failedUrls,
      };

      if (useSSE) {
        res.write(`event: result\ndata: ${JSON.stringify(result)}\n\n`);
        res.end();
      } else {
        res.json(result);
      }
    } catch (error) {
      logger.error("Error processing HTML:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (res.headersSent) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: errorMessage })}\n\n`);
        res.end();
      } else {
        res.status(500).json({ error: `Failed to process HTML content: ${errorMessage}` });
      }
    }
  });

  app.post("/api/campaigns", campaignLimiter, async (req: Request, res: Response) => {
    try {
      logger.info("POST /api/campaigns - Body:", JSON.stringify(req.body));

      const isDraft = req.body.status === "draft" || !req.body.status;

      const requestedSegmentIds = req.body.segmentIds === undefined
        ? (req.body.segmentId ? [req.body.segmentId] : [])
        : req.body.segmentIds;
      if (!Array.isArray(requestedSegmentIds) ||
          requestedSegmentIds.some((id) => typeof id !== "string" || !id.trim()) ||
          new Set(requestedSegmentIds).size !== requestedSegmentIds.length) {
        return res.status(400).json({ error: "segmentIds must be a unique non-empty list" });
      }
      if (!isDraft && requestedSegmentIds.length === 0) {
        return res.status(400).json({ error: "At least one audience segment is required" });
      }
      const normalizedBody = {
        ...req.body,
        ...(requestedSegmentIds.length ? { segmentIds: requestedSegmentIds } : {}),
        mtaId: req.body.mtaId || null,
        segmentId: requestedSegmentIds[0] ?? null,
        excludeSegmentId: req.body.excludeSegmentId || null,
        replyEmail: req.body.replyEmail || null,
      };

      // Task #138: an exclusion segment that matches the include segment
      // would yield an always-empty audience. Reject up front so the user
      // gets a clear error instead of a silent 0-recipient send.
      if (
        normalizedBody.excludeSegmentId && requestedSegmentIds.includes(normalizedBody.excludeSegmentId)
      ) {
        return res.status(400).json({ error: "Exclusion segment cannot be the same as the audience segment" });
      }
      // Task #138 + #148: explicit existence check on both segment refs.
      // Coalesced into a single `WHERE id = ANY(...)` round-trip (1 pool
      // checkout instead of 2) so this route stays under the per-request
      // lease cap when followed by the campaign-insert transaction.
       const segIds = [...requestedSegmentIds, normalizedBody.excludeSegmentId].filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      );
      if (segIds.length > 0) {
        const found = await storage.getSegmentsByIds(segIds);
        const foundSet = new Set(found.map((s) => s.id));
         if (requestedSegmentIds.some((id: string) => !foundSet.has(id))) {
          return res.status(400).json({ error: "Audience segment does not exist" });
        }
        if (normalizedBody.excludeSegmentId && !foundSet.has(normalizedBody.excludeSegmentId)) {
          return res.status(400).json({ error: "Exclusion segment does not exist" });
        }
      }

      let data: any;
      if (isDraft) {
         data = insertCampaignDraftSchema.parse(normalizedBody);
        if (!data.subject) data.subject = "(Draft)";
        if (!data.htmlContent) data.htmlContent = "";
        if (!data.fromName) data.fromName = "";
        if (!data.fromEmail) data.fromEmail = "";
      } else {
        data = insertCampaignSchema.parse(normalizedBody);
      }

      if (data.htmlContent && data.htmlContent !== "") {
        data.htmlContent = sanitizeCampaignHtml(data.htmlContent);
      }
      delete data.segmentIds;
       const campaign = await db.transaction(async (tx) => {
        const [created] = await tx.insert(campaigns).values(data).returning();
         if (requestedSegmentIds.length) {
           await tx.insert(campaignSegments).values(requestedSegmentIds.map((segmentId: string, position: number) => ({
             campaignId: created.id, segmentId, position,
           })));
         }
        if (created.status === "sending") {
          await tx.insert(campaignJobs).values({
            campaignId: created.id,
            status: "pending",
          });
        }
        return created;
      });

      logger.info("Campaign created successfully:", campaign.id);

       res.status(201).json({ ...campaign, segmentIds: requestedSegmentIds });
    } catch (error) {
      if (error instanceof z.ZodError) {
        logger.error("Campaign validation error:", error.errors);
        return res.status(400).json({ error: error.errors });
      }
      logger.error("Error creating campaign:", error);
      res.status(500).json({ error: "Failed to create campaign" });
    }
  });

  app.patch("/api/campaigns/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      logger.info(`PATCH /api/campaigns/${req.params.id} - Body:`, JSON.stringify(req.body));

      const existingCampaign = await storage.getCampaign(req.params.id);
      if (!existingCampaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      logger.info(`Campaign ${req.params.id} current status: ${existingCampaign.status}, new status: ${req.body.status || 'unchanged'}`);

      const isDraft = existingCampaign.status === "draft";

      let normalizedBody: Record<string, any>;
      if (isDraft) {
        const parsed = updateCampaignDraftSchema.parse(req.body);
        normalizedBody = { ...parsed };
      } else {
        normalizedBody = { ...req.body };
        // urgent_mode is reserved for the dedicated POST /urgent endpoint
        // (which performs the accompanying NULL/flush/audit work in one
        // transaction). Stripping it here prevents callers from flipping
        // the CAS bypass via a generic PATCH and skipping the audit trail
        // + held-row flush. To clear urgent mode on an active campaign,
        // /end is the supported path (it sets urgentMode=false as part
        // of the terminal transaction).
        delete normalizedBody.urgentMode;
        delete normalizedBody.urgent_mode;
        if ('mtaId' in normalizedBody && !normalizedBody.mtaId) {
          normalizedBody.mtaId = null;
        }
        if ('segmentId' in normalizedBody && !normalizedBody.segmentId) {
          normalizedBody.segmentId = null;
        }
        if ('excludeSegmentId' in normalizedBody && !normalizedBody.excludeSegmentId) {
          normalizedBody.excludeSegmentId = null;
        }
        if ('replyEmail' in normalizedBody && !normalizedBody.replyEmail) {
          normalizedBody.replyEmail = null;
        }
        // Auto-resend (Task #56): even on non-draft PATCH we must enforce
        // the same constraints we'd enforce on insert/draft. Without this
        // guard a client could PATCH followUpDelayHours=99999 or
        // followUpSubject=<10 KB blob> on a scheduled/sending campaign and
        // bypass the wizard validation. We only validate the follow-up
        // subset (everything else on a non-draft is intentionally trusted).
        const nonDraftPatchSchema = z.object({
          followUpEnabled: z.boolean().optional(),
          followUpDelayHours: z.coerce.number().int().min(1).max(168).optional(),
          followUpSubject: z.preprocess((v) => (v === "" ? null : v), z.string().max(998).nullable().optional()),
          // Step-by-step sending (Task #242): same min(1) guard as the draft
          // and create paths — rejects zero/negative values on any PATCH so
          // the sender can never receive an invalid limit regardless of status.
          stepSendLimit: z.preprocess(
            (v) => (v === "" || v === null || v === undefined ? null : v),
            z.coerce.number().int().min(1, "Step send limit must be at least 1").nullable().optional()
          ),
        });
        const fu = nonDraftPatchSchema.parse({
          followUpEnabled: normalizedBody.followUpEnabled,
          followUpDelayHours: normalizedBody.followUpDelayHours,
          followUpSubject: normalizedBody.followUpSubject,
          stepSendLimit: 'stepSendLimit' in normalizedBody ? normalizedBody.stepSendLimit : undefined,
        });
        if (fu.followUpEnabled !== undefined) normalizedBody.followUpEnabled = fu.followUpEnabled;
        if (fu.followUpDelayHours !== undefined) normalizedBody.followUpDelayHours = fu.followUpDelayHours;
        if (fu.followUpSubject !== undefined) normalizedBody.followUpSubject = fu.followUpSubject;
        if ('stepSendLimit' in normalizedBody) normalizedBody.stepSendLimit = fu.stepSendLimit ?? null;
      }

      if (normalizedBody.scheduledAt && typeof normalizedBody.scheduledAt === 'string') {
        normalizedBody.scheduledAt = new Date(normalizedBody.scheduledAt);
      }

      if (normalizedBody.htmlContent && normalizedBody.htmlContent !== "") {
        normalizedBody.htmlContent = sanitizeCampaignHtml(normalizedBody.htmlContent);
      }

      // segmentIds is canonical when supplied; legacy segmentId updates retain
      // their one-segment behavior. Always mirror the first selection into the
      // legacy column for integrations that still read it.
      const requestedSegmentIds = "segmentIds" in normalizedBody
        ? normalizedBody.segmentIds
        : ("segmentId" in normalizedBody ? (normalizedBody.segmentId ? [normalizedBody.segmentId] : []) : undefined);
      const effectiveStatus = normalizedBody.status ?? existingCampaign.status;
      if (requestedSegmentIds !== undefined) {
        if (!Array.isArray(requestedSegmentIds) ||
            requestedSegmentIds.some((id) => typeof id !== "string" || !id.trim()) ||
            new Set(requestedSegmentIds).size !== requestedSegmentIds.length) {
          return res.status(400).json({ error: "segmentIds must be a unique non-empty list" });
        }
        normalizedBody.segmentId = requestedSegmentIds[0] ?? null;
      }
      // Task #138: enforce self-exclusion against the EFFECTIVE values
      // (incoming PATCH merged onto the existing row). Without merging we'd
      // miss the case where the include id is updated and the existing
      // exclude id silently becomes invalid.
      const effectiveSegmentIds = requestedSegmentIds ?? ((existingCampaign as any).segmentIds ?? (existingCampaign.segmentId ? [existingCampaign.segmentId] : []));
      if (effectiveStatus !== "draft" && effectiveSegmentIds.length === 0) {
        return res.status(400).json({ error: "At least one audience segment is required" });
      }
      const effectiveExcludeId = ('excludeSegmentId' in normalizedBody ? normalizedBody.excludeSegmentId : existingCampaign.excludeSegmentId) ?? null;
       if (effectiveExcludeId && effectiveSegmentIds.includes(effectiveExcludeId)) {
        return res.status(400).json({ error: "Exclusion segment cannot be the same as the audience segment" });
      }
      // Task #138: existence check on whichever segment refs are being
      // changed in this PATCH. We only probe the fields the client sent
      // to avoid an extra DB round-trip on unrelated edits.
       const idsToValidate = [...(requestedSegmentIds ?? []), ...(effectiveExcludeId ? [effectiveExcludeId] : [])];
       if (idsToValidate.length) {
         const found = await storage.getSegmentsByIds(idsToValidate);
         const foundIds = new Set(found.map((segment) => segment.id));
         if ((requestedSegmentIds ?? []).some((id: string) => !foundIds.has(id))) {
           return res.status(400).json({ error: "Audience segment does not exist" });
         }
         if (effectiveExcludeId && !foundIds.has(effectiveExcludeId)) {
           return res.status(400).json({ error: "Exclusion segment does not exist" });
         }
      }

      const campaign = await db.transaction(async (tx) => {
         delete normalizedBody.segmentIds;
        const [updated] = await tx.update(campaigns).set(normalizedBody).where(sql`${campaigns.id} = ${req.params.id}`).returning();
        if (!updated) return null;
         if (requestedSegmentIds !== undefined) {
           await tx.delete(campaignSegments).where(eq(campaignSegments.campaignId, updated.id));
            if (requestedSegmentIds.length) {
              await tx.insert(campaignSegments).values(requestedSegmentIds.map((segmentId: string, position: number) => ({
                campaignId: updated.id, segmentId, position,
              })));
            }
         }
        if (existingCampaign.status !== "sending" && updated.status === "sending") {
          logger.info(`Starting campaign ${updated.id} via PATCH - queueing for processing`);
          await tx.insert(campaignJobs).values({
            campaignId: updated.id,
            status: "pending",
          });
        }
        return updated;
      });
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
       // Task #199: PATCH edits list-visible fields (name/status/schedule/…) via
      // raw tx — invalidate the list cache so the edit shows immediately.
      publishCampaignsListInvalidation();

      if (existingCampaign.status !== "sending" && campaign.status === "sending") {
        await messageQueue.notify("campaign_jobs", { campaignId: req.params.id });
        logger.info(`[CAMPAIGN_SEND] NOTIFY sent for campaign ${req.params.id}`);
      }

       res.json({ ...campaign, segmentIds: requestedSegmentIds ?? (existingCampaign as any).segmentIds ?? (campaign.segmentId ? [campaign.segmentId] : []) });
    } catch (error) {
      if (error instanceof z.ZodError) {
        logger.error("Campaign PATCH validation error:", error.errors);
        return res.status(400).json({ error: error.errors });
      }
      logger.error("Error updating campaign:", error);
      res.status(500).json({ error: "Failed to update campaign" });
    }
  });

  app.delete("/api/campaigns/bulk", async (req: Request, res: Response) => {
    try {
      const schema = z.object({ ids: z.array(z.string()).min(1).max(200) });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "ids must be a non-empty array (max 200)" });
      }
      const { ids } = parsed.data;
      if (ids.some((id) => !validateId(id))) {
        return res.status(400).json({ error: "One or more invalid ID formats" });
      }
      // Run deletes with BOUNDED concurrency (not all-at-once) so a large
      // selection can't open dozens of simultaneous delete transactions and
      // starve the connection pool against the live sender (Task #211). Each
      // delete already runs under a bounded lock/statement timeout, so a busy
      // DB now fails fast per-id instead of hanging the whole request.
      const settled = await mapWithConcurrency(ids, BULK_DELETE_CONCURRENCY, async (id) => {
        try {
          await deleteCampaignWithFollowUpCleanup(id);
          return { id, ok: true as const };
        } catch (err) {
          return { id, ok: false as const, err };
        }
      });
      const blocked = settled.filter((r) => !r.ok && (r as any).err instanceof FollowUpPendingError);
      const timedOut = settled.filter(
        (r) => !r.ok && !((r as any).err instanceof FollowUpPendingError) && classifyDbError((r as any).err).kind === "timeout",
      );
      const otherFailures = settled.filter(
        (r) => !r.ok && !((r as any).err instanceof FollowUpPendingError) && classifyDbError((r as any).err).kind !== "timeout",
      );
      const deletedIds = settled.filter((r) => r.ok).map((r) => r.id);

      // Surface partial failures clearly so the UI can report exactly what
      // succeeded and what to retry, rather than appearing stuck or silently
      // dropping failures. Any failure -> 207-style payload with a 409/503/500
      // status reflecting the most actionable failure class.
      if (blocked.length > 0 || timedOut.length > 0 || otherFailures.length > 0) {
        if (otherFailures.length > 0) {
          logger.error("Error bulk-deleting campaigns:", (otherFailures[0] as any).err);
        }
        if (timedOut.length > 0) {
          logger.warn(`[CAMPAIGN_DELETE] ${timedOut.length} bulk delete(s) timed out (busy DB)`);
        }
        // Pick the status that best describes the failure mix: follow-up blocks
        // are a user action (409); a busy DB is retryable (503); anything else
        // is a server error (500).
        const status = otherFailures.length > 0 ? 500 : blocked.length > 0 ? 409 : 503;
        const messages: string[] = [];
        if (deletedIds.length > 0) messages.push(`${deletedIds.length} deleted`);
        if (blocked.length > 0) messages.push(`${blocked.length} have a pending follow-up (cancel or delete the follow-up first)`);
        if (timedOut.length > 0) messages.push(`${timedOut.length} could not be deleted because the database is busy — please retry`);
        if (otherFailures.length > 0) messages.push(`${otherFailures.length} failed unexpectedly`);
        return res.status(status).json({
          error: otherFailures.length > 0 ? "bulk_delete_partial_failure" : blocked.length > 0 ? "follow_up_pending" : "delete_timeout",
          message: messages.join("; ") + ".",
          deletedIds,
          blockedIds: blocked.map((r) => r.id),
          timedOutIds: timedOut.map((r) => r.id),
          failedIds: otherFailures.map((r) => r.id),
        });
      }
      res.status(204).send();
    } catch (error) {
      logger.error("Error bulk-deleting campaigns:", error);
      res.status(500).json({ error: "Failed to delete campaigns" });
    }
  });

  app.delete("/api/campaigns/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      await deleteCampaignWithFollowUpCleanup(req.params.id);
      res.status(204).send();
    } catch (error: any) {
      if (error instanceof FollowUpPendingError) {
        return res.status(409).json({
          error: "follow_up_pending",
          message: `Cannot delete: this campaign has a ${error.childStatus} follow-up. Cancel or delete the follow-up first.`,
          childId: error.childId,
        });
      }
      // The delete cascade runs under a bounded lock_timeout/statement_timeout
      // (Task #211). When the DB is busy (live sender holding locks, large
      // cascade) it now fails fast with 55P03/57014 instead of hanging. Surface
      // that as a clear, retryable 503 rather than a generic 500.
      const classified = classifyDbError(error);
      if (classified.kind === "timeout") {
        logger.warn(`[CAMPAIGN_DELETE] Delete timed out (busy DB): ${classified.message}`);
        return res.status(503).json({
          error: "delete_timeout",
          message: "The database is busy right now, so the campaign couldn't be deleted. Please try again in a moment.",
        });
      }
      logger.error("Error deleting campaign:", error);
      res.status(500).json({ error: "Failed to delete campaign" });
    }
  });

  app.post("/api/campaigns/:id/copy", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const campaign = await storage.copyCampaign(req.params.id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      res.status(201).json(campaign);
    } catch (error) {
      logger.error("Error copying campaign:", error);
      res.status(500).json({ error: "Failed to copy campaign" });
    }
  });

  app.post("/api/campaigns/:id/pause", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const campaign = await storage.updateCampaign(req.params.id, { status: "paused" });
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      res.json(campaign);
    } catch (error) {
      logger.error("Error pausing campaign:", error);
      res.status(500).json({ error: "Failed to pause campaign" });
    }
  });

  app.post("/api/campaigns/:id/resume", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      await storage.clearStuckJobsForCampaign(req.params.id);
      
      const resetCount = await storage.resetOrphanedFailedSends(req.params.id);
      if (resetCount > 0) {
        logger.info(`[CAMPAIGN_RESUME] Reset ${resetCount} orphaned failed sends for campaign ${req.params.id}`);
      }
      
      // If the campaign was paused before its scheduledAt fired, resume it
      // back to 'scheduled' (no job insert) so the scheduled-poller picks it
      // up at the original time. Otherwise resume to 'sending' immediately.
      const existing = await storage.getCampaign(req.params.id);
      const futureScheduled = !!(existing?.scheduledAt && new Date(existing.scheduledAt).getTime() > Date.now());

      // Step-by-step sending (Task #242): when resuming a campaign that was
      // auto-paused at a step limit, the client chooses one of two actions:
      //   "finish"   → clear the limit (run to completion)
      //   "continue" → reset step counter, optionally update limit
      // Step overrides are only applied when the campaign was actually paused
      // by the step-limit mechanism — not for manual pauses or mta_down.
      // Step-by-step sending (Task #242): typed to include the cursor column.
      let stepOverrides: {
        stepSendLimit?: number | null;
        stepProcessedCount?: number;
        stepCursorId?: string | null;
      } = {};
      const isStepLimitPause = existing?.pauseReason === "step_limit";
      if (isStepLimitPause) {
        const { stepAction, stepLimit } = req.body ?? {};
        if (stepAction === "finish") {
          // Clear the limit so the sender runs to completion.
          // Also clear stepCursorId so the sender restarts from the
          // beginning — with no step budget the re-scan is harmless since
          // already-sent contacts are excluded by the pressure guard and
          // step accounting is disabled (stepSendLimit === null).
          stepOverrides = { stepSendLimit: null, stepProcessedCount: 0, stepCursorId: null };
        } else if (stepAction === "continue") {
          // Strict parse: reject strings like "1abc" that parseInt would
          // accept — Number() returns NaN for them.
          const raw = stepLimit;
          const parsedLimit = (typeof raw === "number") ? raw : Number(raw);
          if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
            return res.status(400).json({ error: "stepLimit must be a positive integer when stepAction is 'continue'" });
          }
          // Reset counter but PRESERVE stepCursorId — the sender resumes
          // exactly where the previous step ended, skipping already-processed
          // contacts without consuming the new step budget.
          stepOverrides = { stepSendLimit: parsedLimit, stepProcessedCount: 0 };
        } else {
          // Plain resume of a step_limit campaign (no explicit action): reset
          // counter, keep limit and cursor — same effect as "continue" with
          // the same X.  Lets the old pauseResumeMutation path work without
          // the dialog if the operator uses keyboard or API directly.
          stepOverrides = { stepProcessedCount: 0 };
        }
      }

      const campaign = await db.transaction(async (tx) => {
        const targetStatus = futureScheduled ? "scheduled" : "sending";
        const [updated] = await tx.update(campaigns).set({
          status: targetStatus,
          pauseReason: null,
          ...(stepOverrides as any),
        }).where(sql`${campaigns.id} = ${req.params.id}`).returning();
        if (!updated) return null;
        if (!futureScheduled) {
          await tx.insert(campaignJobs).values({
            campaignId: updated.id,
            status: "pending",
          });
        }
        return updated;
      });
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      // Task #199: status transition done via raw tx — invalidate the list cache.
      publishCampaignsListInvalidation();

      if (!futureScheduled) {
        await messageQueue.notify("campaign_jobs", { campaignId: req.params.id });
        logger.info(`[CAMPAIGN_SEND] NOTIFY sent for campaign ${req.params.id}`);
      } else {
        logger.info(`[CAMPAIGN_RESUME] Campaign ${req.params.id} returned to 'scheduled' (scheduledAt in future)`);
      }
      
      res.json(campaign);
    } catch (error) {
      logger.error("Error resuming campaign:", error);
      res.status(500).json({ error: "Failed to resume campaign" });
    }
  });

  /**
   * Permanently end a campaign. Stops the sender (sets status='completed' which
   * the sender loop polls via checkStatusAndHeartbeat → shouldStop), purges all
   * deferred sends (campaign_sends rows with status='pending' AND eligible_at
   * IS NOT NULL) so they will never be drained, resets deferred_count to 0, and
   * decrements pending_count by the number of rows actually deleted.
   *
   * Works on ANY status, including 'completed' (use-case: clean up residual
   * deferred rows on already-completed campaigns whose deferred_count drifted).
   *
   * Idempotent: re-calling on an already-ended campaign is a no-op (0 rows
   * deleted) and still returns 200.
   */
  app.post("/api/campaigns/:id/end", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const existing = await storage.getCampaign(req.params.id);
      if (!existing) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      if (existing.status === "draft") {
        return res.status(400).json({ error: "Cannot end a draft campaign" });
      }

      // 1) Clear stuck jobs so no orphaned sender keeps running. Mirror the
      //    /resume route which does the same defensively.
      try {
        await storage.clearStuckJobsForCampaign(req.params.id);
      } catch (e: any) {
        logger.warn(`[CAMPAIGN_END] clearStuckJobsForCampaign failed (non-fatal): ${e?.message || e}`);
      }

      // 2) Atomic transaction: delete deferred sends + update campaign row.
      //    The sender's checkStatusAndHeartbeat() polls status every
      //    STATUS_CHECK_INTERVAL; once it sees status != 'sending' it sets
      //    shouldStop=true and exits the loop gracefully.
      const { deletedDeferred, campaign } = await db.transaction(async (tx) => {
        // Delete deferred rows in BOTH 'pending' and 'attempting' state.
        // 'pending' = sitting in deferred queue waiting for drain pickup.
        // 'attempting' = already claimed by drain worker but not yet
        // dispatched. Deleting an 'attempting' row is safe: drain's later
        // UPDATE ... WHERE id=$1 simply affects 0 rows (no-op). This closes
        // the architect-flagged race where in-flight drained rows would still
        // be sent after end. The sender-side race (10s STATUS_CHECK_INTERVAL)
        // matches existing /pause semantics and is acceptable — a small
        // residual batch (≤ BATCH_SIZE) may complete before shouldStop fires.
        const delResult: any = await tx.execute(sql`
          DELETE FROM campaign_sends
          WHERE campaign_id = ${req.params.id}
            AND status IN ('pending', 'attempting')
            AND eligible_at IS NOT NULL
        `);
        const deleted = Number(delResult?.rowCount ?? 0);

        const [updated] = await tx.update(campaigns).set({
          status: "completed",
          completedAt: existing.completedAt ?? new Date(),
          deferredCount: 0,
          pendingCount: sql`GREATEST(${campaigns.pendingCount} - ${deleted}, 0)` as any,
          pauseReason: null,
          // Terminal state — always clear the urgent-mode bypass so the
          // flag cannot survive into a future requeue/retry-failed flow
          // that reopens this campaign. The audit row in
          // pressure_flush_audit remains for forensic review.
          urgentMode: false,
          urgentFlushJobId: null,
        }).where(sql`${campaigns.id} = ${req.params.id}`).returning();

        return { deletedDeferred: deleted, campaign: updated };
      });
      // Task #199: status transition done via raw tx — invalidate the list cache.
      publishCampaignsListInvalidation();

      logger.info(`[CAMPAIGN_END] Campaign ${req.params.id} ended: deleted ${deletedDeferred} deferred sends, status→completed`);
      res.json({ campaign, deletedDeferred });
    } catch (error: any) {
      logger.error("Error ending campaign:", error);
      res.status(500).json({ error: "Failed to end campaign" });
    }
  });

  /**
   * POST /api/campaigns/:id/urgent — Operator-grade pressure-guard bypass
   * for one campaign. Mirrors the manual SQL incident playbook
   * (NULL last_sent_at + flush eligible_at + flip urgent_mode flag) so
   * it can be triggered from the UI without DB shell access.
   *
   * What it does, in one transaction:
   *   1. campaigns.urgent_mode := true            (CAS bypass enabled,
   *                                                survives PM2 restarts)
   *   2. subscribers.last_sent_at := NULL          for every subscriber
   *                                                currently pending in
   *                                                this campaign (lets
   *                                                them win the very
   *                                                next CAS round even
   *                                                if their last_sent_at
   *                                                was <6h ago)
   *   3. campaign_sends.eligible_at := NOW()       for every pending row
   *                                                with eligible_at in
   *                                                the future
   *   4. campaigns.deferred_count := 0             (live cache resync —
   *                                                no more held rows
   *                                                after this txn)
   *   5. INSERT INTO pressure_flush_audit          (paper trail)
   *
   * Body: none. Idempotent — calling twice is a no-op for #1 and #4,
   * and #2/#3 update 0 rows on the second call (everything is already
   * NULL / DUE NOW).
   *
   * RISKS the caller is opting into:
   *   - Double-send window: a contact who received another campaign's
   *     email <6h ago can be hit again immediately by this campaign.
   *   - FIFO starvation: older campaigns with overlapping audiences
   *     lose their `blocked_by_older` priority over this one until
   *     the urgent flag is cleared.
   * The UI gates this behind a destructive-styled confirm dialog.
   */
  app.post("/api/campaigns/:id/urgent", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      // Auth + per-campaign ownership gate (mirrors pressure.ts pattern).
      const sess = (req as any).session;
      const uid: string | undefined = sess?.userId;
      if (!uid) {
        return res.status(401).json({ error: "Authentication required" });
      }

      // 2026-05-23 — pre-flight load-shedding. The /urgent route used
      // to crash the DB by holding a pool slot for several seconds on
      // a 68k-row UPDATE. The pipeline is now async, but if the pool
      // is ALREADY tight we still refuse to enqueue: the worker that
      // drains the job needs free pool slots, and starting a new flush
      // on a saturated pool would just queue it indefinitely while
      // making symptoms harder to diagnose. Threshold mirrors the
      // global load-shedding middleware.
      const { getPoolSaturation } = await import("../db");
      const sat = getPoolSaturation();
      if (sat >= 0.7) {
        res.setHeader("Retry-After", "30");
        return res.status(503).json({
          error: "Database under load — retry in 30 seconds",
          poolSaturation: Number(sat.toFixed(2)),
        });
      }

      const ownerRow: any = await db.execute(sql`SELECT user_id, status, urgent_flush_job_id FROM campaigns WHERE id = ${req.params.id}`);
      if (!ownerRow.rows?.length) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      const { user_id: ownerId, status: campaignStatus, urgent_flush_job_id: existingJobId } =
        ownerRow.rows[0] as { user_id: string | null; status: string; urgent_flush_job_id: string | null };

      const adminRow: any = await db.execute(sql`SELECT is_admin FROM users WHERE id = ${uid}`);
      const isAdmin = adminRow.rows?.[0]?.is_admin === true;
      if (!isAdmin && ownerId && ownerId !== uid) {
        return res.status(403).json({ error: "Forbidden" });
      }
      if (campaignStatus !== "sending" && campaignStatus !== "paused") {
        return res.status(400).json({
          error: `Urgent mode only available for campaigns in 'sending' or 'paused' status (current: ${campaignStatus})`,
        });
      }

      // Idempotency: if a flush job is already pending/running for this
      // campaign, return it instead of creating a duplicate. The UI's
      // polling loop will pick up the existing job and show its progress.
      if (existingJobId) {
        const existing: any = await db.execute(sql`
          SELECT id, status, total_held, processed
          FROM urgent_flush_jobs
          WHERE id = ${existingJobId} AND status IN ('pending', 'running')
        `);
        if (existing.rows?.length) {
          const row = existing.rows[0];
          return res.status(202).json({
            ok: true,
            jobId: row.id,
            status: row.status,
            totalHeld: Number(row.total_held),
            processed: Number(row.processed),
            alreadyRunning: true,
          });
        }
      }

      // Live held count — used to pre-populate `total_held` so the UI's
      // progress bar can render an accurate denominator on the first poll.
      const heldRow: any = await db.execute(sql`
        SELECT COUNT(*)::int AS held
        FROM campaign_sends
        WHERE campaign_id = ${req.params.id}
          AND status = 'pending'
          AND eligible_at IS NOT NULL
          AND eligible_at > NOW()
      `);
      const liveHeld = Number(heldRow.rows?.[0]?.held ?? 0);
      if (liveHeld === 0) {
        return res.status(400).json({ error: "No held sends — nothing to flush" });
      }

      // Async enqueue. Three fast statements, no per-row work:
      //   1. Flip `urgent_mode` so the drain's force-CAS bypasses the 6h
      //      gap for THIS campaign from the very next dispatch tick.
      //      Honoured immediately even though the held queue is not yet
      //      flushed — rows already DUE NOW (if any) start dispatching
      //      under the bypass right away.
      //   2. Insert one `urgent_flush_jobs` row with the held snapshot.
      //   3. Link the job back to the campaign for fast UI lookup.
      // No long-running transaction, no row-level locks on campaign_sends,
      // no WAL spike. Returns in <100 ms.
      const insertRes: any = await db.execute(sql`
        INSERT INTO urgent_flush_jobs (campaign_id, user_id, total_held, status)
        VALUES (${req.params.id}, ${uid}, ${liveHeld}, 'pending')
        RETURNING id
      `);
      const jobId = insertRes.rows[0].id as string;

      await db.execute(sql`
        UPDATE campaigns
        SET urgent_mode = true, urgent_flush_job_id = ${jobId}
        WHERE id = ${req.params.id}
      `);

      logger.info(
        `[CAMPAIGN_URGENT] Campaign ${req.params.id} enqueued URGENT flush job ${jobId} (totalHeld=${liveHeld})`,
      );

      return res.status(202).json({
        ok: true,
        jobId,
        status: "pending",
        totalHeld: liveHeld,
        processed: 0,
        alreadyRunning: false,
      });
    } catch (error: any) {
      logger.error("[CAMPAIGN_URGENT] Failed:", error);
      res.status(500).json({ error: "Failed to enqueue urgent flush" });
    }
  });

  /**
   * GET /api/urgent-flush/:jobId — UI progress poll endpoint.
   *
   * Returns the current state of an urgent-flush job: status, total,
   * processed, and (for failed jobs) the error message. Auth gate is
   * the same as the POST: admin OR owner of the campaign referenced by
   * the job. Cheap (one PK lookup + one campaigns.user_id lookup).
   */
  app.get("/api/urgent-flush/:jobId", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.jobId)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const sess = (req as any).session;
      const uid: string | undefined = sess?.userId;
      if (!uid) {
        return res.status(401).json({ error: "Authentication required" });
      }
      const jobRow: any = await db.execute(sql`
        SELECT j.id, j.campaign_id, j.status, j.total_held, j.processed,
               j.error, j.created_at, j.started_at, j.completed_at,
               c.user_id AS campaign_user_id
        FROM urgent_flush_jobs j
        LEFT JOIN campaigns c ON c.id = j.campaign_id
        WHERE j.id = ${req.params.jobId}
      `);
      if (!jobRow.rows?.length) {
        return res.status(404).json({ error: "Job not found" });
      }
      const row = jobRow.rows[0];
      const adminRow: any = await db.execute(sql`SELECT is_admin FROM users WHERE id = ${uid}`);
      const isAdmin = adminRow.rows?.[0]?.is_admin === true;
      if (!isAdmin && row.campaign_user_id && row.campaign_user_id !== uid) {
        return res.status(403).json({ error: "Forbidden" });
      }
      return res.json({
        id: row.id,
        campaignId: row.campaign_id,
        status: row.status,
        totalHeld: Number(row.total_held),
        processed: Number(row.processed),
        error: row.error,
        createdAt: row.created_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
      });
    } catch (error: any) {
      logger.error("[URGENT_FLUSH_PROGRESS] Failed:", error);
      res.status(500).json({ error: "Failed to fetch flush job status" });
    }
  });

  app.get("/api/campaigns/:id/errors", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const campaign = await storage.getCampaign(req.params.id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 100));
      const { logs, total } = await storage.getErrorLogs({
        campaignId: req.params.id,
        type: "send_failed",
        limit,
        page,
      });
      // Grouped summary: top error messages with occurrence counts
      const summaryRows = await db
        .select({ message: errorLogs.message, count: sql<number>`count(*)::int` })
        .from(errorLogs)
        .where(and(eq(errorLogs.campaignId, req.params.id), eq(errorLogs.type, "send_failed")))
        .groupBy(errorLogs.message)
        .orderBy(sql`count(*) desc`)
        .limit(20);
      res.json({
        pauseReason: campaign.pauseReason,
        errors: logs,
        total,
        page,
        limit,
        summary: summaryRows.map(r => ({ message: r.message, count: Number(r.count) })),
      });
    } catch (error) {
      logger.error("Error fetching campaign errors:", error);
      res.status(500).json({ error: "Failed to fetch campaign errors" });
    }
  });

  // Retry only failed individual sends — already-sent recipients are never re-contacted.
  // Works regardless of current campaign status (completed, sending, paused, failed).
  //
  // Mechanism:
  //   Failed rows are reset to 'pending' with a fresh sent_at timestamp. The main
  //   send loop (bulkReserveSendSlots / INSERT ON CONFLICT DO NOTHING) will skip
  //   them, but campaign-sender.ts calls recoverOrphanedPendingSends(campaignId, 0)
  //   after flushBuffer() to collect these carry-over rows, adds their count to
  //   totalFailed, and the retry phase then re-sends them via getFailedSendsForRetry.
  //   Already-sent rows (status='sent') are never touched.
  app.post("/api/campaigns/:id/retry-failed", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const existingCampaign = await storage.getCampaign(req.params.id);
      if (!existingCampaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      // All three operations in one transaction for atomicity.
      const { campaign, resetCount } = await db.transaction(async (tx) => {
        // 1. Reset failed rows to pending.
        //    Eligibility is derived from actual DB rows (not just failedCount counter)
        //    to guard against counter drift.
        //    sent_at is refreshed so recoverOrphanedPendingSends (2-min threshold)
        //    at job start does NOT immediately revert them back to failed.
        //    retry_count/last_retry_at are incremented to preserve history.
        const resetResult = await tx.execute(sql`
          UPDATE campaign_sends
          SET status = 'pending',
              retry_count = retry_count + 1,
              last_retry_at = NOW(),
              sent_at = NOW()
          WHERE campaign_id = ${req.params.id} AND status = 'failed'${zeroDupSendGuardEnabled() ? sql` AND smtp_outcome_class IS DISTINCT FROM 'ambiguous'` : sql``}
          RETURNING id
        `);
        const resetCount = resetResult.rows.length;
        if (resetCount === 0) return { campaign: null, resetCount: 0 };

        // 2. Reset campaign counters and status.
        //    retryUntil and autoRetryCount are cleared so campaign-sender sets a fresh
        //    12-hour window and the auto-retry counter resets to 0 (giving 3 more attempts).
        const [updated] = await tx
          .update(campaigns)
          // 2026-05-22: clear urgent_mode on reopen. The operator
          // toggled urgent for a specific past flush; resurrecting the
          // bypass on a fresh retry would silently push the new wave
          // ahead of every other campaign's pressure window. They can
          // re-click /urgent if they actually want that.
          // Zero-Duplicate Send Guard: ambiguous rows stay 'failed' (excluded from
          // the reset above), so failed_count must reflect them, not reset to 0.
          .set({ status: "sending", failedCount: zeroDupSendGuardEnabled() ? sql`(SELECT COUNT(*) FROM campaign_sends WHERE campaign_id = ${req.params.id} AND status = 'failed' AND smtp_outcome_class = 'ambiguous')` : 0, pauseReason: null, retryUntil: null, autoRetryCount: 0, urgentMode: false, urgentFlushJobId: null })
          .where(sql`${campaigns.id} = ${req.params.id}`)
          .returning();
        if (!updated) return { campaign: null, resetCount };

        // 3. Enqueue a new campaign job (deduplicated: skip if one is already
        //    pending/processing to avoid competing workers).
        await tx.execute(sql`
          INSERT INTO campaign_jobs (id, campaign_id, status)
          SELECT gen_random_uuid(), ${updated.id}, 'pending'
          WHERE NOT EXISTS (
            SELECT 1 FROM campaign_jobs
            WHERE campaign_id = ${updated.id} AND status IN ('pending', 'processing')
          )
          ON CONFLICT DO NOTHING
        `);
        return { campaign: updated, resetCount };
      });

      if (!campaign) {
        if (resetCount === 0) {
          return res.status(400).json({ error: "No failed sends to retry" });
        }
        return res.status(404).json({ error: "Campaign not found" });
      }
      // Task #199: status transition done via raw tx — invalidate the list cache.
      publishCampaignsListInvalidation();

      await messageQueue.notify("campaign_jobs", { campaignId: req.params.id });
      logger.info(`[CAMPAIGN_RETRY_FAILED] Reset ${resetCount} failed sends to pending, NOTIFY sent for campaign ${req.params.id}`);
      res.json({ campaign, resetCount });
    } catch (error) {
      logger.error("Error retrying failed campaign sends:", error);
      res.status(500).json({ error: "Failed to retry failed sends" });
    }
  });

  app.post("/api/campaigns/:id/requeue", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const existingCampaign = await storage.getCampaign(req.params.id);
      if (!existingCampaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      if (existingCampaign.status !== "failed") {
        return res.status(400).json({ error: "Only failed campaigns can be requeued" });
      }

      await storage.clearStuckJobsForCampaign(req.params.id);

      const campaign = await db.transaction(async (tx) => {
        const [updated] = await tx.update(campaigns).set({
          status: "sending",
          pauseReason: null,
          sentCount: 0,
          failedCount: 0,
          // 2026-05-22: see /retry-failed comment — urgent_mode must
          // not survive a requeue of a failed campaign.
          urgentMode: false,
          urgentFlushJobId: null,
        }).where(sql`${campaigns.id} = ${req.params.id}`).returning();
        if (!updated) return null;
        await tx.insert(campaignJobs).values({
          campaignId: updated.id,
          status: "pending",
        });
        return updated;
      });
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      // Task #199: status transition done via raw tx — invalidate the list cache.
      publishCampaignsListInvalidation();

      await messageQueue.notify("campaign_jobs", { campaignId: req.params.id });
      logger.info(`[CAMPAIGN_REQUEUE] NOTIFY sent for campaign ${req.params.id}`);

      res.json(campaign);
    } catch (error) {
      logger.error("Error requeuing campaign:", error);
      res.status(500).json({ error: "Failed to requeue campaign" });
    }
  });

  app.post("/api/campaigns/:id/send", async (req: Request, res: Response) => {
    if (isMemoryPressure) {
      // Task #148: route this 503 through the unified helper so it appears
      // in the attribution ring + critsend_memory_pressure_503_total counter.
      return emitServiceBusy(req, res, { source: "memory_pressure", retryAfterSeconds: 60 });
    }
    const campaignId = req.params.id;
    const timestamp = new Date().toISOString();
    const isScheduled = !!req.body.scheduledAt;
    
    if (!validateId(campaignId)) {
      return res.status(400).json({ error: "Invalid ID format" });
    }
    
    logger.info(`[CAMPAIGN_SEND] ${timestamp} - Starting ${isScheduled ? 'schedule' : 'send'} process for campaign ${campaignId}`);
    logger.info(`[CAMPAIGN_SEND] ${timestamp} - Request body:`, JSON.stringify(req.body, null, 2));
    
    try {
      const existingCampaign = await storage.getCampaign(campaignId);
      if (!existingCampaign) {
        logger.error(`[CAMPAIGN_SEND] ${timestamp} - Campaign ${campaignId} not found`);
        return res.status(404).json({ error: "Campaign not found" });
      }
      
      logger.info(`[CAMPAIGN_SEND] ${timestamp} - Campaign found, current status: ${existingCampaign.status}`);
      
      if (existingCampaign.status === "sending") {
        logger.info(`[CAMPAIGN_SEND] ${timestamp} - Campaign already sending`);
        return res.status(400).json({ error: "Campaign is already sending" });
      }
      if (existingCampaign.status === "completed") {
        logger.info(`[CAMPAIGN_SEND] ${timestamp} - Campaign already completed`);
        return res.status(400).json({ error: "Campaign has already completed" });
      }
      
      const updateData = { ...req.body };
      delete updateData.status;
      const hasCanonicalSegments = Object.prototype.hasOwnProperty.call(updateData, "segmentIds");
      const hasLegacySegment = Object.prototype.hasOwnProperty.call(updateData, "segmentId");
      const selectedSegmentIds = hasCanonicalSegments
        ? updateData.segmentIds
        : hasLegacySegment
          ? (updateData.segmentId ? [updateData.segmentId] : [])
          : ((existingCampaign as any).segmentIds ?? (existingCampaign.segmentId ? [existingCampaign.segmentId] : []));
      delete updateData.segmentIds;
      // 2026-05-22 urgent-mode audit: /api/campaigns/:id/send is a generic
      // pre-launch save+send. Allowing urgent_mode through here would let
      // a client toggle the CAS bypass without going through the dedicated
      // /urgent endpoint (which has its own auth, ownership check, held
      // count check, and audit-row insert). Strip both casings.
      delete updateData.urgentMode;
      delete updateData.urgent_mode;
      if (updateData.scheduledAt && typeof updateData.scheduledAt === 'string') {
        updateData.scheduledAt = new Date(updateData.scheduledAt);
      }
      if (!Array.isArray(selectedSegmentIds) || !selectedSegmentIds.length ||
          selectedSegmentIds.some((id) => typeof id !== "string" || !id.trim()) ||
          new Set(selectedSegmentIds).size !== selectedSegmentIds.length) {
        return res.status(400).json({ error: "segmentIds must be a unique non-empty list" });
      }
      const effectiveExcludeId = Object.prototype.hasOwnProperty.call(updateData, "excludeSegmentId")
        ? (updateData.excludeSegmentId || null)
        : existingCampaign.excludeSegmentId;
      if (effectiveExcludeId && selectedSegmentIds.includes(effectiveExcludeId)) {
        return res.status(400).json({ error: "Exclusion segment cannot be the same as the audience segment" });
      }
      const segmentRefs = [...selectedSegmentIds, ...(effectiveExcludeId ? [effectiveExcludeId] : [])];
      const selectedSegments = await storage.getSegmentsByIds(segmentRefs);
      const selectedSegmentSet = new Set(selectedSegments.map((segment) => segment.id));
      if (selectedSegmentIds.some((id: string) => !selectedSegmentSet.has(id))) {
        return res.status(400).json({ error: "Selected segment not found" });
      }
      if (effectiveExcludeId && !selectedSegmentSet.has(effectiveExcludeId)) {
        return res.status(400).json({ error: "Exclusion segment does not exist" });
      }

      const effectiveCampaign = {
        ...existingCampaign,
        ...updateData,
        segmentId: selectedSegmentIds[0],
        excludeSegmentId: effectiveExcludeId,
      };
      const validationErrors: string[] = [];
      if (!effectiveCampaign.name) validationErrors.push("Campaign name is required");
      if (!effectiveCampaign.segmentId) validationErrors.push("Segment is required");
      if (!effectiveCampaign.mtaId) validationErrors.push("MTA server is required");
      if (!effectiveCampaign.fromName) validationErrors.push("Sender name is required");
      if (!effectiveCampaign.fromEmail) validationErrors.push("Sender email is required");
      if (!effectiveCampaign.subject) validationErrors.push("Subject line is required");
      if (!effectiveCampaign.htmlContent) validationErrors.push("Email content is required");
      
      if (validationErrors.length > 0) {
        logger.error(`[CAMPAIGN_SEND] ${timestamp} - Validation failed:`, validationErrors);
        return res.status(400).json({ 
          error: "Campaign validation failed", 
          details: validationErrors 
        });
      }
      
      const mta = await storage.getMta(effectiveCampaign.mtaId!);
      if (!mta) {
        logger.error(`[CAMPAIGN_SEND] ${timestamp} - MTA not found: ${effectiveCampaign.mtaId}`);
        return res.status(400).json({ error: "Selected MTA server not found" });
      }
      if (!mta.isActive) {
        logger.error(`[CAMPAIGN_SEND] ${timestamp} - MTA is not active: ${mta.name}`);
        return res.status(400).json({ error: "Selected MTA server is not active" });
      }
      const subscriberCount = await storage.countSubscribersForSegments(selectedSegmentIds, effectiveExcludeId ?? undefined);
      logger.info(`[CAMPAIGN_SEND] ${timestamp} - ${selectedSegmentIds.length} selected segment(s) have ${subscriberCount} subscribers`);
      
      if (subscriberCount === 0) {
        logger.error(`[CAMPAIGN_SEND] ${timestamp} - Segment has no subscribers`);
        return res.status(400).json({ error: "Selected segment has no subscribers" });
      }
      const targetStatus = isScheduled ? "scheduled" : "sending";
      logger.info(`[CAMPAIGN_SEND] ${timestamp} - Atomically saving audience and setting status '${targetStatus}'`);
      const updatedCampaign = await db.transaction(async (tx) => {
        const [updated] = await tx.update(campaigns).set({
          ...updateData,
          segmentId: selectedSegmentIds[0],
          excludeSegmentId: effectiveExcludeId,
          status: targetStatus,
          ...(isScheduled ? { scheduledAt: new Date(req.body.scheduledAt) } : {}),
        }).where(sql`${campaigns.id} = ${campaignId}`).returning();
        if (!updated || updated.status !== targetStatus) return null;
        await tx.delete(campaignSegments).where(eq(campaignSegments.campaignId, campaignId));
        await tx.insert(campaignSegments).values(
          selectedSegmentIds.map((segmentId: string, position: number) => ({ campaignId, segmentId, position })),
        );
        if (!isScheduled) {
          await tx.insert(campaignJobs).values({
            campaignId: updated.id,
            status: "pending",
          });
        }
        return updated;
      });
      
      if (!updatedCampaign) {
        logger.error(`[CAMPAIGN_SEND] ${timestamp} - Failed to update campaign status`);
        return res.status(500).json({ error: `Failed to ${isScheduled ? "schedule" : "start"} campaign` });
      }
      // Task #199: status transition done via raw tx — invalidate the list cache.
      publishCampaignsListInvalidation();
      if (!isScheduled) {
        logger.info(`[CAMPAIGN_SEND] ${timestamp} - Campaign successfully queued`);
        await messageQueue.notify("campaign_jobs", { campaignId });
        logger.info(`[CAMPAIGN_SEND] NOTIFY sent for campaign ${campaignId}`);
      }
      logger.info(`[CAMPAIGN_SEND] ${timestamp} - Campaign ${campaignId} ${isScheduled ? "scheduled" : "started"} successfully`);
      res.json({ 
        success: true, 
        campaign: { ...updatedCampaign, segmentIds: selectedSegmentIds },
        message: `Campaign ${isScheduled ? "scheduled for" : "started with"} ${subscriberCount} subscribers`
      });
      
    } catch (error: any) {
      logger.error(`[CAMPAIGN_SEND] ${timestamp} - Unexpected error:`, error);
      res.status(500).json({ error: error.message || "Failed to start campaign" });
    }
  });
}
