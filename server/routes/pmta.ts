/**
 * PMTA queue monitoring routes (Task #193).
 *
 * Contract: routes serve cached snapshot rows ONLY. The 5-minute collector
 * lives in server/services/pmta-collector.ts and is the only place that
 * opens an SSH connection. POST /refresh enqueues an immediate (forced)
 * collector tick but the HTTP call returns as soon as the tick completes —
 * it does not bypass the per-domain SSH connection isolation.
 */
import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import {
  getLatestPmtaSnapshots,
  getPmtaSnapshotHistory,
} from "../repositories/pmta-repository";
import {
  requestPmtaRefresh,
  isPmtaConfigured,
  getPmtaConfiguredDomains,
} from "../services/pmta-collector";
import { logger } from "../logger";

const refreshLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Refresh rate limit exceeded — try again in a minute" },
});

const DOMAIN_RE = /^[a-z0-9.-]+$/i;

export function registerPmtaRoutes(app: Express) {
  app.get("/api/pmta/status", (_req: Request, res: Response) => {
    res.json({
      configured: isPmtaConfigured(),
      domains: getPmtaConfiguredDomains(),
    });
  });

  app.get("/api/pmta/snapshots/latest", async (_req: Request, res: Response) => {
    try {
      const rows = await getLatestPmtaSnapshots();
      res.json({
        configured: isPmtaConfigured(),
        configuredDomains: getPmtaConfiguredDomains(),
        snapshots: rows,
      });
    } catch (err) {
      logger.error("[PMTA] failed to fetch latest snapshots:", err);
      res.status(500).json({ error: "Failed to fetch PMTA snapshots" });
    }
  });

  app.get("/api/pmta/snapshots/:domain/history", async (req: Request, res: Response) => {
    const domain = req.params.domain;
    if (!DOMAIN_RE.test(domain)) {
      return res.status(400).json({ error: "Invalid domain" });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
    try {
      const rows = await getPmtaSnapshotHistory(domain, limit);
      res.json({ domain, snapshots: rows });
    } catch (err) {
      logger.error(`[PMTA] failed to fetch history for ${domain}:`, err);
      res.status(500).json({ error: "Failed to fetch PMTA history" });
    }
  });

  // Operator-facing refresh: fire-and-forget. NEVER opens SSH on the request
  // stack — the request returns 202 immediately and the tick runs off the
  // event loop, gated by the same leader-election upsert the 5-min scheduler
  // uses (so only the leader process actually contacts PMTA).
  app.post("/api/pmta/refresh", refreshLimiter, (_req: Request, res: Response) => {
    if (!isPmtaConfigured()) {
      return res.status(503).json({ error: "PMTA collector not configured" });
    }
    const result = requestPmtaRefresh();
    if (!result.scheduled) {
      return res.status(202).json({ scheduled: false, reason: result.reason });
    }
    res.status(202).json({
      scheduled: true,
      note: "Refresh enqueued — will run on the PMTA collector leader process within seconds.",
    });
  });
}
