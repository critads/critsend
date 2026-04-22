import { type Express, type Request, type Response } from "express";
import { storage } from "../storage";
import { db, pool, isPoolHealthy } from "../db";
import { sql } from "drizzle-orm";
import { getWorkerHealth, WORKER_HEARTBEAT_KEY } from "../workers";
import { redisConnection, isRedisConfigured } from "../redis";
import { trackingPool, isTrackingPoolHealthy } from "../tracking-pool";
import { MAIN_POOL_MAX, TRACKING_POOL_MAX } from "../connection-budget";

type WorkerHealthFlags = ReturnType<typeof getWorkerHealth>;
type WorkerHealthReport = WorkerHealthFlags & {
  source: "in-process" | "remote-worker" | "remote-worker-stale" | "remote-worker-missing";
  pid?: number;
  processType?: string;
  heartbeatAgeSeconds?: number;
};

/**
 * Resolve worker health for /api/health.
 *
 * - Monolith mode (PROCESS_TYPE not "web"): workers run in this same process,
 *   so the local in-process flags from getWorkerHealth() are authoritative.
 * - Split-process mode (PROCESS_TYPE=web): workers run in a separate process
 *   and publish a heartbeat to Redis every 10s with a 30s TTL. We read that
 *   key here. If it's missing or stale, we report all workers as down.
 */
async function resolveWorkerHealth(): Promise<WorkerHealthReport> {
  const localFlags = getWorkerHealth();
  const downFlags: WorkerHealthFlags = {
    jobProcessor: false,
    importProcessor: false,
    tagQueueWorker: false,
    flushProcessor: false,
    maintenanceWorker: false,
    scheduledCampaignPoller: false,
  };

  if (process.env.PROCESS_TYPE !== "web") {
    return { ...localFlags, source: "in-process" };
  }

  if (!isRedisConfigured || !redisConnection) {
    // Web process with no Redis can't see the worker. Report as missing
    // rather than lying with the local (always-false) flags.
    return { ...downFlags, source: "remote-worker-missing" };
  }

  try {
    const raw = await redisConnection.get(WORKER_HEARTBEAT_KEY);
    if (!raw) {
      return { ...downFlags, source: "remote-worker-missing" };
    }
    const parsed = JSON.parse(raw) as WorkerHealthFlags & {
      pid?: number;
      processType?: string;
      timestamp?: number;
    };
    const ageMs = parsed.timestamp ? Date.now() - parsed.timestamp : Number.POSITIVE_INFINITY;
    const stale = ageMs > 30_000;
    if (stale) {
      // Heartbeat is older than its TTL window — treat the worker as gone.
      // We must force flags to false so /api/health cannot report "healthy"
      // off of stale data.
      return {
        ...downFlags,
        source: "remote-worker-stale",
        pid: parsed.pid,
        processType: parsed.processType,
        heartbeatAgeSeconds: Math.round(ageMs / 1000),
      };
    }
    return {
      jobProcessor: !!parsed.jobProcessor,
      importProcessor: !!parsed.importProcessor,
      tagQueueWorker: !!parsed.tagQueueWorker,
      flushProcessor: !!parsed.flushProcessor,
      maintenanceWorker: !!parsed.maintenanceWorker,
      scheduledCampaignPoller: !!parsed.scheduledCampaignPoller,
      source: "remote-worker",
      pid: parsed.pid,
      processType: parsed.processType,
      heartbeatAgeSeconds: Math.round(ageMs / 1000),
    };
  } catch {
    return { ...downFlags, source: "remote-worker-missing" };
  }
}

export function registerHealthRoutes(app: Express) {
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

      const mainPoolHealthy = isPoolHealthy();
      const trackingPoolHealthy = isTrackingPoolHealthy();
      const pools = {
        main: {
          status: mainPoolHealthy ? "healthy" : "degraded",
          healthy: mainPoolHealthy,
          inUse: Math.max(0, pool.totalCount - pool.idleCount),
          idle: pool.idleCount,
          waiting: pool.waitingCount,
          max: MAIN_POOL_MAX,
        },
        tracking: {
          status: trackingPoolHealthy ? "healthy" : "degraded",
          healthy: trackingPoolHealthy,
          inUse: Math.max(0, trackingPool.totalCount - trackingPool.idleCount),
          idle: trackingPool.idleCount,
          waiting: trackingPool.waitingCount,
          max: TRACKING_POOL_MAX,
        },
      };
      const poolsHealthy = mainPoolHealthy && trackingPoolHealthy;
      
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

      const workerHealth = await resolveWorkerHealth();
      const allWorkersRunning = workerHealth.jobProcessor && workerHealth.importProcessor && workerHealth.tagQueueWorker && workerHealth.flushProcessor && workerHealth.scheduledCampaignPoller;

      let redisStatus: "ok" | "degraded" | "disabled" = "disabled";
      if (isRedisConfigured && redisConnection) {
        redisStatus = redisConnection.status === "ready" ? "ok" : "degraded";
      }

      const useBullMQ = process.env.USE_BULLMQ === "true";

      res.json({
        status: (dbHealthy && allWorkersRunning && poolsHealthy) ? 'healthy' : 'degraded',
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        database: {
          healthy: dbHealthy,
          status: dbHealthy ? "connected" : "disconnected",
          latencyMs: dbLatency,
          pool: poolStats,
          pools,
        },
        redis: {
          configured: isRedisConfigured,
          status: redisStatus,
        },
        bullmq: {
          enabled: useBullMQ,
        },
        memory: {
          heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
          heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
          rssMB: Math.round(memUsage.rss / 1024 / 1024),
        },
        workers: workerHealth,
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

  app.get("/api/health/ip", async (_req: Request, res: Response) => {
    try {
      const response = await fetch("https://api.ipify.org?format=json");
      const data = await response.json() as { ip: string };
      res.json({ outboundIp: data.ip, timestamp: new Date().toISOString() });
    } catch (error) {
      res.status(500).json({ error: "Failed to resolve outbound IP" });
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
}
