import { type Express, type Request, type Response } from "express";
import { storage } from "../storage";
import { runMaintenanceNow } from "../workers";
import { z } from "zod";

const updateRuleSchema = z.object({
  retentionDays: z.number().int().min(1).max(365).optional(),
  enabled: z.boolean().optional(),
});

export function registerDatabaseHealthRoutes(app: Express) {
  app.get("/api/database-health/stats", async (_req: Request, res: Response) => {
    try {
      const stats = await storage.getTableStats();
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch table stats" });
    }
  });

  app.get("/api/database-health/tracking-token-bloat", async (_req: Request, res: Response) => {
    try {
      const bloat = await storage.getTrackingTokenBloat();
      res.json(bloat);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch tracking_tokens bloat status" });
    }
  });

  app.get("/api/database-health/rules", async (_req: Request, res: Response) => {
    try {
      const rules = await storage.getMaintenanceRules();
      res.json(rules);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch maintenance rules" });
    }
  });

  app.put("/api/database-health/rules/:id", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const parsed = updateRuleSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten().fieldErrors });
      }
      const updateData: any = {};
      if (parsed.data.retentionDays !== undefined) updateData.retentionDays = parsed.data.retentionDays;
      if (parsed.data.enabled !== undefined) updateData.enabled = parsed.data.enabled;

      const rule = await storage.updateMaintenanceRule(id, updateData);
      if (!rule) {
        return res.status(404).json({ error: "Rule not found" });
      }
      res.json(rule);
    } catch (error) {
      res.status(500).json({ error: "Failed to update rule" });
    }
  });

  app.get("/api/database-health/logs", async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
      const logs = await storage.getMaintenanceLogs(limit);
      res.json(logs);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch maintenance logs" });
    }
  });

  app.post("/api/database-health/run", async (_req: Request, res: Response) => {
    try {
      const results = await runMaintenanceNow("manual");
      res.json({ results });
    } catch (error) {
      res.status(500).json({ error: "Failed to run maintenance" });
    }
  });
}
