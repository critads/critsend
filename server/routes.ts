import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import multer from "multer";
import { Readable } from "stream";
import {
  insertSubscriberSchema,
  insertSegmentSchema,
  insertMtaSchema,
  insertEmailHeaderSchema,
  insertCampaignSchema,
} from "@shared/schema";
import { z } from "zod";

const upload = multer({ storage: multer.memoryStorage() });

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // ============ SUBSCRIBERS ============
  app.get("/api/subscribers", async (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const search = req.query.search as string | undefined;
      
      const result = await storage.getSubscribers(page, limit, search);
      res.json({
        ...result,
        page,
        limit,
        totalPages: Math.ceil(result.total / limit),
      });
    } catch (error) {
      console.error("Error fetching subscribers:", error);
      res.status(500).json({ error: "Failed to fetch subscribers" });
    }
  });

  app.get("/api/subscribers/:id", async (req: Request, res: Response) => {
    try {
      const subscriber = await storage.getSubscriber(req.params.id);
      if (!subscriber) {
        return res.status(404).json({ error: "Subscriber not found" });
      }
      res.json(subscriber);
    } catch (error) {
      console.error("Error fetching subscriber:", error);
      res.status(500).json({ error: "Failed to fetch subscriber" });
    }
  });

  app.post("/api/subscribers", async (req: Request, res: Response) => {
    try {
      const data = insertSubscriberSchema.parse(req.body);
      
      // Check if email already exists
      const existing = await storage.getSubscriberByEmail(data.email);
      if (existing) {
        // Update tags instead
        const updated = await storage.updateSubscriber(existing.id, {
          tags: [...new Set([...(existing.tags || []), ...(data.tags || [])])],
        });
        return res.json(updated);
      }
      
      const subscriber = await storage.createSubscriber(data);
      res.status(201).json(subscriber);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Error creating subscriber:", error);
      res.status(500).json({ error: "Failed to create subscriber" });
    }
  });

  app.patch("/api/subscribers/:id", async (req: Request, res: Response) => {
    try {
      const subscriber = await storage.updateSubscriber(req.params.id, req.body);
      if (!subscriber) {
        return res.status(404).json({ error: "Subscriber not found" });
      }
      res.json(subscriber);
    } catch (error) {
      console.error("Error updating subscriber:", error);
      res.status(500).json({ error: "Failed to update subscriber" });
    }
  });

  app.delete("/api/subscribers/:id", async (req: Request, res: Response) => {
    try {
      await storage.deleteSubscriber(req.params.id);
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting subscriber:", error);
      res.status(500).json({ error: "Failed to delete subscriber" });
    }
  });

  // ============ SEGMENTS ============
  app.get("/api/segments", async (req: Request, res: Response) => {
    try {
      const segmentsList = await storage.getSegments();
      // Add subscriber count to each segment
      const segmentsWithCounts = await Promise.all(
        segmentsList.map(async (segment) => ({
          ...segment,
          subscriberCount: await storage.countSubscribersForSegment(segment.id),
        }))
      );
      res.json(segmentsWithCounts);
    } catch (error) {
      console.error("Error fetching segments:", error);
      res.status(500).json({ error: "Failed to fetch segments" });
    }
  });

  app.get("/api/segments/:id", async (req: Request, res: Response) => {
    try {
      const segment = await storage.getSegment(req.params.id);
      if (!segment) {
        return res.status(404).json({ error: "Segment not found" });
      }
      res.json(segment);
    } catch (error) {
      console.error("Error fetching segment:", error);
      res.status(500).json({ error: "Failed to fetch segment" });
    }
  });

  app.get("/api/segments/:id/count", async (req: Request, res: Response) => {
    try {
      const count = await storage.countSubscribersForSegment(req.params.id);
      res.json({ count });
    } catch (error) {
      console.error("Error counting segment subscribers:", error);
      res.status(500).json({ error: "Failed to count subscribers" });
    }
  });

  app.post("/api/segments", async (req: Request, res: Response) => {
    try {
      const data = insertSegmentSchema.parse(req.body);
      const segment = await storage.createSegment(data);
      res.status(201).json(segment);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Error creating segment:", error);
      res.status(500).json({ error: "Failed to create segment" });
    }
  });

  app.patch("/api/segments/:id", async (req: Request, res: Response) => {
    try {
      const segment = await storage.updateSegment(req.params.id, req.body);
      if (!segment) {
        return res.status(404).json({ error: "Segment not found" });
      }
      res.json(segment);
    } catch (error) {
      console.error("Error updating segment:", error);
      res.status(500).json({ error: "Failed to update segment" });
    }
  });

  app.delete("/api/segments/:id", async (req: Request, res: Response) => {
    try {
      await storage.deleteSegment(req.params.id);
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting segment:", error);
      res.status(500).json({ error: "Failed to delete segment" });
    }
  });

  // ============ MTAs ============
  app.get("/api/mtas", async (req: Request, res: Response) => {
    try {
      const mtasList = await storage.getMtas();
      res.json(mtasList);
    } catch (error) {
      console.error("Error fetching MTAs:", error);
      res.status(500).json({ error: "Failed to fetch MTAs" });
    }
  });

  app.get("/api/mtas/:id", async (req: Request, res: Response) => {
    try {
      const mta = await storage.getMta(req.params.id);
      if (!mta) {
        return res.status(404).json({ error: "MTA not found" });
      }
      res.json(mta);
    } catch (error) {
      console.error("Error fetching MTA:", error);
      res.status(500).json({ error: "Failed to fetch MTA" });
    }
  });

  app.post("/api/mtas", async (req: Request, res: Response) => {
    try {
      const data = insertMtaSchema.parse(req.body);
      const mta = await storage.createMta(data);
      res.status(201).json(mta);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Error creating MTA:", error);
      res.status(500).json({ error: "Failed to create MTA" });
    }
  });

  app.patch("/api/mtas/:id", async (req: Request, res: Response) => {
    try {
      const mta = await storage.updateMta(req.params.id, req.body);
      if (!mta) {
        return res.status(404).json({ error: "MTA not found" });
      }
      res.json(mta);
    } catch (error) {
      console.error("Error updating MTA:", error);
      res.status(500).json({ error: "Failed to update MTA" });
    }
  });

  app.delete("/api/mtas/:id", async (req: Request, res: Response) => {
    try {
      await storage.deleteMta(req.params.id);
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting MTA:", error);
      res.status(500).json({ error: "Failed to delete MTA" });
    }
  });

  // ============ EMAIL HEADERS ============
  app.get("/api/headers", async (req: Request, res: Response) => {
    try {
      const headers = await storage.getHeaders();
      res.json(headers);
    } catch (error) {
      console.error("Error fetching headers:", error);
      res.status(500).json({ error: "Failed to fetch headers" });
    }
  });

  app.post("/api/headers", async (req: Request, res: Response) => {
    try {
      const data = insertEmailHeaderSchema.parse(req.body);
      const header = await storage.createHeader(data);
      res.status(201).json(header);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Error creating header:", error);
      res.status(500).json({ error: "Failed to create header" });
    }
  });

  app.patch("/api/headers/:id", async (req: Request, res: Response) => {
    try {
      const header = await storage.updateHeader(req.params.id, req.body);
      if (!header) {
        return res.status(404).json({ error: "Header not found" });
      }
      res.json(header);
    } catch (error) {
      console.error("Error updating header:", error);
      res.status(500).json({ error: "Failed to update header" });
    }
  });

  app.delete("/api/headers/:id", async (req: Request, res: Response) => {
    try {
      await storage.deleteHeader(req.params.id);
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting header:", error);
      res.status(500).json({ error: "Failed to delete header" });
    }
  });

  // ============ CAMPAIGNS ============
  app.get("/api/campaigns", async (req: Request, res: Response) => {
    try {
      const campaignsList = await storage.getCampaigns();
      res.json(campaignsList);
    } catch (error) {
      console.error("Error fetching campaigns:", error);
      res.status(500).json({ error: "Failed to fetch campaigns" });
    }
  });

  app.get("/api/campaigns/:id", async (req: Request, res: Response) => {
    try {
      const campaign = await storage.getCampaign(req.params.id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      res.json(campaign);
    } catch (error) {
      console.error("Error fetching campaign:", error);
      res.status(500).json({ error: "Failed to fetch campaign" });
    }
  });

  app.post("/api/campaigns", async (req: Request, res: Response) => {
    try {
      const data = insertCampaignSchema.parse(req.body);
      const campaign = await storage.createCampaign(data);
      
      // If status is sending, start the sending process
      if (campaign.status === "sending") {
        // Start sending in background (simplified - real implementation would use job queue)
        processCampaign(campaign.id).catch(console.error);
      }
      
      res.status(201).json(campaign);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Error creating campaign:", error);
      res.status(500).json({ error: "Failed to create campaign" });
    }
  });

  app.patch("/api/campaigns/:id", async (req: Request, res: Response) => {
    try {
      const campaign = await storage.updateCampaign(req.params.id, req.body);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      res.json(campaign);
    } catch (error) {
      console.error("Error updating campaign:", error);
      res.status(500).json({ error: "Failed to update campaign" });
    }
  });

  app.delete("/api/campaigns/:id", async (req: Request, res: Response) => {
    try {
      await storage.deleteCampaign(req.params.id);
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting campaign:", error);
      res.status(500).json({ error: "Failed to delete campaign" });
    }
  });

  app.post("/api/campaigns/:id/copy", async (req: Request, res: Response) => {
    try {
      const campaign = await storage.copyCampaign(req.params.id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      res.status(201).json(campaign);
    } catch (error) {
      console.error("Error copying campaign:", error);
      res.status(500).json({ error: "Failed to copy campaign" });
    }
  });

  app.post("/api/campaigns/:id/pause", async (req: Request, res: Response) => {
    try {
      const campaign = await storage.updateCampaign(req.params.id, { status: "paused" });
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      res.json(campaign);
    } catch (error) {
      console.error("Error pausing campaign:", error);
      res.status(500).json({ error: "Failed to pause campaign" });
    }
  });

  app.post("/api/campaigns/:id/resume", async (req: Request, res: Response) => {
    try {
      const campaign = await storage.updateCampaign(req.params.id, { status: "sending" });
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      // Resume sending process
      processCampaign(campaign.id).catch(console.error);
      res.json(campaign);
    } catch (error) {
      console.error("Error resuming campaign:", error);
      res.status(500).json({ error: "Failed to resume campaign" });
    }
  });

  // ============ IMPORT ============
  app.post("/api/import", upload.single("file"), async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const content = req.file.buffer.toString("utf-8");
      const lines = content.split("\n").filter(line => line.trim());
      
      if (lines.length < 2) {
        return res.status(400).json({ error: "CSV file is empty or invalid" });
      }

      // Create import job
      const job = await storage.createImportJob({
        filename: req.file.originalname,
        totalRows: lines.length - 1, // Exclude header
      });

      // Process in background
      processImport(job.id, lines).catch(console.error);

      res.status(202).json(job);
    } catch (error) {
      console.error("Error starting import:", error);
      res.status(500).json({ error: "Failed to start import" });
    }
  });

  app.get("/api/import-jobs", async (req: Request, res: Response) => {
    try {
      const jobs = await storage.getImportJobs();
      res.json(jobs);
    } catch (error) {
      console.error("Error fetching import jobs:", error);
      res.status(500).json({ error: "Failed to fetch import jobs" });
    }
  });

  // ============ EXPORT ============
  app.get("/api/export", async (req: Request, res: Response) => {
    try {
      const fields = (req.query.fields as string)?.split(",") || ["email", "tags", "ipAddress", "importDate"];
      
      let page = 1;
      const limit = 10000;
      let csvContent = fields.join(",") + "\n";
      
      while (true) {
        const { subscribers: subs, total } = await storage.getSubscribers(page, limit);
        
        for (const sub of subs) {
          const row = fields.map(field => {
            if (field === "email") return sub.email;
            if (field === "tags") return (sub.tags || []).join(";");
            if (field === "ipAddress") return sub.ipAddress || "";
            if (field === "importDate") return sub.importDate.toISOString();
            return "";
          });
          csvContent += row.join(",") + "\n";
        }
        
        if (page * limit >= total) break;
        page++;
      }
      
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename=critsend-export-${new Date().toISOString().split("T")[0]}.csv`);
      res.send(csvContent);
    } catch (error) {
      console.error("Error exporting:", error);
      res.status(500).json({ error: "Failed to export" });
    }
  });

  // ============ DASHBOARD ============
  app.get("/api/dashboard/stats", async (req: Request, res: Response) => {
    try {
      const stats = await storage.getDashboardStats();
      res.json(stats);
    } catch (error) {
      console.error("Error fetching dashboard stats:", error);
      res.status(500).json({ error: "Failed to fetch dashboard stats" });
    }
  });

  // ============ ANALYTICS ============
  app.get("/api/analytics/overall", async (req: Request, res: Response) => {
    try {
      const analytics = await storage.getOverallAnalytics();
      res.json(analytics);
    } catch (error) {
      console.error("Error fetching overall analytics:", error);
      res.status(500).json({ error: "Failed to fetch analytics" });
    }
  });

  app.get("/api/analytics/campaign/:id", async (req: Request, res: Response) => {
    try {
      const analytics = await storage.getCampaignAnalytics(req.params.id);
      if (!analytics) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      res.json(analytics);
    } catch (error) {
      console.error("Error fetching campaign analytics:", error);
      res.status(500).json({ error: "Failed to fetch campaign analytics" });
    }
  });

  // ============ TRACKING PIXELS & LINKS ============
  app.get("/api/track/open/:campaignId/:subscriberId", async (req: Request, res: Response) => {
    try {
      const { campaignId, subscriberId } = req.params;
      
      // Record the open
      await storage.addCampaignStat(campaignId, subscriberId, "open");
      
      // Add tag if configured
      const campaign = await storage.getCampaign(campaignId);
      if (campaign?.openTag) {
        const subscriber = await storage.getSubscriber(subscriberId);
        if (subscriber) {
          const tags = [...new Set([...(subscriber.tags || []), campaign.openTag])];
          await storage.updateSubscriber(subscriberId, { tags });
        }
      }
      
      // Return 1x1 transparent pixel
      const pixel = Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        "base64"
      );
      res.setHeader("Content-Type", "image/gif");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.send(pixel);
    } catch (error) {
      console.error("Error tracking open:", error);
      // Still return pixel even on error
      const pixel = Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        "base64"
      );
      res.setHeader("Content-Type", "image/gif");
      res.send(pixel);
    }
  });

  app.get("/api/track/click/:campaignId/:subscriberId", async (req: Request, res: Response) => {
    try {
      const { campaignId, subscriberId } = req.params;
      const url = req.query.url as string;
      
      if (!url) {
        return res.status(400).json({ error: "URL required" });
      }
      
      // Record the click
      await storage.addCampaignStat(campaignId, subscriberId, "click", url);
      
      // Add tag if configured
      const campaign = await storage.getCampaign(campaignId);
      if (campaign?.clickTag) {
        const subscriber = await storage.getSubscriber(subscriberId);
        if (subscriber) {
          const tags = [...new Set([...(subscriber.tags || []), campaign.clickTag])];
          await storage.updateSubscriber(subscriberId, { tags });
        }
      }
      
      // Redirect to actual URL
      res.redirect(url);
    } catch (error) {
      console.error("Error tracking click:", error);
      const url = req.query.url as string;
      if (url) {
        res.redirect(url);
      } else {
        res.status(500).json({ error: "Failed to track click" });
      }
    }
  });

  app.get("/api/unsubscribe/:campaignId/:subscriberId", async (req: Request, res: Response) => {
    try {
      const { campaignId, subscriberId } = req.params;
      
      const campaign = await storage.getCampaign(campaignId);
      const subscriber = await storage.getSubscriber(subscriberId);
      
      if (subscriber) {
        // Add BCK tag (blocklist) and unsubscribe tag if configured
        const tags = [...new Set([
          ...(subscriber.tags || []),
          "BCK",
          ...(campaign?.unsubscribeTag ? [campaign.unsubscribeTag] : []),
        ])];
        await storage.updateSubscriber(subscriberId, { tags });
      }
      
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
    } catch (error) {
      console.error("Error unsubscribing:", error);
      res.status(500).send("An error occurred");
    }
  });

  return httpServer;
}

// Background process for importing CSV
async function processImport(jobId: string, lines: string[]) {
  const BATCH_SIZE = 20000;
  const header = lines[0].split(",").map(h => h.trim().toLowerCase());
  const emailIdx = header.indexOf("email");
  const tagsIdx = header.indexOf("tags");
  const ipIdx = header.indexOf("ip_address");
  
  if (emailIdx === -1) {
    await storage.updateImportJob(jobId, {
      status: "failed",
      errorMessage: "CSV must have an 'email' column",
    });
    return;
  }
  
  await storage.updateImportJob(jobId, { status: "processing" });
  
  let processedRows = 0;
  let newSubscribers = 0;
  let updatedSubscribers = 0;
  let failedRows = 0;
  
  // Process in batches
  for (let i = 1; i < lines.length; i += BATCH_SIZE) {
    const batch = lines.slice(i, Math.min(i + BATCH_SIZE, lines.length));
    
    for (const line of batch) {
      try {
        const cols = line.split(",").map(c => c.trim());
        const email = cols[emailIdx];
        
        if (!email || !email.includes("@")) {
          failedRows++;
          processedRows++;
          continue;
        }
        
        const tags = tagsIdx >= 0 && cols[tagsIdx]
          ? cols[tagsIdx].replace(/"/g, "").split(";").map(t => t.trim().toUpperCase()).filter(Boolean)
          : [];
        const ipAddress = ipIdx >= 0 ? cols[ipIdx] : undefined;
        
        const existing = await storage.getSubscriberByEmail(email);
        
        if (existing) {
          // Merge tags
          const mergedTags = [...new Set([...(existing.tags || []), ...tags])];
          await storage.updateSubscriber(existing.id, { tags: mergedTags });
          updatedSubscribers++;
        } else {
          await storage.createSubscriber({ email, tags, ipAddress });
          newSubscribers++;
        }
        processedRows++;
      } catch (error) {
        console.error("Error processing row:", error);
        failedRows++;
        processedRows++;
      }
    }
    
    // Update job progress
    await storage.updateImportJob(jobId, {
      processedRows,
      newSubscribers,
      updatedSubscribers,
      failedRows,
    });
  }
  
  await storage.updateImportJob(jobId, {
    status: "completed",
    completedAt: new Date(),
    processedRows,
    newSubscribers,
    updatedSubscribers,
    failedRows,
  });
}

// Sending speed configurations (emails per minute)
const SPEED_CONFIG: Record<string, number> = {
  slow: 500,
  medium: 1000,
  fast: 2000,
  godzilla: 3000,
};

// Background process for sending campaign with proper batching and speed control
async function processCampaign(campaignId: string) {
  const campaign = await storage.getCampaign(campaignId);
  if (!campaign || campaign.status !== "sending") return;
  
  if (!campaign.segmentId) {
    await storage.updateCampaign(campaignId, { status: "failed" });
    return;
  }
  
  // Get total count first (uses SQL, doesn't load all into memory)
  const total = await storage.countSubscribersForSegment(campaign.segmentId);
  
  await storage.updateCampaign(campaignId, {
    pendingCount: total,
    startedAt: new Date(),
  });
  
  // Calculate delay based on sending speed
  const speedKey = campaign.sendingSpeed || "medium";
  const emailsPerMinute = SPEED_CONFIG[speedKey] || 1000;
  const delayBetweenEmails = Math.floor(60000 / emailsPerMinute); // ms per email
  
  // Process in batches of 1000 to avoid memory issues
  const BATCH_SIZE = 1000;
  let offset = 0;
  let sentCount = campaign.sentCount || 0; // Resume from where we left off
  let failedCount = campaign.failedCount || 0;
  
  // Note: In a production implementation, this would:
  // 1. Use a proper job queue (Bull, BullMQ, etc.)
  // 2. Connect to actual SMTP servers via the configured MTA
  // 3. Use worker threads for concurrent sending
  // 4. Implement retry logic with exponential backoff
  // 5. Handle bounce/complaint feedback loops
  
  while (true) {
    // Check if campaign was paused or cancelled
    const currentCampaign = await storage.getCampaign(campaignId);
    if (!currentCampaign || currentCampaign.status !== "sending") {
      console.log(`Campaign ${campaignId} paused/cancelled at ${sentCount} emails`);
      break;
    }
    
    // Fetch batch of subscribers (using SQL-level filtering with BCK exclusion)
    const batch = await storage.getSubscribersForSegment(campaign.segmentId, BATCH_SIZE, offset);
    
    if (batch.length === 0) {
      // No more subscribers
      break;
    }
    
    for (const subscriber of batch) {
      // Check pause status periodically (every 100 emails)
      if (sentCount % 100 === 0) {
        const checkCampaign = await storage.getCampaign(campaignId);
        if (!checkCampaign || checkCampaign.status !== "sending") {
          console.log(`Campaign ${campaignId} paused during batch at ${sentCount}`);
          await storage.updateCampaign(campaignId, { sentCount, failedCount });
          return;
        }
      }
      
      // Record send BEFORE sending to prevent duplicates (atomic operation)
      // This uses a unique constraint - returns false if already sent
      const canSend = await storage.recordCampaignSend(campaignId, subscriber.id, "pending");
      
      if (!canSend) {
        // Email was already sent to this subscriber for this campaign - skip
        console.log(`Skipping duplicate send to ${subscriber.email} for campaign ${campaignId}`);
        continue;
      }
      
      // Simulate sending with rate limiting
      // In production: Actually send email via SMTP using campaign.mtaId
      try {
        // await sendEmail(subscriber, campaign, mta); // Production implementation
        sentCount++;
        
        // Apply rate limiting based on sending speed
        if (delayBetweenEmails > 0) {
          await new Promise(resolve => setTimeout(resolve, delayBetweenEmails));
        }
      } catch (error) {
        console.error(`Failed to send to ${subscriber.email}:`, error);
        failedCount++;
      }
      
      // Update progress every 100 emails
      if ((sentCount + failedCount) % 100 === 0) {
        await storage.updateCampaign(campaignId, {
          sentCount,
          failedCount,
          pendingCount: total - sentCount - failedCount,
        });
      }
    }
    
    offset += BATCH_SIZE;
  }
  
  // Final update
  const finalCampaign = await storage.getCampaign(campaignId);
  if (finalCampaign?.status === "sending") {
    await storage.updateCampaign(campaignId, {
      status: "completed",
      completedAt: new Date(),
      sentCount,
      failedCount,
      pendingCount: 0,
    });
    console.log(`Campaign ${campaignId} completed: ${sentCount} sent, ${failedCount} failed`);
  }
}
