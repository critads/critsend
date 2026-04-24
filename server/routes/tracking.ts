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
import { withAdvisoryLock, indexExistsAndValid, columnHasData, LOCK_KEYS } from "../bootstrap-lock";
import {
  resolveTrackingTokenViaTrackingPool,
  getCampaignTagsViaTrackingPool,
} from "../tracking-queries";

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
            SET suppressed_until = cs.last_unsub + INTERVAL '30 days'
            FROM (
              SELECT subscriber_id, MAX(timestamp) AS last_unsub
              FROM campaign_stats
              WHERE type = 'unsubscribe'
                AND timestamp > NOW() - INTERVAL '7 days'
              GROUP BY subscriber_id
            ) cs
            WHERE s.id = cs.subscriber_id
              AND (s.suppressed_until IS NULL OR s.suppressed_until < cs.last_unsub + INTERVAL '30 days')
          `);
          logger.info("[TRACKING] Bootstrap migration: suppressed_until column ready, recent unsubscribers backfilled");
        } else {
          logger.info("[TRACKING] Bootstrap migration: suppressed_until column already populated — skipping backfill");
        }
      } catch (err: any) {
        logger.error(`[TRACKING] Bootstrap migration FAILED (suppressed_until): ${err?.message || err}`);
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
    },
  );
})();

function extractTrackingContext(req: Request): TrackingContext {
  const rawIp =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] as string ||
    req.socket.remoteAddress ||
    "";
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
const CAMPAIGN_CACHE_TTL = 60000;

async function getCampaignTagsCached(campaignId: string): Promise<CachedTags | null> {
  const cached = campaignTagCache.get(campaignId);
  if (cached && Date.now() - cached.fetchedAt < CAMPAIGN_CACHE_TTL) {
    return { openTag: cached.openTag, clickTag: cached.clickTag, unsubscribeTag: cached.unsubscribeTag };
  }
  // IMPORTANT: cache miss must go through trackingPool, NOT the main pool —
  // the whole point of the dedicated tracking pool is that pixel-fueled
  // bursts cannot drain the main pool and starve user-facing requests.
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
const COMPLAINT_BOT_IPS = new Set([
  "195.154.17.225",
]);

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

  app.get("/api/track/open/:campaignId/:subscriberId", async (req: Request, res: Response) => {
    const { campaignId, subscriberId } = req.params;
    const sig = req.query.sig as string;

    const returnPixel = () => {
      const pixel = Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        "base64"
      );
      res.setHeader("Content-Type", "image/gif");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
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
      const isComplaintBot = COMPLAINT_BOT_IPS.has(ctx.ipAddress || "");

      // Tag lookup is in-process cached (60s TTL) — only one DB hit per
      // campaign per minute, so safe on the request path.
      const tags = await getCampaignTagsCached(campaignId).catch(() => null);

      if (isComplaintBot) {
        // Buffer handles setSuppressedUntil + STOP-tag inside processSideEffects.
        // unsubscribeTag comes from the same cached lookup — no second DB roundtrip.
        // skipDedupe so a complaint is never silently dropped because a normal
        // open with the same (campaign, subscriber) was just enqueued.
        enqueueTrackingEvent(
          {
            type: "complaint",
            campaignId,
            subscriberId,
            ctx,
            unsubscribeTag: tags?.unsubscribeTag ?? null,
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
  });

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
