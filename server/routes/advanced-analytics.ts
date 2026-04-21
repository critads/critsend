import { type Express, type Request, type Response } from "express";
import { pool } from "../db";
import { logger } from "../logger";
import {
  runAnalyticsRollup,
  getAnalyticsCached,
  publishAnalyticsInvalidation,
  parseRefreshFlag,
} from "../repositories/analytics-ops";

export function registerAdvancedAnalyticsRoutes(app: Express) {

  app.get("/api/analytics/overview", async (req: Request, res: Response) => {
    try {
      const refresh = parseRefreshFlag(req.query);
      const data = await getAnalyticsCached("overview", async () => {
        // Fast path: read the materialized single-row totals refreshed
        // every 15 minutes by the worker. PK lookup, no big-table scans.
        // If the table is missing entirely (fresh deploy before db:push
        // applied the new schema), Postgres throws 42P01 — treat that as
        // "no row" so the live-COUNT fallback kicks in instead of 500ing.
        let totalsRow: { rowCount: number; rows: any[] };
        try {
          const r = await pool.query(
            `SELECT total_subscribers, total_campaigns, total_sent, total_bounces,
                    total_opens, total_clicks, total_unsubscribes, updated_at
             FROM analytics_totals WHERE id = 'global' LIMIT 1`
          );
          totalsRow = { rowCount: r.rowCount ?? 0, rows: r.rows };
        } catch (err: any) {
          if (err?.code === "42P01") {
            totalsRow = { rowCount: 0, rows: [] };
          } else {
            throw err;
          }
        }

        let totalSubscribers: number;
        let totalCampaigns: number;
        let totalSent: number;
        let totalBounces: number;
        let totalOpens: number;
        let totalClicks: number;
        let totalUnsubscribes: number;

        if (totalsRow.rowCount && totalsRow.rowCount > 0) {
          const r = totalsRow.rows[0];
          totalSubscribers = r.total_subscribers ?? 0;
          totalCampaigns = r.total_campaigns ?? 0;
          totalSent = r.total_sent ?? 0;
          totalBounces = r.total_bounces ?? 0;
          totalOpens = r.total_opens ?? 0;
          totalClicks = r.total_clicks ?? 0;
          totalUnsubscribes = r.total_unsubscribes ?? 0;
        } else {
          // Fallback for fresh deployments before the rollup has run.
          // Same expensive scans as before, but only on the very first
          // hit; subsequent calls hit the materialized row.
          const [subscriberResult, campaignResult, sendsResult, statsResult] = await Promise.all([
            pool.query(`SELECT COUNT(*)::int AS total_subscribers FROM subscribers`),
            pool.query(`SELECT COUNT(*)::int AS total_campaigns FROM campaigns`),
            pool.query(`SELECT COUNT(*)::int AS total_sent,
                               COUNT(*) FILTER (WHERE status = 'bounced')::int AS total_bounces
                        FROM campaign_sends`),
            pool.query(`SELECT COUNT(*) FILTER (WHERE type = 'open')::int AS total_opens,
                               COUNT(*) FILTER (WHERE type = 'click')::int AS total_clicks,
                               COUNT(*) FILTER (WHERE type = 'unsubscribe')::int AS total_unsubscribes
                        FROM campaign_stats`),
          ]);
          totalSubscribers = subscriberResult.rows[0]?.total_subscribers ?? 0;
          totalCampaigns = campaignResult.rows[0]?.total_campaigns ?? 0;
          totalSent = sendsResult.rows[0]?.total_sent ?? 0;
          totalBounces = sendsResult.rows[0]?.total_bounces ?? 0;
          totalOpens = statsResult.rows[0]?.total_opens ?? 0;
          totalClicks = statsResult.rows[0]?.total_clicks ?? 0;
          totalUnsubscribes = statsResult.rows[0]?.total_unsubscribes ?? 0;
        }

        const openRate = totalSent > 0 ? (totalOpens / totalSent) * 100 : 0;
        const clickRate = totalSent > 0 ? (totalClicks / totalSent) * 100 : 0;
        const bounceRate = totalSent > 0 ? (totalBounces / totalSent) * 100 : 0;
        const unsubscribeRate = totalSent > 0 ? (totalUnsubscribes / totalSent) * 100 : 0;

        return {
          totalSubscribers,
          totalCampaigns,
          totalSent,
          totalOpens,
          totalClicks,
          totalBounces,
          totalUnsubscribes,
          openRate: Math.round(openRate * 100) / 100,
          clickRate: Math.round(clickRate * 100) / 100,
          bounceRate: Math.round(bounceRate * 100) / 100,
          unsubscribeRate: Math.round(unsubscribeRate * 100) / 100,
        };
      }, refresh);
      res.json(data);
    } catch (error) {
      logger.error("Error fetching analytics overview:", error);
      res.status(500).json({ error: "Failed to fetch analytics overview" });
    }
  });

  app.get("/api/analytics/engagement", async (req: Request, res: Response) => {
    try {
      const days = Math.min(Math.max(parseInt(req.query.days as string) || 30, 1), 365);
      const refresh = parseRefreshFlag(req.query);

      const rows = await getAnalyticsCached(`engagement:${days}`, async () => {
      const rollupResult = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM analytics_daily WHERE date >= NOW() - $1::int * INTERVAL '1 day'`,
        [days]
      );
      const hasRollupData = (rollupResult.rows[0]?.cnt ?? 0) > 0;

      let rows;
      if (hasRollupData) {
        const result = await pool.query(
          `SELECT
            date::date AS date,
            SUM(total_sent)::int AS sent,
            SUM(total_opens)::int AS opens,
            SUM(total_clicks)::int AS clicks,
            SUM(total_bounces)::int AS bounces,
            SUM(total_unsubscribes)::int AS unsubscribes
          FROM analytics_daily
          WHERE date >= NOW() - $1::int * INTERVAL '1 day'
          GROUP BY date::date
          ORDER BY date::date ASC`,
          [days]
        );
        rows = result.rows;
      } else {
        const result = await pool.query(
          `WITH date_series AS (
            SELECT generate_series(
              (CURRENT_DATE - $1::int * INTERVAL '1 day')::date,
              CURRENT_DATE,
              '1 day'::interval
            )::date AS date
          ),
          daily_sends AS (
            SELECT sent_at::date AS date,
              COUNT(*)::int AS sent,
              COUNT(*) FILTER (WHERE status = 'bounced')::int AS bounces
            FROM campaign_sends
            WHERE sent_at >= NOW() - $1::int * INTERVAL '1 day'
            GROUP BY sent_at::date
          ),
          daily_stats AS (
            SELECT timestamp::date AS date,
              COUNT(*) FILTER (WHERE type = 'open')::int AS opens,
              COUNT(*) FILTER (WHERE type = 'click')::int AS clicks,
              COUNT(*) FILTER (WHERE type = 'unsubscribe')::int AS unsubscribes
            FROM campaign_stats
            WHERE timestamp >= NOW() - $1::int * INTERVAL '1 day'
            GROUP BY timestamp::date
          )
          SELECT
            ds.date,
            COALESCE(s.sent, 0) AS sent,
            COALESCE(st.opens, 0) AS opens,
            COALESCE(st.clicks, 0) AS clicks,
            COALESCE(s.bounces, 0) AS bounces,
            COALESCE(st.unsubscribes, 0) AS unsubscribes
          FROM date_series ds
          LEFT JOIN daily_sends s ON ds.date = s.date
          LEFT JOIN daily_stats st ON ds.date = st.date
          ORDER BY ds.date ASC`,
          [days]
        );
        rows = result.rows;
      }

      return rows;
      }, refresh);

      res.json(rows);
    } catch (error) {
      logger.error("Error fetching engagement trends:", error);
      res.status(500).json({ error: "Failed to fetch engagement trends" });
    }
  });

  app.get("/api/analytics/cohort", async (req: Request, res: Response) => {
    try {
      const periodParam = req.query.period as string;
      if (periodParam && !["weekly", "monthly"].includes(periodParam)) {
        return res.status(400).json({ error: "Invalid period. Must be 'weekly' or 'monthly'" });
      }
      const period = periodParam === "weekly" ? "week" : "month";
      const refresh = parseRefreshFlag(req.query);

      const rows = await getAnalyticsCached(`cohort:${period}`, async () => {
        // Denormalized cohort: subscribers.suppressed_until and
        // subscribers.last_engaged_at are kept up to date by the rollup
        // (and an idempotent one-shot bootstrap), so cohort analysis
        // scans ONLY the subscribers table — never the 5.5M-row
        // campaign_stats. A single GROUP BY + COUNT(*) FILTER does it.
        const result = await pool.query(
          `SELECT
            date_trunc($1, import_date)::date AS cohort,
            COUNT(*)::int AS total_subscribers,
            COUNT(*) FILTER (WHERE suppressed_until IS NULL OR suppressed_until < NOW())::int AS active_subscribers,
            CASE WHEN COUNT(*) > 0
              THEN ROUND((COUNT(*) FILTER (WHERE suppressed_until IS NULL OR suppressed_until < NOW())::numeric
                          / COUNT(*)) * 100, 2)
              ELSE 0
            END AS active_rate,
            CASE WHEN COUNT(*) > 0
              THEN ROUND((COUNT(*) FILTER (WHERE last_engaged_at IS NOT NULL)::numeric
                          / COUNT(*)) * 100, 2)
              ELSE 0
            END AS engagement_rate
          FROM subscribers
          GROUP BY date_trunc($1, import_date)::date
          ORDER BY date_trunc($1, import_date)::date DESC`,
          [period]
        );
        return result.rows;
      }, refresh);

      res.json(rows);
    } catch (error) {
      logger.error("Error fetching cohort analysis:", error);
      res.status(500).json({ error: "Failed to fetch cohort analysis" });
    }
  });

  app.get("/api/analytics/deliverability", async (req: Request, res: Response) => {
    try {
      const days = Math.min(Math.max(parseInt(req.query.days as string) || 30, 1), 365);
      const refresh = parseRefreshFlag(req.query);

      const data = await getAnalyticsCached(`deliverability:${days}`, async () => {
      const [overallResult, mtaResult] = await Promise.all([
        pool.query(
          `SELECT
            COUNT(*)::int AS total_sent,
            COUNT(*) FILTER (WHERE status = 'sent')::int AS total_delivered,
            COUNT(*) FILTER (WHERE status = 'bounced')::int AS total_bounced,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS total_failed
          FROM campaign_sends
          WHERE sent_at >= NOW() - $1::int * INTERVAL '1 day'`,
          [days]
        ),
        pool.query(
          `SELECT
            m.id AS mta_id,
            m.name AS mta_name,
            COUNT(cs.id)::int AS total_sent,
            COUNT(cs.id) FILTER (WHERE cs.status = 'sent')::int AS total_delivered,
            COUNT(cs.id) FILTER (WHERE cs.status = 'bounced')::int AS total_bounced,
            COUNT(cs.id) FILTER (WHERE cs.status = 'failed')::int AS total_failed
          FROM mtas m
          LEFT JOIN campaigns c ON c.mta_id = m.id
          LEFT JOIN campaign_sends cs ON cs.campaign_id = c.id AND cs.sent_at >= NOW() - $1::int * INTERVAL '1 day'
          GROUP BY m.id, m.name
          ORDER BY m.name`,
          [days]
        ),
      ]);

      const complaintsResult = await pool.query(
        `SELECT COUNT(*)::int AS total_complaints
         FROM campaign_stats
         WHERE type = 'complaint' AND timestamp >= NOW() - $1::int * INTERVAL '1 day'`,
        [days]
      );

      const overall = overallResult.rows[0];
      const totalSent = overall?.total_sent ?? 0;
      const totalDelivered = overall?.total_delivered ?? 0;
      const totalBounced = overall?.total_bounced ?? 0;
      const totalComplaints = complaintsResult.rows[0]?.total_complaints ?? 0;

      const deliveryRate = totalSent > 0 ? Math.round((totalDelivered / totalSent) * 10000) / 100 : 0;
      const bounceRate = totalSent > 0 ? Math.round((totalBounced / totalSent) * 10000) / 100 : 0;
      const complaintRate = totalSent > 0 ? Math.round((totalComplaints / totalSent) * 10000) / 100 : 0;
      const inboxPlacementEstimate = Math.max(0, Math.round((deliveryRate - complaintRate * 5) * 100) / 100);

      const byMta = mtaResult.rows.map((row: any) => {
        const mtaSent = row.total_sent ?? 0;
        const mtaDelivered = row.total_delivered ?? 0;
        const mtaBounced = row.total_bounced ?? 0;
        return {
          mtaId: row.mta_id,
          mtaName: row.mta_name,
          totalSent: mtaSent,
          deliveryRate: mtaSent > 0 ? Math.round((mtaDelivered / mtaSent) * 10000) / 100 : 0,
          bounceRate: mtaSent > 0 ? Math.round((mtaBounced / mtaSent) * 10000) / 100 : 0,
        };
      });

      return {
        deliveryRate,
        bounceRate,
        complaintRate,
        inboxPlacementEstimate,
        totalSent,
        totalDelivered,
        totalBounced: totalBounced,
        totalComplaints,
        byMta,
      };
      }, refresh);
      res.json(data);
    } catch (error) {
      logger.error("Error fetching deliverability metrics:", error);
      res.status(500).json({ error: "Failed to fetch deliverability metrics" });
    }
  });

  app.get("/api/analytics/top-campaigns", async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 10, 1), 100);
      const sortBy = req.query.sortBy as string || "openRate";
      // Window the scan: by default we only consider campaigns that sent
      // anything in the last 90 days, which slashes both CTE inputs and
      // matches what users actually look at on this page.
      const days = Math.min(Math.max(parseInt(req.query.days as string) || 90, 1), 3650);
      const refresh = parseRefreshFlag(req.query);

      const allowedSortBy = ["openRate", "clickRate", "sent"];
      if (!allowedSortBy.includes(sortBy)) {
        return res.status(400).json({ error: "Invalid sortBy. Must be one of: openRate, clickRate, sent" });
      }

      let orderClause: string;
      switch (sortBy) {
        case "clickRate":
          orderClause = "click_rate DESC NULLS LAST";
          break;
        case "sent":
          orderClause = "total_sent DESC";
          break;
        case "openRate":
        default:
          orderClause = "open_rate DESC NULLS LAST";
          break;
      }

      const rows = await getAnalyticsCached(`top-campaigns:${sortBy}:${limit}:${days}`, async () => {
        // Pre-aggregate per campaign in CTEs BEFORE joining. The original
        // query did three LEFT JOINs followed by COUNT(DISTINCT ...) which
        // is a cardinality bomb on a 14M-row sends table × 5.5M-row stats
        // table. The CTE form scans each table once and emits one row per
        // campaign, then joins those tiny aggregates back onto campaigns.
        // The time window cuts each scan to roughly the last `days` worth
        // of rows, slashing buffer reads on multi-million-row tables.
        const result = await pool.query(
          `WITH sends AS (
            SELECT campaign_id, COUNT(*)::int AS total_sent
            FROM campaign_sends
            WHERE sent_at >= NOW() - $2::int * INTERVAL '1 day'
            GROUP BY campaign_id
          ),
          opens AS (
            SELECT campaign_id,
              COUNT(*)::int AS total_opens,
              COUNT(DISTINCT subscriber_id)::int AS unique_opens
            FROM campaign_stats
            WHERE type = 'open'
              AND timestamp >= NOW() - $2::int * INTERVAL '1 day'
            GROUP BY campaign_id
          ),
          clicks AS (
            SELECT campaign_id,
              COUNT(*)::int AS total_clicks,
              COUNT(DISTINCT subscriber_id)::int AS unique_clicks
            FROM campaign_stats
            WHERE type = 'click'
              AND timestamp >= NOW() - $2::int * INTERVAL '1 day'
            GROUP BY campaign_id
          )
          SELECT
            c.id, c.name, c.subject, c.status, c.created_at, c.sent_count,
            s.total_sent,
            COALESCE(o.total_opens, 0) AS total_opens,
            COALESCE(cl.total_clicks, 0) AS total_clicks,
            CASE WHEN s.total_sent > 0
              THEN ROUND((COALESCE(o.total_opens, 0)::numeric / s.total_sent) * 100, 2)
              ELSE 0 END AS open_rate,
            CASE WHEN s.total_sent > 0
              THEN ROUND((COALESCE(cl.total_clicks, 0)::numeric / s.total_sent) * 100, 2)
              ELSE 0 END AS click_rate
          FROM campaigns c
          JOIN sends s ON s.campaign_id = c.id
          LEFT JOIN opens o ON o.campaign_id = c.id
          LEFT JOIN clicks cl ON cl.campaign_id = c.id
          WHERE s.total_sent > 0
          ORDER BY ${orderClause}
          LIMIT $1`,
          [limit, days]
        );
        return result.rows.map((row: any) => ({
          id: row.id,
          name: row.name,
          subject: row.subject,
          status: row.status,
          createdAt: row.created_at,
          sentCount: row.sent_count,
          totalSent: Number(row.total_sent),
          totalOpens: Number(row.total_opens),
          totalClicks: Number(row.total_clicks),
          openRate: parseFloat(row.open_rate),
          clickRate: parseFloat(row.click_rate),
        }));
      }, refresh);

      res.json(rows);
    } catch (error) {
      logger.error("Error fetching top campaigns:", error);
      res.status(500).json({ error: "Failed to fetch top campaigns" });
    }
  });

  app.get("/api/analytics/subscriber-growth", async (req: Request, res: Response) => {
    try {
      const days = Math.min(Math.max(parseInt(req.query.days as string) || 30, 1), 365);
      const refresh = parseRefreshFlag(req.query);

      const data = await getAnalyticsCached(`subscriber-growth:${days}`, async () => {
      const result = await pool.query(
        `WITH date_series AS (
          SELECT generate_series(
            (CURRENT_DATE - $1::int * INTERVAL '1 day')::date,
            CURRENT_DATE,
            '1 day'::interval
          )::date AS date
        ),
        daily_new AS (
          SELECT import_date::date AS date, COUNT(*)::int AS new_subscribers
          FROM subscribers
          WHERE import_date >= NOW() - $1::int * INTERVAL '1 day'
          GROUP BY import_date::date
        ),
        daily_churn AS (
          SELECT date::date AS date, SUM(subscriber_churn)::int AS removed_subscribers
          FROM analytics_daily
          WHERE date >= NOW() - $1::int * INTERVAL '1 day'
          GROUP BY date::date
        ),
        total_before AS (
          SELECT COUNT(*)::int AS cnt
          FROM subscribers
          WHERE import_date < (CURRENT_DATE - $1::int * INTERVAL '1 day')
        )
        SELECT
          ds.date,
          COALESCE(dn.new_subscribers, 0) AS "newSubscribers",
          COALESCE(dc.removed_subscribers, 0) AS "removedSubscribers",
          COALESCE(dn.new_subscribers, 0) - COALESCE(dc.removed_subscribers, 0) AS "netGrowth",
          (SELECT cnt FROM total_before) +
            SUM(COALESCE(dn.new_subscribers, 0) - COALESCE(dc.removed_subscribers, 0))
            OVER (ORDER BY ds.date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
          AS "totalAtDate"
        FROM date_series ds
        LEFT JOIN daily_new dn ON ds.date = dn.date
        LEFT JOIN daily_churn dc ON ds.date = dc.date
        ORDER BY ds.date ASC`,
        [days]
      );

      return result.rows.map((row: any) => ({
        date: row.date,
        newSubscribers: parseInt(row.newSubscribers) || 0,
        removedSubscribers: parseInt(row.removedSubscribers) || 0,
        netGrowth: parseInt(row.netGrowth) || 0,
        totalAtDate: parseInt(row.totalAtDate) || 0,
      }));
      }, refresh);
      res.json(data);
    } catch (error) {
      logger.error("Error fetching subscriber growth:", error);
      res.status(500).json({ error: "Failed to fetch subscriber growth" });
    }
  });

  // Force-clear the analytics cache across all processes (web + worker).
  // Called by the "Refresh" button so the next chart render recomputes
  // from scratch instead of waiting for the 5-min TTL to expire.
  app.post("/api/analytics/cache/invalidate", async (req: Request, res: Response) => {
    try {
      const prefix = typeof req.query.prefix === "string" ? req.query.prefix : undefined;
      publishAnalyticsInvalidation(prefix);
      res.json({ success: true, prefix: prefix ?? null });
    } catch (error) {
      logger.error("Error invalidating analytics cache:", error);
      res.status(500).json({ error: "Failed to invalidate analytics cache" });
    }
  });

  app.post("/api/analytics/rollup", async (req: Request, res: Response) => {
    try {
      const days = Math.min(Math.max(parseInt(req.query.days as string) || 7, 1), 3650);
      await runAnalyticsRollup(days);
      res.json({ success: true, message: `Rollup completed for the last ${days} days` });
    } catch (error) {
      logger.error("Error running analytics rollup:", error);
      res.status(500).json({ error: "Failed to run analytics rollup" });
    }
  });

}
