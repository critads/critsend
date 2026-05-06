import { type Express, type Request, type Response } from "express";
import { storage } from "../storage";
import { db, pool, isPoolHealthy } from "../db";
import { sql } from "drizzle-orm";
import { getWorkerHealth, WORKER_HEARTBEAT_KEY } from "../workers";
import { redisConnection, isRedisConfigured } from "../redis";
import { trackingPool, isTrackingPoolHealthy } from "../tracking-pool";
import { MAIN_POOL_MAX, TRACKING_POOL_MAX } from "../connection-budget";
import { register } from "../metrics";
import { logger } from "../logger";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

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
    const mainPoolHealthy = isPoolHealthy();
    const trackingPoolHealthy = isTrackingPoolHealthy();
    const memUsage = process.memoryUsage();

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

    let dbHealthy = true;
    let dbLatency = 0;
    let queueDepths: any = {};
    let workerHealth: WorkerHealthReport;

    if (mainPoolHealthy && pool.idleCount > 0) {
      try {
        const startTime = Date.now();
        await db.execute(sql`SELECT 1`);
        dbLatency = Date.now() - startTime;
      } catch {
        dbHealthy = false;
      }

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
      } catch {
        queueDepths = { error: "Failed to query queue depths" };
      }
    } else {
      queueDepths = { skipped: "pool_saturated" };
    }

    try {
      workerHealth = await resolveWorkerHealth();
    } catch {
      workerHealth = {
        jobProcessor: false, importProcessor: false, tagQueueWorker: false,
        flushProcessor: false, maintenanceWorker: false, scheduledCampaignPoller: false,
        source: "remote-worker-missing",
      };
    }

    const allWorkersRunning = workerHealth.jobProcessor && workerHealth.importProcessor && workerHealth.tagQueueWorker && workerHealth.flushProcessor && workerHealth.scheduledCampaignPoller;

    let redisStatus: "ok" | "degraded" | "disabled" = "disabled";
    if (isRedisConfigured && redisConnection) {
      redisStatus = redisConnection.status === "ready" ? "ok" : "degraded";
    }

    const overallHealthy = dbHealthy && allWorkersRunning && mainPoolHealthy && trackingPoolHealthy;

    res.json({
      status: overallHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      database: {
        healthy: dbHealthy,
        status: dbHealthy ? "connected" : "disconnected",
        latencyMs: dbLatency,
        pool: {
          totalCount: pool.totalCount,
          idleCount: pool.idleCount,
          waitingCount: pool.waitingCount,
        },
        pools,
      },
      redis: {
        configured: isRedisConfigured,
        status: redisStatus,
      },
      bullmq: {
        enabled: process.env.USE_BULLMQ === "true",
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

  app.get("/api/system-metrics", async (_req: Request, res: Response) => {
    try {
      const metricsJson = await register.getMetricsAsJSON();
      const lookup = new Map<string, any>();
      for (const m of metricsJson) lookup.set(m.name, m);

      function counterValue(name: string, labels?: Record<string, string>): number {
        const m = lookup.get(name);
        if (!m?.values) return 0;
        if (!labels) return m.values.reduce((s: number, v: any) => s + (v.value ?? 0), 0);
        return m.values
          .filter((v: any) => Object.entries(labels).every(([k, val]) => v.labels?.[k] === val))
          .reduce((s: number, v: any) => s + (v.value ?? 0), 0);
      }
      function gaugeValue(name: string, labels?: Record<string, string>): number {
        const m = lookup.get(name);
        if (!m?.values) return 0;
        if (!labels) return m.values[0]?.value ?? 0;
        const match = m.values.find((v: any) =>
          Object.entries(labels).every(([k, val]) => v.labels?.[k] === val)
        );
        return match?.value ?? 0;
      }
      function labeledValues(name: string): Array<{ labels: Record<string, string>; value: number }> {
        const m = lookup.get(name);
        if (!m?.values) return [];
        return m.values.map((v: any) => ({ labels: v.labels ?? {}, value: v.value ?? 0 }));
      }

      const http5xx = (lookup.get("critsend_http_requests_total")?.values ?? [])
        .filter((v: any) => v.labels?.status_code && parseInt(v.labels.status_code) >= 500)
        .map((v: any) => ({
          method: v.labels?.method,
          route: v.labels?.route,
          statusCode: v.labels?.status_code,
          count: v.value ?? 0,
        }))
        .filter((v: any) => v.count > 0);

      const totalRequests = counterValue("critsend_http_requests_total");
      const total5xx = http5xx.reduce((s: number, v: any) => s + v.count, 0);

      res.json({
        timestamp: new Date().toISOString(),
        uptimeSeconds: process.uptime(),

        errors: {
          loadShedTotal: counterValue("critsend_db_pool_load_shed_total"),
          loadShedByReason: labeledValues("critsend_db_pool_load_shed_total"),
          checkoutTimeouts: counterValue("critsend_db_pool_checkout_timeout_total"),
          leaseExceeded: labeledValues("critsend_db_pool_request_lease_exceeded_total"),
          poolSaturationEvents: counterValue("critsend_db_pool_saturation_total"),
          totalErrors: counterValue("critsend_errors_total"),
          errorsByType: labeledValues("critsend_errors_total"),
          http5xx,
          total5xx,
          totalRequests,
          errorRate5xx: totalRequests > 0 ? ((total5xx / totalRequests) * 100) : 0,
        },

        pools: {
          main: {
            total: pool.totalCount,
            idle: pool.idleCount,
            waiting: pool.waitingCount,
            max: MAIN_POOL_MAX,
            saturation: MAIN_POOL_MAX > 0 ? ((pool.totalCount - pool.idleCount) / MAIN_POOL_MAX) : 0,
          },
          tracking: {
            inUse: gaugeValue("critsend_tracking_pool_in_use"),
            max: TRACKING_POOL_MAX,
            total: trackingPool.totalCount,
            idle: trackingPool.idleCount,
            waiting: trackingPool.waitingCount,
          },
        },

        tracking: {
          bufferDepth: gaugeValue("critsend_tracking_buffer_queue_depth"),
          enqueued: counterValue("critsend_tracking_buffer_enqueued_total"),
          flushed: counterValue("critsend_tracking_buffer_flushed_total"),
          dropped: counterValue("critsend_tracking_buffer_dropped_total"),
          droppedByReason: labeledValues("critsend_tracking_buffer_dropped_total"),
          deduped: counterValue("critsend_tracking_buffer_deduped_total"),
        },

        bounces: {
          bufferDepth: gaugeValue("critsend_bounce_buffer_queue_depth"),
          enqueued: counterValue("critsend_bounce_buffer_enqueued_total"),
          flushed: counterValue("critsend_bounce_buffer_flushed_total"),
          dropped: counterValue("critsend_bounce_buffer_dropped_total"),
          deduped: counterValue("critsend_bounce_buffer_deduped_total"),
          partialFailures: counterValue("critsend_bounce_buffer_flush_partial_failure_total"),
          totalByType: labeledValues("critsend_bounces_total"),
        },

        counterDrift: {
          fixed: labeledValues("critsend_counter_drift_fixed_total"),
          lastRunMs: gaugeValue("critsend_counter_drift_run_duration_ms"),
          lastRunAt: gaugeValue("critsend_counter_drift_last_run_timestamp_seconds"),
        },

        system: {
          heapUsedMB: Math.round(gaugeValue("critsend_memory_usage_bytes", { type: "heapUsed" }) / 1048576),
          heapTotalMB: Math.round(gaugeValue("critsend_memory_usage_bytes", { type: "heapTotal" }) / 1048576),
          rssMB: Math.round(gaugeValue("critsend_memory_usage_bytes", { type: "rss" }) / 1048576),
          activeCampaigns: gaugeValue("critsend_active_campaigns"),
          emailsSent: counterValue("critsend_emails_sent_total"),
          workerRestarts: counterValue("critsend_worker_restarts_total"),
        },

        queues: {
          campaign: gaugeValue("critsend_queue_depth", { queue_name: "campaign" }),
          import: gaugeValue("critsend_queue_depth", { queue_name: "import" }),
          tag: gaugeValue("critsend_queue_depth", { queue_name: "tag" }),
        },
      });
    } catch (error) {
      logger.error("[SYSTEM_METRICS] Failed to serialize metrics", { error: String(error) });
      res.status(500).json({ error: "Failed to fetch system metrics" });
    }
  });

  const DEPLOY_LOG = "/tmp/critsend-deploy.log";
  const DEPLOY_STATUS = "/tmp/critsend-deploy-status.json";

  function readDeployStatus(): { status: string; startedAt?: string; finishedAt?: string; log?: string } {
    try {
      const raw = fs.readFileSync(DEPLOY_STATUS, "utf8");
      const status = JSON.parse(raw);
      try {
        status.log = fs.readFileSync(DEPLOY_LOG, "utf8");
      } catch { status.log = ""; }
      return status;
    } catch {
      return { status: "idle", log: "" };
    }
  }

  const DEPLOY_STALE_MS = 10 * 60 * 1000;

  app.post("/api/admin/deploy", async (req: Request, res: Response) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const current = readDeployStatus();
    if (current.status === "running") {
      const elapsed = current.startedAt ? Date.now() - new Date(current.startedAt).getTime() : 0;
      if (elapsed < DEPLOY_STALE_MS) {
        return res.status(409).json({ error: "A deploy is already in progress" });
      }
      logger.warn("[DEPLOY] Stale deploy detected, allowing new deploy");
    }

    const skipSchema = req.body?.skipSchema === true;
    const repoRoot = process.env.CRITSEND_REPO_ROOT || "/home/ubuntu/critsend";
    const deployScript = path.join(repoRoot, "deploy", "deploy.sh");

    if (!fs.existsSync(deployScript)) {
      return res.status(404).json({ error: "Deploy script not found at " + deployScript });
    }

    const startedAt = new Date().toISOString();
    const mode = skipSchema ? "code-only" : "full";
    fs.writeFileSync(DEPLOY_STATUS, JSON.stringify({ status: "running", startedAt, mode }));
    fs.writeFileSync(DEPLOY_LOG, "");

    logger.info("[DEPLOY] Deploy triggered via admin UI", { userId: req.session.userId, mode });

    const wrapperScript = `
      exec > "${DEPLOY_LOG}" 2>&1
      ${skipSchema ? 'export SKIP_SCHEMA_PUSH=1' : ''}
      bash "${deployScript}"
      EXIT_CODE=$?
      FINISHED=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
      if [ $EXIT_CODE -eq 0 ]; then
        echo '{"status":"success","startedAt":"${startedAt}","finishedAt":"'$FINISHED'","exitCode":0,"mode":"${mode}"}' > "${DEPLOY_STATUS}"
      else
        echo '{"status":"failed","startedAt":"${startedAt}","finishedAt":"'$FINISHED'","exitCode":'$EXIT_CODE',"mode":"${mode}"}' > "${DEPLOY_STATUS}"
      fi
    `;

    const child = spawn("bash", ["-c", wrapperScript], {
      cwd: repoRoot,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, HOME: process.env.HOME || "/home/ubuntu" },
    });

    child.unref();

    res.json({ message: "Deploy started", startedAt });
  });

  app.post("/api/admin/deploy/cancel", async (req: Request, res: Response) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const current = readDeployStatus();
    if (current.status !== "running") {
      return res.status(409).json({ error: "No deploy is currently running" });
    }

    logger.warn("[DEPLOY] Deploy cancelled via admin UI", { userId: req.session.userId });

    try {
      spawn("bash", ["-c", "pkill -f 'deploy.sh' 2>/dev/null; pkill -f 'drizzle-kit' 2>/dev/null; pkill -f 'npm run build' 2>/dev/null"], {
        stdio: "ignore",
      });
    } catch {}

    const finishedAt = new Date().toISOString();
    const statusObj = { status: "cancelled", startedAt: current.startedAt, finishedAt, exitCode: 130 };
    fs.writeFileSync(DEPLOY_STATUS, JSON.stringify(statusObj));

    try {
      fs.appendFileSync(DEPLOY_LOG, `\n[deploy] ✗ Deploy cancelled by user at ${finishedAt}\n`);
    } catch {}

    res.json({ message: "Deploy cancelled" });
  });

  app.get("/api/admin/deploy/status", async (req: Request, res: Response) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    const result = readDeployStatus();
    const offset = parseInt(req.query.logOffset as string) || 0;
    if (result.log && offset > 0) {
      result.log = result.log.substring(offset);
    }
    (result as any).logLength = offset + (result.log?.length || 0);
    res.json(result);
  });
}
