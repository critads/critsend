import { type Express, type Request, type Response } from "express";
import { storage } from "../storage";
import { logger } from "../logger";
import { verifyTrackingSignature } from "../tracking";
import { UAParser } from "ua-parser-js";
import geoip from "geoip-lite";
import type { TrackingContext } from "../repositories/campaign-repository";

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

export function registerTrackingRoutes(app: Express) {
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
    } catch (error) {
      logger.error("Error tracking open:", error);
      returnPixel();
    }
  });

  app.get("/api/track/click/:campaignId/:subscriberId", async (req: Request, res: Response) => {
    const { campaignId, subscriberId } = req.params;
    const url = req.query.url as string;
    const sig = req.query.sig as string;
    
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
      return res.status(403).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Invalid Link</title>
          <style>
            body { font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
            .container { text-align: center; }
            h1 { color: #c00; }
            p { color: #666; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Invalid Link</h1>
            <p>This unsubscribe link is invalid or has expired.</p>
          </div>
        </body>
        </html>
      `);
    }

    logger.info(`Unsubscribe request: campaign=${campaignId}, subscriber=${subscriberId}`);
    
    try {
      const campaign = await storage.getCampaign(campaignId);
      const subscriber = await storage.getSubscriber(subscriberId);
      
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Unsubscribed</title>
          <style>
            body { font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
            .container { text-align: center; }
            h1 { color: #333; }
            p { color: #666; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Unsubscribed Successfully</h1>
            <p>You have been removed from our mailing list.</p>
          </div>
        </body>
        </html>
      `);
      
      if (subscriber) {
        const ctx = extractTrackingContext(req);

        storage.addCampaignStat(campaignId, subscriberId, "unsubscribe", undefined, ctx)
          .catch(err => logger.error("Failed to record unsubscribe stat:", err));

        storage.enqueueTagOperation(subscriberId, "BCK", "unsubscribe", campaignId)
          .then(() => logger.info(`BCK tag enqueued for subscriber=${subscriberId}`))
          .catch(err => logger.error("Failed to enqueue BCK tag:", err));
        
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
