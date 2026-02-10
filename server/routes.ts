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
  segmentRulesArraySchema,
  campaigns,
  campaignJobs,
  importJobs,
  importJobQueue,
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
import { fork, ChildProcess } from "child_process";
import { ObjectStorageService } from "./replit_integrations/object_storage";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import { logger } from "./logger";
import sanitizeHtml from "sanitize-html";
import { registerSubscriberRoutes } from "./routes/subscribers";
import { registerSegmentRoutes } from "./routes/segments";
import { registerMtaRoutes } from "./routes/mtas";
import { registerTrackingRoutes } from "./routes/tracking";
import { registerWebhookRoutes } from "./routes/webhooks";
import { registerAnalyticsRoutes } from "./routes/analytics";
import { registerAbTestingRoutes } from "./routes/ab-testing";
import { registerWarmupRoutes } from "./routes/warmup";
import { registerAutomationRoutes } from "./routes/automation";
import { registerAdvancedAnalyticsRoutes } from "./routes/advanced-analytics";

const dnsLookup = promisify(dns.lookup);

// Object storage service for persistent file storage (survives deployments)
const objectStorageService = new ObjectStorageService();

// Ensure uploads directory exists for disk storage
const UPLOADS_DIR_BASE = path.join(process.cwd(), "uploads", "imports");
if (!fs.existsSync(UPLOADS_DIR_BASE)) {
  fs.mkdirSync(UPLOADS_DIR_BASE, { recursive: true });
}

// Use disk storage for imports to avoid memory issues with large files (300MB+)
const importDiskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_DIR_BASE);
  },
  filename: (_req, _file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    cb(null, `import-${uniqueSuffix}.csv`);
  }
});

const uploadToDisk = multer({ 
  storage: importDiskStorage,
  limits: { fileSize: 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowedMimes = ['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel'];
    const allowedExts = ['.csv', '.txt'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed for import'));
    }
  },
});

// Disk storage for chunk uploads (no file type filter - chunks are raw binary)
const chunkDiskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_DIR_BASE);
  },
  filename: (_req, _file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    cb(null, `chunk-${uniqueSuffix}.bin`);
  }
});

const uploadChunkToDisk = multer({
  storage: chunkDiskStorage,
  limits: { fileSize: 30 * 1024 * 1024 },
});

// Memory storage for small file uploads (images, etc.)
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
        logger.info(`Cleaned up orphaned temp session: ${entry}`);
      }
    }
  } catch (error) {
    logger.error("Error cleaning up temp sessions:", error);
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
    logger.info(`[Image download] Failed: ${url} - too many redirects`);
    return false;
  }
  
  let urlObj: URL;
  let resolvedIP: string;
  
  try {
    urlObj = new URL(url);
    
    if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") {
      logger.info(`[Image download] Failed: ${url} - invalid protocol`);
      return false;
    }
    
    if (isBlockedHost(urlObj.hostname)) {
      logger.info(`[Image download] Failed: ${url} - blocked host`);
      return false;
    }
    
    const result = await dnsLookup(urlObj.hostname);
    resolvedIP = result.address;
    
    if (isBlockedIP(resolvedIP)) {
      logger.info(`[Image download] Failed: ${url} - blocked IP ${resolvedIP}`);
      return false;
    }
  } catch (error) {
    logger.info(`[Image download] Failed: ${url} - DNS/URL error: ${error}`);
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
      // Add servername for TLS SNI (required for HTTPS requests with custom lookup)
      servername: urlObj.hostname,
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
        logger.info(`[Image download] Failed: ${url} - HTTP ${response.statusCode}`);
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
      logger.info(`[Image download] Failed: ${url} - network error: ${err.message}`);
      resolve(false);
    });
    
    request.on("timeout", () => {
      logger.info(`[Image download] Failed: ${url} - timeout`);
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

function sanitizeCampaignHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      'img', 'style', 'head', 'html', 'body', 'meta', 'title',
      'center', 'font', 'span', 'div', 'table', 'tr', 'td', 'th',
      'thead', 'tbody', 'tfoot', 'caption', 'colgroup', 'col',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'br', 'p',
      'a', 'b', 'i', 'u', 'em', 'strong', 'sup', 'sub',
      'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
    ]),
    allowedAttributes: {
      '*': ['style', 'class', 'id', 'dir', 'lang', 'align', 'valign', 'bgcolor', 'background', 'width', 'height', 'border', 'cellpadding', 'cellspacing'],
      'a': ['href', 'target', 'rel', 'title', 'name'],
      'img': ['src', 'alt', 'title', 'width', 'height'],
      'td': ['colspan', 'rowspan', 'width', 'height', 'align', 'valign', 'bgcolor', 'style'],
      'th': ['colspan', 'rowspan', 'width', 'height', 'align', 'valign', 'bgcolor', 'style'],
      'table': ['width', 'height', 'border', 'cellpadding', 'cellspacing', 'align', 'bgcolor', 'style'],
      'font': ['color', 'size', 'face'],
      'meta': ['charset', 'name', 'content', 'http-equiv'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'data'],
    allowedSchemesByTag: {
      img: ['http', 'https', 'data'],
    },
    allowVulnerableTags: false,
  });
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  const generalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" },
  });
  app.use("/api/", generalLimiter);

  const importLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many import requests, please try again later" },
  });
  app.use("/api/import", importLimiter);

  const campaignLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many campaign requests, please try again later" },
  });
  app.use("/api/campaigns", campaignLimiter);

  const trackingLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use("/api/track/", trackingLimiter);
  app.use("/api/unsubscribe/", trackingLimiter);

  const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many webhook requests, please try again later" },
  });
  app.use("/api/webhooks/", webhookLimiter);

  function parsePagination(query: any): { page: number; limit: number } {
    const page = Math.max(1, Math.min(10000, parseInt(query.page as string) || 1));
    const limit = Math.max(1, Math.min(100, parseInt(query.limit as string) || 20));
    return { page, limit };
  }

  function validateId(id: string): boolean {
    return typeof id === 'string' && id.length > 0 && id.length <= 100 && /^[a-zA-Z0-9_-]+$/.test(id);
  }

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
      let dbHealthy = true;
      try {
        await db.execute(sql`SELECT 1`);
      } catch {
        dbHealthy = false;
      }

      const startTime = Date.now();
      await storage.healthCheck();
      const dbLatency = Date.now() - startTime;
      
      const poolStats = {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount,
      };
      
      const memUsage = process.memoryUsage();
      
      let queueDepths: any = {};
      try {
        const [campaignQueue, importQueue, tagQueue] = await Promise.all([
          pool.query("SELECT COUNT(*) as count FROM campaign_jobs WHERE status IN ('pending', 'processing')"),
          pool.query("SELECT COUNT(*) as count FROM import_job_queue WHERE status IN ('pending', 'processing')"),
          pool.query("SELECT COUNT(*) as count FROM pending_tag_operations WHERE status IN ('pending', 'processing')"),
        ]);
        queueDepths = {
          campaignJobs: parseInt(campaignQueue.rows[0]?.count || '0'),
          importJobs: parseInt(importQueue.rows[0]?.count || '0'),
          pendingTags: parseInt(tagQueue.rows[0]?.count || '0'),
        };
      } catch (queueErr) {
        queueDepths = { error: "Failed to query queue depths" };
      }

      const allWorkersRunning = !!jobPollingInterval && !!importJobPollingInterval && !!tagQueueInterval && !!flushJobPollingInterval;

      res.json({
        status: (dbHealthy && allWorkersRunning) ? 'healthy' : 'degraded',
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        database: {
          healthy: dbHealthy,
          status: dbHealthy ? "connected" : "disconnected",
          latencyMs: dbLatency,
          pool: poolStats,
        },
        memory: {
          heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
          heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
          rssMB: Math.round(memUsage.rss / 1024 / 1024),
        },
        workers: {
          jobProcessor: !!jobPollingInterval,
          importProcessor: !!importJobPollingInterval,
          tagQueueWorker: !!tagQueueInterval,
          flushProcessor: !!flushJobPollingInterval,
        },
        queues: queueDepths,
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
      const { limit } = parsePagination(req.query);
      const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
      
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
      logger.error("Error fetching import queue debug info:", error);
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
      logger.error("Error recovering stuck imports:", error);
      res.status(500).json({ error: "Failed to recover stuck imports" });
    }
  });

  // Debug endpoint to manually process an import job (deprecated - use normal import flow)
  app.post("/api/debug/force-process-import/:queueId", async (req: Request, res: Response) => {
    res.status(410).json({ error: "This debug endpoint is deprecated. Use the normal import flow." });
  });

  app.get("/api/debug/import-queue-details/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
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
      logger.error("Error fetching queue details:", error);
      res.status(500).json({ error: "Failed to fetch queue details" });
    }
  });
  
  // ============ MODULAR ROUTES ============
  const helpers = { parsePagination, validateId, sanitizeCampaignHtml };
  registerSubscriberRoutes(app, helpers);
  registerSegmentRoutes(app, helpers);
  registerMtaRoutes(app, helpers);
  registerTrackingRoutes(app);
  registerWebhookRoutes(app);
  registerAnalyticsRoutes(app, helpers);
  registerAbTestingRoutes(app, helpers);
  registerWarmupRoutes(app);
  registerAutomationRoutes(app);
  registerAdvancedAnalyticsRoutes(app);

  // ============ CAMPAIGNS ============
  
  // Send test email endpoint - Uses the selected MTA's SMTP configuration
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
      
      // Get MTA configuration
      let mta = null;
      if (mtaId) {
        mta = await storage.getMta(mtaId);
      }
      
      // Build email headers
      const headers: Record<string, string> = {
        "X-Campaign-ID": "test-campaign",
        "X-Subscriber-ID": "test-subscriber",
        "X-Test-Email": "true",
      };
      
      // Add default custom headers with {UNSUBSCRIBE} placeholder replacement
      const defaultHeaders = await storage.getDefaultHeaders();
      const trackingDomain = mta?.trackingDomain || undefined;
      const testUnsubscribeUrl = trackingDomain 
        ? `${trackingDomain.replace(/\/$/, "")}/api/unsubscribe/test-campaign/test-subscriber`
        : "#unsubscribe-placeholder";
      
      for (const header of defaultHeaders) {
        const resolvedValue = header.value.replace(/\{UNSUBSCRIBE\}/gi, testUnsubscribeUrl);
        headers[header.name] = resolvedValue;
      }
      
      // If MTA is selected, use SMTP to send test email
      if (mta) {
        logger.info(`[TEST EMAIL] Sending via MTA SMTP (${mta.name}) to: ${email}`);
        const { sendTestEmailViaSMTP } = await import("./email-service");
        
        const result = await sendTestEmailViaSMTP(mta, {
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
        });
        
        if (result.success) {
          res.json({ success: true, messageId: result.messageId });
        } else {
          res.status(500).json({ error: result.error || "Failed to send test email via SMTP" });
        }
        return;
      }
      
      // Fallback to Resend API if no MTA selected
      logger.info(`[TEST EMAIL] No MTA selected, using Resend API to: ${email}`);
      const { sendTestEmailViaResend } = await import("./resend-client");
      
      const result = await sendTestEmailViaResend({
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
      });
      
      if (result.success) {
        res.json({ success: true, messageId: result.messageId });
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
      const campaignsList = await storage.getCampaigns();
      res.json(campaignsList);
    } catch (error) {
      logger.error("Error fetching campaigns:", error);
      res.status(500).json({ error: "Failed to fetch campaigns" });
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

  // ============ HTML IMAGE PROCESSING ============
  // Create a temporary session ID for new campaigns that don't have an ID yet
  app.post("/api/campaign-assets/session", async (_req: Request, res: Response) => {
    const sessionId = `temp_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    res.json({ sessionId });
  });

  app.post("/api/campaigns/:id/process-html", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
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
      logger.error("Error processing HTML:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: `Failed to process HTML content: ${errorMessage}` });
    }
  });

  app.post("/api/campaigns", campaignLimiter, async (req: Request, res: Response) => {
    try {
      logger.info("POST /api/campaigns - Body:", JSON.stringify(req.body));
      
      // Normalize empty FK strings to null before validation
      const normalizedBody = {
        ...req.body,
        mtaId: req.body.mtaId || null,
        segmentId: req.body.segmentId || null,
      };
      
      const data = insertCampaignSchema.parse(normalizedBody);
      if (data.htmlContent) {
        data.htmlContent = sanitizeCampaignHtml(data.htmlContent);
      }
      const campaign = await db.transaction(async (tx) => {
        const [created] = await tx.insert(campaigns).values(data).returning();
        if (created.status === "sending") {
          await tx.insert(campaignJobs).values({
            campaignId: created.id,
            status: "pending",
          });
        }
        return created;
      });
      
      logger.info("Campaign created successfully:", campaign.id);
      res.status(201).json(campaign);
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
      
      // Get the current campaign to check if status is changing
      const existingCampaign = await storage.getCampaign(req.params.id);
      if (!existingCampaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      
      logger.info(`Campaign ${req.params.id} current status: ${existingCampaign.status}, new status: ${req.body.status || 'unchanged'}`);
      
      // Normalize empty FK strings to null to avoid FK violations
      const normalizedBody = { ...req.body };
      if ('mtaId' in normalizedBody && !normalizedBody.mtaId) {
        normalizedBody.mtaId = null;
      }
      if ('segmentId' in normalizedBody && !normalizedBody.segmentId) {
        normalizedBody.segmentId = null;
      }
      if (normalizedBody.htmlContent) {
        normalizedBody.htmlContent = sanitizeCampaignHtml(normalizedBody.htmlContent);
      }
      
      const campaign = await db.transaction(async (tx) => {
        const [updated] = await tx.update(campaigns).set(normalizedBody).where(sql`${campaigns.id} = ${req.params.id}`).returning();
        if (!updated) return null;
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
      
      res.json(campaign);
    } catch (error) {
      logger.error("Error updating campaign:", error);
      res.status(500).json({ error: "Failed to update campaign" });
    }
  });

  app.delete("/api/campaigns/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      await storage.deleteCampaign(req.params.id);
      res.status(204).send();
    } catch (error) {
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
      
      const campaign = await db.transaction(async (tx) => {
        const [updated] = await tx.update(campaigns).set({ status: "sending", pauseReason: null }).where(sql`${campaigns.id} = ${req.params.id}`).returning();
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
      res.json(campaign);
    } catch (error) {
      logger.error("Error resuming campaign:", error);
      res.status(500).json({ error: "Failed to resume campaign" });
    }
  });

  // ============ DEDICATED CAMPAIGN SEND ENDPOINT ============
  // This endpoint atomically saves campaign data, validates, sets status to sending/scheduled, and queues the job
  app.post("/api/campaigns/:id/send", async (req: Request, res: Response) => {
    if (isMemoryPressure) {
      res.setHeader('Retry-After', '60');
      return res.status(503).json({ error: "Server under memory pressure. Please retry later." });
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
      // Step 1: Verify campaign exists
      const existingCampaign = await storage.getCampaign(campaignId);
      if (!existingCampaign) {
        logger.error(`[CAMPAIGN_SEND] ${timestamp} - Campaign ${campaignId} not found`);
        return res.status(404).json({ error: "Campaign not found" });
      }
      
      logger.info(`[CAMPAIGN_SEND] ${timestamp} - Campaign found, current status: ${existingCampaign.status}`);
      
      // Step 2: Validate campaign is in a sendable state
      if (existingCampaign.status === "sending") {
        logger.info(`[CAMPAIGN_SEND] ${timestamp} - Campaign already sending`);
        return res.status(400).json({ error: "Campaign is already sending" });
      }
      if (existingCampaign.status === "completed") {
        logger.info(`[CAMPAIGN_SEND] ${timestamp} - Campaign already completed`);
        return res.status(400).json({ error: "Campaign has already completed" });
      }
      
      // Step 3: Merge and save any final data from the request body (including scheduledAt)
      const updateData = { ...req.body };
      delete updateData.status; // We'll set status ourselves
      
      if (Object.keys(updateData).length > 0) {
        logger.info(`[CAMPAIGN_SEND] ${timestamp} - Saving final campaign data`);
        await storage.updateCampaign(campaignId, updateData);
      }
      
      // Step 4: Re-fetch to get the latest state
      const refreshedCampaign = await storage.getCampaign(campaignId);
      if (!refreshedCampaign) {
        logger.error(`[CAMPAIGN_SEND] ${timestamp} - Campaign disappeared after update`);
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
        logger.error(`[CAMPAIGN_SEND] ${timestamp} - Validation failed:`, validationErrors);
        return res.status(400).json({ 
          error: "Campaign validation failed", 
          details: validationErrors 
        });
      }
      
      // Step 6: Verify MTA exists and is active
      const mta = await storage.getMta(refreshedCampaign.mtaId!);
      if (!mta) {
        logger.error(`[CAMPAIGN_SEND] ${timestamp} - MTA not found: ${refreshedCampaign.mtaId}`);
        return res.status(400).json({ error: "Selected MTA server not found" });
      }
      if (!mta.isActive) {
        logger.error(`[CAMPAIGN_SEND] ${timestamp} - MTA is not active: ${mta.name}`);
        return res.status(400).json({ error: "Selected MTA server is not active" });
      }
      
      // Step 7: Verify segment exists and has subscribers
      const segment = await storage.getSegment(refreshedCampaign.segmentId!);
      if (!segment) {
        logger.error(`[CAMPAIGN_SEND] ${timestamp} - Segment not found: ${refreshedCampaign.segmentId}`);
        return res.status(400).json({ error: "Selected segment not found" });
      }
      
      const subscriberCount = await storage.countSubscribersForSegment(refreshedCampaign.segmentId!);
      logger.info(`[CAMPAIGN_SEND] ${timestamp} - Segment '${segment.name}' has ${subscriberCount} subscribers`);
      
      if (subscriberCount === 0) {
        logger.error(`[CAMPAIGN_SEND] ${timestamp} - Segment has no subscribers`);
        return res.status(400).json({ error: "Selected segment has no subscribers" });
      }
      
      // Step 8: Handle scheduled vs immediate send
      if (isScheduled) {
        // For scheduled campaigns, just update status to "scheduled"
        logger.info(`[CAMPAIGN_SEND] ${timestamp} - Setting campaign status to 'scheduled' for ${req.body.scheduledAt}`);
        const updatedCampaign = await storage.updateCampaign(campaignId, { 
          status: "scheduled",
          scheduledAt: new Date(req.body.scheduledAt)
        });
        
        if (!updatedCampaign || updatedCampaign.status !== "scheduled") {
          logger.error(`[CAMPAIGN_SEND] ${timestamp} - Failed to schedule campaign`);
          return res.status(500).json({ error: "Failed to schedule campaign" });
        }
        
        logger.info(`[CAMPAIGN_SEND] ${timestamp} - Campaign ${campaignId} scheduled successfully`);
        return res.json({ 
          success: true, 
          campaign: updatedCampaign,
          message: `Campaign scheduled for ${subscriberCount} subscribers` 
        });
      }
      
      // Step 9: Atomically update status to "sending" and enqueue job in a single transaction
      logger.info(`[CAMPAIGN_SEND] ${timestamp} - Setting campaign status to 'sending' and enqueuing job`);
      const updatedCampaign = await db.transaction(async (tx) => {
        const [updated] = await tx.update(campaigns).set({ status: "sending" }).where(sql`${campaigns.id} = ${campaignId}`).returning();
        if (!updated || updated.status !== "sending") return null;
        await tx.insert(campaignJobs).values({
          campaignId: updated.id,
          status: "pending",
        });
        return updated;
      });
      
      if (!updatedCampaign) {
        logger.error(`[CAMPAIGN_SEND] ${timestamp} - Failed to update campaign status`);
        return res.status(500).json({ error: "Failed to start campaign - status update failed" });
      }
      logger.info(`[CAMPAIGN_SEND] ${timestamp} - Campaign successfully queued`);
      
      // Step 11: Success - return the campaign immediately
      logger.info(`[CAMPAIGN_SEND] ${timestamp} - Campaign ${campaignId} started successfully`);
      res.json({ 
        success: true, 
        campaign: updatedCampaign,
        message: `Campaign started with ${subscriberCount} subscribers` 
      });
      
    } catch (error: any) {
      logger.error(`[CAMPAIGN_SEND] ${timestamp} - Unexpected error:`, error);
      res.status(500).json({ error: error.message || "Failed to start campaign" });
    }
  });

  // ============ IMPORT ============
  // Use disk storage defined at module level (uploadToDisk)
  
  app.post("/api/import", uploadToDisk.single("file"), async (req: Request, res: Response) => {
    if (isMemoryPressure) {
      res.setHeader('Retry-After', '60');
      return res.status(503).json({ error: "Server under memory pressure. Please retry later." });
    }
    try {
      logger.info(`[IMPORT] Received import request`);
      if (!req.file) {
        logger.info(`[IMPORT] No file in request`);
        return res.status(400).json({ error: "No file uploaded" });
      }

      // Get tag mode from form data (default to merge for backwards compatibility)
      const tagMode = (req.body.tagMode === "override") ? "override" : "merge";
      const fileSizeBytes = req.file.size;
      logger.info(`[IMPORT] File received: ${req.file.originalname}, size: ${fileSizeBytes} bytes (${Math.round(fileSizeBytes / 1024 / 1024)}MB), tagMode: ${tagMode}`);
      
      // For large files, use streaming line count instead of loading into memory
      const csvFilePath = req.file.path;
      logger.info(`[IMPORT] File saved to disk: ${csvFilePath}`);
      
      // Stream-based line counting for memory efficiency
      let lineCount = 0;
      const lineCountStream = fs.createReadStream(csvFilePath, { encoding: 'utf-8', highWaterMark: 64 * 1024 });
      
      await new Promise<void>((resolve, reject) => {
        let lastChar = '';
        lineCountStream.on('data', (chunk: string | Buffer) => {
          const str = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
          for (let i = 0; i < str.length; i++) {
            if (str[i] === '\n') lineCount++;
          }
          lastChar = str[str.length - 1];
        });
        lineCountStream.on('end', () => {
          // Add 1 if file doesn't end with newline
          if (lastChar && lastChar !== '\n') lineCount++;
          resolve();
        });
        lineCountStream.on('error', reject);
      });
      
      logger.info(`[IMPORT] Streaming line count complete: ${lineCount} lines`);
      
      if (lineCount < 2) {
        logger.info(`[IMPORT] CSV empty or invalid, lines: ${lineCount}`);
        // Clean up uploaded file
        try { fs.unlinkSync(csvFilePath); } catch {}
        return res.status(400).json({ error: "CSV file is empty or invalid" });
      }

      const totalDataRows = lineCount - 1; // Exclude header
      logger.info(`[IMPORT] CSV has ${totalDataRows} data rows`);

      // Create import job record first to get ID
      const job = await storage.createImportJob({
        filename: req.file.originalname,
        totalRows: totalDataRows,
        tagMode: tagMode,
      });
      logger.info(`[IMPORT] Created import job: ${job.id}`);

      // Upload file to persistent object storage (survives deployments)
      const objectStoragePath = await objectStorageService.uploadLocalFile(csvFilePath, `${job.id}.csv`);
      logger.info(`[IMPORT] Uploaded to object storage: ${objectStoragePath}`);
      
      // Verify the file exists in object storage
      const objectExists = await objectStorageService.objectExists(objectStoragePath);
      if (!objectExists) {
        throw new Error(`Object storage verification failed: ${objectStoragePath} does not exist after upload`);
      }
      
      // Delete local temp file after successful upload
      try { fs.unlinkSync(csvFilePath); } catch {}

      // Atomically update import job status and enqueue for processing
      const queueItem = await db.transaction(async (tx) => {
        await tx.update(importJobs).set({ status: "queued" }).where(sql`${importJobs.id} = ${job.id}`);
        const [queued] = await tx.insert(importJobQueue).values({
          importJobId: job.id,
          csvFilePath: objectStoragePath,
          totalLines: lineCount,
          processedLines: 0,
          fileSizeBytes,
          processedBytes: 0,
          lastCheckpointLine: 0,
          status: "pending",
        }).returning();
        return queued;
      });
      logger.info(`[IMPORT] Import job ${job.id} enqueued with queue item ID: ${queueItem.id}, object storage path: ${objectStoragePath}`);

      // Return immediately with job ID for progress tracking
      res.status(202).json(job);
    } catch (error) {
      logger.error("[IMPORT] Error starting import:", error);
      // Clean up uploaded file if it exists
      if (req.file?.path) {
        try { fs.unlinkSync(req.file.path); } catch {}
      }
      res.status(500).json({ error: "Failed to start import" });
    }
  });

  app.get("/api/import-jobs", async (req: Request, res: Response) => {
    try {
      const jobs = await storage.getImportJobs();
      res.json(jobs);
    } catch (error) {
      logger.error("Error fetching import jobs:", error);
      res.status(500).json({ error: "Failed to fetch import jobs" });
    }
  });

  app.post("/api/import/:id/cancel", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const cancelled = await storage.cancelImportJob(req.params.id);
      if (cancelled) {
        logger.info(`[IMPORT] Import job ${req.params.id} cancelled by user`);
        res.json({ success: true, message: "Import cancelled" });
      } else {
        res.status(400).json({ error: "Import cannot be cancelled (already completed or not found)" });
      }
    } catch (error) {
      logger.error("Error cancelling import:", error);
      res.status(500).json({ error: "Failed to cancel import" });
    }
  });

  app.get("/api/import/:id/progress", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
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
      logger.error("Error fetching import progress:", error);
      res.status(500).json({ error: "Failed to fetch import progress" });
    }
  });

  // ============ CHUNKED UPLOAD ============
  // For large files (>50MB), use chunked upload to bypass platform request size limits
  const CHUNKS_DIR = path.join(process.cwd(), "uploads", "chunks");
  if (!fs.existsSync(CHUNKS_DIR)) {
    fs.mkdirSync(CHUNKS_DIR, { recursive: true });
  }

  // Track active chunked uploads in memory (simple approach - survives page refresh but not server restart)
  const chunkedUploads = new Map<string, {
    filename: string;
    tagMode: "merge" | "override";
    totalChunks: number;
    totalSize: number;
    receivedChunks: Set<number>;
    createdAt: Date;
  }>();

  // Cleanup old chunked uploads (older than 1 hour)
  setInterval(() => {
    const now = Date.now();
    for (const [uploadId, upload] of chunkedUploads.entries()) {
      if (now - upload.createdAt.getTime() > 60 * 60 * 1000) {
        // Delete chunk files
        for (let i = 0; i < upload.totalChunks; i++) {
          const chunkPath = path.join(CHUNKS_DIR, `${uploadId}_${i}`);
          try { fs.unlinkSync(chunkPath); } catch {}
        }
        chunkedUploads.delete(uploadId);
        logger.info(`[CHUNKED] Cleaned up stale upload: ${uploadId}`);
      }
    }
  }, 5 * 60 * 1000); // Check every 5 minutes

  // Start a chunked upload session
  app.post("/api/import/chunked/start", async (req: Request, res: Response) => {
    try {
      const { filename, tagMode, totalChunks, totalSize } = req.body;
      
      if (!filename || !totalChunks || !totalSize) {
        return res.status(400).json({ error: "Missing required fields: filename, totalChunks, totalSize" });
      }
      
      if (totalSize > 1024 * 1024 * 1024) {
        return res.status(400).json({ error: "File too large. Maximum size is 1GB" });
      }
      
      const uploadId = `chunk_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
      
      chunkedUploads.set(uploadId, {
        filename,
        tagMode: tagMode === "override" ? "override" : "merge",
        totalChunks: parseInt(totalChunks),
        totalSize: parseInt(totalSize),
        receivedChunks: new Set(),
        createdAt: new Date(),
      });
      
      logger.info(`[CHUNKED] Started upload: ${uploadId}, file: ${filename}, ${totalChunks} chunks, ${Math.round(totalSize / 1024 / 1024)}MB`);
      
      res.json({ uploadId, message: "Chunked upload started" });
    } catch (error) {
      logger.error("[CHUNKED] Error starting upload:", error);
      res.status(500).json({ error: "Failed to start chunked upload" });
    }
  });

  // Upload a single chunk (use raw body to handle binary data efficiently)
  app.post("/api/import/chunked/:uploadId/chunk/:chunkIndex", uploadChunkToDisk.single("chunk"), async (req: Request, res: Response) => {
    try {
      const { uploadId, chunkIndex } = req.params;
      const index = parseInt(chunkIndex);
      
      // Validate chunkIndex is a valid number
      if (isNaN(index) || index < 0) {
        if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
        return res.status(400).json({ error: "Invalid chunk index" });
      }
      
      const upload = chunkedUploads.get(uploadId);
      if (!upload) {
        if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
        return res.status(404).json({ error: "Upload session not found or expired" });
      }
      
      // Validate chunkIndex is within expected range
      if (index >= upload.totalChunks) {
        if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
        return res.status(400).json({ error: `Chunk index ${index} exceeds total chunks ${upload.totalChunks}` });
      }
      
      if (!req.file) {
        return res.status(400).json({ error: "No chunk data received" });
      }
      
      // Move chunk to chunks directory with proper naming
      const chunkPath = path.join(CHUNKS_DIR, `${uploadId}_${index}`);
      fs.renameSync(req.file.path, chunkPath);
      
      upload.receivedChunks.add(index);
      
      logger.info(`[CHUNKED] ${uploadId}: Received chunk ${index + 1}/${upload.totalChunks}`);
      
      res.json({ 
        success: true, 
        chunkIndex: index,
        receivedChunks: upload.receivedChunks.size,
        totalChunks: upload.totalChunks,
        progress: Math.round((upload.receivedChunks.size / upload.totalChunks) * 100)
      });
    } catch (error) {
      logger.error("[CHUNKED] Error receiving chunk:", error);
      if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
      res.status(500).json({ error: "Failed to receive chunk" });
    }
  });

  // Complete chunked upload - assemble chunks and start import
  app.post("/api/import/chunked/:uploadId/complete", async (req: Request, res: Response) => {
    if (isMemoryPressure) {
      res.setHeader('Retry-After', '60');
      return res.status(503).json({ error: "Server under memory pressure. Please retry later." });
    }
    const tempCsvPath = path.join(UPLOADS_DIR_BASE, `upload-${Date.now()}-temp.csv`);
    let writeStream: fs.WriteStream | null = null;
    
    try {
      const { uploadId } = req.params;
      
      const upload = chunkedUploads.get(uploadId);
      if (!upload) {
        return res.status(404).json({ error: "Upload session not found or expired" });
      }
      
      // Verify all chunks received
      if (upload.receivedChunks.size !== upload.totalChunks) {
        const missing = [];
        for (let i = 0; i < upload.totalChunks; i++) {
          if (!upload.receivedChunks.has(i)) missing.push(i);
        }
        return res.status(400).json({ 
          error: `Missing chunks: ${missing.join(", ")}`,
          receivedChunks: upload.receivedChunks.size,
          totalChunks: upload.totalChunks
        });
      }
      
      logger.info(`[CHUNKED] ${uploadId}: All ${upload.totalChunks} chunks received, assembling file...`);
      
      // Assemble chunks into final CSV file using streaming (memory-efficient)
      writeStream = fs.createWriteStream(tempCsvPath);
      
      // Stream each chunk to the output file (avoids loading all chunks into memory)
      for (let i = 0; i < upload.totalChunks; i++) {
        const chunkPath = path.join(CHUNKS_DIR, `${uploadId}_${i}`);
        
        // Check if chunk file exists
        if (!fs.existsSync(chunkPath)) {
          throw new Error(`Missing chunk file: ${i}`);
        }
        
        // Stream chunk to output file
        await new Promise<void>((resolve, reject) => {
          const readStream = fs.createReadStream(chunkPath);
          readStream.on('error', reject);
          readStream.on('end', () => {
            // Delete chunk after streaming
            try { fs.unlinkSync(chunkPath); } catch {}
            resolve();
          });
          readStream.pipe(writeStream!, { end: false });
        });
      }
      
      await new Promise<void>((resolve, reject) => {
        writeStream!.end((err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
      
      const fileSizeBytes = fs.statSync(tempCsvPath).size;
      logger.info(`[CHUNKED] ${uploadId}: File assembled: ${tempCsvPath}, size: ${Math.round(fileSizeBytes / 1024 / 1024)}MB`);
      
      // Stream-based line counting
      let lineCount = 0;
      const lineCountStream = fs.createReadStream(tempCsvPath, { encoding: 'utf-8', highWaterMark: 64 * 1024 });
      
      await new Promise<void>((resolve, reject) => {
        let lastChar = '';
        lineCountStream.on('data', (chunk: string | Buffer) => {
          const str = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
          for (let i = 0; i < str.length; i++) {
            if (str[i] === '\n') lineCount++;
          }
          lastChar = str[str.length - 1];
        });
        lineCountStream.on('end', () => {
          if (lastChar && lastChar !== '\n') lineCount++;
          resolve();
        });
        lineCountStream.on('error', reject);
      });
      
      logger.info(`[CHUNKED] ${uploadId}: Line count: ${lineCount}`);
      
      if (lineCount < 2) {
        fs.unlinkSync(tempCsvPath);
        chunkedUploads.delete(uploadId);
        return res.status(400).json({ error: "CSV file is empty or invalid" });
      }
      
      const totalDataRows = lineCount - 1;
      
      // Create import job
      const job = await storage.createImportJob({
        filename: upload.filename,
        totalRows: totalDataRows,
        tagMode: upload.tagMode,
      });
      logger.info(`[CHUNKED] ${uploadId}: Created import job: ${job.id}`);
      
      // Upload assembled file to persistent object storage (survives deployments)
      const objectStoragePath = await objectStorageService.uploadLocalFile(tempCsvPath, `${job.id}.csv`);
      logger.info(`[CHUNKED] ${uploadId}: Uploaded to object storage: ${objectStoragePath}`);
      
      // Verify the file exists in object storage
      const objectExists = await objectStorageService.objectExists(objectStoragePath);
      if (!objectExists) {
        throw new Error(`Object storage verification failed: ${objectStoragePath} does not exist after upload`);
      }
      
      // Get file size for verification
      const verifiedSize = fs.statSync(tempCsvPath).size;
      logger.info(`[CHUNKED] ${uploadId}: File verified in object storage, size: ${verifiedSize} bytes`);
      
      // Atomically update import job status and enqueue for processing
      const queueItem = await db.transaction(async (tx) => {
        await tx.update(importJobs).set({ status: "queued" }).where(sql`${importJobs.id} = ${job.id}`);
        const [queued] = await tx.insert(importJobQueue).values({
          importJobId: job.id,
          csvFilePath: objectStoragePath,
          totalLines: lineCount,
          processedLines: 0,
          fileSizeBytes: verifiedSize,
          processedBytes: 0,
          lastCheckpointLine: 0,
          status: "pending",
        }).returning();
        return queued;
      });
      logger.info(`[CHUNKED] ${uploadId}: Import job ${job.id} enqueued with object storage path`);
      
      // Delete local temp file after successful upload to object storage
      try { fs.unlinkSync(tempCsvPath); } catch {}
      
      // Cleanup
      chunkedUploads.delete(uploadId);
      
      res.status(202).json(job);
    } catch (error: any) {
      logger.error("[CHUNKED] Error completing upload:", error);
      
      // Cleanup on error: remove temp file if it exists
      try { 
        if (fs.existsSync(tempCsvPath)) {
          fs.unlinkSync(tempCsvPath); 
        }
      } catch {}
      
      // Close write stream if open
      if (writeStream) {
        try { writeStream.destroy(); } catch {}
      }
      
      // Cleanup any remaining chunk files for this upload
      const { uploadId } = req.params;
      const upload = chunkedUploads.get(uploadId);
      if (upload) {
        for (let i = 0; i < upload.totalChunks; i++) {
          const chunkPath = path.join(CHUNKS_DIR, `${uploadId}_${i}`);
          try { fs.unlinkSync(chunkPath); } catch {}
        }
        chunkedUploads.delete(uploadId);
      }
      
      res.status(500).json({ error: error.message || "Failed to complete chunked upload" });
    }
  });

  // Get chunked upload status
  app.get("/api/import/chunked/:uploadId/status", async (req: Request, res: Response) => {
    try {
      const upload = chunkedUploads.get(req.params.uploadId);
      if (!upload) {
        return res.status(404).json({ error: "Upload session not found or expired" });
      }
      
      res.json({
        uploadId: req.params.uploadId,
        filename: upload.filename,
        totalChunks: upload.totalChunks,
        receivedChunks: upload.receivedChunks.size,
        progress: Math.round((upload.receivedChunks.size / upload.totalChunks) * 100),
        createdAt: upload.createdAt,
      });
    } catch (error) {
      logger.error("[CHUNKED] Error fetching status:", error);
      res.status(500).json({ error: "Failed to fetch upload status" });
    }
  });

  // ============ EXPORT ============
  function sanitizeCsvValue(val: string): string {
    if (val && /^[=+\-@\t\r]/.test(val)) {
      return "'" + val;
    }
    return val;
  }

  app.get("/api/export", async (req: Request, res: Response) => {
    try {
      const fields = (req.query.fields as string)?.split(",") || ["email", "tags", "ipAddress", "importDate"];
      
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename=critsend-export-${new Date().toISOString().split("T")[0]}.csv`);
      res.setHeader("Transfer-Encoding", "chunked");
      
      // Write header row
      res.write(fields.join(",") + "\n");
      
      let page = 1;
      const limit = 10000;
      
      while (true) {
        const { subscribers: subs, total } = await storage.getSubscribers(page, limit);
        
        // Build and write chunk for this page
        let chunk = "";
        for (const sub of subs) {
          const row = fields.map(field => {
            let val = "";
            if (field === "email") val = sub.email;
            else if (field === "tags") val = (sub.tags || []).join(";");
            else if (field === "ipAddress") val = sub.ipAddress || "";
            else if (field === "importDate") val = sub.importDate.toISOString();
            val = sanitizeCsvValue(val);
            if (val.includes(",") || val.includes('"') || val.includes("\n")) {
              return '"' + val.replace(/"/g, '""') + '"';
            }
            return val;
          });
          chunk += row.join(",") + "\n";
        }
        
        // Write this page's data and flush
        if (chunk) {
          const canContinue = res.write(chunk);
          // Handle backpressure - wait for drain if buffer is full
          if (!canContinue) {
            await new Promise<void>(resolve => res.once("drain", resolve));
          }
        }
        
        if (page * limit >= total || subs.length === 0) break;
        page++;
      }
      
      res.end();
    } catch (error) {
      logger.error("Error exporting:", error);
      // Only send error if headers haven't been sent yet
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to export" });
      } else {
        res.end();
      }
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
          op.tagValue
        );
        
        // Mark as completed
        await storage.completeTagOperation(op.id);
      } catch (error: any) {
        logger.error(`Failed to process tag operation ${op.id}:`, error);
        await storage.failTagOperation(op.id, error.message || "Unknown error");
      }
    }
    
    if (operations.length > 0) {
      logger.info(`Processed ${operations.length} tag operations`);
    }
  } catch (error) {
    logger.error("Error in tag queue processing:", error);
  }
}

// Start the tag queue worker
let tagCleanupInterval: NodeJS.Timeout | null = null;

export function startTagQueueWorker() {
  if (tagQueueInterval) {
    return; // Already running
  }
  
  logger.info("Starting tag queue worker...");
  
  // Process immediately, then every 500ms
  processTagQueue();
  tagQueueInterval = setInterval(processTagQueue, 500);
  
  // Cleanup completed operations every hour
  tagCleanupInterval = setInterval(async () => {
    try {
      const cleaned = await storage.cleanupCompletedTagOperations(7);
      if (cleaned > 0) {
        logger.info(`Cleaned up ${cleaned} completed tag operations`);
      }
    } catch (error) {
      logger.error("Error cleaning up tag operations:", error);
    }
  }, 60 * 60 * 1000);
}

function stopTagQueueWorker() {
  if (tagQueueInterval) {
    clearInterval(tagQueueInterval);
    tagQueueInterval = null;
  }
  if (tagCleanupInterval) {
    clearInterval(tagCleanupInterval);
    tagCleanupInterval = null;
  }
  logger.info("Tag queue worker stopped");
}

export function stopAllBackgroundWorkers() {
  logger.info("[SHUTDOWN] Stopping all background workers...");
  stopMemoryMonitor();
  stopJobProcessor();
  stopTagQueueWorker();
  logger.info("[SHUTDOWN] All background workers stopped");
}

// Sending speed configurations (emails per minute and concurrent workers)
const SPEED_CONFIG: Record<string, { emailsPerMinute: number; concurrency: number }> = {
  slow: { emailsPerMinute: 500, concurrency: 5 },
  medium: { emailsPerMinute: 1000, concurrency: 10 },
  fast: { emailsPerMinute: 2000, concurrency: 20 },
  godzilla: { emailsPerMinute: 3000, concurrency: 50 },
};

// Memory monitoring for long-running workers
const MEMORY_CHECK_INTERVAL = 60000;
const MEMORY_WARN_THRESHOLD_MB = 2048;
const MEMORY_CRITICAL_THRESHOLD_MB = 4096;
let memoryCheckInterval: NodeJS.Timeout | null = null;
let consecutiveHighMemoryCount = 0;
export let isMemoryPressure = false;

function startMemoryMonitor() {
  if (memoryCheckInterval) return;
  
  memoryCheckInterval = setInterval(() => {
    const memUsage = process.memoryUsage();
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
    const rssMB = Math.round(memUsage.rss / 1024 / 1024);
    
    if (heapUsedMB > MEMORY_CRITICAL_THRESHOLD_MB) {
      consecutiveHighMemoryCount++;
      logger.error('Memory critical', { heapUsedMB, heapTotalMB, rssMB, consecutiveHighMemoryCount });
      
      if (global.gc) {
        logger.warn('Forcing garbage collection');
        global.gc();
      }
      
      if (consecutiveHighMemoryCount >= 5) {
        logger.error('Memory critically high for extended period', { consecutiveHighMemoryCount, heapUsedMB, heapTotalMB, rssMB });
      }
      isMemoryPressure = true;
    } else if (heapUsedMB > MEMORY_WARN_THRESHOLD_MB) {
      consecutiveHighMemoryCount = 0;
      isMemoryPressure = false;
      logger.warn('Memory usage warning', { heapUsedMB, heapTotalMB, rssMB });
    } else {
      consecutiveHighMemoryCount = 0;
      isMemoryPressure = false;
    }
  }, MEMORY_CHECK_INTERVAL);
}

function stopMemoryMonitor() {
  if (memoryCheckInterval) {
    clearInterval(memoryCheckInterval);
    memoryCheckInterval = null;
  }
}

// ============ POSTGRESQL-BACKED JOB QUEUE FOR CAMPAIGN SERIALIZATION ============
// Persists job state across server restarts and supports multiple workers via row-level locking

// Generate a unique worker ID for this instance
const WORKER_ID = `worker-${process.pid}-${Date.now()}`;
let jobPollingInterval: NodeJS.Timeout | null = null;
let importJobPollingInterval: NodeJS.Timeout | null = null;
let flushJobPollingInterval: NodeJS.Timeout | null = null;

// ============ FLUSH JOB PROCESSOR (Subscriber deletion with progress) ============
const FLUSH_BATCH_SIZE = 5000; // Delete 5k subscribers per batch

function startFlushJobProcessor() {
  if (flushJobPollingInterval) {
    return; // Already running
  }
  logger.info(`Starting flush job processor with worker ID: ${WORKER_ID}`);
  flushJobPollingInterval = setInterval(pollForFlushJobs, 1000);
  pollForFlushJobs(); // Run immediately
}

function stopFlushJobProcessor() {
  if (flushJobPollingInterval) {
    clearInterval(flushJobPollingInterval);
    flushJobPollingInterval = null;
    logger.info("Flush job processor stopped");
  }
}

async function pollForFlushJobs() {
  if (isMemoryPressure) {
    logger.warn('Skipping flush job poll - memory pressure active');
    return;
  }
  try {
    const job = await storage.claimFlushJob(WORKER_ID);
    if (!job) {
      return; // No pending flush jobs
    }
    
    logger.info(`Worker ${WORKER_ID} claimed flush job ${job.id} (${job.totalRows} subscribers)`);
    
    try {
      await processFlushJob(job.id, job.totalRows);
      await storage.completeFlushJob(job.id, "completed");
      storage.invalidateSegmentCountCache();
      logger.info(`Flush job ${job.id} completed successfully`);
    } catch (error: any) {
      logger.error(`Error processing flush job ${job.id}:`, error);
      await storage.completeFlushJob(job.id, "failed", error.message || "Unknown error");
    }
  } catch (error) {
    logger.error("Error in flush job polling:", error);
  }
}

async function processFlushJob(jobId: string, totalRows: number) {
  logger.info(`[FLUSH] Job ${jobId}: Clearing dependent tables first...`);
  await storage.clearSubscriberDependencies();
  logger.info(`[FLUSH] Job ${jobId}: Dependent tables cleared. Starting subscriber batch deletion...`);
  
  let processedRows = 0;
  
  while (processedRows < totalRows) {
    const job = await storage.getFlushJob(jobId);
    if (!job || job.status === "cancelled") {
      logger.info(`Flush job ${jobId} was cancelled`);
      return;
    }
    
    const deletedCount = await storage.deleteSubscriberBatch(FLUSH_BATCH_SIZE);
    
    if (deletedCount === 0) {
      break;
    }
    
    processedRows += deletedCount;
    await storage.updateFlushJobProgress(jobId, processedRows);
    
    logger.info(`[FLUSH] Job ${jobId}: Deleted ${processedRows}/${totalRows} subscribers (${Math.round(processedRows/totalRows*100)}%)`);
    
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  await storage.updateFlushJobProgress(jobId, processedRows);
}

// Public function to start a campaign - enqueues to PostgreSQL-backed job queue
async function processCampaign(campaignId: string) {
  // Check if this campaign already has a pending/processing job
  const existingStatus = await storage.getJobStatus(campaignId);
  if (existingStatus) {
    logger.info(`Campaign ${campaignId} already has a ${existingStatus} job`);
    return;
  }
  
  await storage.enqueueCampaignJob(campaignId);
  logger.info(`Campaign ${campaignId} added to PostgreSQL job queue`);
}

// Background job processor - polls for pending jobs
async function pollForJobs() {
  if (isMemoryPressure) {
    logger.warn('Skipping job poll - memory pressure active');
    return;
  }
  try {
    // Clean up stale jobs from crashed workers
    const staleCount = await storage.cleanupStaleJobs(30);
    if (staleCount > 0) {
      logger.info(`Cleaned up ${staleCount} stale jobs`);
    }
    
    // Try to claim a pending job using FOR UPDATE SKIP LOCKED
    const job = await storage.claimNextJob(WORKER_ID);
    
    if (!job) {
      return; // No pending jobs
    }
    
    logger.info(`Worker ${WORKER_ID} claimed job ${job.id} for campaign ${job.campaignId}`);
    
    try {
      await processCampaignInternal(job.campaignId);
      await storage.completeJob(job.id, "completed");
      logger.info(`Job ${job.id} completed successfully`);
    } catch (error: any) {
      logger.error(`Error processing job ${job.id}:`, error);
      await storage.completeJob(job.id, "failed", error.message || "Unknown error");
      await storage.updateCampaignStatusAtomic(job.campaignId, "failed");
    }
  } catch (error) {
    logger.error("Error in job polling:", error);
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
        logger.info(`MTA ${mta.name} is back online - resuming campaign ${campaign.id} (${campaign.name})`);
        // Clear any stuck processing jobs before enqueuing new one
        await storage.clearStuckJobsForCampaign(campaign.id);
        // Clear pause reason and set status back to sending
        await storage.updateCampaign(campaign.id, { status: "sending", pauseReason: null });
        // Re-enqueue for processing
        await storage.enqueueCampaignJob(campaign.id);
      }
    }
  } catch (error) {
    logger.error("Error checking MTA recovery:", error);
  }
}

// Resume campaigns that were interrupted by server restart
async function resumeInterruptedCampaigns() {
  try {
    const result = await db.execute(sql`
      SELECT c.id, c.name FROM campaigns c
      WHERE c.status = 'sending'
      AND NOT EXISTS (
        SELECT 1 FROM campaign_jobs cj 
        WHERE cj.campaign_id = c.id 
        AND cj.status IN ('pending', 'processing')
      )
    `);
    
    const stuckCampaigns = result.rows as Array<{ id: string; name: string }>;
    
    if (stuckCampaigns.length > 0) {
      logger.info(`[RECOVERY] Found ${stuckCampaigns.length} interrupted campaign(s) to resume`);
      for (const campaign of stuckCampaigns) {
        logger.info(`[RECOVERY] Re-enqueuing campaign ${campaign.id} (${campaign.name})`);
        await storage.enqueueCampaignJob(campaign.id);
      }
    }

    const stuckImports = await db.execute(sql`
      UPDATE import_jobs SET status = 'pending', error_message = 'Interrupted by server restart - will retry'
      WHERE status = 'processing'
      RETURNING id, filename
    `);
    
    if (stuckImports.rows.length > 0) {
      logger.info(`[RECOVERY] Reset ${stuckImports.rows.length} stuck import job(s)`);
    }

    const stuckFlushJobs = await db.execute(sql`
      UPDATE flush_jobs SET status = 'pending', error_message = 'Interrupted by server restart - will retry'
      WHERE status = 'processing'
      RETURNING id
    `);
    
    if (stuckFlushJobs.rows.length > 0) {
      logger.info(`[RECOVERY] Reset ${stuckFlushJobs.rows.length} stuck flush job(s)`);
    }
  } catch (error) {
    logger.error('[RECOVERY] Error resuming interrupted campaigns:', error);
  }
}

// Start the background job processor
function startJobProcessor() {
  if (jobPollingInterval) {
    return; // Already running
  }
  
  logger.info(`Starting job processor with worker ID: ${WORKER_ID}`);
  
  // Poll every 2 seconds for new jobs
  jobPollingInterval = setInterval(pollForJobs, 2000);
  
  // Also run immediately on startup
  pollForJobs();
  
  // Resume any campaigns interrupted by server restart
  resumeInterruptedCampaigns();
  
  // Also start the import job processor
  startImportJobProcessor();
  
  // Also start the flush job processor
  startFlushJobProcessor();
  
  // Start MTA recovery checker - check every 30 seconds for MTA-down paused campaigns
  if (!mtaRecoveryInterval) {
    mtaRecoveryInterval = setInterval(checkMtaRecovery, 30000);
    logger.info("MTA recovery checker started (30s interval)");
  }
  
  startMemoryMonitor();
}

// Stop the background job processor
function stopJobProcessor() {
  stopMemoryMonitor();
  if (jobPollingInterval) {
    clearInterval(jobPollingInterval);
    jobPollingInterval = null;
    logger.info("Job processor stopped");
  }
  if (mtaRecoveryInterval) {
    clearInterval(mtaRecoveryInterval);
    mtaRecoveryInterval = null;
    logger.info("MTA recovery checker stopped");
  }
  stopImportJobProcessor();
  stopFlushJobProcessor();
}

// ============ POSTGRESQL-BACKED JOB QUEUE FOR IMPORT PROCESSING ============

// Start the background import job processor
function startImportJobProcessor() {
  if (importJobPollingInterval) {
    return; // Already running
  }
  
  logger.info(`Starting import job processor with worker ID: ${WORKER_ID}`);
  
  // Clean up orphaned import_staging data on startup - only for jobs that are not processing
  // This prevents data loss for active imports while cleaning up stale data from crashed imports
  db.execute(sql`
    DELETE FROM import_staging s
    WHERE NOT EXISTS (
      SELECT 1 FROM import_jobs j 
      WHERE j.id = s.job_id 
      AND j.status = 'processing'
    )
  `)
    .then(() => logger.info('[IMPORT] Cleaned up orphaned import_staging data on startup (excluding active jobs)'))
    .catch((err: any) => logger.error('[IMPORT] Failed to clean up import_staging on startup:', err.message));
  
  // GIN Index Integrity Check - recover from crash scenarios where indexes were dropped but never recreated
  storage.areGinIndexesPresent().then(async (present) => {
    if (!present) {
      logger.warn('[IMPORT] GIN indexes missing on startup! Likely from a crash during large import. Recreating...');
      try {
        await storage.recreateSubscriberGinIndexes();
        logger.info('[IMPORT] GIN indexes recovered successfully');
      } catch (err: any) {
        logger.error('[IMPORT] Failed to recover GIN indexes on startup:', err.message);
      }
    } else {
      logger.info('[IMPORT] GIN indexes integrity check passed');
    }
  }).catch((err: any) => {
    logger.error('[IMPORT] GIN index integrity check failed:', err.message);
  });
  
  storage.ensureTrigramIndex()
    .then(() => logger.info('[IMPORT] Email trigram index verified'))
    .catch((err: any) => logger.error('[IMPORT] Failed to create email trigram index:', err.message));
  
  // Poll every 2 seconds for new import jobs
  importJobPollingInterval = setInterval(pollForImportJobs, 2000);
  
  // Also run immediately on startup
  pollForImportJobs();
}

// Track active import worker child processes
let activeImportWorker: ChildProcess | null = null;
let activeImportJobInfo: { queueId: string; importJobId: string } | null = null;

// Stop the import job processor
function stopImportJobProcessor() {
  if (importJobPollingInterval) {
    clearInterval(importJobPollingInterval);
    importJobPollingInterval = null;
    logger.info("Import job processor stopped");
  }
  if (activeImportWorker) {
    logger.info("Killing active import worker process");
    activeImportWorker.kill("SIGTERM");
    activeImportWorker = null;
    activeImportJobInfo = null;
  }
}

// Background import job processor - polls for pending import jobs
let lastRecoveryCheck = 0;
async function pollForImportJobs() {
  if (activeImportWorker) {
    return;
  }
  try {
    const now = Date.now();
    if (now - lastRecoveryCheck > 5 * 60 * 1000) {
      lastRecoveryCheck = now;
      
      const recoveredCount = await storage.recoverStuckImportJobs();
      if (recoveredCount > 0) {
        logger.info(`Recovered ${recoveredCount} stuck import jobs back to pending`);
      }
      
      const staleCount = await storage.cleanupStaleImportJobs(30);
      if (staleCount > 0) {
        logger.info(`Cleaned up ${staleCount} stale import jobs`);
      }
    }
    
    const queueItem = await storage.claimNextImportJob(WORKER_ID);
    
    if (!queueItem) {
      return;
    }
    
    logger.info(`Worker ${WORKER_ID} claimed import job queue item ${queueItem.id} for import ${queueItem.importJobId} - forking child process`);
    
    const isDev = process.env.NODE_ENV !== "production";
    const workerExt = isDev ? "import-worker.ts" : "import-worker.cjs";
    const currentDir = path.dirname(new URL(import.meta.url).pathname);
    const workerPath = path.resolve(currentDir, workerExt);
    
    const forkOptions: any = {
      env: {
        ...process.env,
        NODE_OPTIONS: "--max-old-space-size=4096",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    };
    
    if (isDev) {
      const tsxPath = path.resolve(process.cwd(), "node_modules", ".bin", "tsx");
      forkOptions.execPath = tsxPath;
    }
    
    const child = fork(workerPath, [], forkOptions);
    
    activeImportWorker = child;
    activeImportJobInfo = { queueId: queueItem.id, importJobId: queueItem.importJobId };
    
    child.on("message", async (msg: any) => {
      if (!msg || !msg.type) return;
      
      switch (msg.type) {
        case "complete": {
          const d = msg.data;
          logger.info(`[IMPORT] Worker completed: committed=${d.committedRows}, new=${d.newSubscribers}, updated=${d.updatedSubscribers}, failed=${d.failedRows}, duration=${d.duration}s`);
          try {
            const finalJob = await storage.getImportJob(queueItem.importJobId);
            if (finalJob?.status === "cancelled") {
              logger.info(`Import job ${queueItem.id} was cancelled during processing`);
            } else {
              await storage.completeImportQueueJob(queueItem.id, "completed");
              storage.invalidateSegmentCountCache();
              logger.info(`Import job ${queueItem.id} completed successfully`);
            }
          } catch (err: any) {
            logger.error(`Failed to finalize import job ${queueItem.id}:`, err);
          }
          break;
        }
        case "error": {
          const d = msg.data;
          logger.error(`[IMPORT] Worker error: ${d.message}`);
          try {
            const jobAfterError = await storage.getImportJob(queueItem.importJobId);
            if (jobAfterError?.status === "cancelled") {
              logger.info(`Import job ${queueItem.id} was cancelled, not marking as failed`);
            } else {
              await storage.completeImportQueueJob(queueItem.id, "failed", d.message || "Unknown error");
              await storage.updateImportJob(queueItem.importJobId, {
                status: "failed",
                errorMessage: d.message || "Unknown error",
              });
            }
            await storage.logError({
              type: "import_failed",
              severity: "error",
              message: `Import job failed: ${d.message || "Unknown error"}`,
              importJobId: queueItem.importJobId,
              details: d.stack || String(d.message),
            });
          } catch (logErr) {
            logger.error("Failed to log import error:", logErr);
          }
          break;
        }
        case "log": {
          const d = msg.data;
          const level = d.level as "info" | "warn" | "error" | "debug";
          if (logger[level]) {
            logger[level](`[IMPORT-WORKER] ${d.message}`, d.extra);
          }
          break;
        }
      }
    });
    
    child.on("exit", (code, signal) => {
      const jobInfo = activeImportJobInfo;
      activeImportWorker = null;
      activeImportJobInfo = null;
      
      if (code !== 0 && code !== null) {
        logger.error(`[IMPORT] Worker process exited with code ${code}, signal ${signal}`);
        if (jobInfo) {
          storage.completeImportQueueJob(jobInfo.queueId, "failed", `Worker crashed with exit code ${code}`)
            .catch((err) => logger.error("Failed to mark crashed import as failed:", err));
          storage.updateImportJob(jobInfo.importJobId, {
            status: "failed",
            errorMessage: `Worker process crashed (exit code ${code})`,
          }).catch((err) => logger.error("Failed to update crashed import job:", err));
        }
      } else {
        logger.info(`[IMPORT] Worker process exited cleanly (code=${code})`);
      }
    });
    
    child.on("error", (err) => {
      logger.error(`[IMPORT] Worker process error:`, err);
      activeImportWorker = null;
      activeImportJobInfo = null;
    });
    
    child.send({
      type: "start",
      data: {
        queueId: queueItem.id,
        importJobId: queueItem.importJobId,
        csvFilePath: queueItem.csvFilePath,
      },
    });
    
  } catch (error: any) {
    logger.error(`Error in import job polling: ${error?.message || String(error)}`, { stack: error?.stack });
    activeImportWorker = null;
    activeImportJobInfo = null;
  }
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
      logger.error(`Campaign ${campaignId}: MTA ${campaign.mtaId} not found`);
      await storage.updateCampaignStatusAtomic(campaignId, "failed");
      return;
    }
    
    // Verify SMTP connection before starting
    const verifyResult = await verifyTransporter(mta);
    if (!verifyResult.success) {
      logger.error(`Campaign ${campaignId}: SMTP verification failed: ${verifyResult.error}`);
      // Pause instead of fail - will auto-resume when MTA is back online
      await storage.updateCampaign(campaignId, { status: "paused", pauseReason: "mta_down" });
      logger.info(`Campaign ${campaignId}: Paused due to MTA unavailable - will auto-resume when MTA is back`);
      return;
    }
    logger.info(`Campaign ${campaignId}: SMTP connection verified for MTA ${mta.name}`);
  }
  
  // Recovery: Clean up any orphaned pending sends from previous crashes
  // This ensures retries can proceed and counters stay accurate
  const recovered = await storage.recoverOrphanedPendingSends(campaignId, 2);
  if (recovered > 0) {
    logger.info(`Campaign ${campaignId}: Recovered ${recovered} orphaned pending sends before processing`);
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
  
  logger.info(`[CAMPAIGN] ${campaignId}: Starting parallel send - Speed: ${speedKey}, Concurrency: ${concurrency}, Rate: ${emailsPerMinute}/min`);
  
  // Process in batches of 1000 to avoid memory issues
  const BATCH_SIZE = 1000;
  let cursorId: string | undefined = undefined; // Cursor-based pagination (stable, no skip/duplicate)
  let processedCount = 0;
  let totalSent = 0;
  let totalFailed = 0;
  let consecutiveSmtpFailures = 0; // Track consecutive SMTP failures for health monitoring
  const MAX_CONSECUTIVE_FAILURES = 10; // Auto-pause after 10 consecutive SMTP failures
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
          logger.error(`Failed to send to ${subscriber.email}: ${result.error}`);
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
      logger.error(`Exception sending to ${subscriber.email}:`, error.message);
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
      logger.error(`INVARIANT VIOLATION during finalize for ${subscriber.email}: ${finalizeError.message}`);
      await storage.forceFailPendingSend(campaignId, subscriber.id).catch(() => {});
    }
    
    // Track consecutive SMTP failures for MTA health monitoring
    if (sendSuccess) {
      consecutiveSmtpFailures = 0; // Reset on success
    } else {
      consecutiveSmtpFailures++;
    }
    
    return { success: sendSuccess, email: subscriber.email };
  }
  
  // Process batches with parallel workers using cursor-based pagination
  // (cursor-based prevents skipping/duplicating subscribers if data changes during send)
  while (true) {
    // Check if campaign was paused or cancelled (atomic read)
    const currentCampaign = await storage.getCampaign(campaignId);
    if (!currentCampaign || currentCampaign.status !== "sending") {
      logger.info(`[CAMPAIGN] ${campaignId}: Paused/cancelled at ${processedCount} processed`);
      break;
    }
    
    // MTA health check: auto-pause if too many consecutive SMTP failures
    if (consecutiveSmtpFailures >= MAX_CONSECUTIVE_FAILURES && mtaRef) {
      logger.error(`[CAMPAIGN] ${campaignId}: ${consecutiveSmtpFailures} consecutive SMTP failures - pausing campaign for MTA recovery`);
      await storage.updateCampaign(campaignId, { status: "paused", pauseReason: "mta_down" });
      
      // Refresh the transporter so it reconnects when campaign resumes
      closeTransporter(mtaRef.id);
      
      await storage.logError({
        type: "campaign_paused",
        severity: "warning",
        message: `Campaign auto-paused after ${consecutiveSmtpFailures} consecutive SMTP failures`,
        campaignId,
        details: `MTA: ${mtaRef.name}, sent: ${totalSent}, failed: ${totalFailed}`,
      }).catch(() => {});
      break;
    }
    
    // Fetch batch of subscribers using cursor-based pagination (stable ordering by ID)
    const batch = await storage.getSubscribersForSegmentCursor(campaign.segmentId, BATCH_SIZE, cursorId);
    
    if (batch.length === 0) {
      // No more subscribers
      break;
    }
    
    // Update cursor to last subscriber ID in this batch
    cursorId = batch[batch.length - 1].id;
    
    // Process this batch in parallel chunks
    for (let i = 0; i < batch.length; i += concurrency) {
      // Check pause status at start of each parallel chunk
      if (i > 0 && i % (concurrency * 10) === 0) {
        const checkCampaign = await storage.getCampaign(campaignId);
        if (!checkCampaign || checkCampaign.status !== "sending") {
          logger.info(`[CAMPAIGN] ${campaignId}: Paused during batch at ${processedCount}`);
          return;
        }
        
        // Also check MTA health mid-batch
        if (consecutiveSmtpFailures >= MAX_CONSECUTIVE_FAILURES && mtaRef) {
          logger.error(`[CAMPAIGN] ${campaignId}: MTA failure threshold reached mid-batch, pausing`);
          await storage.updateCampaign(campaignId, { status: "paused", pauseReason: "mta_down" });
          closeTransporter(mtaRef.id);
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
    logger.info(`[CAMPAIGN] ${campaignId}: Progress ${processedCount}/${total} (${rate.toFixed(0)}/min) - Sent: ${totalSent}, Failed: ${totalFailed}`);
  }
  
  // Clean up transporter connection pool when done
  if (mta) {
    closeTransporter(mta.id);
    logger.info(`Campaign ${campaignId}: Closed SMTP connection for MTA ${mta.name}`);
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
    logger.info(`Campaign ${campaignId} completed: ${finalCampaign?.sentCount} sent, ${finalCampaign?.failedCount} failed`);
  }
}
