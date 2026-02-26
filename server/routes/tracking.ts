import { type Express, type Request, type Response } from "express";
import { storage } from "../storage";
import { logger } from "../logger";
import { verifyTrackingSignature } from "../tracking";

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
      const isFirstOpen = await storage.recordFirstOpen(campaignId, subscriberId);
      
      await storage.addCampaignStat(campaignId, subscriberId, "open");
      
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
      const isFirstClick = await storage.recordFirstClick(campaignId, subscriberId);
      
      await storage.addCampaignStat(campaignId, subscriberId, "click", url);
      
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
      logger.warn(`Invalid tracking signature for unsubscribe: campaign=${campaignId}, subscriber=${subscriberId}`);
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
        storage.enqueueTagOperation(subscriberId, "BCK", "unsubscribe", campaignId)
          .catch(err => logger.error("Failed to enqueue BCK tag:", err));
        
        if (campaign?.unsubscribeTag) {
          storage.enqueueTagOperation(subscriberId, campaign.unsubscribeTag, "unsubscribe", campaignId)
            .catch(err => logger.error("Failed to enqueue unsubscribe tag:", err));
        }
      }
    } catch (error) {
      logger.error("Error unsubscribing:", error);
      res.status(500).send("An error occurred");
    }
  });
}
