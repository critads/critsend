#!/usr/bin/env tsx
/**
 * Reconcile one campaign's cached Orange/Wanadoo complaint badge counters,
 * or advance the durable historical scan by one bounded batch.
 *
 * This deliberately runs outside the /campaigns request path: deriving the
 * counters requires scanning the campaign's send and tracking history.
 *
 * Dry-run:
 *   tsx scripts/reconcile-orange-wanadoo-campaign-counters.ts --campaign=<id>
 *
 * Apply:
 *   tsx scripts/reconcile-orange-wanadoo-campaign-counters.ts \
 *     --campaign=<id> --yes --confirm=orange-wanadoo-counter-reconcile
 *
 * Historical batch (always applies; bounded and transactionally resumable):
 *   tsx scripts/reconcile-orange-wanadoo-campaign-counters.ts --historical-batch=2000
 */

import { pool } from "../server/db";

const CONFIRMATION = "orange-wanadoo-counter-reconcile";

function readArg(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

async function main(): Promise<void> {
  const historicalBatchArg = readArg("historical-batch");
  if (historicalBatchArg !== null) {
    const batchSize = Number(historicalBatchArg);
    if (!Number.isInteger(batchSize) || batchSize < 100 || batchSize > 10_000) {
      throw new Error("--historical-batch must be an integer from 100 to 10000");
    }
    const { reconcileOrangeWanadooHistoricalBatch } = await import(
      "../server/workers/counter-reconciler"
    );
    const result = await reconcileOrangeWanadooHistoricalBatch(batchSize);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const campaignId = readArg("campaign")?.trim() ?? "";
  if (!campaignId || campaignId.length > 128) {
    throw new Error("Pass one bounded campaign id with --campaign=<id>");
  }

  const apply = process.argv.includes("--yes");
  if (apply && readArg("confirm") !== CONFIRMATION) {
    throw new Error(`Applying requires --yes --confirm=${CONFIRMATION}`);
  }

  const truth = await pool.query<{
    name: string;
    stored_sent: string | number;
    stored_complaints: string | number;
    true_sent: string | number;
    true_complaints: string | number;
    total_sent: string | number;
    surviving_total_sent: string | number;
  }>(
    `SELECT c.name,
            c.orange_wanadoo_sent_count AS stored_sent,
            c.orange_wanadoo_complaints_count AS stored_complaints,
             c.sent_count AS total_sent,
             (
               SELECT COUNT(*)::int
                 FROM campaign_sends cs
                WHERE cs.campaign_id = c.id
                  AND cs.status = 'sent'
             ) AS surviving_total_sent,
             (
               SELECT COUNT(DISTINCT cs.subscriber_id)::int
                 FROM campaign_sends cs
                 JOIN subscribers s ON s.id = cs.subscriber_id
                WHERE cs.campaign_id = c.id
                  AND cs.status = 'sent'
                  AND lower(split_part(s.email, '@', 2)) IN ('orange.fr', 'wanadoo.fr')
             ) AS true_sent,
             (
               SELECT COUNT(DISTINCT st.subscriber_id)::int
                 FROM campaign_stats st
                 JOIN subscribers s ON s.id = st.subscriber_id
                WHERE st.campaign_id = c.id
                  AND st.ip_address = '195.154.17.225'
                  AND st.type IN ('open', 'complaint')
                  AND lower(split_part(s.email, '@', 2)) IN ('orange.fr', 'wanadoo.fr')
             ) AS true_complaints
        FROM campaigns c
       WHERE c.id = $1`,
    [campaignId],
  );

  const row = truth.rows[0];
  if (!row) throw new Error(`Campaign not found: ${campaignId}`);

  const storedSent = Number(row.stored_sent) || 0;
  const storedComplaints = Number(row.stored_complaints) || 0;
  const trueSent = Number(row.true_sent) || 0;
  const trueComplaints = Number(row.true_complaints) || 0;
  const appliedSent = Math.max(storedSent, trueSent);
  const sendHistoryPossiblyPruned =
    Number(row.surviving_total_sent) < Number(row.total_sent);
  const rate = appliedSent > 0 ? (100 * trueComplaints) / appliedSent : null;

  console.log(JSON.stringify({
    campaignId,
    name: row.name,
    stored: { sent: storedSent, complaints: storedComplaints },
    reconstruction: {
      sentLowerBound: trueSent,
      complaints: trueComplaints,
      sendHistoryPossiblyPruned,
      ratePercent: rate,
    },
    applied: { sent: appliedSent, complaints: trueComplaints },
    changed: storedSent !== appliedSent || storedComplaints !== trueComplaints,
    mode: apply ? "apply" : "dry-run",
  }, null, 2));

  if (!apply) return;

  const updated = await pool.query(
    `UPDATE campaigns
        SET orange_wanadoo_sent_count = GREATEST(orange_wanadoo_sent_count, $2),
            orange_wanadoo_complaints_count = $3
      WHERE id = $1
        AND (
          orange_wanadoo_sent_count < $2
          OR orange_wanadoo_complaints_count IS DISTINCT FROM $3
        )
      RETURNING id`,
    [campaignId, trueSent, trueComplaints],
  );
  console.log(`Updated campaigns: ${updated.rowCount ?? 0}`);
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    await pool.end().catch(() => {});
    process.exit(1);
  });