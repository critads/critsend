import { type Express, type Request, type Response } from "express";
import { storage } from "../storage";
import { pool } from "../db";
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

  app.get("/api/analytics/campaign/:id/heatmap-data", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const data = await storage.getCampaignClickHeatmap(req.params.id);
      if (!data) return res.status(404).json({ error: "Campaign not found" });
      res.json({ links: data.links, totalClicks: data.totalClicks });
    } catch (error) {
      logger.error("Error fetching heatmap data:", error);
      res.status(500).json({ error: "Failed to fetch heatmap data" });
    }
  });

  app.get("/api/analytics/campaign/:id/heatmap", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).send("<p>Invalid campaign ID</p>");
      }
      const data = await storage.getCampaignClickHeatmap(req.params.id);
      if (!data) return res.status(404).send("<p>Campaign not found</p>");

      const clickMap = new Map(data.links.map(l => [l.url, l]));

      const heatColor = (pct: number, clicks: number) => {
        if (clicks === 0) return "#9ca3af";
        if (pct >= 30) return "#ef4444";
        if (pct >= 10) return "#f97316";
        if (pct >= 3)  return "#eab308";
        return "#22c55e";
      };

      let html = data.htmlContent.replace(
        /href="(https?:\/\/[^"]+)"/gi,
        (_match, url: string) => {
          const stat = clickMap.get(url);
          const clicks = stat?.clicks ?? 0;
          const pct = stat?.pct ?? 0;
          const color = heatColor(pct, clicks);
          return `href="${url}" data-hm-clicks="${clicks}" data-hm-pct="${pct.toFixed(1)}" data-hm-color="${color}"`;
        }
      );

      const injection = `
<style>
  .hm-badge {
    display: inline-block !important;
    font-size: 10px !important;
    font-weight: 700 !important;
    font-family: system-ui, -apple-system, sans-serif !important;
    color: #fff !important;
    background: var(--hm-color, #9ca3af) !important;
    padding: 2px 7px !important;
    border-radius: 9999px !important;
    margin-left: 5px !important;
    vertical-align: middle !important;
    white-space: nowrap !important;
    pointer-events: none !important;
    line-height: 1.5 !important;
    box-shadow: 0 1px 3px rgba(0,0,0,0.35) !important;
    position: relative !important;
    z-index: 9999 !important;
  }
</style>
<script>
(function() {
  function init() {
    document.querySelectorAll('[data-hm-clicks]').forEach(function(el) {
      var clicks = parseInt(el.getAttribute('data-hm-clicks') || '0', 10);
      var pct   = el.getAttribute('data-hm-pct') || '0';
      var color = el.getAttribute('data-hm-color') || '#9ca3af';
      var badge = document.createElement('span');
      badge.className = 'hm-badge';
      badge.style.setProperty('--hm-color', color);
      badge.textContent = clicks > 0
        ? clicks + ' click' + (clicks !== 1 ? 's' : '') + ' (' + pct + '%)'
        : '0 clicks';
      el.parentNode && el.parentNode.insertBefore(badge, el.nextSibling);
    });
    window.parent.postMessage({ type: 'hm-height', height: document.documentElement.scrollHeight }, '*');
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
</script>`;

      if (html.includes("</head>")) {
        html = html.replace("</head>", injection + "</head>");
      } else if (html.match(/<body[^>]*>/i)) {
        html = html.replace(/(<body[^>]*>)/i, "$1" + injection);
      } else {
        html = injection + html;
      }

      res.set("Content-Type", "text/html; charset=utf-8");
      res.set("X-Frame-Options", "SAMEORIGIN");
      res.send(html);
    } catch (error) {
      logger.error("Error rendering heatmap:", error);
      res.status(500).send("<p>Failed to render heatmap</p>");
    }
  });

  app.get("/api/analytics/campaign/:id/device-stats", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const data = await storage.getCampaignDeviceStats(req.params.id);
      res.json(data);
    } catch (error) {
      logger.error("Error fetching device stats:", error);
      res.status(500).json({ error: "Failed to fetch device stats" });
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

  app.get("/api/analytics/campaign/:id/batch-opens", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const rawBatchSize = parseInt(req.query.batchSize as string, 10);
      const batchSize = isNaN(rawBatchSize)
        ? 10000
        : Math.min(50000, Math.max(1000, rawBatchSize));
      const data = await storage.getCampaignBatchOpenStats(req.params.id, batchSize);
      if (data.length === 0) {
        return res.status(404).json({ error: "No send data found for this campaign" });
      }
      res.json(data);
    } catch (error) {
      logger.error("Error fetching batch open stats:", error);
      res.status(500).json({ error: "Failed to fetch batch open stats" });
    }
  });

  app.get("/api/analytics/campaign/:id/clicker-ips", async (req: Request, res: Response) => {
    try {
      if (!validateId(req.params.id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }
      const result = await pool.query(
        `SELECT DISTINCT ip_address
         FROM campaign_stats
         WHERE campaign_id = $1
           AND type = 'click'
           AND ip_address IS NOT NULL
         ORDER BY ip_address`,
        [req.params.id]
      );
      const lines = ["ip_address", ...result.rows.map((r: any) => r.ip_address)];
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="clickers-${req.params.id}.csv"`);
      res.send(lines.join("\n"));
    } catch (error) {
      logger.error("Error exporting clicker IPs:", error);
      res.status(500).json({ error: "Failed to export clicker IPs" });
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
