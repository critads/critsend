import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { ensureCampaignWarmStartSchema } from "../server/campaign-warm-start-bootstrap";
import {
  getCampaignWarmRecipientsCursor,
  getSubscribersForSegmentsCursor,
  markCampaignWarmAudienceExhausted,
  planCampaignWarmStart,
} from "../server/repositories/subscriber-repository";
import { completeCampaignIfDrained, copyCampaign } from "../server/repositories/campaign-repository";

// This test mutates and rolls back/cleans a small dataset. Run it only against
// a dedicated integration database; the shared large development database has
// legacy unindexed subscriber foreign keys that make fixture deletion unsafe.
const HAS_DB = process.env.RUN_WARM_START_DB_TESTS === "true"
  && !!(process.env.NEON_DATABASE_URL || process.env.DATABASE_URL);
const describeWithDb = HAS_DB ? describe : describe.skip;

describeWithDb("campaign warm start — PostgreSQL behavior", () => {
  const suffix = randomUUID();
  const segmentId = `warm-seg-${suffix}`;
  const sourceCampaignId = `warm-source-${suffix}`;
  const targetCampaignId = `warm-target-${suffix}`;
  const emailMarker = `warm-${suffix}`;
  const subscriberIds = Array.from({ length: 10 }, () => randomUUID());
  let copiedCampaignId: string | undefined;

  beforeAll(async () => {
    await ensureCampaignWarmStartSchema();
    await pool.query(
      `INSERT INTO segments (id, name, description, rules)
       VALUES ($1, $2, '', $3::jsonb)`,
      [
        segmentId,
        `Warm integration ${suffix}`,
        JSON.stringify([{ field: "email", operator: "contains", value: emailMarker }]),
      ],
    );
    await pool.query(
      `INSERT INTO campaigns
        (id, name, segment_id, from_name, from_email, subject, html_content, status, prioritize_active_clickers)
       VALUES
        ($1, 'Warm source', NULL, 'Sender', 'sender@example.test', 'Source', '<p>Source</p>', 'completed', false),
        ($2, 'Warm target', $3, 'Sender', 'sender@example.test', 'Target', '<p>Target</p>', 'draft', true)`,
      [sourceCampaignId, targetCampaignId, segmentId],
    );
    for (let i = 0; i < subscriberIds.length; i++) {
      await pool.query(
        `INSERT INTO subscribers (id, email, tags, refs)
         VALUES ($1, $2, ARRAY[]::text[], ARRAY[]::text[])`,
        [subscriberIds[i], `${emailMarker}-${i}@example.test`],
      );
    }
    for (const index of [0, 1, 2, 3]) {
      await pool.query(
        `INSERT INTO campaign_stats (id, campaign_id, subscriber_id, type, timestamp)
         VALUES ($1, $2, $3, 'click', NOW() - INTERVAL '1 day')`,
        [randomUUID(), sourceCampaignId, subscriberIds[index]],
      );
    }
    await pool.query(
      `INSERT INTO campaign_stats (id, campaign_id, subscriber_id, type, timestamp)
       VALUES
        ($1, $2, $3, 'click', NOW() - INTERVAL '31 days'),
        ($4, $2, $5, 'click', NOW() + INTERVAL '1 day')`,
      [randomUUID(), sourceCampaignId, subscriberIds[4], randomUUID(), subscriberIds[5]],
    );
  }, 60_000);

  afterAll(async () => {
    const campaignIds = [sourceCampaignId, targetCampaignId, ...(copiedCampaignId ? [copiedCampaignId] : [])];
    await pool.query(`DELETE FROM campaign_jobs WHERE campaign_id = ANY($1::varchar[])`, [campaignIds]).catch(() => {});
    await pool.query(`DELETE FROM campaign_stats WHERE campaign_id = ANY($1::varchar[])`, [campaignIds]).catch(() => {});
    await pool.query(`DELETE FROM campaign_warm_recipients WHERE campaign_id = ANY($1::varchar[])`, [campaignIds]).catch(() => {});
    await pool.query(`DELETE FROM campaigns WHERE id = ANY($1::varchar[])`, [campaignIds]).catch(() => {});
    await pool.query(`DELETE FROM subscribers WHERE id = ANY($1::varchar[])`, [subscriberIds]).catch(() => {});
    await pool.query(`DELETE FROM segments WHERE id = $1`, [segmentId]).catch(() => {});
  }, 60_000);

  it("freezes exactly min(clickers, 30 percent, 50000) and excludes that head from normal enumeration", async () => {
    await pool.query(`UPDATE campaigns SET status='sending' WHERE id=$1`, [targetCampaignId]);
    const plan = await planCampaignWarmStart(targetCampaignId, [segmentId], undefined, 0);
    expect(plan.eligibleCount).toBe(10);
    expect(plan.cap).toBe(3);
    expect(plan.phase).toBe("warm");

    const warm = await getCampaignWarmRecipientsCursor(targetCampaignId, 100);
    expect(warm).toHaveLength(3);

    const replayTail = await getCampaignWarmRecipientsCursor(targetCampaignId, 100, warm[0].id);
    expect(replayTail.map((subscriber) => subscriber.id)).toEqual(
      warm.slice(1).map((subscriber) => subscriber.id),
    );

    const normal = await getSubscribersForSegmentsCursor(
      [segmentId],
      100,
      undefined,
      undefined,
      false,
      targetCampaignId,
    );
    expect(normal).toHaveLength(7);
    const warmIds = new Set(warm.map((subscriber) => subscriber.id));
    expect(normal.every((subscriber) => !warmIds.has(subscriber.id))).toBe(true);
  });

  it("fences exhaustion by generation and gates automatic completion", async () => {
    await pool.query(
      `UPDATE campaigns
       SET status='sending', warm_phase='normal', step_execution_version=3,
           warm_audience_exhausted_at=NULL, step_processed_count=0, step_cursor_id=NULL
       WHERE id=$1`,
      [targetCampaignId],
    );
    expect(await markCampaignWarmAudienceExhausted(targetCampaignId, 2, 0, null)).toBe(false);
    expect(await completeCampaignIfDrained(targetCampaignId, 3)).toBe(false);
    expect(await markCampaignWarmAudienceExhausted(targetCampaignId, 3, 0, null)).toBe(true);
    expect(await completeCampaignIfDrained(targetCampaignId, 3)).toBe(true);
  });

  it("copies the operator choice but resets warm, step, retry, and lifecycle state", async () => {
    await pool.query(
      `UPDATE campaigns SET
         status='paused',
         started_at=NOW(),
         first_send_at=NOW(),
         last_send_at=NOW(),
         sent_count=7,
         pending_count=3,
         failed_count=2,
         auto_retry_count=1,
         pause_reason='mta_down',
         retry_until=NOW() + INTERVAL '1 hour',
         step_send_limit=5,
         step_processed_count=4,
         step_cursor_id=$2,
         step_execution_version=7,
         warm_audience_exhausted_at=NOW(),
         urgent_mode=true,
         urgent_flush_job_id='old-flush'
       WHERE id=$1`,
      [targetCampaignId, subscriberIds[0]],
    );

    const copied = await copyCampaign(targetCampaignId);
    expect(copied).toBeDefined();
    copiedCampaignId = copied!.id;
    expect(copied!.status).toBe("draft");
    expect(copied!.prioritizeActiveClickers).toBe(true);
    expect(copied!.stepSendLimit).toBe(5);
    expect(copied!.stepProcessedCount).toBe(0);
    expect(copied!.stepCursorId).toBeNull();
    expect(copied!.stepExecutionVersion).toBe(0);
    expect(copied!.startedAt).toBeNull();
    expect(copied!.pauseReason).toBeNull();
    expect(copied!.retryUntil).toBeNull();
    expect(copied!.warmPhase).toBeNull();
    expect(copied!.warmCursorId).toBeNull();
    expect(copied!.warmAudienceExhaustedAt).toBeNull();
    expect(copied!.urgentMode).toBe(false);
    expect(copied!.sentCount).toBe(0);
    expect(copied!.pendingCount).toBe(0);
    expect(copied!.failedCount).toBe(0);
  });
});