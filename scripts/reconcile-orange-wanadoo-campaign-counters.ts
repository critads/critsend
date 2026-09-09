#!/usr/bin/env tsx
/**
 * Reconcile one campaign's cached Orange/Wanadoo complaint badge counters.
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
 */

import { pool } from "../server/db";

const CONFIRMATION = "orange-wanadoo-counter-reconcile";

function readArg(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

async function main(): Promise<void> {
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
  }>(
    `SELECT c.name,
            c.orange_wanadoo_sent_count AS stored_sent,
            c.orange_wanadoo_complaints_count AS stored_complaints,
            COUNT(DISTINCT cs.subscriber_id)::int AS true_sent,
            COUNT(DISTINCT st.subscriber_id)::int AS true_complaints
       FROM campaigns c
       LEFT JOIN campaign_sends cs
         ON cs.campaign_id = c.id
        AND cs.status = 'sent'
       LEFT JOIN subscribers s
         ON s.id = cs.subscriber_id
        AND lower(split_part(s.email, '@', 2)) IN ('orange.fr', 'wanadoo.fr')
       LEFT JOIN campaign_stats st
         ON st.campaign_id = cs.campaign_id
        AND st.subscriber_id = cs.subscriber_id
        AND st.ip_address = '195.154.17.225'
        AND st.type IN ('open', 'complaint')
      WHERE c.id = $1
        AND (cs.subscriber_id IS NULL OR s.id IS NOT NULL)
      GROUP BY c.id, c.name, c.orange_wanadoo_sent_count,
               c.orange_wanadoo_complaints_count`,
    [campaignId],
  );

  const row = truth.rows[0];
  if (!row) throw new Error(`Campaign not found: ${campaignId}`);

  const storedSent = Number(row.stored_sent) || 0;
  const storedComplaints = Number(row.stored_complaints) || 0;
  const trueSent = Number(row.true_sent) || 0;
  const trueComplaints = Number(row.true_complaints) || 0;
  const rate = trueSent > 0 ? (100 * trueComplaints) / trueSent : null;

  console.log(JSON.stringify({
    campaignId,
    name: row.name,
    stored: { sent: storedSent, complaints: storedComplaints },
    truth: { sent: trueSent, complaints: trueComplaints, ratePercent: rate },
    changed: storedSent !== trueSent || storedComplaints !== trueComplaints,
    mode: apply ? "apply" : "dry-run",
  }, null, 2));

  if (!apply) return;

  const updated = await pool.query(
    `UPDATE campaigns
        SET orange_wanadoo_sent_count = $2,
            orange_wanadoo_complaints_count = $3
      WHERE id = $1
        AND (
          orange_wanadoo_sent_count IS DISTINCT FROM $2
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