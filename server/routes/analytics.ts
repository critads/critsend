import { type Express, type Request, type Response } from "express";
import { storage } from "../storage";
import { logger } from "../logger";

export function registerAnalyticsRoutes(app: Express, helpers: {
  parsePagination: (query: any) => { page: number; limit: number };
  validateId: (id: string) => boolean;
}) {
  const { parsePagination, validateId } = helpers;

  app.get("/api/dashboard/stats", async (req: Request, res: Response) => {
    try {
      const stats = await storage.getDashboardStats();
      res.json(stats);
    } catch (error) {
      logger.error("Error fetching dashboard stats:", error);
      res.status(500).json({ error: "Failed to fetch dashboard stats" });
    }
  });

  app.get("/api/analytics/overall", async (req: Request, res: Response) => {
    try {
      const analytics = await storage.getOverallAnalytics();
      res.json(analytics);
    } catch (error) {
      logger.error("Error fetching overall analytics:", error);
      res.status(500).json({ error: "Failed to fetch analytics" });
    }
  });

  app.get("/api/analytics/campaign/:id", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const analytics = await storage.getCampaignAnalytics(req.params.id);
      if (!analytics) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      res.json(analytics);
    } catch (error) {
      logger.error("Error fetching campaign analytics:", error);
      res.status(500).json({ error: "Failed to fetch campaign analytics" });
    }
  });

  app.get("/api/analytics/campaign/:id/provider-open-rates", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const data = await storage.getCampaignProviderOpenRates(req.params.id);
      res.json(data);
    } catch (error) {
      logger.error("Error fetching provider open rates:", error);
      res.status(500).json({ error: "Failed to fetch provider open rates" });
    }
  });

  app.get("/api/error-logs", async (req: Request, res: Response) => {
    try {
      const { page, limit } = parsePagination(req.query);
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
      logger.error("Error fetching error logs:", error);
      res.status(500).json({ error: "Failed to fetch error logs" });
    }
  });

  app.get("/api/error-logs/stats", async (req: Request, res: Response) => {
    try {
      const stats = await storage.getErrorLogStats();
      res.json(stats);
    } catch (error) {
      logger.error("Error fetching error log stats:", error);
      res.status(500).json({ error: "Failed to fetch error log stats" });
    }
  });

  app.delete("/api/error-logs", async (req: Request, res: Response) => {
    try {
      const beforeDate = req.query.before ? new Date(req.query.before as string) : undefined;
      const count = await storage.clearErrorLogs(beforeDate);
      res.json({ deleted: count });
    } catch (error) {
      logger.error("Error clearing error logs:", error);
      res.status(500).json({ error: "Failed to clear error logs" });
    }
  });
}
