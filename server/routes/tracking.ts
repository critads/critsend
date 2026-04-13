import { type Express, type Request, type Response } from "express";
import { storage } from "../storage";
import { db } from "../db";
import { sql } from "drizzle-orm";
import { logger } from "../logger";
import { verifyTrackingSignature } from "../tracking";
import { UAParser } from "ua-parser-js";
import geoip from "geoip-lite";
import type { TrackingContext } from "../repositories/campaign-repository";

// Bootstrap: add suppressed_until column and backfill subscribers who unsubscribed
// in the last 7 days so the 30-day cooling-off window applies to existing data.
(async () => {
  try {
    await db.execute(sql`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS suppressed_until TIMESTAMP`);
    // Retroactively suppress anyone who clicked unsubscribe in the last 7 days.
    // Uses MAX(timestamp) so a subscriber who unsubscribed multiple times gets
    // the most recent event as the start of their 30-day window.
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
  } catch (err: any) {
    logger.error(`[TRACKING] Bootstrap migration FAILED (suppressed_until): ${err?.message || err}`);
  }
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

const campaignTagCache = new Map<string, { openTag: string | null; clickTag: string | null; fetchedAt: number }>();
const CAMPAIGN_CACHE_TTL = 60000;

async function getCampaignTagsCached(campaignId: string): Promise<{ openTag: string | null; clickTag: string | null } | null> {
  const cached = campaignTagCache.get(campaignId);
  if (cached && Date.now() - cached.fetchedAt < CAMPAIGN_CACHE_TTL) {
    return { openTag: cached.openTag, clickTag: cached.clickTag };
  }
  const campaign = await storage.getCampaign(campaignId);
  if (!campaign) return null;
  campaignTagCache.set(campaignId, {
    openTag: campaign.openTag || null,
    clickTag: campaign.clickTag || null,
    fetchedAt: Date.now(),
  });
  if (campaignTagCache.size > 500) {
    const oldest = [...campaignTagCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    for (let i = 0; i < 100; i++) campaignTagCache.delete(oldest[i][0]);
  }
  return { openTag: campaign.openTag || null, clickTag: campaign.clickTag || null };
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
      const resolved = await storage.resolveTrackingToken(token);
      if (!resolved || resolved.type !== "click" || !resolved.linkId) {
        logger.warn(`Short click token not found or invalid: ${token}`);
        return res.status(404).send("Link not found");
      }
      const { campaignId, subscriberId, linkId } = resolved;

      const destinationUrl = await storage.getCampaignLinkDestination(linkId);
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

      // Record stat and redirect
      const ctx = extractTrackingContext(req);
      const isFirstClick = await storage.recordFirstClick(campaignId, subscriberId);
      await storage.addCampaignStat(campaignId, subscriberId, "click", destinationUrl, ctx);
      res.redirect(destinationUrl);

      if (isFirstClick) {
        const tags = await getCampaignTagsCached(campaignId);
        if (tags?.clickTag) {
          storage.enqueueTagOperation(subscriberId, tags.clickTag, "click", campaignId)
            .catch(err => logger.error("Failed to enqueue click tag (short):", err));
        }
      }
    } catch (error) {
      logger.error("Error in short click route:", error);
      res.status(500).send("Tracking error");
    }
  });

  /**
   * GET /u/:token  — Short unsubscribe page (branded URL).
   * Immediately processes the unsubscribe and returns a confirmation page.
   */
  app.get("/u/:token", async (req: Request, res: Response) => {
    const { token } = req.params;
    try {
      const resolved = await storage.resolveTrackingToken(token);
      if (!resolved || resolved.type !== "unsubscribe") {
        logger.warn(`Short unsubscribe token not found or invalid: ${token}`);
        return res.status(403).send(renderUnsubscribePage("invalid"));
      }
      const { campaignId, subscriberId } = resolved;

      const subscriber = await storage.getSubscriber(subscriberId);
      res.send(renderUnsubscribePage("success"));

      if (subscriber) {
        const ctx = extractTrackingContext(req);
        const campaign = await storage.getCampaign(campaignId);

        storage.addCampaignStat(campaignId, subscriberId, "unsubscribe", undefined, ctx)
          .catch(err => logger.error("Failed to record unsubscribe stat (short):", err));

        storage.setSuppressedUntil(subscriberId)
          .catch(err => logger.error("Failed to set suppressed_until (short):", err));

        if (campaign?.unsubscribeTag) {
          storage.enqueueTagOperation(subscriberId, campaign.unsubscribeTag, "unsubscribe", campaignId)
            .then(() => logger.info(`Short unsub: tag '${campaign.unsubscribeTag}' enqueued for subscriber=${subscriberId}`))
            .catch(err => logger.error("Failed to enqueue unsubscribe tag (short):", err));
        }
        logger.info(`Short unsubscribe: campaign=${campaignId}, subscriber=${subscriberId}`);
      } else {
        logger.warn(`Short unsubscribe: subscriber not found: ${subscriberId}`);
      }
    } catch (error) {
      logger.error("Error in short unsubscribe route:", error);
      res.status(500).send(renderUnsubscribePage("error", "An error occurred. Please try again."));
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
      const resolved = await storage.resolveTrackingToken(token);
      if (!resolved || resolved.type !== "unsubscribe") {
        logger.warn(`POST short unsubscribe token not found or invalid: ${token}`);
        return res.status(404).json({ error: "Unsubscribe token not found" });
      }
      const { campaignId, subscriberId } = resolved;

      const subscriber = await storage.getSubscriber(subscriberId);
      // Respond immediately with 200 (RFC 8058 requires 200 on success)
      res.status(200).json({ unsubscribed: true });

      if (subscriber) {
        const ctx = extractTrackingContext(req);
        const campaign = await storage.getCampaign(campaignId);

        storage.addCampaignStat(campaignId, subscriberId, "unsubscribe", undefined, ctx)
          .catch(err => logger.error("Failed to record unsubscribe stat (POST short):", err));

        storage.setSuppressedUntil(subscriberId)
          .catch(err => logger.error("Failed to set suppressed_until (POST short):", err));

        if (campaign?.unsubscribeTag) {
          storage.enqueueTagOperation(subscriberId, campaign.unsubscribeTag, "unsubscribe", campaignId)
            .then(() => logger.info(`POST short unsub: tag '${campaign.unsubscribeTag}' enqueued for subscriber=${subscriberId}`))
            .catch(err => logger.error("Failed to enqueue unsubscribe tag (POST short):", err));
        }
        logger.info(`POST short unsubscribe (RFC 8058): campaign=${campaignId}, subscriber=${subscriberId}`);
      } else {
        logger.warn(`POST short unsubscribe: subscriber not found: ${subscriberId}`);
      }
    } catch (error) {
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
    
    try {
      const ctx = extractTrackingContext(req);
      const isComplaintBot = COMPLAINT_BOT_IPS.has(ctx.ipAddress || "");

      if (isComplaintBot) {
        await storage.addCampaignStat(campaignId, subscriberId, "complaint", undefined, ctx);
        returnPixel();

        const campaign = await storage.getCampaign(campaignId);
        if (campaign?.unsubscribeTag) {
          const stopTag = `STOP-${campaign.unsubscribeTag}`;
          storage.enqueueTagOperation(subscriberId, stopTag, "unsubscribe", campaignId)
            .then(() => logger.info(`[COMPLAINT] Bot IP ${ctx.ipAddress}: tag '${stopTag}' enqueued for subscriber=${subscriberId}, campaign=${campaignId}`))
            .catch(err => logger.error("Failed to enqueue complaint stop tag:", err));
        }

        storage.setSuppressedUntil(subscriberId)
          .catch(err => logger.error("Failed to set suppressed_until for complaint:", err));

        logger.info(`[COMPLAINT] Bot open from ${ctx.ipAddress}: campaign=${campaignId}, subscriber=${subscriberId}`);
      } else {
        const isFirstOpen = await storage.recordFirstOpen(campaignId, subscriberId);
        await storage.addCampaignStat(campaignId, subscriberId, "open", undefined, ctx);
        returnPixel();

        if (isFirstOpen) {
          const tags = await getCampaignTagsCached(campaignId);
          if (tags?.openTag) {
            storage.enqueueTagOperation(subscriberId, tags.openTag, "open", campaignId)
              .catch(err => logger.error("Failed to enqueue open tag:", err));
          }
        }
      }
    } catch (error) {
      logger.error("Error tracking open:", error);
      returnPixel();
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
        destinationUrl = await storage.getCampaignLinkDestination(lid);
      } catch (err: any) {
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

      try {
        const ctx = extractTrackingContext(req);
        const isFirstClick = await storage.recordFirstClick(campaignId, subscriberId);
        await storage.addCampaignStat(campaignId, subscriberId, "click", destinationUrl, ctx);
        res.redirect(destinationUrl);
        if (isFirstClick) {
          const tags = await getCampaignTagsCached(campaignId);
          if (tags?.clickTag) {
            storage.enqueueTagOperation(subscriberId, tags.clickTag, "click", campaignId)
              .catch(err => logger.error("Failed to enqueue click tag:", err));
          }
        }
      } catch (error) {
        logger.error("Error tracking click (lid):", error);
        return res.status(500).json({ error: "Tracking error" });
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

    try {
      const ctx = extractTrackingContext(req);
      const isFirstClick = await storage.recordFirstClick(campaignId, subscriberId);
      await storage.addCampaignStat(campaignId, subscriberId, "click", url, ctx);
      res.redirect(url);
      if (isFirstClick) {
        const tags = await getCampaignTagsCached(campaignId);
        if (tags?.clickTag) {
          storage.enqueueTagOperation(subscriberId, tags.clickTag, "click", campaignId)
            .catch(err => logger.error("Failed to enqueue click tag:", err));
        }
      }
    } catch (error) {
      logger.error("Error tracking click:", error);
      return res.status(500).json({ error: "Tracking error" });
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
      const campaign = await storage.getCampaign(campaignId);
      const subscriber = await storage.getSubscriber(subscriberId);
      
      res.send(renderUnsubscribePage("success"));
      
      if (subscriber) {
        const ctx = extractTrackingContext(req);

        storage.addCampaignStat(campaignId, subscriberId, "unsubscribe", undefined, ctx)
          .catch(err => logger.error("Failed to record unsubscribe stat:", err));

        storage.setSuppressedUntil(subscriberId)
          .catch(err => logger.error("Failed to set suppressed_until:", err));

        if (campaign?.unsubscribeTag) {
          storage.enqueueTagOperation(subscriberId, campaign.unsubscribeTag, "unsubscribe", campaignId)
            .then(() => logger.info(`Unsubscribe tag '${campaign.unsubscribeTag}' enqueued for subscriber=${subscriberId}`))
            .catch(err => logger.error("Failed to enqueue unsubscribe tag:", err));
        }
      } else {
        logger.warn(`Unsubscribe: subscriber not found: ${subscriberId}`);
      }
    } catch (error) {
      logger.error("Error unsubscribing:", error);
      res.status(500).send("An error occurred");
    }
  });
}
