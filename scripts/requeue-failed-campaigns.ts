/**
 * One-off remediation: requeue the `failed` campaign_sends of a fixed set of
 * campaigns that were marked `completed` with un-retried failures (the
 * pressure-guard drain abandoned drain-produced failures at retry_count=0 —
 * fixed in server/workers/pressure-guard-worker.ts).
 *
 * Per campaign it performs the SAME atomic transaction as the manual
 * POST /api/campaigns/:id/retry-failed route:
 *   1. failed -> pending (retry_count + 1, last_retry_at = NOW, sent_at = NOW)
 *   2. campaigns: status='sending', failed_count=0, pause_reason=NULL,
 *      retry_until=NULL, auto_retry_count=0 (fresh 3-attempt auto-retry budget),
 *      urgent_mode=false, urgent_flush_job_id=NULL
 *   3. enqueue one campaign_job (deduped against pending/processing)
 *
 * Eligibility is derived from actual DB rows (status='failed'), guarding
 * against the campaigns.failed_count counter drift observed in production
 * (e.g. campaign f35a36c3 had failed_count=1093 but 44982 failed rows).
 *
 * IMPORTANT: run this only AFTER deploying the drain fix, so the residual
 * failures left after this first pass are auto-retried (up to 3x) instead of
 * being re-abandoned by the still-buggy drain.
 *
 * Usage:
 *   tsx scripts/requeue-failed-campaigns.ts          # dry-run (counts only)
 *   tsx scripts/requeue-failed-campaigns.ts --yes     # execute
 */
import { sql } from "drizzle-orm";
import { db } from "../server/db";

const CAMPAIGN_IDS = [
  "2f3c195e-c90f-4fc3-9112-deb9a912fbef", // #3073 Mauboussin
  "4b5f6b0c-b139-4cbe-a6c3-6009d0f88ef2", // #3029 Club Med
  "dbfa5d05-f5f5-4f99-ad4b-12f2febbdd4d", // #3082 Lafuma Mobilier
  "6cec3637-ce72-4479-a38a-d8eff581a4b0", // #3049 Belambra
  "f35a36c3-9fdc-4f92-9299-534dfee58a5f", // #3076 maty
  "0b1624b7-fb97-4ddd-84bb-5ce8c220f65a", // #3063 Transavia
  "9ec97daf-0b2a-410c-8a0c-52dc783a5b12", // #3029 Club Med
];

async function main() {
  const execute = process.argv.includes("--yes");
  console.log(
    execute
      ? "=== REQUEUE (EXECUTE) ==="
      : "=== REQUEUE (DRY-RUN — pass --yes to execute) ===",
  );

  let grandTotal = 0;
  for (const id of CAMPAIGN_IDS) {
    const countRes = await db.execute(sql`
      SELECT
        (SELECT name FROM campaigns WHERE id = ${id}) AS name,
        (SELECT status FROM campaigns WHERE id = ${id}) AS status,
        (SELECT COUNT(*)::int FROM campaign_sends WHERE campaign_id = ${id} AND status = 'failed') AS failed
    `);
    const row = countRes.rows[0] as { name?: string; status?: string; failed?: number } | undefined;
    if (!row || row.name == null) {
      console.log(`  [SKIP] ${id} — campaign not found`);
      continue;
    }
    const failed = Number(row.failed ?? 0);
    grandTotal += failed;

    if (!execute) {
      console.log(`  [DRY] ${id} "${row.name}" status=${row.status} failed=${failed}`);
      continue;
    }

    // Chunked failed -> pending reset. A single UPDATE over ~100k rows exceeds
    // the prod statement_timeout (57014), so we reset in bounded batches, each
    // its own autocommit statement. Idempotent and re-runnable: only rows still
    // 'failed' are touched, so a mid-run crash just resumes on re-run. The
    // `cs.status = 'failed'` recheck inside the UPDATE (not only in the CTE
    // snapshot) guards against double-touch (a second retry_count++) if another
    // requeue/route races us on the same rows.
    const BATCH = 5000;
    let reset = 0;
    for (;;) {
      const r = await db.execute(sql`
        WITH batch AS (
          SELECT id FROM campaign_sends
          WHERE campaign_id = ${id} AND status = 'failed'
          LIMIT ${BATCH}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE campaign_sends cs
        SET status = 'pending',
            retry_count = retry_count + 1,
            last_retry_at = NOW(),
            sent_at = NOW()
        FROM batch
        WHERE cs.id = batch.id AND cs.status = 'failed'
        RETURNING cs.id
      `);
      const n = r.rows.length;
      reset += n;
      if (n > 0) process.stdout.write(`\r  [..] ${id} reset ${reset}/${failed}`);
      if (n < BATCH) break;
    }
    if (reset > 0) process.stdout.write("\n");

    // Finalize UNCONDITIONALLY (not gated on reset>0 this run): a previous run
    // could have died after resetting all failed rows but before flipping the
    // campaign / enqueuing the job. Re-running must still complete that, so we
    // key off the durable post-condition — "are there pending rows to send?" —
    // rather than off how many rows this particular invocation reset.
    const pendRes = await db.execute(sql`
      SELECT COUNT(*)::int AS pending
      FROM campaign_sends WHERE campaign_id = ${id} AND status = 'pending'
    `);
    const pending = Number((pendRes.rows[0] as { pending?: number })?.pending ?? 0);

    if (pending === 0) {
      console.log(`  [SKIP] ${id} "${row.name}" — nothing pending to send`);
      continue;
    }

    // Flip campaign back to sending with a fresh auto-retry budget, then enqueue
    // a deduped job. Both are idempotent (set absolute values; job insert deduped
    // against pending/processing) so re-running after a kill is safe.
    await db.execute(sql`
      UPDATE campaigns
      SET status = 'sending',
          failed_count = 0,
          pause_reason = NULL,
          retry_until = NULL,
          auto_retry_count = 0,
          urgent_mode = false,
          urgent_flush_job_id = NULL
      WHERE id = ${id}
    `);
    await db.execute(sql`
      INSERT INTO campaign_jobs (id, campaign_id, status)
      SELECT gen_random_uuid(), ${id}, 'pending'
      WHERE NOT EXISTS (
        SELECT 1 FROM campaign_jobs
        WHERE campaign_id = ${id} AND status IN ('pending', 'processing')
      )
    `);

    console.log(`  [DONE] ${id} "${row.name}" — reset ${reset} this run; ${pending} pending; status=sending, job enqueued`);
  }

  console.log(`Total failed across ${CAMPAIGN_IDS.length} campaigns: ${grandTotal}`);
  if (!execute) console.log("Nothing changed. Re-run with --yes to apply.");
  process.exit(0);
}

main().catch((err) => {
  console.error("requeue-failed-campaigns failed:", err);
  process.exit(1);
});
