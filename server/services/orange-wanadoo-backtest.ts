import { pool } from "../db";

export interface BacktestScenario {
  coolingDays: 7 | 15 | 30;
  sends: number;
  complaints: number;
  complaintsAvoided: number;
  clickedCampaignsRetained: number;
  campaignsUnderHardThresholdBefore: number;
  campaignsUnderHardThresholdAfter: number;
}

/**
 * Point-in-time simulation. Every eligibility decision only sees detections
 * strictly before that send, preventing future leakage.
 */
export async function runOrangeWanadooBacktest(asOf: Date, lookbackDays = 30): Promise<{
  asOf: string;
  lookbackDays: number;
  scenarios: BacktestScenario[];
}> {
  if (!Number.isFinite(asOf.getTime())) throw new Error("Invalid as-of timestamp");
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 365) {
    throw new Error("lookbackDays must be an integer from 1 to 365");
  }
  const scenarios: BacktestScenario[] = [];
  for (const coolingDays of [7, 15, 30] as const) {
    const result = await pool.query(
      `WITH target_sends AS (
         SELECT cs.campaign_id, cs.subscriber_id, cs.sent_at,
           EXISTS (
             SELECT 1 FROM campaign_stats prior
             WHERE prior.subscriber_id=cs.subscriber_id
               AND prior.ip_address='195.154.17.225'
               AND prior.type IN ('open','complaint')
               AND prior.timestamp < cs.sent_at
               AND prior.timestamp >= cs.sent_at - ($3::int || ' days')::interval
           ) AS blocked,
           EXISTS (
             SELECT 1 FROM campaign_stats cl
             WHERE cl.campaign_id=cs.campaign_id AND cl.subscriber_id=cs.subscriber_id
               AND cl.type='click' AND cl.timestamp >= cs.sent_at AND cl.timestamp <= $1
           ) AS clicked,
           EXISTS (
             SELECT 1 FROM campaign_stats co
             WHERE co.campaign_id=cs.campaign_id AND co.subscriber_id=cs.subscriber_id
               AND co.ip_address='195.154.17.225' AND co.type IN ('open','complaint')
               AND co.timestamp >= cs.sent_at AND co.timestamp <= $1
           ) AS complained
         FROM campaign_sends cs JOIN subscribers s ON s.id=cs.subscriber_id
         WHERE cs.status='sent' AND cs.sent_at <= $1
           AND cs.sent_at >= $1 - ($2::int || ' days')::interval
           AND lower(split_part(s.email,'@',2)) IN ('orange.fr','wanadoo.fr')
       ), by_campaign AS (
         SELECT campaign_id, COUNT(*) AS sent,
           COUNT(*) FILTER (WHERE complained) AS complaints,
           COUNT(*) FILTER (WHERE complained AND blocked) AS avoided,
           COUNT(*) FILTER (WHERE clicked AND NOT blocked) AS clicks_retained,
           COUNT(*) FILTER (WHERE NOT blocked) AS projected_sent,
           COUNT(*) FILTER (WHERE complained AND NOT blocked) AS projected_complaints
         FROM target_sends GROUP BY campaign_id
       )
       SELECT COALESCE(SUM(sent),0)::int AS sends,
         COALESCE(SUM(complaints),0)::int AS complaints,
         COALESCE(SUM(avoided),0)::int AS avoided,
         COALESCE(SUM(clicks_retained),0)::int AS clicks_retained,
         COUNT(*) FILTER (WHERE complaints::numeric/NULLIF(sent,0) <= .006)::int AS under_before,
         COUNT(*) FILTER (WHERE projected_sent=0 OR projected_complaints::numeric/projected_sent <= .006)::int AS under_after
       FROM by_campaign`,
      [asOf.toISOString(), lookbackDays, coolingDays],
    );
    const row = result.rows[0];
    scenarios.push({
      coolingDays,
      sends: Number(row.sends),
      complaints: Number(row.complaints),
      complaintsAvoided: Number(row.avoided),
      clickedCampaignsRetained: Number(row.clicks_retained),
      campaignsUnderHardThresholdBefore: Number(row.under_before),
      campaignsUnderHardThresholdAfter: Number(row.under_after),
    });
  }
  return { asOf: asOf.toISOString(), lookbackDays, scenarios };
}
