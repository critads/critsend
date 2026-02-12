import { type Express, type Request, type Response } from "express";
import { storage } from "../storage";
import { db } from "../db";
import { sql } from "drizzle-orm";
import { getNullsinkServer } from "../nullsink-smtp";
import { logger } from "../logger";
import { getWorkerId, getImportJobProcessorRunning } from "../workers";

export function registerNullsinkRoutes(app: Express, helpers: {
  parsePagination: (query: any) => { page: number; limit: number };
  validateId: (id: string) => boolean;
}) {
  const { parsePagination, validateId } = helpers;

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

  app.get("/api/nullsink/captures/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const result = await db.execute(sql`
        SELECT id, campaign_id, subscriber_id, mta_id, from_email, to_email, subject, 
               message_size, html_body, status, handshake_time_ms, total_time_ms, timestamp
        FROM nullsink_captures 
        WHERE id = ${req.params.id}
      `);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Capture not found" });
      }
      res.json(result.rows[0]);
    } catch (error) {
      res.status(500).json({ error: "Failed to get capture" });
    }
  });

  app.get("/api/nullsink/metrics", async (req: Request, res: Response) => {
    try {
      const campaignId = req.query.campaignId as string | undefined;
      const metrics = await storage.getNullsinkMetrics(campaignId);
      
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
      
      const server = getNullsinkServer();
      server.resetMetrics();
      
      res.json({ success: true, deleted });
    } catch (error) {
      res.status(500).json({ error: "Failed to clear nullsink captures" });
    }
  });

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
        workerId: getWorkerId(),
        importJobProcessorRunning: getImportJobProcessorRunning(),
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
}
