/**
 * One-off remediation for the three 2026-09-08 campaigns whose ordinary
 * pending outer-batch reservations were incorrectly aged into failed rows
 * during sender restarts.
 *
 * Run only AFTER deploying the sender restart + pause/replay guards:
 *   tsx scripts/requeue-sept8-false-failed.ts
 *   tsx scripts/requeue-sept8-false-failed.ts --yes --confirm=retry-sept8-failed
 *
 * The execute path:
 *   1. pauses all target campaigns so no new sender starts;
 *   2. waits for any processing jobs to stop;
 *   3. resets failed rows to explicit retry carry-overs in bounded batches;
 *   4. reconciles counters, resumes each campaign, ensures one pending job,
 *      and writes a durable completion marker.
 *
 * It is idempotent. Re-running completes a partially applied remediation.
 */
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { FALSE_FAILED_RECOVERY_PAUSE_REASON } from "../shared/campaign-remediation";

const CAMPAIGN_IDS = [
  "3a7a0863-913a-4182-a5eb-ee61f2bc05fd",
  "e46a1b10-e57c-47d6-b3ca-5d0f32a86cbf",
  "0e0ea235-9ffd-4403-8127-b2ab4f04a3f5",
] as const;

const EXECUTE = process.argv.includes("--yes");
const CONFIRMED = process.argv.includes("--confirm=retry-sept8-failed");
const BATCH_SIZE = 5_000;
const QUIESCE_TIMEOUT_MS = 15 * 60_000;
const QUIESCE_POLL_MS = 2_000;
const COMPLETION_MARKER = "remediation:sept8-false-failed:v1:completed";
const CAMPAIGN_ID_LIST = sql.join(
  CAMPAIGN_IDS.map((id) => sql`${id}`),
  sql`, `,
);
let hasSmtpOutcomeClass = false;

type Snapshot = {
  id: string;
  name: string;
  status: string;
  failed: number;
  pending: number;
  attempting: number;
  active_jobs: number;
  pause_reason: string | null;
  remediation_done: boolean;
};

async function getSnapshots(): Promise<Snapshot[]> {
  const result = await db.execute(sql`
    SELECT
      c.id,
      c.name,
      c.status,
      c.pause_reason,
      COUNT(cs.id) FILTER (WHERE cs.status = 'failed')::int AS failed,
      COUNT(cs.id) FILTER (WHERE cs.status = 'pending')::int AS pending,
      COUNT(cs.id) FILTER (WHERE cs.status = 'attempting')::int AS attempting,
      (
        SELECT COUNT(*)::int
        FROM campaign_jobs cj
        WHERE cj.campaign_id = c.id AND cj.status = 'processing'
      ) AS active_jobs,
      EXISTS (
        SELECT 1
        FROM campaign_jobs marker
        WHERE marker.campaign_id = c.id
          AND marker.status = 'completed'
          AND marker.error_message = ${COMPLETION_MARKER}
      ) AS remediation_done
    FROM campaigns c
    LEFT JOIN campaign_sends cs ON cs.campaign_id = c.id
    WHERE c.id IN (${CAMPAIGN_ID_LIST})
    GROUP BY c.id, c.name, c.status
    ORDER BY c.id
  `);
  return result.rows.map((row: any) => ({
    id: String(row.id),
    name: String(row.name),
    status: String(row.status),
    failed: Number(row.failed ?? 0),
    pending: Number(row.pending ?? 0),
    attempting: Number(row.attempting ?? 0),
    active_jobs: Number(row.active_jobs ?? 0),
    pause_reason: row.pause_reason == null ? null : String(row.pause_reason),
    remediation_done: Boolean(row.remediation_done),
  }));
}

async function detectSmtpOutcomeClass() {
  const result = await db.execute(sql`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'campaign_sends'
        AND column_name = 'smtp_outcome_class'
    ) AS present
  `);
  hasSmtpOutcomeClass = Boolean((result.rows[0] as any)?.present);
}

function printSnapshots(label: string, snapshots: Snapshot[]) {
  console.log(`\n=== ${label} ===`);
  for (const row of snapshots) {
    console.log(
      `${row.id} "${row.name}" status=${row.status}`
      + ` failed=${row.failed} pending=${row.pending}`
      + ` attempting=${row.attempting} processing_jobs=${row.active_jobs}`
      + ` remediation_done=${row.remediation_done}`,
    );
  }
  const missing = CAMPAIGN_IDS.filter((id) => !snapshots.some((row) => row.id === id));
  for (const id of missing) console.log(`${id} [MISSING]`);
}

async function pauseTarget(campaignId: string) {
  const result = await db.execute(sql`
    UPDATE campaigns c
    SET status = 'paused',
        pause_reason = ${FALSE_FAILED_RECOVERY_PAUSE_REASON}
    WHERE c.id = ${campaignId}
      AND NOT EXISTS (
        SELECT 1
        FROM campaign_jobs marker
        WHERE marker.campaign_id = c.id
          AND marker.status = 'completed'
          AND marker.error_message = ${COMPLETION_MARKER}
      )
    RETURNING c.id
  `);
  if (result.rows.length !== 1) {
    throw new Error(`${campaignId}: could not establish remediation pause`);
  }
}

async function waitForSendersToStop(campaignIds: readonly string[]) {
  const campaignIdList = sql.join(
    campaignIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const deadline = Date.now() + QUIESCE_TIMEOUT_MS;
  for (;;) {
    const result = await db.execute(sql`
      SELECT COUNT(*)::int AS active
      FROM campaign_jobs
      WHERE campaign_id IN (${campaignIdList}) AND status = 'processing'
    `);
    const active = Number((result.rows[0] as any)?.active ?? 0);
    if (active === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `${active} processing job(s) did not stop within 15 minutes;`
        + " campaigns were left paused. Resolve the stuck jobs, then rerun this script.",
      );
    }
    process.stdout.write(`\rWaiting for ${active} processing job(s) to stop...`);
    await new Promise((resolve) => setTimeout(resolve, QUIESCE_POLL_MS));
  }
}

async function resetFailedRows(campaignId: string): Promise<number> {
  let reset = 0;
  for (;;) {
    const result = await db.execute(sql`
      WITH batch AS (
        SELECT id
        FROM campaign_sends
        WHERE campaign_id = ${campaignId}
          AND status = 'failed'
          ${hasSmtpOutcomeClass
            ? sql`AND smtp_outcome_class IS DISTINCT FROM 'ambiguous'`
            : sql``}
        LIMIT ${BATCH_SIZE}
        FOR UPDATE
      )
      UPDATE campaign_sends cs
      SET status = 'pending',
          retry_count = cs.retry_count + 1,
          last_retry_at = NOW(),
          sent_at = NOW()
      FROM batch
      WHERE cs.id = batch.id
        AND cs.status = 'failed'
        ${hasSmtpOutcomeClass
          ? sql`AND cs.smtp_outcome_class IS DISTINCT FROM 'ambiguous'`
          : sql``}
      RETURNING cs.id
    `);
    const count = result.rows.length;
    reset += count;
    if (count > 0) process.stdout.write(`\r${campaignId}: reset ${reset} failed row(s)`);
    if (count === 0) break;
  }
  if (reset > 0) process.stdout.write("\n");
  return reset;
}

async function resumeTarget(campaignId: string) {
  await db.transaction(async (tx) => {
    const campaignResult = await tx.execute(sql`
      SELECT status, pause_reason,
             first_send_at <= NOW() - INTERVAL '71 hours' AS near_deadline
      FROM campaigns
      WHERE id = ${campaignId}
      FOR UPDATE
    `);
    const campaign = campaignResult.rows[0] as any;
    if (!campaign) throw new Error(`${campaignId}: campaign disappeared`);
    if (
      campaign.status !== "paused"
      || campaign.pause_reason !== FALSE_FAILED_RECOVERY_PAUSE_REASON
    ) {
      throw new Error(`${campaignId}: remediation pause was lost`);
    }
    if (campaign.near_deadline) {
      throw new Error(`${campaignId}: campaign is inside its absolute 72-hour deadline window`);
    }

    const activeResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS active
      FROM campaign_jobs
      WHERE campaign_id = ${campaignId} AND status = 'processing'
    `);
    if (Number((activeResult.rows[0] as any)?.active ?? 0) !== 0) {
      throw new Error(`${campaignId}: a sender became active during remediation`);
    }

    const state = hasSmtpOutcomeClass
      ? await tx.execute(sql`
          SELECT
            COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
            COUNT(*) FILTER (
              WHERE status = 'pending' AND eligible_at IS NULL
            )::int AS immediate_pending,
            COUNT(*) FILTER (
              WHERE status = 'pending' AND eligible_at IS NOT NULL
            )::int AS deferred,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
            COUNT(*) FILTER (
              WHERE status = 'failed'
                AND smtp_outcome_class IS DISTINCT FROM 'ambiguous'
            )::int AS retryable_failed,
            COUNT(*) FILTER (WHERE status = 'attempting')::int AS attempting
          FROM campaign_sends
          WHERE campaign_id = ${campaignId}
        `)
      : await tx.execute(sql`
          SELECT
            COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
            COUNT(*) FILTER (
              WHERE status = 'pending' AND eligible_at IS NULL
            )::int AS immediate_pending,
            COUNT(*) FILTER (
              WHERE status = 'pending' AND eligible_at IS NOT NULL
            )::int AS deferred,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS retryable_failed,
            COUNT(*) FILTER (WHERE status = 'attempting')::int AS attempting
          FROM campaign_sends
          WHERE campaign_id = ${campaignId}
        `);
    const pending = Number((state.rows[0] as any)?.pending ?? 0);
    const deferred = Number((state.rows[0] as any)?.deferred ?? 0);
    const failed = Number((state.rows[0] as any)?.failed ?? 0);
    const retryableFailed = Number((state.rows[0] as any)?.retryable_failed ?? 0);
    const attempting = Number((state.rows[0] as any)?.attempting ?? 0);
    if (attempting !== 0 || retryableFailed !== 0) {
      throw new Error(
        `${campaignId}: not quiescent after reset`
        + ` (attempting=${attempting}, retryable_failed=${retryableFailed})`,
      );
    }
    if (pending === 0) {
      throw new Error(`${campaignId}: no pending rows remain after reset`);
    }

    await tx.execute(sql`
      UPDATE campaigns
      SET status = 'sending',
          failed_count = ${failed},
          pending_count = ${pending},
          deferred_count = ${deferred},
          pause_reason = NULL,
          retry_until = NULL,
          auto_retry_count = 0,
          urgent_mode = false,
          urgent_flush_job_id = NULL
      WHERE id = ${campaignId}
    `);
    await tx.execute(sql`
      INSERT INTO campaign_jobs (id, campaign_id, status)
      SELECT gen_random_uuid(), ${campaignId}, 'pending'
      WHERE NOT EXISTS (
        SELECT 1 FROM campaign_jobs
        WHERE campaign_id = ${campaignId}
          AND status IN ('pending', 'processing')
      )
      ON CONFLICT DO NOTHING
    `);
    await tx.execute(sql`
      INSERT INTO campaign_jobs (
        id, campaign_id, status, created_at, completed_at, error_message
      )
      VALUES (
        gen_random_uuid(), ${campaignId}, 'completed', NOW(), NOW(),
        ${COMPLETION_MARKER}
      )
    `);
    await tx.execute(sql`SELECT pg_notify('campaign_jobs', ${campaignId})`);
  });
}

async function main() {
  await detectSmtpOutcomeClass();
  const before = await getSnapshots();
  printSnapshots(EXECUTE ? "PRE-REMEDIATION" : "DRY RUN", before);

  if (!EXECUTE) {
    const total = before.reduce((sum, row) => sum + row.failed, 0);
    console.log(`\nDry run only: ${total} failed row(s) would be considered.`);
    console.log("Nothing changed.");
    return;
  }
  if (!CONFIRMED) {
    throw new Error(
      "Execution requires both --yes and --confirm=retry-sept8-failed",
    );
  }
  if (before.length !== CAMPAIGN_IDS.length) {
    throw new Error("One or more target campaigns are missing; nothing changed.");
  }

  const candidates = before.filter(
    (row) => !row.remediation_done
      && (
        row.failed > 0
        || row.pause_reason === FALSE_FAILED_RECOVERY_PAUSE_REASON
      ),
  );
  if (candidates.length === 0) {
    console.log("\nAll target campaigns are already remediated; nothing changed.");
    return;
  }

  for (const row of candidates) await pauseTarget(row.id);
  await waitForSendersToStop(candidates.map((row) => row.id));
  process.stdout.write("\n");

  for (const row of candidates) {
    await resetFailedRows(row.id);
    await resumeTarget(row.id);
  }

  printSnapshots("POST-REMEDIATION", await getSnapshots());
}

main()
  .then(async () => {
    await db.$client.end();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("\nrequeue-sept8-false-failed failed:", error);
    await db.$client.end();
    process.exit(1);
  });