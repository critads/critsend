import express, { type Express, type Request, type Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { db, pool } from "./db";
import { sql } from "drizzle-orm";
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
import { sendEmail, sendEmailWithNullsink, verifyTransporter, closeTransporter } from "./email-service";
import { getNullsinkServer, startNullsinkServer, stopNullsinkServer } from "./nullsink-smtp";
import { verifyTrackingSignature } from "./tracking";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";
import * as dns from "dns";
import { promisify } from "util";

const dnsLookup = promisify(dns.lookup);

const upload = multer({ storage: multer.memoryStorage() });

const IMAGES_DIR = path.join(process.cwd(), "images");
const TEMP_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function cleanupOrphanedTempSessions(): void {
  try {
    if (!fs.existsSync(IMAGES_DIR)) return;
    
    const entries = fs.readdirSync(IMAGES_DIR);
    const now = Date.now();
    
    for (const entry of entries) {
      if (!entry.startsWith("temp_")) continue;
      
      const entryPath = path.join(IMAGES_DIR, entry);
      const stat = fs.statSync(entryPath);
      
      if (!stat.isDirectory()) continue;
      
      const age = now - stat.mtimeMs;
      if (age > TEMP_SESSION_MAX_AGE_MS) {
        const files = fs.readdirSync(entryPath);
        for (const file of files) {
          fs.unlinkSync(path.join(entryPath, file));
        }
        fs.rmdirSync(entryPath);
        console.log(`Cleaned up orphaned temp session: ${entry}`);
      }
    }
  } catch (error) {
    console.error("Error cleaning up temp sessions:", error);
  }
}

function isBlockedIP(ip: string): boolean {
  const blockedPatterns = [
    /^127\.\d+\.\d+\.\d+$/,
    /^10\.\d+\.\d+\.\d+$/,
    /^192\.168\.\d+\.\d+$/,
    /^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/,
    /^169\.254\.\d+\.\d+$/,
    /^0\.0\.0\.0$/,
    /^::1$/,
    /^fe80:/i,
    /^fc00:/i,
    /^fd00:/i,
  ];
  return blockedPatterns.some(pattern => pattern.test(ip));
}

function isBlockedHost(hostname: string): boolean {
  const blockedPatterns = [
    /^localhost$/i,
    /^127\.\d+\.\d+\.\d+$/,
    /^10\.\d+\.\d+\.\d+$/,
    /^192\.168\.\d+\.\d+$/,
    /^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/,
    /^169\.254\.\d+\.\d+$/,
    /^0\.0\.0\.0$/,
    /^\[?::1\]?$/,
    /^\[?fe80:/i,
    /^\[?fc00:/i,
    /^\[?fd00:/i,
  ];
  return blockedPatterns.some(pattern => pattern.test(hostname));
}

async function downloadImage(url: string, destPath: string, redirectCount = 0): Promise<boolean> {
  if (redirectCount > 3) {
    console.log(`[Image download] Failed: ${url} - too many redirects`);
    return false;
  }
  
  let urlObj: URL;
  let resolvedIP: string;
  
  try {
    urlObj = new URL(url);
    
    if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") {
      console.log(`[Image download] Failed: ${url} - invalid protocol`);
      return false;
    }
    
    if (isBlockedHost(urlObj.hostname)) {
      console.log(`[Image download] Failed: ${url} - blocked host`);
      return false;
    }
    
    const result = await dnsLookup(urlObj.hostname);
    resolvedIP = result.address;
    
    if (isBlockedIP(resolvedIP)) {
      console.log(`[Image download] Failed: ${url} - blocked IP ${resolvedIP}`);
      return false;
    }
  } catch (error) {
    console.log(`[Image download] Failed: ${url} - DNS/URL error: ${error}`);
    return false;
  }
  
  return new Promise((resolve) => {
    const protocol = url.startsWith("https") ? https : http;
    const timeout = 15000;
    const maxSize = 10 * 1024 * 1024;
    
    const safetyLookup = (hostname: string, options: any, callback: any) => {
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }
      if (options && options.all) {
        callback(null, [{ address: resolvedIP, family: 4 }]);
      } else {
        callback(null, resolvedIP, 4);
      }
    };
    
    const requestOptions: https.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: "GET",
      timeout,
      lookup: safetyLookup as any,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; CritsendBot/1.0)",
      },
    };
    
    const request = protocol.get(requestOptions, (response) => {
      const socket = response.socket as any;
      if (socket && socket.remoteAddress && isBlockedIP(socket.remoteAddress)) {
        request.destroy();
        resolve(false);
        return;
      }
      
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          try {
            const redirectObj = new URL(redirectUrl, url);
            if (redirectObj.protocol !== "http:" && redirectObj.protocol !== "https:") {
              resolve(false);
              return;
            }
            if (isBlockedHost(redirectObj.hostname)) {
              resolve(false);
              return;
            }
            downloadImage(redirectObj.href, destPath, redirectCount + 1).then(resolve);
            return;
          } catch {
            resolve(false);
            return;
          }
        }
      }
      
      if (response.statusCode !== 200) {
        console.log(`[Image download] Failed: ${url} - HTTP ${response.statusCode}`);
        resolve(false);
        return;
      }
      
      const contentLength = parseInt(response.headers["content-length"] || "0", 10);
      if (contentLength > maxSize) {
        resolve(false);
        return;
      }
      
      let downloadedSize = 0;
      const fileStream = fs.createWriteStream(destPath);
      
      response.on("data", (chunk: Buffer) => {
        downloadedSize += chunk.length;
        if (downloadedSize > maxSize) {
          request.destroy();
          fileStream.close();
          fs.unlink(destPath, () => {});
          resolve(false);
        }
      });
      
      response.pipe(fileStream);
      
      fileStream.on("finish", () => {
        fileStream.close();
        resolve(true);
      });
      
      fileStream.on("error", () => {
        fs.unlink(destPath, () => {});
        resolve(false);
      });
    });
    
    request.on("error", (err) => {
      console.log(`[Image download] Failed: ${url} - network error: ${err.message}`);
      resolve(false);
    });
    
    request.on("timeout", () => {
      console.log(`[Image download] Failed: ${url} - timeout`);
      request.destroy();
      resolve(false);
    });
  });
}

function getExtensionFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const match = pathname.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
    if (match) {
      const ext = match[1].toLowerCase();
      if (["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico"].includes(ext)) {
        return ext === "jpeg" ? "jpg" : ext;
      }
    }
  } catch {}
  return "jpg";
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 50);
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Serve static images from /images folder
  app.use("/images", express.static(IMAGES_DIR));
  
  // Start the background job processor for campaign processing
  startJobProcessor();
  
  // Start the background import job processor
  startImportJobProcessor();
  
  // Clean up orphaned temp sessions on startup and every hour
  cleanupOrphanedTempSessions();
  setInterval(cleanupOrphanedTempSessions, 60 * 60 * 1000);
  
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

  // Tag Queue Stats - for monitoring reliable tag additions
  app.get("/api/tag-queue/stats", async (_req: Request, res: Response) => {
    try {
      const stats = await storage.getTagQueueStats();
      res.json({
        timestamp: new Date().toISOString(),
        tagQueue: stats,
        status: stats.failed > 0 ? "warning" : "healthy"
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch tag queue stats" });
    }
  });

  // Nullsink SMTP Server Control
  app.get("/api/nullsink/status", async (_req: Request, res: Response) => {
    try {
      const server = getNullsinkServer();
      const config = server.getConfig();
      const metrics = server.getMetrics();
      
      res.json({
        running: server.isRunning(),
        config: {
          port: config.port,
          simulatedLatencyMs: config.simulatedLatencyMs,
          failureRate: config.failureRate,
        },
        metrics: {
          totalEmails: metrics.totalEmails,
          successfulEmails: metrics.successfulEmails,
          failedEmails: metrics.failedEmails,
          averageTimeMs: Math.round(metrics.averageTimeMs * 100) / 100,
          emailsPerSecond: Math.round(metrics.emailsPerSecond * 100) / 100,
          startTime: metrics.startTime?.toISOString() || null,
        },
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to get nullsink status" });
    }
  });

  app.post("/api/nullsink/start", async (_req: Request, res: Response) => {
    try {
      const server = getNullsinkServer();
      if (!server.isRunning()) {
        await server.start();
      }
      res.json({ success: true, message: "Nullsink server started" });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to start nullsink server" });
    }
  });

  app.post("/api/nullsink/stop", async (_req: Request, res: Response) => {
    try {
      const server = getNullsinkServer();
      if (server.isRunning()) {
        await server.stop();
      }
      res.json({ success: true, message: "Nullsink server stopped" });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to stop nullsink server" });
    }
  });

  app.post("/api/nullsink/reset", async (_req: Request, res: Response) => {
    try {
      const server = getNullsinkServer();
      server.resetMetrics();
      res.json({ success: true, message: "Nullsink metrics reset" });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to reset nullsink metrics" });
    }
  });

  app.get("/api/nullsink/captures", async (req: Request, res: Response) => {
    try {
      const campaignId = req.query.campaignId as string | undefined;
      const limit = parseInt(req.query.limit as string) || 100;
      const offset = parseInt(req.query.offset as string) || 0;
      
      const result = await storage.getNullsinkCaptures({ campaignId, limit, offset });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: "Failed to get nullsink captures" });
    }
  });

  app.get("/api/nullsink/metrics", async (req: Request, res: Response) => {
    try {
      const campaignId = req.query.campaignId as string | undefined;
      const metrics = await storage.getNullsinkMetrics(campaignId);
      
      // Also get in-memory metrics from the server
      const server = getNullsinkServer();
      const liveMetrics = server.getMetrics();
      
      res.json({
        database: {
          totalEmails: metrics.totalEmails,
          successfulEmails: metrics.successfulEmails,
          failedEmails: metrics.failedEmails,
          averageHandshakeTimeMs: Math.round(metrics.avgHandshakeTimeMs * 100) / 100,
          averageTotalTimeMs: Math.round(metrics.avgTotalTimeMs * 100) / 100,
          emailsPerSecond: Math.round(metrics.emailsPerSecond * 100) / 100,
        },
        live: {
          totalEmails: liveMetrics.totalEmails,
          successfulEmails: liveMetrics.successfulEmails,
          failedEmails: liveMetrics.failedEmails,
          averageTimeMs: Math.round(liveMetrics.averageTimeMs * 100) / 100,
          emailsPerSecond: Math.round(liveMetrics.emailsPerSecond * 100) / 100,
          isRunning: liveMetrics.isRunning,
          startTime: liveMetrics.startTime?.toISOString() || null,
        },
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to get nullsink metrics" });
    }
  });

  app.delete("/api/nullsink/captures", async (req: Request, res: Response) => {
    try {
      const campaignId = req.query.campaignId as string | undefined;
      const deleted = await storage.clearNullsinkCaptures(campaignId);
      
      // Also reset in-memory metrics
      const server = getNullsinkServer();
      server.resetMetrics();
      
      res.json({ success: true, deleted });
    } catch (error) {
      res.status(500).json({ error: "Failed to clear nullsink captures" });
    }
  });

  // Debug endpoint to check import queue status
  app.get("/api/debug/import-queue", async (_req: Request, res: Response) => {
    try {
      const result = await db.execute(sql`
        SELECT id, import_job_id, status, created_at, started_at, worker_id, error_message 
        FROM import_job_queue 
        ORDER BY created_at DESC 
        LIMIT 10
      `);
      
      const importJobs = await db.execute(sql`
        SELECT id, filename, status, total_rows, processed_rows, created_at
        FROM import_jobs
        ORDER BY created_at DESC
        LIMIT 10
      `);
      
      res.json({
        workerId: WORKER_ID,
        importJobProcessorRunning: !!importJobPollingInterval,
        queueItems: result.rows,
        importJobs: importJobs.rows
      });
    } catch (error) {
      console.error("Error fetching import queue debug info:", error);
      res.status(500).json({ error: "Failed to fetch debug info" });
    }
  });

  app.post("/api/debug/recover-stuck-imports", async (_req: Request, res: Response) => {
    try {
      const recoveredCount = await storage.recoverStuckImportJobs();
      res.json({ 
        success: true, 
        recoveredCount,
        message: recoveredCount > 0 
          ? `Recovered ${recoveredCount} stuck jobs back to pending` 
          : "No stuck jobs found to recover"
      });
    } catch (error) {
      console.error("Error recovering stuck imports:", error);
      res.status(500).json({ error: "Failed to recover stuck imports" });
    }
  });

  // Debug endpoint to manually process an import job (deprecated - use normal import flow)
  app.post("/api/debug/force-process-import/:queueId", async (req: Request, res: Response) => {
    res.status(410).json({ error: "This debug endpoint is deprecated. Use the normal import flow." });
  });

  app.get("/api/debug/import-queue-details/:id", async (req: Request, res: Response) => {
    try {
      const result = await db.execute(sql`
        SELECT id, import_job_id, status, csv_file_path, total_lines, processed_lines, heartbeat,
               created_at, started_at, worker_id
        FROM import_job_queue 
        WHERE id = ${req.params.id}
      `);
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Queue item not found" });
      }
      
      res.json(result.rows[0]);
    } catch (error) {
      console.error("Error fetching queue details:", error);
      res.status(500).json({ error: "Failed to fetch queue details" });
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
        // Update tags instead - merge with existing
        const updated = await storage.updateSubscriber(existing.id, {
          tags: [...new Set([...(existing.tags || []), ...(data.tags || [])])],
          positiveTags: [...new Set([...(existing.positiveTags || []), ...(data.positiveTags || [])])],
          negativeTags: [...new Set([...(existing.negativeTags || []), ...(data.negativeTags || [])])],
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

  app.delete("/api/subscribers", async (req: Request, res: Response) => {
    try {
      const deletedCount = await storage.deleteAllSubscribers();
      res.json({ deleted: deletedCount, message: `Successfully deleted ${deletedCount} subscribers` });
    } catch (error) {
      console.error("Error deleting all subscribers:", error);
      res.status(500).json({ error: "Failed to delete all subscribers" });
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
  
  // Send test email endpoint - Always uses Resend HTTP API (bypasses SMTP restrictions)
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
      } = req.body;
      
      if (!email || !fromEmail || !subject || !htmlContent) {
        return res.status(400).json({ error: "Missing required fields (email, fromEmail, subject, htmlContent)" });
      }
      
      console.log(`[TEST EMAIL] Sending test email via Resend API to: ${email}`);
      
      // Get MTA tracking domain if provided
      let trackingDomain: string | undefined;
      let imageHostingDomain: string | undefined;
      if (mtaId) {
        const mta = await storage.getMta(mtaId);
        if (mta) {
          trackingDomain = mta.trackingDomain || undefined;
          imageHostingDomain = (mta as any).imageHostingDomain || undefined;
        }
      }
      
      // Rewrite local image URLs if image hosting domain is configured
      let processedHtmlContent = htmlContent;
      if (imageHostingDomain) {
        const { rewriteImageUrls } = await import("./email-service");
        processedHtmlContent = rewriteImageUrls(processedHtmlContent, imageHostingDomain);
      }
      
      // Build email headers (similar to real campaign sending)
      const headers: Record<string, string> = {
        "X-Campaign-ID": "test-campaign",
        "X-Subscriber-ID": "test-subscriber",
        "X-Test-Email": "true",
      };
      
      // Add default custom headers with {UNSUBSCRIBE} placeholder replacement
      const defaultHeaders = await storage.getDefaultHeaders();
      const testUnsubscribeUrl = trackingDomain 
        ? `${trackingDomain.replace(/\/$/, "")}/api/unsubscribe/test-campaign/test-subscriber`
        : "#unsubscribe-placeholder";
      
      for (const header of defaultHeaders) {
        const resolvedValue = header.value.replace(/\{UNSUBSCRIBE\}/gi, testUnsubscribeUrl);
        headers[header.name] = resolvedValue;
      }
      
      // Use Resend HTTP API for test emails (works in Replit environment)
      const { sendTestEmailViaResend } = await import("./resend-client");
      
      const result = await sendTestEmailViaResend({
        to: email,
        fromName: fromName || "Test",
        fromEmail,
        subject,
        htmlContent: processedHtmlContent,
        preheader,
        companyAddress,
        unsubscribeText,
        trackingDomain,
        headers,
      });
      
      if (result.success) {
        res.json({ success: true, messageId: result.messageId });
      } else {
        res.status(500).json({ error: result.error || "Failed to send test email" });
      }
    } catch (error: any) {
      console.error("Error sending test email:", error);
      res.status(500).json({ error: error.message || "Failed to send test email" });
    }
  });
  
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

  // ============ HTML IMAGE PROCESSING ============
  // Create a temporary session ID for new campaigns that don't have an ID yet
  app.post("/api/campaign-assets/session", async (_req: Request, res: Response) => {
    const sessionId = `temp_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    res.json({ sessionId });
  });

  app.post("/api/campaigns/:id/process-html", async (req: Request, res: Response) => {
    try {
      const campaignId = req.params.id;
      const { html } = req.body;
      
      if (!html || typeof html !== "string") {
        return res.status(400).json({ error: "HTML content is required" });
      }
      
      const validIdPattern = /^[a-zA-Z0-9_-]+$/;
      if (!validIdPattern.test(campaignId) || campaignId.length > 100) {
        return res.status(400).json({ error: "Invalid campaign ID format" });
      }
      
      const campaignImagesDir = path.join(IMAGES_DIR, campaignId);
      if (!fs.existsSync(IMAGES_DIR)) {
        fs.mkdirSync(IMAGES_DIR, { recursive: true });
      }
      if (fs.existsSync(campaignImagesDir)) {
        const files = fs.readdirSync(campaignImagesDir);
        for (const file of files) {
          fs.unlinkSync(path.join(campaignImagesDir, file));
        }
      } else {
        fs.mkdirSync(campaignImagesDir, { recursive: true });
      }
      
      const $ = cheerio.load(html);
      const imgElements = $("img");
      const downloadedImages: { original: string; local: string }[] = [];
      const failedImages: string[] = [];
      let imageIndex = 0;
      
      const downloadPromises: Promise<void>[] = [];
      
      imgElements.each((_, el) => {
        const src = $(el).attr("src");
        if (src && (src.startsWith("http://") || src.startsWith("https://"))) {
          const currentIndex = imageIndex++;
          const ext = getExtensionFromUrl(src);
          const filename = `img_${currentIndex}.${ext}`;
          const destPath = path.join(campaignImagesDir, filename);
          const localUrl = `/images/${campaignId}/${filename}`;
          
          const promise = downloadImage(src, destPath).then((success) => {
            if (success) {
              $(el).attr("src", localUrl);
              downloadedImages.push({ original: src, local: localUrl });
            } else {
              failedImages.push(src);
            }
          });
          
          downloadPromises.push(promise);
        }
      });
      
      await Promise.all(downloadPromises);
      
      const processedHtml = $.html();
      
      res.json({
        html: processedHtml,
        downloaded: downloadedImages.length,
        failed: failedImages.length,
        failedUrls: failedImages
      });
    } catch (error) {
      console.error("Error processing HTML:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: `Failed to process HTML content: ${errorMessage}` });
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
      console.log(`PATCH /api/campaigns/${req.params.id} - Body:`, JSON.stringify(req.body));
      
      // Get the current campaign to check if status is changing
      const existingCampaign = await storage.getCampaign(req.params.id);
      if (!existingCampaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      
      console.log(`Campaign ${req.params.id} current status: ${existingCampaign.status}, new status: ${req.body.status || 'unchanged'}`);
      
      const campaign = await storage.updateCampaign(req.params.id, req.body);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      
      // If status changed to sending, start the campaign processing
      if (existingCampaign.status !== "sending" && campaign.status === "sending") {
        console.log(`Starting campaign ${campaign.id} via PATCH - queueing for processing`);
        processCampaign(campaign.id).catch((err) => {
          console.error(`Failed to queue campaign ${campaign.id}:`, err);
        });
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
      // Clear any stuck processing jobs for this campaign before resuming
      await storage.clearStuckJobsForCampaign(req.params.id);
      
      const campaign = await storage.updateCampaign(req.params.id, { status: "sending", pauseReason: null });
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

  // ============ DEDICATED CAMPAIGN SEND ENDPOINT ============
  // This endpoint atomically saves campaign data, validates, sets status to sending/scheduled, and queues the job
  app.post("/api/campaigns/:id/send", async (req: Request, res: Response) => {
    const campaignId = req.params.id;
    const timestamp = new Date().toISOString();
    const isScheduled = !!req.body.scheduledAt;
    
    console.log(`[CAMPAIGN_SEND] ${timestamp} - Starting ${isScheduled ? 'schedule' : 'send'} process for campaign ${campaignId}`);
    console.log(`[CAMPAIGN_SEND] ${timestamp} - Request body:`, JSON.stringify(req.body, null, 2));
    
    try {
      // Step 1: Verify campaign exists
      const existingCampaign = await storage.getCampaign(campaignId);
      if (!existingCampaign) {
        console.error(`[CAMPAIGN_SEND] ${timestamp} - Campaign ${campaignId} not found`);
        return res.status(404).json({ error: "Campaign not found" });
      }
      
      console.log(`[CAMPAIGN_SEND] ${timestamp} - Campaign found, current status: ${existingCampaign.status}`);
      
      // Step 2: Validate campaign is in a sendable state
      if (existingCampaign.status === "sending") {
        console.log(`[CAMPAIGN_SEND] ${timestamp} - Campaign already sending`);
        return res.status(400).json({ error: "Campaign is already sending" });
      }
      if (existingCampaign.status === "completed") {
        console.log(`[CAMPAIGN_SEND] ${timestamp} - Campaign already completed`);
        return res.status(400).json({ error: "Campaign has already completed" });
      }
      
      // Step 3: Merge and save any final data from the request body (including scheduledAt)
      const updateData = { ...req.body };
      delete updateData.status; // We'll set status ourselves
      
      if (Object.keys(updateData).length > 0) {
        console.log(`[CAMPAIGN_SEND] ${timestamp} - Saving final campaign data`);
        await storage.updateCampaign(campaignId, updateData);
      }
      
      // Step 4: Re-fetch to get the latest state
      const refreshedCampaign = await storage.getCampaign(campaignId);
      if (!refreshedCampaign) {
        console.error(`[CAMPAIGN_SEND] ${timestamp} - Campaign disappeared after update`);
        return res.status(500).json({ error: "Campaign update failed" });
      }
      
      // Step 5: Validate required fields for sending
      const validationErrors: string[] = [];
      if (!refreshedCampaign.name) validationErrors.push("Campaign name is required");
      if (!refreshedCampaign.segmentId) validationErrors.push("Segment is required");
      if (!refreshedCampaign.mtaId) validationErrors.push("MTA server is required");
      if (!refreshedCampaign.fromName) validationErrors.push("Sender name is required");
      if (!refreshedCampaign.fromEmail) validationErrors.push("Sender email is required");
      if (!refreshedCampaign.subject) validationErrors.push("Subject line is required");
      if (!refreshedCampaign.htmlContent) validationErrors.push("Email content is required");
      
      if (validationErrors.length > 0) {
        console.error(`[CAMPAIGN_SEND] ${timestamp} - Validation failed:`, validationErrors);
        return res.status(400).json({ 
          error: "Campaign validation failed", 
          details: validationErrors 
        });
      }
      
      // Step 6: Verify MTA exists and is active
      const mta = await storage.getMta(refreshedCampaign.mtaId!);
      if (!mta) {
        console.error(`[CAMPAIGN_SEND] ${timestamp} - MTA not found: ${refreshedCampaign.mtaId}`);
        return res.status(400).json({ error: "Selected MTA server not found" });
      }
      if (!mta.isActive) {
        console.error(`[CAMPAIGN_SEND] ${timestamp} - MTA is not active: ${mta.name}`);
        return res.status(400).json({ error: "Selected MTA server is not active" });
      }
      
      // Step 7: Verify segment exists and has subscribers
      const segment = await storage.getSegment(refreshedCampaign.segmentId!);
      if (!segment) {
        console.error(`[CAMPAIGN_SEND] ${timestamp} - Segment not found: ${refreshedCampaign.segmentId}`);
        return res.status(400).json({ error: "Selected segment not found" });
      }
      
      const subscriberCount = await storage.countSubscribersForSegment(refreshedCampaign.segmentId!);
      console.log(`[CAMPAIGN_SEND] ${timestamp} - Segment '${segment.name}' has ${subscriberCount} subscribers`);
      
      if (subscriberCount === 0) {
        console.error(`[CAMPAIGN_SEND] ${timestamp} - Segment has no subscribers`);
        return res.status(400).json({ error: "Selected segment has no subscribers" });
      }
      
      // Step 8: Handle scheduled vs immediate send
      if (isScheduled) {
        // For scheduled campaigns, just update status to "scheduled"
        console.log(`[CAMPAIGN_SEND] ${timestamp} - Setting campaign status to 'scheduled' for ${req.body.scheduledAt}`);
        const updatedCampaign = await storage.updateCampaign(campaignId, { 
          status: "scheduled",
          scheduledAt: new Date(req.body.scheduledAt)
        });
        
        if (!updatedCampaign || updatedCampaign.status !== "scheduled") {
          console.error(`[CAMPAIGN_SEND] ${timestamp} - Failed to schedule campaign`);
          return res.status(500).json({ error: "Failed to schedule campaign" });
        }
        
        console.log(`[CAMPAIGN_SEND] ${timestamp} - Campaign ${campaignId} scheduled successfully`);
        return res.json({ 
          success: true, 
          campaign: updatedCampaign,
          message: `Campaign scheduled for ${subscriberCount} subscribers` 
        });
      }
      
      // Step 9: Atomically update status to "sending" (immediate send)
      console.log(`[CAMPAIGN_SEND] ${timestamp} - Setting campaign status to 'sending'`);
      const updatedCampaign = await storage.updateCampaign(campaignId, { status: "sending" });
      
      if (!updatedCampaign || updatedCampaign.status !== "sending") {
        console.error(`[CAMPAIGN_SEND] ${timestamp} - Failed to update campaign status`);
        return res.status(500).json({ error: "Failed to start campaign - status update failed" });
      }
      
      // Step 10: Queue the campaign for processing (don't await - let it run in background)
      console.log(`[CAMPAIGN_SEND] ${timestamp} - Queuing campaign for processing`);
      processCampaign(campaignId).catch((queueError: any) => {
        console.error(`[CAMPAIGN_SEND] ${timestamp} - Background queue error for ${campaignId}:`, queueError);
      });
      console.log(`[CAMPAIGN_SEND] ${timestamp} - Campaign successfully queued`);
      
      // Step 11: Success - return the campaign immediately
      console.log(`[CAMPAIGN_SEND] ${timestamp} - Campaign ${campaignId} started successfully`);
      res.json({ 
        success: true, 
        campaign: updatedCampaign,
        message: `Campaign started with ${subscriberCount} subscribers` 
      });
      
    } catch (error: any) {
      console.error(`[CAMPAIGN_SEND] ${timestamp} - Unexpected error:`, error);
      res.status(500).json({ error: error.message || "Failed to start campaign" });
    }
  });

  // ============ IMPORT ============
  // Ensure uploads directory exists
  const UPLOADS_DIR = path.join(process.cwd(), "uploads", "imports");
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }

  app.post("/api/import", upload.single("file"), async (req: Request, res: Response) => {
    try {
      console.log(`[IMPORT] Received import request`);
      if (!req.file) {
        console.log(`[IMPORT] No file in request`);
        return res.status(400).json({ error: "No file uploaded" });
      }

      // Get tag mode from form data (default to merge for backwards compatibility)
      const tagMode = (req.body.tagMode === "override") ? "override" : "merge";
      console.log(`[IMPORT] File received: ${req.file.originalname}, size: ${req.file.size} bytes, tagMode: ${tagMode}`);
      
      // Count lines without loading entire file into memory for line count
      const content = req.file.buffer.toString("utf-8");
      let lineCount = 0;
      for (let i = 0; i < content.length; i++) {
        if (content[i] === '\n') lineCount++;
      }
      // Add 1 if file doesn't end with newline
      if (content.length > 0 && content[content.length - 1] !== '\n') lineCount++;
      
      if (lineCount < 2) {
        console.log(`[IMPORT] CSV empty or invalid, lines: ${lineCount}`);
        return res.status(400).json({ error: "CSV file is empty or invalid" });
      }

      const totalDataRows = lineCount - 1; // Exclude header
      console.log(`[IMPORT] CSV has ${totalDataRows} data rows`);

      // Create import job record first to get ID
      const job = await storage.createImportJob({
        filename: req.file.originalname,
        totalRows: totalDataRows,
        tagMode: tagMode,
      });
      console.log(`[IMPORT] Created import job: ${job.id}`);

      // Save CSV file to disk instead of database
      const csvFilePath = path.join(UPLOADS_DIR, `${job.id}.csv`);
      fs.writeFileSync(csvFilePath, content);
      console.log(`[IMPORT] Saved CSV to: ${csvFilePath}`);

      // Enqueue for background processing with file path (not content)
      const queueItem = await storage.enqueueImportJob(job.id, csvFilePath, lineCount);
      console.log(`[IMPORT] Import job ${job.id} enqueued with queue item ID: ${queueItem.id}`);

      // Return immediately with job ID for progress tracking
      res.status(202).json(job);
    } catch (error) {
      console.error("[IMPORT] Error starting import:", error);
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

  app.post("/api/import/:id/cancel", async (req: Request, res: Response) => {
    try {
      const cancelled = await storage.cancelImportJob(req.params.id);
      if (cancelled) {
        console.log(`[IMPORT] Import job ${req.params.id} cancelled by user`);
        res.json({ success: true, message: "Import cancelled" });
      } else {
        res.status(400).json({ error: "Import cannot be cancelled (already completed or not found)" });
      }
    } catch (error) {
      console.error("Error cancelling import:", error);
      res.status(500).json({ error: "Failed to cancel import" });
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

  // ============ ERROR LOGS ============
  app.get("/api/error-logs", async (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      const type = req.query.type as string | undefined;
      const severity = req.query.severity as string | undefined;
      const campaignId = req.query.campaignId as string | undefined;
      const importJobId = req.query.importJobId as string | undefined;
      
      const result = await storage.getErrorLogs({
        page,
        limit,
        type: type || undefined,
        severity: severity || undefined,
        campaignId: campaignId || undefined,
        importJobId: importJobId || undefined,
      });
      res.json(result);
    } catch (error) {
      console.error("Error fetching error logs:", error);
      res.status(500).json({ error: "Failed to fetch error logs" });
    }
  });

  app.get("/api/error-logs/stats", async (req: Request, res: Response) => {
    try {
      const stats = await storage.getErrorLogStats();
      res.json(stats);
    } catch (error) {
      console.error("Error fetching error log stats:", error);
      res.status(500).json({ error: "Failed to fetch error log stats" });
    }
  });

  app.delete("/api/error-logs", async (req: Request, res: Response) => {
    try {
      const beforeDate = req.query.before ? new Date(req.query.before as string) : undefined;
      const count = await storage.clearErrorLogs(beforeDate);
      res.json({ deleted: count });
    } catch (error) {
      console.error("Error clearing error logs:", error);
      res.status(500).json({ error: "Failed to clear error logs" });
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
      // Check if this is the first open for this subscriber/campaign (unique per email per campaign)
      const isFirstOpen = await storage.recordFirstOpen(campaignId, subscriberId);
      
      // Always record the open for activity history/analytics
      await storage.addCampaignStat(campaignId, subscriberId, "open");
      
      // Return pixel immediately - don't block on tag processing
      returnPixel();
      
      // Queue tag addition asynchronously (fire-and-forget)
      // This ensures 100% delivery with retry logic, without delaying the response
      if (isFirstOpen) {
        const campaign = await storage.getCampaign(campaignId);
        if (campaign?.openTag) {
          storage.enqueueTagOperation(subscriberId, "positive", campaign.openTag, "open", campaignId)
            .catch(err => console.error("Failed to enqueue open tag:", err));
        }
      }
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
      // Check if this is the first click for this subscriber/campaign (unique per email per campaign)
      const isFirstClick = await storage.recordFirstClick(campaignId, subscriberId);
      
      // Always record the click for link-level analytics (topLinks needs all clicks)
      await storage.addCampaignStat(campaignId, subscriberId, "click", url);
      
      // Redirect to actual URL immediately - don't block on tag processing
      res.redirect(url);
      
      // Queue tag addition asynchronously (fire-and-forget)
      // This ensures 100% delivery with retry logic, without delaying the redirect
      if (isFirstClick) {
        const campaign = await storage.getCampaign(campaignId);
        if (campaign?.clickTag) {
          storage.enqueueTagOperation(subscriberId, "positive", campaign.clickTag, "click", campaignId)
            .catch(err => console.error("Failed to enqueue click tag:", err));
        }
      }
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
      
      // Send confirmation page immediately - don't block on tag processing
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
      
      // Queue tag additions asynchronously (fire-and-forget)
      // This ensures 100% delivery with retry logic, without delaying the response
      if (subscriber) {
        // BCK tag is always added (blocklist)
        storage.enqueueTagOperation(subscriberId, "negative", "BCK", "unsubscribe", campaignId)
          .catch(err => console.error("Failed to enqueue BCK tag:", err));
        
        // Add campaign-specific unsubscribe tag if configured
        if (campaign?.unsubscribeTag) {
          storage.enqueueTagOperation(subscriberId, "negative", campaign.unsubscribeTag, "unsubscribe", campaignId)
            .catch(err => console.error("Failed to enqueue unsubscribe tag:", err));
        }
      }
    } catch (error) {
      console.error("Error unsubscribing:", error);
      res.status(500).send("An error occurred");
    }
  });

  return httpServer;
}

// ============ TAG QUEUE WORKER ============
// Background worker that processes pending tag operations with retry logic
let tagQueueInterval: NodeJS.Timeout | null = null;

async function processTagQueue() {
  try {
    // Claim pending operations
    const operations = await storage.claimPendingTagOperations(50);
    
    if (operations.length === 0) {
      return;
    }
    
    // Process each operation
    for (const op of operations) {
      try {
        // Use atomic tag addition
        await storage.addTagToSubscriber(
          op.subscriberId,
          op.tagType as "positive" | "negative",
          op.tagValue
        );
        
        // Mark as completed
        await storage.completeTagOperation(op.id);
      } catch (error: any) {
        console.error(`Failed to process tag operation ${op.id}:`, error);
        await storage.failTagOperation(op.id, error.message || "Unknown error");
      }
    }
    
    if (operations.length > 0) {
      console.log(`Processed ${operations.length} tag operations`);
    }
  } catch (error) {
    console.error("Error in tag queue processing:", error);
  }
}

// Start the tag queue worker
export function startTagQueueWorker() {
  if (tagQueueInterval) {
    return; // Already running
  }
  
  console.log("Starting tag queue worker...");
  
  // Process immediately, then every 500ms
  processTagQueue();
  tagQueueInterval = setInterval(processTagQueue, 500);
  
  // Cleanup completed operations every hour
  setInterval(async () => {
    try {
      const cleaned = await storage.cleanupCompletedTagOperations(7);
      if (cleaned > 0) {
        console.log(`Cleaned up ${cleaned} completed tag operations`);
      }
    } catch (error) {
      console.error("Error cleaning up tag operations:", error);
    }
  }, 60 * 60 * 1000);
}

// Sending speed configurations (emails per minute and concurrent workers)
const SPEED_CONFIG: Record<string, { emailsPerMinute: number; concurrency: number }> = {
  slow: { emailsPerMinute: 500, concurrency: 5 },
  medium: { emailsPerMinute: 1000, concurrency: 10 },
  fast: { emailsPerMinute: 2000, concurrency: 20 },
  godzilla: { emailsPerMinute: 3000, concurrency: 50 },
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

// Check for paused campaigns due to MTA down and auto-resume when MTA is back
let mtaRecoveryInterval: NodeJS.Timeout | null = null;
async function checkMtaRecovery() {
  try {
    // Get all campaigns paused due to MTA being down
    const pausedCampaigns = await storage.getCampaignsByPauseReason("mta_down");
    
    for (const campaign of pausedCampaigns) {
      if (!campaign.mtaId) continue;
      
      const mta = await storage.getMta(campaign.mtaId);
      if (!mta) continue;
      
      // Try to verify MTA connection
      const verifyResult = await verifyTransporter(mta);
      
      if (verifyResult.success) {
        console.log(`MTA ${mta.name} is back online - resuming campaign ${campaign.id} (${campaign.name})`);
        // Clear any stuck processing jobs before enqueuing new one
        await storage.clearStuckJobsForCampaign(campaign.id);
        // Clear pause reason and set status back to sending
        await storage.updateCampaign(campaign.id, { status: "sending", pauseReason: null });
        // Re-enqueue for processing
        await storage.enqueueCampaignJob(campaign.id);
      }
    }
  } catch (error) {
    console.error("Error checking MTA recovery:", error);
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
  
  // Start MTA recovery checker - check every 30 seconds for MTA-down paused campaigns
  if (!mtaRecoveryInterval) {
    mtaRecoveryInterval = setInterval(checkMtaRecovery, 30000);
    console.log("MTA recovery checker started (30s interval)");
  }
}

// Stop the background job processor
function stopJobProcessor() {
  if (jobPollingInterval) {
    clearInterval(jobPollingInterval);
    jobPollingInterval = null;
    console.log("Job processor stopped");
  }
  if (mtaRecoveryInterval) {
    clearInterval(mtaRecoveryInterval);
    mtaRecoveryInterval = null;
    console.log("MTA recovery checker stopped");
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
let lastRecoveryCheck = 0;
async function pollForImportJobs() {
  try {
    // Only run recovery check every 5 minutes to avoid excessive DB queries
    const now = Date.now();
    if (now - lastRecoveryCheck > 5 * 60 * 1000) {
      lastRecoveryCheck = now;
      
      // Recover stuck import jobs from crashed workers or server restarts
      const recoveredCount = await storage.recoverStuckImportJobs();
      if (recoveredCount > 0) {
        console.log(`Recovered ${recoveredCount} stuck import jobs back to pending`);
      }
      
      // Clean up stale import jobs from crashed workers
      const staleCount = await storage.cleanupStaleImportJobs(30);
      if (staleCount > 0) {
        console.log(`Cleaned up ${staleCount} stale import jobs`);
      }
    }
    
    // Try to claim a pending import job using FOR UPDATE SKIP LOCKED
    const queueItem = await storage.claimNextImportJob(WORKER_ID);
    
    if (!queueItem) {
      return; // No pending import jobs
    }
    
    console.log(`Worker ${WORKER_ID} claimed import job queue item ${queueItem.id} for import ${queueItem.importJobId}`);
    
    try {
      await processImportFromQueue(queueItem.id, queueItem.importJobId, queueItem.csvFilePath);
      await storage.completeImportQueueJob(queueItem.id, "completed");
      console.log(`Import job ${queueItem.id} completed successfully`);
    } catch (error: any) {
      console.error(`Error processing import job ${queueItem.id}:`, error);
      await storage.completeImportQueueJob(queueItem.id, "failed", error.message || "Unknown error");
      await storage.updateImportJob(queueItem.importJobId, {
        status: "failed",
        errorMessage: error.message || "Unknown error",
      });
      try {
        await storage.logError({
          type: "import_failed",
          severity: "error",
          message: `Import job failed: ${error.message || "Unknown error"}`,
          importJobId: queueItem.importJobId,
          details: error?.stack || String(error),
        });
      } catch (logError) {
        console.error("Failed to log error:", logError);
      }
    }
  } catch (error) {
    console.error("Error in import job polling:", error);
  }
}

// Production-ready import processor with file-based streaming and bulk upserts
async function processImportFromQueue(queueId: string, importJobId: string, csvFilePath: string) {
  console.log(`[IMPORT] Processing job ${importJobId} from file: ${csvFilePath}`);
  
  // Check file exists
  if (!fs.existsSync(csvFilePath)) {
    throw new Error(`CSV file not found: ${csvFilePath}`);
  }
  
  // Get import job to retrieve tagMode
  const importJob = await storage.getImportJob(importJobId);
  const tagMode = (importJob?.tagMode as "merge" | "override") || "merge";
  console.log(`[IMPORT] ${importJobId}: Using tag mode: ${tagMode}`);
  
  // Read file content - for production with huge files, we'd use streaming
  // but for reliability we read the full file
  const csvContent = fs.readFileSync(csvFilePath, 'utf-8');
  const lines = csvContent.split('\n');
  
  // Parse header
  const headerLine = lines[0];
  if (!headerLine) {
    throw new Error('CSV file is empty');
  }
  
  const header = headerLine.split(',').map(h => h.trim().toLowerCase());
  console.log(`[IMPORT] ${importJobId}: Header columns: ${header.join(', ')}`);
  
  const emailIdx = header.indexOf('email');
  const tagsIdx = header.indexOf('tags');
  const ipIdx = header.indexOf('ip_address');
  
  if (emailIdx === -1) {
    await storage.updateImportJob(importJobId, {
      status: 'failed',
      errorMessage: "CSV must have an 'email' column",
    });
    throw new Error("CSV must have an 'email' column");
  }
  
  await storage.updateImportJob(importJobId, { status: 'processing' });
  
  const BATCH_SIZE = 5000; // Smaller batches for better memory and progress tracking
  const HEARTBEAT_INTERVAL = 30000; // 30 seconds
  
  let processedRows = 0;
  let newSubscribers = 0;
  let updatedSubscribers = 0;
  let failedRows = 0;
  let lastHeartbeat = Date.now();
  
  // Process data rows (skip header at index 0)
  for (let batchStart = 1; batchStart < lines.length; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, lines.length);
    const batchRows: Array<{ email: string; tags: string[]; ipAddress: string | null; lineNumber: number }> = [];
    
    // Parse batch into structured data
    for (let i = batchStart; i < batchEnd; i++) {
      const line = lines[i];
      if (!line || !line.trim()) {
        continue; // Skip empty lines
      }
      
      try {
        const cols = line.split(',').map(c => c.trim());
        const email = cols[emailIdx]?.toLowerCase();
        
        if (!email || !email.includes('@')) {
          failedRows++;
          processedRows++;
          continue;
        }
        
        const tags = tagsIdx >= 0 && cols[tagsIdx]
          ? cols[tagsIdx].split(';').map(t => t.trim().toUpperCase()).filter(Boolean)
          : [];
        const ipAddress = ipIdx >= 0 ? cols[ipIdx] || null : null;
        
        batchRows.push({ email, tags, ipAddress, lineNumber: i });
        processedRows++;
      } catch (err) {
        failedRows++;
        processedRows++;
      }
    }
    
    // Bulk upsert using PostgreSQL ON CONFLICT
    if (batchRows.length > 0) {
      try {
        const result = await bulkUpsertSubscribers(importJobId, batchRows, tagMode);
        newSubscribers += result.inserted;
        updatedSubscribers += result.updated;
      } catch (err: any) {
        console.error(`[IMPORT] Bulk upsert failed for batch:`, err.message);
        // Fall back to individual inserts if bulk fails
        for (const row of batchRows) {
          try {
            const existing = await storage.getSubscriberByEmail(row.email);
            if (existing) {
              const mergedTags = tagMode === "override" 
                ? row.tags 
                : [...new Set([...(existing.tags || []), ...row.tags])];
              await storage.updateSubscriber(existing.id, { tags: mergedTags });
              updatedSubscribers++;
            } else {
              await storage.createSubscriber(row);
              newSubscribers++;
            }
          } catch (individualErr) {
            failedRows++;
          }
        }
      }
    }
    
    // Update heartbeat and progress
    const now = Date.now();
    if (now - lastHeartbeat > HEARTBEAT_INTERVAL) {
      await storage.updateImportQueueHeartbeat(queueId);
      lastHeartbeat = now;
    }
    
    // Update progress after each batch
    await storage.updateImportQueueProgress(queueId, processedRows);
    await storage.updateImportJob(importJobId, {
      processedRows,
      newSubscribers,
      updatedSubscribers,
      failedRows,
    });
    
    console.log(`[IMPORT] ${importJobId}: Batch ${Math.ceil(batchStart / BATCH_SIZE)} - processed: ${processedRows}, new: ${newSubscribers}, updated: ${updatedSubscribers}, failed: ${failedRows}`);
  }
  
  // Mark complete and cleanup file
  await storage.updateImportJob(importJobId, {
    status: 'completed',
    completedAt: new Date(),
    processedRows,
    newSubscribers,
    updatedSubscribers,
    failedRows,
  });
  
  // Clean up the CSV file after successful processing
  try {
    fs.unlinkSync(csvFilePath);
    console.log(`[IMPORT] ${importJobId}: Cleaned up CSV file`);
  } catch (err) {
    console.error(`[IMPORT] Failed to clean up CSV file: ${csvFilePath}`);
  }
  
  console.log(`[IMPORT] ${importJobId}: Complete - processed: ${processedRows}, new: ${newSubscribers}, updated: ${updatedSubscribers}, failed: ${failedRows}`);
}

// High-speed bulk upsert using staging table + single merge query
// This is 10-100x faster than individual INSERT statements
async function bulkUpsertSubscribers(
  jobId: string,
  rows: Array<{ email: string; tags: string[]; ipAddress: string | null; lineNumber: number }>,
  tagMode: "merge" | "override" = "merge"
): Promise<{ inserted: number; updated: number }> {
  if (rows.length === 0) {
    return { inserted: 0, updated: 0 };
  }
  
  // Build multi-row VALUES clause for staging table
  // Using parameterized query building for safety
  const CHUNK_SIZE = 500; // Reasonable chunk for VALUES clause
  let totalInserted = 0;
  let totalUpdated = 0;
  
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    
    // Build VALUES clause dynamically
    const valuesClauses: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;
    
    for (const row of chunk) {
      const email = row.email.toLowerCase();
      // Format tags as PostgreSQL array literal
      const tagsArray = `{${row.tags.map(t => `"${t.replace(/"/g, '\\"')}"`).join(',')}}`;
      valuesClauses.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}::text[], $${paramIdx + 3}, $${paramIdx + 4})`);
      params.push(jobId, email, tagsArray, row.ipAddress, row.lineNumber);
      paramIdx += 5;
    }
    
    try {
      // Step 1: Insert into staging table using pool directly for parameterized query
      const insertSql = `
        INSERT INTO import_staging (job_id, email, tags, ip_address, line_number)
        VALUES ${valuesClauses.join(', ')}
      `;
      await pool.query(insertSql, params);
      
      // Step 2: Merge from staging to subscribers with single SQL statement
      // First aggregate duplicate emails within the staging batch to preserve all tags
      // Uses LEFT JOIN LATERAL to preserve rows with empty tag arrays
      // Uses line_number for deterministic IP selection (last row wins)
      // tagMode determines whether to merge or override existing tags
      const mergeResult = tagMode === "override" 
        ? await db.execute(sql`
          WITH aggregated_staging AS (
            SELECT 
              s.email,
              COALESCE(
                array_agg(DISTINCT t.tag) FILTER (WHERE t.tag IS NOT NULL),
                ARRAY[]::text[]
              ) AS tags,
              (array_agg(s.ip_address ORDER BY s.line_number DESC))[1] AS ip_address
            FROM import_staging s
            LEFT JOIN LATERAL unnest(s.tags) AS t(tag) ON true
            WHERE s.job_id = ${jobId}
            GROUP BY s.email
          ),
          merge_data AS (
            INSERT INTO subscribers (email, tags, ip_address, import_date)
            SELECT email, tags, ip_address, NOW()
            FROM aggregated_staging
            ON CONFLICT (email) DO UPDATE 
            SET tags = EXCLUDED.tags,
            ip_address = COALESCE(EXCLUDED.ip_address, subscribers.ip_address)
            RETURNING (xmax = 0) AS is_insert
          )
          SELECT 
            COUNT(*) FILTER (WHERE is_insert = true) AS inserted,
            COUNT(*) FILTER (WHERE is_insert = false) AS updated
          FROM merge_data
        `)
        : await db.execute(sql`
          WITH aggregated_staging AS (
            SELECT 
              s.email,
              COALESCE(
                array_agg(DISTINCT t.tag) FILTER (WHERE t.tag IS NOT NULL),
                ARRAY[]::text[]
              ) AS tags,
              (array_agg(s.ip_address ORDER BY s.line_number DESC))[1] AS ip_address
            FROM import_staging s
            LEFT JOIN LATERAL unnest(s.tags) AS t(tag) ON true
            WHERE s.job_id = ${jobId}
            GROUP BY s.email
          ),
          merge_data AS (
            INSERT INTO subscribers (email, tags, ip_address, import_date)
            SELECT email, tags, ip_address, NOW()
            FROM aggregated_staging
            ON CONFLICT (email) DO UPDATE 
            SET tags = COALESCE(
              (SELECT array_agg(DISTINCT t) 
               FROM unnest(subscribers.tags || EXCLUDED.tags) AS t
               WHERE t IS NOT NULL),
              ARRAY[]::text[]
            ),
            ip_address = COALESCE(EXCLUDED.ip_address, subscribers.ip_address)
            RETURNING (xmax = 0) AS is_insert
          )
          SELECT 
            COUNT(*) FILTER (WHERE is_insert = true) AS inserted,
            COUNT(*) FILTER (WHERE is_insert = false) AS updated
          FROM merge_data
        `);
      
      // Step 3: Clear staging for this job
      await db.execute(sql`DELETE FROM import_staging WHERE job_id = ${jobId}`);
      
      if (mergeResult.rows.length > 0) {
        const result = mergeResult.rows[0] as any;
        totalInserted += parseInt(result.inserted || '0');
        totalUpdated += parseInt(result.updated || '0');
      }
    } catch (err: any) {
      console.error(`[IMPORT] Bulk upsert chunk failed:`, err.message);
      // Clean up staging on error
      await db.execute(sql`DELETE FROM import_staging WHERE job_id = ${jobId}`);
      
      // Fall back to individual inserts for this chunk
      for (const row of chunk) {
        try {
          const result = tagMode === "override"
            ? await db.execute(sql`
              INSERT INTO subscribers (email, tags, ip_address, import_date)
              VALUES (${row.email.toLowerCase()}, ${row.tags}::text[], ${row.ipAddress}, NOW())
              ON CONFLICT (email) DO UPDATE 
              SET tags = EXCLUDED.tags
              RETURNING (xmax = 0) AS is_insert
            `)
            : await db.execute(sql`
              INSERT INTO subscribers (email, tags, ip_address, import_date)
              VALUES (${row.email.toLowerCase()}, ${row.tags}::text[], ${row.ipAddress}, NOW())
              ON CONFLICT (email) DO UPDATE 
              SET tags = COALESCE(
                (SELECT array_agg(DISTINCT t) 
                 FROM unnest(subscribers.tags || EXCLUDED.tags) AS t
                 WHERE t IS NOT NULL),
                ARRAY[]::text[]
              )
              RETURNING (xmax = 0) AS is_insert
            `);
          
          if (result.rows.length > 0) {
            const isInsert = (result.rows[0] as any).is_insert;
            if (isInsert) totalInserted++;
            else totalUpdated++;
          }
        } catch (individualErr) {
          // Skip failed rows
        }
      }
    }
  }
  
  return { inserted: totalInserted, updated: totalUpdated };
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
  let mta: Awaited<ReturnType<typeof storage.getMta>> | null = null;
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
      // Pause instead of fail - will auto-resume when MTA is back online
      await storage.updateCampaign(campaignId, { status: "paused", pauseReason: "mta_down" });
      console.log(`Campaign ${campaignId}: Paused due to MTA unavailable - will auto-resume when MTA is back`);
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
  
  // Get speed configuration for parallel processing
  const speedKey = campaign.sendingSpeed || "medium";
  const speedConfig = SPEED_CONFIG[speedKey] || SPEED_CONFIG.medium;
  const { emailsPerMinute, concurrency } = speedConfig;
  
  // Calculate delay between batches to respect rate limits
  // For parallel sending: we send `concurrency` emails at once, then wait
  const batchDelayMs = Math.floor((concurrency / emailsPerMinute) * 60000);
  
  console.log(`[CAMPAIGN] ${campaignId}: Starting parallel send - Speed: ${speedKey}, Concurrency: ${concurrency}, Rate: ${emailsPerMinute}/min`);
  
  // Process in batches of 1000 to avoid memory issues
  const BATCH_SIZE = 1000;
  let offset = 0;
  let processedCount = 0;
  let totalSent = 0;
  let totalFailed = 0;
  const startTime = Date.now();
  
  // Capture campaign reference for closure (guaranteed defined at this point)
  const campaignRef = campaign;
  const mtaRef = mta;
  
  // Fetch default headers and convert to Record<string, string>
  const defaultHeaders = await storage.getDefaultHeaders();
  const customHeadersMap: Record<string, string> = {};
  for (const header of defaultHeaders) {
    customHeadersMap[header.name] = header.value;
  }
  
  // Helper function to send a single email (used by parallel workers)
  async function sendSingleEmail(subscriber: any): Promise<{ success: boolean; email: string }> {
    // Reserve send slot BEFORE attempting to send
    const reserved = await storage.reserveSendSlot(campaignId, subscriber.id);
    
    if (!reserved) {
      // Email was already reserved/sent to this subscriber - skip
      return { success: true, email: subscriber.email }; // Count as processed, not failed
    }
    
    let sendSuccess = true;
    try {
      if (mtaRef) {
        // Use nullsink-aware sending (routes to real SMTP or nullsink based on MTA mode)
        const result = await sendEmailWithNullsink(mtaRef, subscriber, campaignRef, {
          trackOpens: campaignRef.trackOpens,
          trackClicks: campaignRef.trackClicks,
          trackingDomain: mtaRef.trackingDomain,
          openTrackingDomain: mtaRef.openTrackingDomain,
          openTag: campaignRef.openTag,
          clickTag: campaignRef.clickTag,
        }, customHeadersMap);
        
        sendSuccess = result.success;
        
        // If using nullsink mode, store the capture
        if ((mtaRef as any).mode === "nullsink" && result.capture) {
          try {
            await storage.createNullsinkCapture(result.capture);
          } catch (captureErr) {
            // Ignore capture errors
          }
        }
        
        if (!result.success) {
          console.error(`Failed to send to ${subscriber.email}: ${result.error}`);
          await storage.logError({
            type: "send_failed",
            severity: "error",
            message: `Failed to send email: ${result.error}`,
            email: subscriber.email,
            campaignId: campaignRef.id,
            subscriberId: subscriber.id,
            details: `MTA: ${mtaRef.name}, Mode: ${(mtaRef as any).mode || 'real'}`,
          }).catch(() => {});
        }
      }
    } catch (error: any) {
      console.error(`Exception sending to ${subscriber.email}:`, error.message);
      sendSuccess = false;
      await storage.logError({
        type: "send_failed",
        severity: "error",
        message: `Exception during email send: ${error?.message || "Unknown error"}`,
        email: subscriber.email,
        campaignId: campaignRef.id,
        subscriberId: subscriber.id,
        details: error?.stack || String(error),
      }).catch(() => {});
    }
    
    // Finalize the send with the result
    try {
      await storage.finalizeSend(campaignId, subscriber.id, sendSuccess);
    } catch (finalizeError: any) {
      console.error(`INVARIANT VIOLATION during finalize for ${subscriber.email}: ${finalizeError.message}`);
      await storage.forceFailPendingSend(campaignId, subscriber.id).catch(() => {});
    }
    
    return { success: sendSuccess, email: subscriber.email };
  }
  
  // Process batches with parallel workers
  while (true) {
    // Check if campaign was paused or cancelled (atomic read)
    const currentCampaign = await storage.getCampaign(campaignId);
    if (!currentCampaign || currentCampaign.status !== "sending") {
      console.log(`[CAMPAIGN] ${campaignId}: Paused/cancelled at ${processedCount} processed`);
      break;
    }
    
    // Fetch batch of subscribers (using SQL-level filtering with BCK exclusion)
    const batch = await storage.getSubscribersForSegment(campaign.segmentId, BATCH_SIZE, offset);
    
    if (batch.length === 0) {
      // No more subscribers
      break;
    }
    
    // Process this batch in parallel chunks
    for (let i = 0; i < batch.length; i += concurrency) {
      // Check pause status at start of each parallel chunk
      if (i > 0 && i % (concurrency * 10) === 0) {
        const checkCampaign = await storage.getCampaign(campaignId);
        if (!checkCampaign || checkCampaign.status !== "sending") {
          console.log(`[CAMPAIGN] ${campaignId}: Paused during batch at ${processedCount}`);
          return;
        }
      }
      
      // Get chunk of subscribers for parallel processing
      const chunk = batch.slice(i, i + concurrency);
      
      // Send all emails in this chunk in parallel
      const results = await Promise.allSettled(
        chunk.map(subscriber => sendSingleEmail(subscriber))
      );
      
      // Count results
      for (const result of results) {
        processedCount++;
        if (result.status === "fulfilled") {
          if (result.value.success) {
            totalSent++;
          } else {
            totalFailed++;
          }
        } else {
          totalFailed++;
        }
      }
      
      // Apply rate limiting between parallel batches
      if (batchDelayMs > 0 && i + concurrency < batch.length) {
        await new Promise(resolve => setTimeout(resolve, batchDelayMs));
      }
    }
    
    // Log progress every batch
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = processedCount / elapsed * 60;
    console.log(`[CAMPAIGN] ${campaignId}: Progress ${processedCount}/${total} (${rate.toFixed(0)}/min) - Sent: ${totalSent}, Failed: ${totalFailed}`);
    
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
