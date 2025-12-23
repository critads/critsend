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
import { sendEmail, verifyTransporter, closeTransporter } from "./email-service";
import { verifyTrackingSignature } from "./tracking";

const upload = multer({ storage: multer.memoryStorage() });

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Start the background job processor for campaign processing
  startJobProcessor();
  
  // ============ HEALTH CHECK ============
  app.get("/api/health", async (_req: Request, res: Response) => {
    try {
      const startTime = Date.now();
      await storage.healthCheck();
      const dbLatency = Date.now() - startTime;
      
      res.json({
        status: "healthy",
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        database: {
          status: "connected",
          latencyMs: dbLatency
        },
        version: "1.0.0"
      });
    } catch (error) {
      res.status(503).json({
        status: "unhealthy",
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        database: {
          status: "disconnected",
          error: error instanceof Error ? error.message : "Unknown error"
        }
      });
    }
  });

  app.get("/api/health/ready", async (_req: Request, res: Response) => {
    try {
      await storage.healthCheck();
      const activeJobs = await storage.getActiveJobs();
      
      res.json({
        ready: true,
        timestamp: new Date().toISOString(),
        jobProcessor: {
          running: true,
          activeJobs: activeJobs.length
        }
      });
    } catch (error) {
      res.status(503).json({
        ready: false,
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Service not ready"
      });
    }
  });

  app.get("/api/metrics", async (_req: Request, res: Response) => {
    try {
      const [activeJobs, stats] = await Promise.all([
        storage.getActiveJobs(),
        storage.getDashboardStats()
      ]);
      
      res.json({
        timestamp: new Date().toISOString(),
        campaigns: {
          total: stats.totalCampaigns,
          pendingJobs: activeJobs.filter(j => j.status === "pending").length,
          processingJobs: activeJobs.filter(j => j.status === "processing").length
        },
        subscribers: {
          total: stats.totalSubscribers
        },
        tracking: {
          totalOpens: stats.totalOpens,
          totalClicks: stats.totalClicks
        }
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch metrics" });
    }
  });
  
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

      // Create import job record
      const job = await storage.createImportJob({
        filename: req.file.originalname,
        totalRows: lines.length - 1, // Exclude header
      });

      // Enqueue for background processing (stores CSV content in queue table)
      await storage.enqueueImportJob(job.id, content);
      console.log(`Import job ${job.id} added to PostgreSQL queue`);

      // Return immediately with job ID for progress tracking
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

  app.get("/api/import/:id/progress", async (req: Request, res: Response) => {
    try {
      const job = await storage.getImportJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Import job not found" });
      }
      
      const queueStatus = await storage.getImportJobQueueStatus(job.id);
      
      res.json({
        id: job.id,
        filename: job.filename,
        status: job.status,
        queueStatus: queueStatus,
        totalRows: job.totalRows,
        processedRows: job.processedRows,
        newSubscribers: job.newSubscribers,
        updatedSubscribers: job.updatedSubscribers,
        failedRows: job.failedRows,
        progress: job.totalRows > 0 ? Math.round((job.processedRows / job.totalRows) * 100) : 0,
        errorMessage: job.errorMessage,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
      });
    } catch (error) {
      console.error("Error fetching import progress:", error);
      res.status(500).json({ error: "Failed to fetch import progress" });
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
    const { campaignId, subscriberId } = req.params;
    const sig = req.query.sig as string;
    
    // Always return pixel to avoid broken images, but only record if signature is valid
    const returnPixel = () => {
      const pixel = Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        "base64"
      );
      res.setHeader("Content-Type", "image/gif");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.send(pixel);
    };
    
    // Verify signature before recording
    if (!sig || !verifyTrackingSignature(campaignId, subscriberId, "open", sig)) {
      console.warn(`Invalid tracking signature for open: campaign=${campaignId}, subscriber=${subscriberId}`);
      return returnPixel();
    }
    
    try {
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
      
      returnPixel();
    } catch (error) {
      console.error("Error tracking open:", error);
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
    
    // Verify signature before recording (include URL in signature verification)
    if (!sig || !verifyTrackingSignature(campaignId, subscriberId, "click", sig, url)) {
      console.warn(`Invalid tracking signature for click: campaign=${campaignId}, subscriber=${subscriberId}`);
      // Still redirect to avoid broken user experience
      return res.redirect(url);
    }
    
    try {
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
      res.redirect(url);
    }
  });

  app.get("/api/unsubscribe/:campaignId/:subscriberId", async (req: Request, res: Response) => {
    const { campaignId, subscriberId } = req.params;
    const sig = req.query.sig as string;
    
    // Verify signature before processing unsubscribe
    if (!sig || !verifyTrackingSignature(campaignId, subscriberId, "unsubscribe", sig)) {
      console.warn(`Invalid tracking signature for unsubscribe: campaign=${campaignId}, subscriber=${subscriberId}`);
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

// Sending speed configurations (emails per minute)
const SPEED_CONFIG: Record<string, number> = {
  slow: 500,
  medium: 1000,
  fast: 2000,
  godzilla: 3000,
};

// ============ POSTGRESQL-BACKED JOB QUEUE FOR CAMPAIGN SERIALIZATION ============
// Persists job state across server restarts and supports multiple workers via row-level locking

// Generate a unique worker ID for this instance
const WORKER_ID = `worker-${process.pid}-${Date.now()}`;
let jobPollingInterval: NodeJS.Timeout | null = null;
let importJobPollingInterval: NodeJS.Timeout | null = null;

// Public function to start a campaign - enqueues to PostgreSQL-backed job queue
async function processCampaign(campaignId: string) {
  // Check if this campaign already has a pending/processing job
  const existingStatus = await storage.getJobStatus(campaignId);
  if (existingStatus) {
    console.log(`Campaign ${campaignId} already has a ${existingStatus} job`);
    return;
  }
  
  await storage.enqueueCampaignJob(campaignId);
  console.log(`Campaign ${campaignId} added to PostgreSQL job queue`);
}

// Background job processor - polls for pending jobs
async function pollForJobs() {
  try {
    // Clean up stale jobs from crashed workers
    const staleCount = await storage.cleanupStaleJobs(30);
    if (staleCount > 0) {
      console.log(`Cleaned up ${staleCount} stale jobs`);
    }
    
    // Try to claim a pending job using FOR UPDATE SKIP LOCKED
    const job = await storage.claimNextJob(WORKER_ID);
    
    if (!job) {
      return; // No pending jobs
    }
    
    console.log(`Worker ${WORKER_ID} claimed job ${job.id} for campaign ${job.campaignId}`);
    
    try {
      await processCampaignInternal(job.campaignId);
      await storage.completeJob(job.id, "completed");
      console.log(`Job ${job.id} completed successfully`);
    } catch (error: any) {
      console.error(`Error processing job ${job.id}:`, error);
      await storage.completeJob(job.id, "failed", error.message || "Unknown error");
      await storage.updateCampaignStatusAtomic(job.campaignId, "failed");
    }
  } catch (error) {
    console.error("Error in job polling:", error);
  }
}

// Start the background job processor
function startJobProcessor() {
  if (jobPollingInterval) {
    return; // Already running
  }
  
  console.log(`Starting job processor with worker ID: ${WORKER_ID}`);
  
  // Poll every 2 seconds for new jobs
  jobPollingInterval = setInterval(pollForJobs, 2000);
  
  // Also run immediately on startup
  pollForJobs();
  
  // Also start the import job processor
  startImportJobProcessor();
}

// Stop the background job processor
function stopJobProcessor() {
  if (jobPollingInterval) {
    clearInterval(jobPollingInterval);
    jobPollingInterval = null;
    console.log("Job processor stopped");
  }
  stopImportJobProcessor();
}

// ============ POSTGRESQL-BACKED JOB QUEUE FOR IMPORT PROCESSING ============

// Start the background import job processor
function startImportJobProcessor() {
  if (importJobPollingInterval) {
    return; // Already running
  }
  
  console.log(`Starting import job processor with worker ID: ${WORKER_ID}`);
  
  // Poll every 2 seconds for new import jobs
  importJobPollingInterval = setInterval(pollForImportJobs, 2000);
  
  // Also run immediately on startup
  pollForImportJobs();
}

// Stop the import job processor
function stopImportJobProcessor() {
  if (importJobPollingInterval) {
    clearInterval(importJobPollingInterval);
    importJobPollingInterval = null;
    console.log("Import job processor stopped");
  }
}

// Background import job processor - polls for pending import jobs
async function pollForImportJobs() {
  try {
    // Clean up stale import jobs from crashed workers
    const staleCount = await storage.cleanupStaleImportJobs(30);
    if (staleCount > 0) {
      console.log(`Cleaned up ${staleCount} stale import jobs`);
    }
    
    // Try to claim a pending import job using FOR UPDATE SKIP LOCKED
    const queueItem = await storage.claimNextImportJob(WORKER_ID);
    
    if (!queueItem) {
      return; // No pending import jobs
    }
    
    console.log(`Worker ${WORKER_ID} claimed import job queue item ${queueItem.id} for import ${queueItem.importJobId}`);
    
    try {
      await processImportFromQueue(queueItem.importJobId, queueItem.csvContent);
      await storage.completeImportQueueJob(queueItem.id, "completed");
      console.log(`Import job ${queueItem.id} completed successfully`);
    } catch (error: any) {
      console.error(`Error processing import job ${queueItem.id}:`, error);
      await storage.completeImportQueueJob(queueItem.id, "failed", error.message || "Unknown error");
      await storage.updateImportJob(queueItem.importJobId, {
        status: "failed",
        errorMessage: error.message || "Unknown error",
      });
    }
  } catch (error) {
    console.error("Error in import job polling:", error);
  }
}

// Process import from queue - parses CSV and imports in batches
async function processImportFromQueue(importJobId: string, csvContent: string) {
  const BATCH_SIZE = 20000;
  const lines = csvContent.split("\n").filter(line => line.trim());
  
  const header = lines[0].split(",").map(h => h.trim().toLowerCase());
  const emailIdx = header.indexOf("email");
  const tagsIdx = header.indexOf("tags");
  const ipIdx = header.indexOf("ip_address");
  
  if (emailIdx === -1) {
    await storage.updateImportJob(importJobId, {
      status: "failed",
      errorMessage: "CSV must have an 'email' column",
    });
    return;
  }
  
  await storage.updateImportJob(importJobId, { status: "processing" });
  
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
          ? cols[tagsIdx].split(";").map(t => t.trim()).filter(Boolean)
          : [];
        const ipAddress = ipIdx >= 0 ? cols[ipIdx] || null : null;
        
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
    
    // Update job progress after each batch
    await storage.updateImportJob(importJobId, {
      processedRows,
      newSubscribers,
      updatedSubscribers,
      failedRows,
    });
  }
  
  await storage.updateImportJob(importJobId, {
    status: "completed",
    completedAt: new Date(),
    processedRows,
    newSubscribers,
    updatedSubscribers,
    failedRows,
  });
}

// Internal processing function - called by the job queue
async function processCampaignInternal(campaignId: string) {
  const campaign = await storage.getCampaign(campaignId);
  if (!campaign || campaign.status !== "sending") return;
  
  if (!campaign.segmentId) {
    await storage.updateCampaignStatusAtomic(campaignId, "failed");
    return;
  }
  
  // Fetch MTA configuration if specified
  let mta = null;
  if (campaign.mtaId) {
    mta = await storage.getMta(campaign.mtaId);
    if (!mta) {
      console.error(`Campaign ${campaignId}: MTA ${campaign.mtaId} not found`);
      await storage.updateCampaignStatusAtomic(campaignId, "failed");
      return;
    }
    
    // Verify SMTP connection before starting
    const verifyResult = await verifyTransporter(mta);
    if (!verifyResult.success) {
      console.error(`Campaign ${campaignId}: SMTP verification failed: ${verifyResult.error}`);
      await storage.updateCampaignStatusAtomic(campaignId, "failed");
      return;
    }
    console.log(`Campaign ${campaignId}: SMTP connection verified for MTA ${mta.name}`);
  }
  
  // Recovery: Clean up any orphaned pending sends from previous crashes
  // This ensures retries can proceed and counters stay accurate
  const recovered = await storage.recoverOrphanedPendingSends(campaignId, 2);
  if (recovered > 0) {
    console.log(`Campaign ${campaignId}: Recovered ${recovered} orphaned pending sends before processing`);
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
  let processedCount = 0;
  
  while (true) {
    // Check if campaign was paused or cancelled (atomic read)
    const currentCampaign = await storage.getCampaign(campaignId);
    if (!currentCampaign || currentCampaign.status !== "sending") {
      console.log(`Campaign ${campaignId} paused/cancelled at ${processedCount} processed`);
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
      if (processedCount % 100 === 0) {
        const checkCampaign = await storage.getCampaign(campaignId);
        if (!checkCampaign || checkCampaign.status !== "sending") {
          console.log(`Campaign ${campaignId} paused during batch at ${processedCount}`);
          return;
        }
      }
      
      // STEP 1: Reserve send slot BEFORE attempting to send
      // This is critical for race condition prevention - the reservation happens
      // atomically before any SMTP attempt, preventing duplicates even if
      // multiple workers try to process the same subscriber
      const reserved = await storage.reserveSendSlot(campaignId, subscriber.id);
      
      if (!reserved) {
        // Email was already reserved/sent to this subscriber - skip
        console.log(`Skipping duplicate send to ${subscriber.email} for campaign ${campaignId}`);
        processedCount++;
        continue;
      }
      
      // STEP 2: Attempt to send email
      let sendSuccess = true;
      try {
        if (mta) {
          // Real SMTP sending via configured MTA
          const result = await sendEmail(mta, subscriber, campaign, {
            trackOpens: campaign.trackOpens,
            trackClicks: campaign.trackClicks,
            trackingDomain: mta.trackingDomain,
            openTrackingDomain: mta.openTrackingDomain,
            openTag: campaign.openTag,
            clickTag: campaign.clickTag,
          });
          
          sendSuccess = result.success;
          if (!result.success) {
            console.error(`Failed to send to ${subscriber.email}: ${result.error}`);
          } else {
            console.log(`Email sent to ${subscriber.email}, messageId: ${result.messageId}`);
          }
        } else {
          // No MTA configured - simulate sending for demo purposes
          console.log(`[SIMULATED] Email to ${subscriber.email} (no MTA configured)`);
        }
        
        // Apply rate limiting based on sending speed
        if (delayBetweenEmails > 0) {
          await new Promise(resolve => setTimeout(resolve, delayBetweenEmails));
        }
      } catch (error) {
        console.error(`Failed to send to ${subscriber.email}:`, error);
        sendSuccess = false;
      }
      
      // STEP 3: Finalize the send with the result (update status + counters atomically)
      // This updates the 'pending' record to 'sent' or 'failed' and adjusts counters
      // finalizeSend throws if no pending row found (invariant violation)
      try {
        await storage.finalizeSend(campaignId, subscriber.id, sendSuccess);
      } catch (finalizeError: any) {
        // Invariant violation: pending row missing or already finalized
        // Attempt to reconcile by force-failing this send record (if it still exists)
        console.error(`INVARIANT VIOLATION during finalize for ${subscriber.email}: ${finalizeError.message}`);
        try {
          // Atomic reconciliation: Mark as failed if still pending (handles edge cases)
          await storage.forceFailPendingSend(campaignId, subscriber.id);
        } catch (reconcileError) {
          console.error(`Failed to reconcile send for ${subscriber.email}:`, reconcileError);
        }
      }
      
      processedCount++;
    }
    
    offset += BATCH_SIZE;
  }
  
  // Clean up transporter connection pool when done
  if (mta) {
    closeTransporter(mta.id);
    console.log(`Campaign ${campaignId}: Closed SMTP connection for MTA ${mta.name}`);
  }
  
  // Final update - use atomic status change with expected status check
  const wasCompleted = await storage.updateCampaignStatusAtomic(campaignId, "completed", "sending");
  if (wasCompleted) {
    // Update completion timestamp
    await storage.updateCampaign(campaignId, {
      completedAt: new Date(),
      pendingCount: 0,
    });
    
    // Get final counts from database (source of truth)
    const finalCampaign = await storage.getCampaign(campaignId);
    console.log(`Campaign ${campaignId} completed: ${finalCampaign?.sentCount} sent, ${finalCampaign?.failedCount} failed`);
  }
}
