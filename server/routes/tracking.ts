import { type Express, type Request, type Response } from "express";
import { storage } from "../storage";
import { db } from "../db";
import { sql } from "drizzle-orm";
import { logger } from "../logger";
import { verifyTrackingSignature } from "../tracking";
import { UAParser } from "ua-parser-js";
import geoip from "geoip-lite";
import type { TrackingContext } from "../repositories/campaign-repository";
import {
  enqueueTrackingEvent,
  getLinkDestinationCached,
  isTrackingPoolUnavailable,
} from "../tracking-buffer";
import { isPoolCheckoutError, pool } from "../db";
import { withAdvisoryLock, indexExistsAndValid, columnHasData, LOCK_KEYS, runIndexDdlNoTimeout } from "../bootstrap-lock";
import {
  resolveTrackingTokenViaTrackingPool,
  getCampaignTagsViaTrackingPool,
} from "../tracking-queries";
import {
  COMPLAINT_IP,
  COMPLAINT_IPS,
  COMPLAINT_IP_SUPPRESSION_DAYS,
} from "../config/suppression";

// Task #282: rolling windows must age out even when no new click/complaint
// arrives. This intentionally runs off the request/startup path. A
// transaction-scoped advisory lock elects one refresher across processes;
// unlike session locks it is safe with transaction-pooling proxies.
const RISK_PROFILE_REFRESH_LOCK = 900027;
const RISK_PROFILE_REFRESH_MS = 15 * 60 * 1000;
const RISK_SCHEMA_RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 120_000, 300_000];

async function ensureOrangeWanadooRiskSchema(): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock($1) AS acquired",
      [RISK_PROFILE_REFRESH_LOCK],
    );
    if (!lock.rows[0]?.acquired) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscriber_risk_profiles (
        subscriber_id varchar PRIMARY KEY REFERENCES subscribers(id) ON DELETE CASCADE,
        last_detection_at timestamp,
        first_detection_at timestamp,
        detections_7d integer NOT NULL DEFAULT 0,
        detections_15d integer NOT NULL DEFAULT 0,
        detections_30d integer NOT NULL DEFAULT 0,
        distinct_clicked_campaigns_30d integer NOT NULL DEFAULT 0,
        distinct_clicked_campaigns_90d integer NOT NULL DEFAULT 0,
        updated_at timestamp NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS subscriber_risk_profiles_last_detection_idx
      ON subscriber_risk_profiles(last_detection_at)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS orange_wanadoo_risk_audit (
        campaign_id varchar NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        batch_cursor varchar NOT NULL,
        mode text NOT NULL,
        counts_by_tier jsonb NOT NULL,
        would_block_count integer NOT NULL DEFAULT 0,
        created_at timestamp NOT NULL DEFAULT NOW(),
        PRIMARY KEY (campaign_id, batch_cursor)
      )
    `);
    await client.query("COMMIT");
    logger.info("[TRACKING] Orange/Wanadoo risk profile schema ready; rolling reconciliation is scheduled");
    return true;
  } catch (error: any) {
    try { await client.query("ROLLBACK"); } catch { /* no active transaction */ }
    logger.warn(`[TRACKING] Orange/Wanadoo schema bootstrap deferred: ${error?.message || error}`);
    return false;
  } finally {
    client.release();
  }
}

function scheduleOrangeWanadooRiskSchemaBootstrap(attempt = 0): void {
  const delay = RISK_SCHEMA_RETRY_DELAYS_MS[Math.min(attempt, RISK_SCHEMA_RETRY_DELAYS_MS.length - 1)];
  const timer = setTimeout(async () => {
    const ready = await ensureOrangeWanadooRiskSchema().catch((error) => {
      logger.warn(`[TRACKING] Orange/Wanadoo schema bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    });
    if (!ready) scheduleOrangeWanadooRiskSchemaBootstrap(attempt + 1);
  }, delay);
  timer.unref();
}

scheduleOrangeWanadooRiskSchemaBootstrap();

export async function refreshOrangeWanadooRiskProfiles(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock($1) AS acquired",
      [RISK_PROFILE_REFRESH_LOCK],
    );
    if (!lock.rows[0]?.acquired) {
      await client.query("ROLLBACK");
      return;
    }
    await client.query(`
      WITH candidates AS (
        SELECT id FROM (
          (SELECT s.id, 0 AS priority
             FROM subscribers s
             JOIN campaign_stats cs ON cs.subscriber_id=s.id
             LEFT JOIN subscriber_risk_profiles p ON p.subscriber_id=s.id
            WHERE p.subscriber_id IS NULL
              AND lower(split_part(s.email, '@', 2)) IN ('orange.fr', 'wanadoo.fr')
              AND cs.timestamp >= NOW()-INTERVAL '30 days'
              AND cs.ip_address=$1 AND cs.type IN ('open','complaint')
            GROUP BY s.id LIMIT 1000)
          UNION ALL
          (SELECT subscriber_id AS id, 1 AS priority
             FROM subscriber_risk_profiles
            ORDER BY updated_at ASC NULLS FIRST LIMIT 1000)
        ) chosen
        GROUP BY id ORDER BY MIN(priority), id LIMIT 2000
      ),
      detections AS (
        SELECT cs.subscriber_id,
          MIN(cs.timestamp) AS first_detection_at, MAX(cs.timestamp) AS last_detection_at,
          COUNT(*) FILTER (WHERE cs.timestamp >= NOW() - INTERVAL '7 days')::int AS d7,
          COUNT(*) FILTER (WHERE cs.timestamp >= NOW() - INTERVAL '15 days')::int AS d15,
          COUNT(*) FILTER (WHERE cs.timestamp >= NOW() - INTERVAL '30 days')::int AS d30
        FROM campaign_stats cs JOIN candidates t ON t.id = cs.subscriber_id
        WHERE cs.timestamp >= NOW() - INTERVAL '90 days'
          AND cs.ip_address = $1 AND cs.type IN ('open', 'complaint')
        GROUP BY cs.subscriber_id
      ),
      clicks AS (
        SELECT cs.subscriber_id,
          COUNT(DISTINCT cs.campaign_id) FILTER (WHERE cs.timestamp >= NOW() - INTERVAL '30 days')::int AS c30,
          COUNT(DISTINCT cs.campaign_id)::int AS c90
        FROM campaign_stats cs JOIN candidates t ON t.id = cs.subscriber_id
        WHERE cs.timestamp >= NOW() - INTERVAL '90 days' AND cs.type = 'click'
        GROUP BY cs.subscriber_id
      )
      , upserted AS (
        INSERT INTO subscriber_risk_profiles (
          subscriber_id, first_detection_at, last_detection_at, detections_7d,
          detections_15d, detections_30d, distinct_clicked_campaigns_30d,
          distinct_clicked_campaigns_90d, updated_at
        )
        SELECT t.id, d.first_detection_at, d.last_detection_at,
          COALESCE(d.d7,0), COALESCE(d.d15,0), COALESCE(d.d30,0),
          COALESCE(c.c30,0), COALESCE(c.c90,0), NOW()
        FROM candidates t
        LEFT JOIN detections d ON d.subscriber_id=t.id
        LEFT JOIN clicks c ON c.subscriber_id=t.id
        WHERE d.subscriber_id IS NOT NULL OR c.subscriber_id IS NOT NULL
        ON CONFLICT (subscriber_id) DO UPDATE SET
          first_detection_at=EXCLUDED.first_detection_at, last_detection_at=EXCLUDED.last_detection_at,
          detections_7d=EXCLUDED.detections_7d, detections_15d=EXCLUDED.detections_15d,
          detections_30d=EXCLUDED.detections_30d,
          distinct_clicked_campaigns_30d=EXCLUDED.distinct_clicked_campaigns_30d,
          distinct_clicked_campaigns_90d=EXCLUDED.distinct_clicked_campaigns_90d, updated_at=NOW()
        RETURNING subscriber_id
      )
      DELETE FROM subscriber_risk_profiles p
      USING candidates t
      WHERE p.subscriber_id=t.id
        AND NOT EXISTS (
          SELECT 1 FROM detections d WHERE d.subscriber_id=t.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM clicks c WHERE c.subscriber_id=t.id
        )
    `, [COMPLAINT_IP]);
    await client.query("COMMIT");
    logger.info("[TRACKING] Orange/Wanadoo risk profiles reconciled");
  } catch (err: any) {
    try { await client.query("ROLLBACK"); } catch { /* no active transaction */ }
    logger.error(`[TRACKING] Orange/Wanadoo scheduled profile reconciliation failed: ${err?.message || err}`);
  } finally {
    client.release();
  }
}
setTimeout(() => {
  void refreshOrangeWanadooRiskProfiles();
  const timer = setInterval(() => void refreshOrangeWanadooRiskProfiles(), RISK_PROFILE_REFRESH_MS);
  timer.unref();
}, 15 * 60 * 1000).unref();

(async () => {
  await withAdvisoryLock(
    LOCK_KEYS.TRACKING_BOOTSTRAP,
    "TRACKING",
    async (_lockClient) => {
      try {
        await db.execute(sql`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS suppressed_until TIMESTAMP`);
        const alreadyBackfilled = await columnHasData("subscribers", "suppressed_until");
        if (!alreadyBackfilled) {
          await db.execute(sql`
            UPDATE subscribers s
            SET suppressed_until = cs.last_unsub + INTERVAL '7 days'
            FROM (
              SELECT subscriber_id, MAX(timestamp) AS last_unsub
              FROM campaign_stats
              WHERE type = 'unsubscribe'
                AND timestamp > NOW() - INTERVAL '7 days'
              GROUP BY subscriber_id
            ) cs
            WHERE s.id = cs.subscriber_id
              AND (s.suppressed_until IS NULL OR s.suppressed_until < cs.last_unsub + INTERVAL '7 days')
          `);
          logger.info("[TRACKING] Bootstrap migration: suppressed_until column ready, recent unsubscribers backfilled");
        } else {
          logger.info("[TRACKING] Bootstrap migration: suppressed_until column already populated — skipping backfill");
        }
      } catch (err: any) {
        logger.error(`[TRACKING] Bootstrap migration FAILED (suppressed_until): ${err?.message || err}`);
      }

      if (!(await indexExistsAndValid("campaign_stats_complaint_ip_timestamp_subscriber_idx"))) {
        try {
          await runIndexDdlNoTimeout(
            `CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_stats_complaint_ip_timestamp_subscriber_idx
               ON campaign_stats (timestamp, subscriber_id)
               WHERE ip_address = '195.154.17.225'
                 AND type IN ('open', 'complaint')`,
            "CREATE campaign_stats_complaint_ip_timestamp_subscriber_idx",
          );
          logger.info("[TRACKING] Bootstrap migration: complaint-IP timestamp backfill index ready");
        } catch (err: any) {
          logger.error(
            `[TRACKING] Bootstrap migration FAILED (complaint-IP timestamp index): ${err?.message || err}`,
          );
        }
      } else {
        logger.info("[TRACKING] Bootstrap migration: complaint-IP timestamp backfill index already exists — skipping");
      }

      // Apply the complaint-IP cooling-off rule retroactively on every deploy.
      // Current detections are stored as complaint rows; historical rows may
      // still be opens, so both event types are included. MAX(timestamp) keeps
      // the deadline anchored to the latest actual detection, while the WHERE
      // clause makes this idempotent and never shortens a later suppression.
      try {
        const result = await db.execute(sql`
          WITH latest_complaint_ip_detection AS (
            SELECT subscriber_id, MAX(timestamp) AS detected_at
            FROM campaign_stats
            WHERE ip_address = ${COMPLAINT_IP}
              AND type IN ('open', 'complaint')
              AND timestamp >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
                - make_interval(days => ${COMPLAINT_IP_SUPPRESSION_DAYS})
            GROUP BY subscriber_id
          ),
          updated AS (
            UPDATE subscribers s
            SET suppressed_until = d.detected_at
              + make_interval(days => ${COMPLAINT_IP_SUPPRESSION_DAYS})
            FROM latest_complaint_ip_detection d
            WHERE s.id = d.subscriber_id
              AND (
                s.suppressed_until IS NULL
                OR s.suppressed_until < d.detected_at
                  + make_interval(days => ${COMPLAINT_IP_SUPPRESSION_DAYS})
              )
            RETURNING 1
          )
          SELECT COUNT(*)::int AS affected FROM updated
        `);
        const affected = Number(
          (result.rows[0] as { affected?: number | string } | undefined)?.affected ?? 0,
        );
        logger.info(
          `[TRACKING] Bootstrap migration: complaint-IP 15-day suppression backfill applied to ${affected} subscriber(s)`,
        );
      } catch (err: any) {
        logger.error(
          `[TRACKING] Bootstrap migration FAILED (complaint-IP suppression backfill): ${err?.message || err}`,
        );
      }

      if (!(await indexExistsAndValid("campaign_stats_campaign_subscriber_type_idx"))) {
        try {
          await pool.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_stats_campaign_subscriber_type_idx
              ON campaign_stats (campaign_id, subscriber_id, type)
          `);
          logger.info("[TRACKING] Bootstrap migration: campaign_stats(campaign_id, subscriber_id, type) covering index ready");
        } catch (err: any) {
          logger.error(`[TRACKING] Bootstrap migration FAILED (campaign_stats covering index): ${err?.message || err}`);
        }
      } else {
        logger.info("[TRACKING] Bootstrap migration: campaign_stats covering index already exists — skipping");
      }

      // Task #232 — clicker-tier segment operators run a correlated
      // COUNT(DISTINCT campaign_id) over recent clicks per subscriber.
      // Partial index keeps that probe cheap on the multi-GB stats table
      // (index-only scan: subscriber_id, timestamp, campaign_id).
      if (!(await indexExistsAndValid("campaign_stats_click_subscriber_ts_idx"))) {
        try {
          // Large concurrent build on a multi-GB table: must bypass the
          // global statement timeout (dedicated session, timeout=0).
          await runIndexDdlNoTimeout(
            `CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_stats_click_subscriber_ts_idx
               ON campaign_stats (subscriber_id, timestamp, campaign_id)
               WHERE type = 'click'`,
            "CREATE campaign_stats_click_subscriber_ts_idx",
          );
          logger.info("[TRACKING] Bootstrap migration: campaign_stats click partial index ready");
        } catch (err: any) {
          logger.error(`[TRACKING] Bootstrap migration FAILED (campaign_stats click partial index): ${err?.message || err}`);
        }
      } else {
        logger.info("[TRACKING] Bootstrap migration: campaign_stats click partial index already exists — skipping");
      }

      // Task #239 — timestamp-first click index for clicker-tier segment operators.
      // The existing index (subscriber_id, timestamp, campaign_id) lets PostgreSQL
      // probe cheaply per-subscriber but cannot limit the date range at the index
      // level when the query filters only by timestamp first (no leading subscriber_id
      // predicate). A timestamp-first partial index lets PostgreSQL scan only the
      // recent 60-day slice before grouping by subscriber — turning a multi-GB
      // historical scan into a narrow range scan on a much smaller slice.
      if (!(await indexExistsAndValid("campaign_stats_click_ts_subscriber_campaign_idx"))) {
        try {
          await runIndexDdlNoTimeout(
            `CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_stats_click_ts_subscriber_campaign_idx
               ON campaign_stats (timestamp, subscriber_id, campaign_id)
               WHERE type = 'click'`,
            "CREATE campaign_stats_click_ts_subscriber_campaign_idx",
          );
          logger.info("[TRACKING] Bootstrap migration: campaign_stats timestamp-first click partial index ready");
        } catch (err: any) {
          logger.error(`[TRACKING] Bootstrap migration FAILED (campaign_stats timestamp-first click partial index): ${err?.message || err}`);
        }
      } else {
        logger.info("[TRACKING] Bootstrap migration: campaign_stats timestamp-first click partial index already exists — skipping");
      }

      // Lifetime segment exclusion for the fixed complaint-bot IP. The
      // predicate includes both normal opens and counting-only complaint rows,
      // matching how tracking stores activity from 195.154.17.225.
      if (!(await indexExistsAndValid("campaign_stats_bot_open_subscriber_idx"))) {
        try {
          await runIndexDdlNoTimeout(
            `CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_stats_bot_open_subscriber_idx
               ON campaign_stats (subscriber_id)
               WHERE ip_address = '195.154.17.225'
                 AND type IN ('open', 'complaint')`,
            "CREATE campaign_stats_bot_open_subscriber_idx",
          );
          logger.info("[TRACKING] Bootstrap migration: bot-open subscriber partial index ready");
        } catch (err: any) {
          logger.error(`[TRACKING] Bootstrap migration FAILED (bot-open subscriber partial index): ${err?.message || err}`);
        }
      } else {
        logger.info("[TRACKING] Bootstrap migration: bot-open subscriber partial index already exists — skipping");
      }

      // Segment operator: distinct campaigns explicitly unsubscribed from per
      // subscriber. This narrow covering index avoids scanning unrelated
      // opens, clicks, and complaints in the multi-GB stats table.
      if (!(await indexExistsAndValid("campaign_stats_unsubscribe_subscriber_campaign_idx"))) {
        try {
          await runIndexDdlNoTimeout(
            `CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_stats_unsubscribe_subscriber_campaign_idx
               ON campaign_stats (subscriber_id, campaign_id)
               WHERE type = 'unsubscribe'`,
            "CREATE campaign_stats_unsubscribe_subscriber_campaign_idx",
          );
          logger.info("[TRACKING] Bootstrap migration: unsubscribe subscriber-campaign partial index ready");
        } catch (err: any) {
          logger.error(`[TRACKING] Bootstrap migration FAILED (unsubscribe subscriber-campaign partial index): ${err?.message || err}`);
        }
      } else {
        logger.info("[TRACKING] Bootstrap migration: unsubscribe subscriber-campaign partial index already exists — skipping");
      }
    },
  );
})();

function extractTrackingContext(req: Request): TrackingContext {
  // server/index.ts trusts exactly one reverse-proxy hop. Express therefore
  // derives req.ip from the right-hand side of X-Forwarded-For and ignores any
  // client-prepended spoofed value. Reading the raw first header entry here
  // would let anyone holding a valid tracking URL fake the complaint IP.
  const rawIp = req.ip || req.socket.remoteAddress || "";
  const ip = rawIp.replace(/^::ffff:/, "");

  const ua = req.headers["user-agent"] || "";
  const parsed = new UAParser(ua);
  const browser = parsed.getBrowser();
  const os = parsed.getOS();
  const device = parsed.getDevice();

  const deviceType = device.type ?? (ua.toLowerCase().includes("mobile") ? "mobile" : "desktop");

  let country: string | undefined;
  let city: string | undefined;
  if (ip && ip !== "::1" && ip !== "127.0.0.1") {
    const geo = geoip.lookup(ip);
    if (geo) {
      country = geo.country || undefined;
      city = geo.city || undefined;
    }
  }

  return {
    ipAddress: ip || undefined,
    userAgent: ua || undefined,
    browser: browser.name || undefined,
    os: os.name || undefined,
    deviceType: deviceType || undefined,
    country,
    city,
  };
}

type CachedTags = { openTag: string | null; clickTag: string | null; unsubscribeTag: string | null };
const campaignTagCache = new Map<string, CachedTags & { fetchedAt: number }>();
const campaignTagInflight = new Map<string, Promise<CachedTags | null>>();
const CAMPAIGN_CACHE_TTL = 60000;

async function getCampaignTagsCached(campaignId: string): Promise<CachedTags | null> {
  const cached = campaignTagCache.get(campaignId);
  if (cached && Date.now() - cached.fetchedAt < CAMPAIGN_CACHE_TTL) {
    return { openTag: cached.openTag, clickTag: cached.clickTag, unsubscribeTag: cached.unsubscribeTag };
  }

  const existing = campaignTagInflight.get(campaignId);
  if (existing) return existing;

  const promise = _fetchTagsCached(campaignId).finally(() => campaignTagInflight.delete(campaignId));
  campaignTagInflight.set(campaignId, promise);
  return promise;
}

async function _fetchTagsCached(campaignId: string): Promise<CachedTags | null> {
  const tags = await getCampaignTagsViaTrackingPool(campaignId);
  if (!tags) return null;
  const entry: CachedTags & { fetchedAt: number } = {
    openTag: tags.openTag,
    clickTag: tags.clickTag,
    unsubscribeTag: tags.unsubscribeTag,
    fetchedAt: Date.now(),
  };
  campaignTagCache.set(campaignId, entry);
  if (campaignTagCache.size > 500) {
    const oldest = [...campaignTagCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    for (let i = 0; i < 100; i++) campaignTagCache.delete(oldest[i][0]);
  }
  return { openTag: entry.openTag, clickTag: entry.clickTag, unsubscribeTag: entry.unsubscribeTag };
}

// ─── Complaint bot IPs ──────────────────────────────────────────────────────
// Opens from these IPs are recorded as
// campaign_stats(type='complaint') and bump the campaign's complaints_count,
// without adding an unsubscribe/BCK tag. The tracking buffer applies a
// temporary suppressed_until window only to these IP-attributed complaints.
// The FBL webhook (POST /api/webhooks) remains unchanged.

// ─── Shared HTML helpers ────────────────────────────────────────────────────

function renderUnsubscribePage(status: "success" | "error" | "invalid", message?: string): string {
  const isSuccess = status === "success";
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${isSuccess ? "Désabonnement" : "Erreur"}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center;
           align-items: center; height: 100vh; margin: 0; background: #f9fafb; }
    .card { background: #fff; border-radius: 12px; padding: 48px 40px; text-align: center;
            box-shadow: 0 1px 3px rgba(0,0,0,.1); max-width: 480px; width: 100%; }
    h1 { margin: 0 0 20px; font-size: 2rem; font-weight: 800; color: #333; line-height: 1.2; }
    p  { margin: 0 0 32px; color: #555; line-height: 1.6; font-size: 1.05rem; font-style: italic; }
    .btn { display: inline-block; background: #d33; color: #fff; text-decoration: none;
           padding: 16px 48px; border-radius: 6px; font-size: 1.1rem; font-weight: 600;
           transition: background 0.2s; }
    .btn:hover { background: #b22; }
  </style>
</head>
<body>
  <div class="card">
    ${isSuccess
      ? `<h1>Votre demande est enregistrée</h1>
         <p>Votre demande de désabonnement va bientôt été prise en compte</p>
         <a href="https://redirect.critads.com/r/abort" class="btn">Cliquez-ici pour continuer</a>`
      : `<h1>${status === "invalid" ? "Lien invalide" : "Une erreur est survenue"}</h1>
         <p>${message || "Ce lien de désabonnement est invalide ou a expiré."}</p>`
    }
  </div>
</body>
</html>`;
}

// ─── Short branded tracking routes ─────────────────────────────────────────

export function registerTrackingRoutes(app: Express) {
  /**
   * GET /c/:token  — Short click redirect (branded URL, no destination exposed).
   * Token was generated per-subscriber per-link and stored in tracking_tokens.
   */
  app.get("/c/:token", async (req: Request, res: Response) => {
    const { token } = req.params;
    try {
      // Token resolution must use trackingPool (not main pool).
      const resolved = await resolveTrackingTokenViaTrackingPool(token);
      if (!resolved || resolved.type !== "click" || !resolved.linkId) {
        logger.warn(`Short click token not found or invalid: ${token}`);
        return res.status(404).send("Link not found");
      }
      const { campaignId, subscriberId, linkId } = resolved;

      // LRU-cached lookup against the dedicated tracking pool (warm path = no DB)
      const destinationUrl = await getLinkDestinationCached(linkId);
      if (!destinationUrl) {
        logger.warn(`Short click token ${token}: link destination missing for linkId=${linkId}`);
        return res.status(404).send("Link not found");
      }

      // Open-redirect prevention
      try {
        const parsed = new URL(destinationUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          logger.warn(`Short click token ${token}: blocked non-http protocol`);
          return res.status(400).send("Invalid URL");
        }
      } catch {
        return res.status(400).send("Invalid URL");
      }

      // Redirect immediately, then queue the stat write
      res.redirect(destinationUrl);

      const ctx = extractTrackingContext(req);
      const tags = await getCampaignTagsCached(campaignId).catch(() => null);
      enqueueTrackingEvent({
        type: "click",
        campaignId,
        subscriberId,
        link: destinationUrl,
        ctx,
        clickTag: tags?.clickTag ?? null,
      });
    } catch (error) {
      // Task #57 fix: tracking-pool checkout failures (saturation) become
      // 503 + Retry-After:1 so the recipient's browser auto-retries instead
      // of receiving a generic 500 "Tracking error" page.
      if (isTrackingPoolUnavailable(error) || isPoolCheckoutError(error)) {
        logger.warn(`Short click /c/${token}: tracking pool unavailable, returning 503`);
        if (!res.headersSent) {
          res.setHeader("Retry-After", "1");
          res.status(503).json({ error: "service_busy" });
        }
        return;
      }
      logger.error("Error in short click route:", error);
      if (!res.headersSent) res.status(500).send("Tracking error");
    }
  });

  /**
   * GET /u/:token  — Short unsubscribe page (branded URL).
   * Immediately processes the unsubscribe and returns a confirmation page.
   */
  app.get("/u/:token", async (req: Request, res: Response) => {
    const { token } = req.params;
    try {
      // Token resolution must use trackingPool (not main pool).
      const resolved = await resolveTrackingTokenViaTrackingPool(token);
      if (!resolved || resolved.type !== "unsubscribe") {
        logger.warn(`Short unsubscribe token not found or invalid: ${token}`);
        return res.status(403).send(renderUnsubscribePage("invalid"));
      }
      const { campaignId, subscriberId } = resolved;

      // Respond IMMEDIATELY — do not block the recipient on any DB writes.
      // The buffer's flusher (against trackingPool) handles the actual
      // suppressed_until UPDATE + tag enqueue; bad subscriber IDs are a
      // no-op there (UPDATE … WHERE id = X returns 0 rows).
      res.send(renderUnsubscribePage("success"));

      const ctx = extractTrackingContext(req);
      const tags = await getCampaignTagsCached(campaignId).catch(() => null);
      enqueueTrackingEvent({
        type: "unsubscribe",
        campaignId,
        subscriberId,
        ctx,
        unsubscribeTag: tags?.unsubscribeTag ?? null,
      });
      logger.info(`Short unsubscribe: campaign=${campaignId}, subscriber=${subscriberId}`);
    } catch (error) {
      if (isTrackingPoolUnavailable(error) || isPoolCheckoutError(error)) {
        logger.warn(`Short unsubscribe /u/${token}: tracking pool unavailable, returning 503`);
        if (!res.headersSent) {
          res.setHeader("Retry-After", "1");
          res.status(503).json({ error: "service_busy" });
        }
        return;
      }
      logger.error("Error in short unsubscribe route:", error);
      if (!res.headersSent) res.status(500).send(renderUnsubscribePage("error", "An error occurred. Please try again."));
    }
  });

  /**
   * POST /u/:token  — RFC 8058 one-click unsubscribe.
   * Processes the unsubscribe directly without redirect.
   * Email clients (Gmail, Outlook) POST List-Unsubscribe-Post here.
   */
  app.post("/u/:token", async (req: Request, res: Response) => {
    const { token } = req.params;
    try {
      // Token resolution must use trackingPool (not main pool).
      const resolved = await resolveTrackingTokenViaTrackingPool(token);
      if (!resolved || resolved.type !== "unsubscribe") {
        logger.warn(`POST short unsubscribe token not found or invalid: ${token}`);
        return res.status(404).json({ error: "Unsubscribe token not found" });
      }
      const { campaignId, subscriberId } = resolved;

      // Respond immediately with 200 (RFC 8058 requires 200 on success).
      // No subscriber lookup on the request path — buffer side-effects
      // (against trackingPool) are a no-op for unknown IDs.
      res.status(200).json({ unsubscribed: true });

      const ctx = extractTrackingContext(req);
      const tags = await getCampaignTagsCached(campaignId).catch(() => null);
      enqueueTrackingEvent({
        type: "unsubscribe",
        campaignId,
        subscriberId,
        ctx,
        unsubscribeTag: tags?.unsubscribeTag ?? null,
      });
      logger.info(`POST short unsubscribe (RFC 8058): campaign=${campaignId}, subscriber=${subscriberId}`);
    } catch (error) {
      if (isTrackingPoolUnavailable(error) || isPoolCheckoutError(error)) {
        logger.warn(`POST short unsubscribe /u/${token}: tracking pool unavailable, returning 503`);
        if (!res.headersSent) {
          res.setHeader("Retry-After", "1");
          res.status(503).json({ error: "service_busy" });
        }
        return;
      }
      logger.error("Error in POST short unsubscribe route:", error);
      res.status(500).json({ error: "Unsubscribe failed" });
    }
  });

  const handleOpenTracking = async (req: Request, res: Response) => {
    const { campaignId, subscriberId } = req.params;
    const sig = req.query.sig as string;

    const returnPixel = () => {
      const pixel = Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        "base64"
      );
      res.setHeader("Content-Type", "image/gif");
      res.setHeader(
        "Cache-Control",
        "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
      );
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.send(pixel);
    };

    if (!sig || !verifyTrackingSignature(campaignId, subscriberId, "open", sig)) {
      logger.warn(`Invalid tracking signature for open: campaign=${campaignId}, subscriber=${subscriberId}`);
      return returnPixel();
    }

    // Respond first; persistence happens in the buffered flusher.
    returnPixel();

    try {
      const ctx = extractTrackingContext(req);
      const isComplaintBot = COMPLAINT_IPS.has(ctx.ipAddress || "");

      // Tag lookup is in-process cached (60s TTL) — only one DB hit per
      // campaign per minute, so safe on the request path.
      const tags = await getCampaignTagsCached(campaignId).catch(() => null);

      if (isComplaintBot) {
        // The campaign-level
        // complaints_count and the campaign_stats(type='complaint') analytics
        // row are written. unsubscribeTag remains null so no permanent/plain
        // unsubscribe tag is added; the tracking buffer applies only the
        // complaint-IP temporary suppression window. FBL webhook complaints
        // keep their existing tag behavior and no temporary suppression.
        // skipDedupe so a complaint is never silently dropped because a normal
        // open with the same (campaign, subscriber) was just enqueued.
        enqueueTrackingEvent(
          {
            type: "complaint",
            campaignId,
            subscriberId,
            ctx,
            unsubscribeTag: null,
          },
          { skipDedupe: true },
        );
        logger.info(`[COMPLAINT] Bot open from ${ctx.ipAddress}: campaign=${campaignId}, subscriber=${subscriberId}`);
      } else {
        enqueueTrackingEvent({
          type: "open",
          campaignId,
          subscriberId,
          ctx,
          openTag: tags?.openTag ?? null,
        });
      }
    } catch (error) {
      // Response already sent; just log and move on.
      logger.error("Error queuing open event:", error);
    }
  };

  // Legacy open-pixel route (kept forever so already-sent emails keep recording
  // opens) + the pretty/disguised `/o/.../p.gif` alias new sends use. Both share
  // the exact same handler: campaignId/subscriberId from the path, sig + mid from
  // the query. The trailing `:file` (e.g. p.gif) is cosmetic and ignored.
  app.get("/api/track/open/:campaignId/:subscriberId", handleOpenTracking);
  app.get("/o/:campaignId/:subscriberId/:file", handleOpenTracking);

  app.get("/api/track/click/:campaignId/:subscriberId", async (req: Request, res: Response) => {
    const { campaignId, subscriberId } = req.params;
    const lid = req.query.lid as string | undefined;
    const legacyUrl = req.query.url as string | undefined;
    const sig = req.query.sig as string;

    // ── New format: ?lid=<linkId>&sig=<hmac> ──────────────────────────────
    if (lid) {
      if (!sig || !verifyTrackingSignature(campaignId, subscriberId, "click", sig, lid)) {
        logger.warn(`Invalid tracking signature for click (lid): campaign=${campaignId}, subscriber=${subscriberId}`);
        return res.status(403).json({ error: "Invalid tracking signature" });
      }

      let destinationUrl: string | null;
      try {
        destinationUrl = await getLinkDestinationCached(lid);
      } catch (err: any) {
        // Task #57 fix: tracking-pool checkout failures (saturation) become
        // 503 + Retry-After:1 so the recipient's browser auto-retries instead
        // of receiving a generic 500 "Tracking error" page.
        if (isTrackingPoolUnavailable(err) || isPoolCheckoutError(err)) {
          logger.warn(`Click lid=${lid}: tracking pool unavailable, returning 503`);
          res.setHeader("Retry-After", "1");
          return res.status(503).json({ error: "service_busy" });
        }
        logger.error(`Error looking up link destination lid=${lid}: ${err.message}`);
        return res.status(500).json({ error: "Tracking error" });
      }

      if (!destinationUrl) {
        logger.warn(`Unknown link id: lid=${lid}, campaign=${campaignId}`);
        return res.status(404).json({ error: "Link not found" });
      }

      // Validate resolved URL protocol (open-redirect prevention)
      try {
        const parsed = new URL(destinationUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          logger.warn(`Blocked non-http redirect from link registry: lid=${lid}`);
          return res.status(400).json({ error: "Invalid URL protocol" });
        }
      } catch {
        logger.warn(`Malformed destination URL in link registry: lid=${lid}`);
        return res.status(400).json({ error: "Invalid URL" });
      }

      // Redirect first; persistence happens in the buffered flusher.
      res.redirect(destinationUrl);
      try {
        const ctx = extractTrackingContext(req);
        const tags = await getCampaignTagsCached(campaignId).catch(() => null);
        enqueueTrackingEvent({
          type: "click",
          campaignId,
          subscriberId,
          link: destinationUrl,
          ctx,
          clickTag: tags?.clickTag ?? null,
        });
      } catch (error) {
        logger.error("Error queuing click event (lid):", error);
      }
      return;
    }

    // ── Legacy format: ?url=<encoded>&sig=<hmac> ──────────────────────────
    const url = legacyUrl;
    if (!url) {
      return res.status(400).json({ error: "URL required" });
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        logger.warn(`Blocked non-http redirect attempt: ${url}`);
        return res.status(400).json({ error: "Invalid URL protocol" });
      }
    } catch {
      logger.warn(`Blocked malformed redirect URL: ${url}`);
      return res.status(400).json({ error: "Invalid URL" });
    }

    if (!sig || !verifyTrackingSignature(campaignId, subscriberId, "click", sig, url)) {
      logger.warn(`Invalid tracking signature for click: campaign=${campaignId}, subscriber=${subscriberId}`);
      return res.status(403).json({ error: "Invalid tracking signature" });
    }

    res.redirect(url);
    try {
      const ctx = extractTrackingContext(req);
      const tags = await getCampaignTagsCached(campaignId).catch(() => null);
      enqueueTrackingEvent({
        type: "click",
        campaignId,
        subscriberId,
        link: url,
        ctx,
        clickTag: tags?.clickTag ?? null,
      });
    } catch (error) {
      logger.error("Error queuing click event (legacy):", error);
    }
  });

  app.get("/api/unsubscribe/:campaignId/:subscriberId", async (req: Request, res: Response) => {
    const { campaignId, subscriberId } = req.params;
    const sig = req.query.sig as string;
    
    if (!sig || !verifyTrackingSignature(campaignId, subscriberId, "unsubscribe", sig)) {
      logger.warn(`Invalid tracking signature for unsubscribe: campaign=${campaignId}, subscriber=${subscriberId}, sig=${sig?.slice(0, 8)}...`);
      return res.status(403).send(renderUnsubscribePage("invalid"));
    }

    logger.info(`Unsubscribe request: campaign=${campaignId}, subscriber=${subscriberId}`);
    
    try {
      // Respond immediately — buffer side-effects against trackingPool
      // are no-ops for unknown subscriber IDs, so no main-pool lookup needed.
      res.send(renderUnsubscribePage("success"));

      const ctx = extractTrackingContext(req);
      const tags = await getCampaignTagsCached(campaignId).catch(() => null);
      enqueueTrackingEvent({
        type: "unsubscribe",
        campaignId,
        subscriberId,
        ctx,
        unsubscribeTag: tags?.unsubscribeTag ?? null,
      });
    } catch (error) {
      if (isTrackingPoolUnavailable(error) || isPoolCheckoutError(error)) {
        logger.warn(`Unsubscribe: tracking pool unavailable, returning 503`);
        if (!res.headersSent) {
          res.setHeader("Retry-After", "1");
          res.status(503).json({ error: "service_busy" });
        }
        return;
      }
      logger.error("Error unsubscribing:", error);
      if (!res.headersSent) res.status(500).send("An error occurred");
    }
  });
}
