#!/usr/bin/env tsx
/**
 * Reconcile cached Orange/Wanadoo complaint badge counters — one campaign,
 * every finished campaign started since a date, or one bounded batch of the
 * durable historical scan.
 *
 * This deliberately runs outside the /campaigns request path: deriving the
 * counters requires scanning the campaign's send and tracking history.
 *
 * Dry-run (one campaign):
 *   tsx scripts/reconcile-orange-wanadoo-campaign-counters.ts --campaign=<id>
 *
 * Apply (one campaign):
 *   tsx scripts/reconcile-orange-wanadoo-campaign-counters.ts \
 *     --campaign=<id> --yes --confirm=orange-wanadoo-counter-reconcile
 *
 * Sweep every finished campaign (completed/sent/failed/cancelled) started on
 * or after a date, newest first — dry-run prints the drift, --yes applies it
 * one campaign per statement:
 *   tsx scripts/reconcile-orange-wanadoo-campaign-counters.ts --since=2026-05-01
 *   tsx scripts/reconcile-orange-wanadoo-campaign-counters.ts \
 *     --since=2026-05-01 --yes --confirm=orange-wanadoo-counter-reconcile
 *
 * Historical batch (always applies; bounded and transactionally resumable):
 *   tsx scripts/reconcile-orange-wanadoo-campaign-counters.ts --historical-batch=2000
 *
 * Writes only touch finished campaigns (completed/sent/failed/cancelled) whose
 * counters have not moved since they were read; a live campaign is owned by
 * the sender and the 15-minute reconciler and is reported as skipped.
 *
 * The sent counter is fill-only (GREATEST): campaign_sends is retention-purged,
 * so a reconstruction is a lower bound and must never lower a lifetime value.
 * The complaint counter is assigned from the same truth the 15-minute
 * reconciler uses (distinct Orange/Wanadoo subscribers detected from the
 * complaint scanner IP).
 */
import { pool } from "../server/db";

const CONFIRMATION = "orange-wanadoo-counter-reconcile";
const TERMINAL_STATUSES = ["completed", "sent", "failed", "cancelled"];

function readArg(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

interface TruthRow {
  name: string;
  stored_sent: string | number;
  stored_complaints: string | number;
  true_sent: string | number;
  true_complaints: string | number;
  total_sent: string | number;
  surviving_total_sent: string | number;
}

interface ReconcileOutcome {
  campaignId: string;
  name: string;
  stored: { sent: number; complaints: number };
  reconstruction: {
    sentLowerBound: number;
    complaints: number;
    sendHistoryPossiblyPruned: boolean;
    ratePercent: number | null;
  };
  applied: { sent: number; complaints: number };
  changed: boolean;
  mode: "apply" | "dry-run";
  updatedRows: number;
  /** apply requested but the stored counters moved since the truth read. */
  skippedConcurrent: boolean;
}

async function reconcileOne(campaignId: string, apply: boolean): Promise<ReconcileOutcome> {
  const truth = await pool.query<TruthRow>(
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
  const changed = storedSent !== appliedSent || storedComplaints !== trueComplaints;

  let updatedRows = 0;
  let skippedConcurrent = false;
  if (apply && changed) {
    // Compare-and-set on both stored counters plus terminal status (the same
    // guards the historical reconciler uses): the truth above was read a
    // moment ago, and a live sender / tracking flush may have moved the
    // counters since. Assigning a stale complaint count would erase that
    // increment, so a mismatch skips the campaign instead — re-run to pick
    // it up.
    // The status guard keeps the write off a campaign that resumed sending
    // after it was selected: while it sends, the live paths own the counters.
    const updated = await pool.query(
      `UPDATE campaigns
          SET orange_wanadoo_sent_count = GREATEST(orange_wanadoo_sent_count, $2),
              orange_wanadoo_complaints_count = $3
        WHERE id = $1
          AND status = ANY($6::text[])
          AND orange_wanadoo_sent_count IS NOT DISTINCT FROM $4
          AND orange_wanadoo_complaints_count IS NOT DISTINCT FROM $5
        RETURNING id`,
      [campaignId, trueSent, trueComplaints, row.stored_sent, row.stored_complaints, TERMINAL_STATUSES],
    );
    updatedRows = updated.rowCount ?? 0;
    skippedConcurrent = updatedRows === 0;
  }

  return {
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
    changed,
    mode: apply ? "apply" : "dry-run",
    updatedRows,
    skippedConcurrent,
  };
}

function formatPercent(rate: number | null): string {
  return rate === null ? "n/a" : `${rate.toFixed(2)}%`;
}

async function sweepSince(since: string, apply: boolean): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || Number.isNaN(Date.parse(since))) {
    throw new Error("--since must be a calendar date formatted YYYY-MM-DD");
  }
  const candidates = await pool.query<{ id: string }>(
    `SELECT id
       FROM campaigns
      WHERE status = ANY($1::text[])
        AND started_at >= $2::date
      ORDER BY started_at DESC, id`,
    [TERMINAL_STATUSES, since],
  );
  console.log(
    `${apply ? "Applying" : "Dry-run"}: ${candidates.rowCount ?? 0} finished campaign(s) started on or after ${since}`,
  );

  let examined = 0;
  let drifted = 0;
  let updated = 0;
  let skipped = 0;
  for (const { id } of candidates.rows) {
    const outcome = await reconcileOne(id, apply);
    examined += 1;
    if (!outcome.changed) continue;
    drifted += 1;
    updated += outcome.updatedRows;
    if (outcome.skippedConcurrent) skipped += 1;
    const storedRate =
      outcome.stored.sent > 0 ? (100 * outcome.stored.complaints) / outcome.stored.sent : null;
    const label = outcome.updatedRows > 0 ? "FIXED " : outcome.skippedConcurrent ? "SKIP  " : "DRIFT ";
    console.log(
      `${label}${id}  ${outcome.name}\n` +
        `       stored  sent=${outcome.stored.sent} complaints=${outcome.stored.complaints} (${formatPercent(storedRate)})\n` +
        `       truth   sent>=${outcome.reconstruction.sentLowerBound} complaints=${outcome.reconstruction.complaints}` +
        ` -> applied sent=${outcome.applied.sent} complaints=${outcome.applied.complaints} (${formatPercent(outcome.reconstruction.ratePercent)})` +
        `${outcome.reconstruction.sendHistoryPossiblyPruned ? "  [send history partly purged: sent is a lower bound]" : ""}`,
    );
  }
  console.log(
    `Done: examined=${examined} drifted=${drifted} ${apply ? `updated=${updated} skipped_concurrent=${skipped}` : "(dry-run, nothing written)"}`,
  );
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

  const apply = process.argv.includes("--yes");
  if (apply && readArg("confirm") !== CONFIRMATION) {
    throw new Error(`Applying requires --yes --confirm=${CONFIRMATION}`);
  }

  const since = readArg("since")?.trim();
  if (since) {
    await sweepSince(since, apply);
    return;
  }

  const campaignId = readArg("campaign")?.trim() ?? "";
  if (!campaignId || campaignId.length > 128) {
    throw new Error("Pass one bounded campaign id with --campaign=<id>, or a sweep with --since=YYYY-MM-DD");
  }

  const outcome = await reconcileOne(campaignId, apply);
  const { updatedRows, skippedConcurrent, ...report } = outcome;
  console.log(JSON.stringify(report, null, 2));
  if (apply) {
    console.log(`Updated campaigns: ${updatedRows}`);
    if (skippedConcurrent) console.log("Skipped: campaign is not finished or its stored counters changed since the truth read — re-run once it is finished.");
  }
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
