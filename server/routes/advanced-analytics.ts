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
        // The all-time totals are inherently expensive on tables this size
        // (campaign_sends ≈ 14M, campaign_stats ≈ 5.5M). The 5-min cache
        // amortizes that cost across requests; the rollup is not used here
        // because totals span all history, not the rollup's window.
        const [subscriberResult, campaignResult, sendsResult, statsResult] = await Promise.all([
          pool.query(`SELECT COUNT(*)::int AS total_subscribers FROM subscribers`),
          pool.query(`SELECT COUNT(*)::int AS total_campaigns FROM campaigns`),
          pool.query(`
            SELECT
              COUNT(*)::int AS total_sent,
              COUNT(*) FILTER (WHERE status = 'bounced')::int AS total_bounces
            FROM campaign_sends
          `),
          pool.query(`
            SELECT
              COUNT(*) FILTER (WHERE type = 'open')::int AS total_opens,
              COUNT(*) FILTER (WHERE type = 'click')::int AS total_clicks,
              COUNT(*) FILTER (WHERE type = 'unsubscribe')::int AS total_unsubscribes
            FROM campaign_stats
          `),
        ]);

        const totalSubscribers = subscriberResult.rows[0]?.total_subscribers ?? 0;
        const totalCampaigns = campaignResult.rows[0]?.total_campaigns ?? 0;
        const totalSent = sendsResult.rows[0]?.total_sent ?? 0;
        const totalBounces = sendsResult.rows[0]?.total_bounces ?? 0;
        const totalOpens = statsResult.rows[0]?.total_opens ?? 0;
        const totalClicks = statsResult.rows[0]?.total_clicks ?? 0;
        const totalUnsubscribes = statsResult.rows[0]?.total_unsubscribes ?? 0;

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
        // Cohort rewrite: the original query joined the full 5.5M-row
        // campaign_stats table to subscribers TWICE (once for unsubscribes,
        // once for opens/clicks) and counted DISTINCT subscriber_id per
        // cohort — that scans every event row before grouping. Here we
        // first collapse campaign_stats to one row per subscriber per
        // event class (unsub_subs, engaged_subs), turning the join input
        // from millions of events into at most ~1.2M unique subscriber
        // IDs. The final join to `subs` rides the new
        // subscribers(import_date) index for the cohort bucketing.
        const result = await pool.query(
          `WITH subs AS (
            SELECT id, date_trunc($1, import_date)::date AS cohort
            FROM subscribers
          ),
          cohort_totals AS (
            SELECT cohort, COUNT(*)::int AS total_subscribers
            FROM subs
            GROUP BY cohort
          ),
          unsub_subs AS (
            SELECT DISTINCT subscriber_id
            FROM campaign_stats
            WHERE type = 'unsubscribe'
          ),
          engaged_subs AS (
            SELECT DISTINCT subscriber_id
            FROM campaign_stats
            WHERE type IN ('open', 'click')
          ),
          unsub_by_cohort AS (
            SELECT s.cohort, COUNT(*)::int AS unsub_count
            FROM subs s
            JOIN unsub_subs u ON u.subscriber_id = s.id
            GROUP BY s.cohort
          ),
          engaged_by_cohort AS (
            SELECT s.cohort, COUNT(*)::int AS engaged_count
            FROM subs s
            JOIN engaged_subs e ON e.subscriber_id = s.id
            GROUP BY s.cohort
          )
          SELECT
            ct.cohort,
            ct.total_subscribers,
            ct.total_subscribers - COALESCE(u.unsub_count, 0) AS active_subscribers,
            CASE WHEN ct.total_subscribers > 0
              THEN ROUND(((ct.total_subscribers - COALESCE(u.unsub_count, 0))::numeric / ct.total_subscribers) * 100, 2)
              ELSE 0
            END AS active_rate,
            CASE WHEN ct.total_subscribers > 0
              THEN ROUND((COALESCE(e.engaged_count, 0)::numeric / ct.total_subscribers) * 100, 2)
              ELSE 0
            END AS engagement_rate
          FROM cohort_totals ct
          LEFT JOIN unsub_by_cohort u USING (cohort)
          LEFT JOIN engaged_by_cohort e USING (cohort)
          ORDER BY ct.cohort DESC`,
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

      const rows = await getAnalyticsCached(`top-campaigns:${sortBy}:${limit}`, async () => {
        // Pre-aggregate per campaign in CTEs BEFORE joining. The original
        // query did three LEFT JOINs followed by COUNT(DISTINCT ...) which
        // is a cardinality bomb on a 14M-row sends table × 5.5M-row stats
        // table. The CTE form scans each table once and emits one row per
        // campaign, then joins those tiny aggregates back onto campaigns.
        const result = await pool.query(
          `WITH sends AS (
            SELECT campaign_id, COUNT(*)::int AS total_sent
            FROM campaign_sends
            GROUP BY campaign_id
          ),
          opens AS (
            SELECT campaign_id,
              COUNT(*)::int AS total_opens,
              COUNT(DISTINCT subscriber_id)::int AS unique_opens
            FROM campaign_stats
            WHERE type = 'open'
            GROUP BY campaign_id
          ),
          clicks AS (
            SELECT campaign_id,
              COUNT(*)::int AS total_clicks,
              COUNT(DISTINCT subscriber_id)::int AS unique_clicks
            FROM campaign_stats
            WHERE type = 'click'
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
          [limit]
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
