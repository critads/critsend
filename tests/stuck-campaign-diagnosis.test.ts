/**
 * Task #181: regression tests for `diagnoseStuckCampaigns`.
 *
 * Drives the real diagnosis SQL against the test DB by seeding each of
 * the five stuck patterns end-to-end and asserting the classifier
 * returns the right `reason` per campaign. We never invoke the
 * guardian's mutating actions here — those are integration-tested by
 * the production self-heal path. The point of this file is the
 * SQL/CTE itself: a missed branch would silently regress the
 * stuck-pending bug.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

d("Task #181 — diagnoseStuckCampaigns classifies every stuck pattern", () => {
  let db: any;
  let diagnoseStuckCampaigns: () => Promise<any[]>;

  const ts = Date.now();
  const userId = `t181-u-${ts}`;
  const mtaId = `t181-mta-${ts}`;
  const subId = `t181-sub-${ts}`;
  const ids = {
    scheduledStuck: `t181-c-sched-${ts}`,
    sendingNoJob: `t181-c-nojob-${ts}`,
    staleHeartbeat: `t181-c-stale-${ts}`,
    retryExhausted: `t181-c-retry-${ts}`,
    midFlight: `t181-c-midflight-${ts}`,
    healthyControl: `t181-c-ok-${ts}`,
  };

  beforeAll(async () => {
    // Tight thresholds so the test doesn't need real wall-clock delays.
    // Inline reassignment below.
    process.env.STUCK_SCHEDULED_MIN = "1";
    process.env.STUCK_SENDING_NO_JOB_MIN = "1";
    process.env.STUCK_HEARTBEAT_STALE_MIN = "1";
    process.env.STUCK_NO_PROGRESS_MIN = "1";
    process.env.STUCK_MAX_JOB_RETRIES = "3";

    ({ db } = await import("../server/db"));
    ({ diagnoseStuckCampaigns } = await import("../server/services/stuck-campaign-diagnosis"));

    // Dev/test DB schema-self-heal: production runs bootstrap migrations
    // that guarantee campaign_jobs.heartbeat exists. Mirror that here so
    // tests don't depend on the dev DB being in lockstep with prod.
    await db.execute(sql`ALTER TABLE campaign_jobs ADD COLUMN IF NOT EXISTS heartbeat timestamp`);

    await db.execute(sql`INSERT INTO users (id, username, password) VALUES (${userId}, ${userId}, 'x')
      ON CONFLICT (id) DO NOTHING`);
    await db.execute(sql`INSERT INTO mtas (id, name, hostname, port, mode, from_email, from_name)
      VALUES (${mtaId}, 't181-mta', 'localhost', 25, 'nullsink', 'a@b.c', 'T')
      ON CONFLICT (id) DO NOTHING`);
    await db.execute(sql`INSERT INTO subscribers (id, email, tags)
      VALUES (${subId}, ${`${subId}@example.com`}, ARRAY[]::text[])
      ON CONFLICT (id) DO NOTHING`);

    // campaigns.user_id is added by a prod migration; not all dev DBs
    // have it. Insert only columns the diagnosis SQL actually reads.
    const seed = async (id: string, status: string, startedAt: string | null) => {
      await db.execute(sql`
        INSERT INTO campaigns (id, name, mta_id, from_email, from_name, subject, html_content, status,
                               started_at, scheduled_at, created_at)
        VALUES (${id}, ${id}, ${mtaId}, 'a@b.c', 'T', 's', '<p>x</p>', ${status},
                ${startedAt ? sql`${startedAt}::timestamp` : null}, NULL,
                NOW() - INTERVAL '1 hour')
        ON CONFLICT (id) DO NOTHING`);
    };

    // (1) scheduled past-due, no job
    await seed(ids.scheduledStuck, "scheduled", null);
    await db.execute(sql`UPDATE campaigns SET scheduled_at = NOW() - INTERVAL '10 minutes'
      WHERE id = ${ids.scheduledStuck}`);

    // (2) sending, no active job, no recently-failed
    await seed(ids.sendingNoJob, "sending", null);

    // (3) sending, only processing job with stale heartbeat
    await seed(ids.staleHeartbeat, "sending", null);
    await db.execute(sql`
      INSERT INTO campaign_jobs (campaign_id, status, retry_count, started_at, heartbeat, worker_id)
      VALUES (${ids.staleHeartbeat}, 'processing', 0,
              NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '10 minutes', 'dead-worker')`);

    // (4) sending, failed job with retry_count >= max, no successor
    await seed(ids.retryExhausted, "sending", null);
    await db.execute(sql`
      INSERT INTO campaign_jobs (campaign_id, status, retry_count, started_at, completed_at, error_message)
      VALUES (${ids.retryExhausted}, 'failed', 5,
              NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '5 minutes', 'boom')`);

    // (5) mid-flight crash: started_at NOT NULL, sends exist, no progress, no active job
    await seed(ids.midFlight, "sending", "2020-01-01T00:00:00Z");
    await db.execute(sql`UPDATE campaigns SET started_at = NOW() - INTERVAL '30 minutes'
      WHERE id = ${ids.midFlight}`);
    await db.execute(sql`
      INSERT INTO campaign_sends (campaign_id, subscriber_id, status, sent_at)
      VALUES (${ids.midFlight}, ${subId}, 'sent', NOW() - INTERVAL '20 minutes')`);

    // Healthy control: sending with a fresh processing heartbeat — must NOT be flagged.
    await seed(ids.healthyControl, "sending", null);
    await db.execute(sql`
      INSERT INTO campaign_jobs (campaign_id, status, retry_count, started_at, heartbeat, worker_id)
      VALUES (${ids.healthyControl}, 'processing', 0, NOW(), NOW(), 'alive-worker')`);
  }, 60000);

  afterAll(async () => {
    if (!HAS_DB) return;
    for (const id of Object.values(ids)) {
      await db.execute(sql`DELETE FROM campaign_jobs WHERE campaign_id = ${id}`).catch(() => {});
      await db.execute(sql`DELETE FROM campaign_sends WHERE campaign_id = ${id}`).catch(() => {});
      await db.execute(sql`DELETE FROM campaigns WHERE id = ${id}`).catch(() => {});
    }
    await db.execute(sql`DELETE FROM subscribers WHERE id = ${subId}`).catch(() => {});
    await db.execute(sql`DELETE FROM mtas WHERE id = ${mtaId}`).catch(() => {});
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`).catch(() => {});
  }, 60000);

  it("flags scheduled past-due with no job as scheduled_past_due_no_job", async () => {
    const stuck = await diagnoseStuckCampaigns();
    const row = stuck.find((s) => s.id === ids.scheduledStuck);
    expect(row?.reason).toBe("scheduled_past_due_no_job");
    expect(row?.action).toBe("reenqueue");
  });

  it("flags sending with no active job as sending_no_active_job", async () => {
    const stuck = await diagnoseStuckCampaigns();
    const row = stuck.find((s) => s.id === ids.sendingNoJob);
    expect(row?.reason).toBe("sending_no_active_job");
    expect(row?.action).toBe("reenqueue");
  });

  it("flags sending with only a stale-heartbeat processing job", async () => {
    const stuck = await diagnoseStuckCampaigns();
    const row = stuck.find((s) => s.id === ids.staleHeartbeat);
    expect(row?.reason).toBe("sending_stale_heartbeat");
    expect(row?.action).toBe("fail_job_and_reenqueue");
    expect(row?.jobId).toBeTruthy();
  });

  it("flags sending with retry_count >= max as retry_budget_exceeded", async () => {
    const stuck = await diagnoseStuckCampaigns();
    const row = stuck.find((s) => s.id === ids.retryExhausted);
    expect(row?.reason).toBe("sending_retry_budget_exceeded");
    expect(row?.action).toBe("pause_retry_budget_exceeded");
    expect(row?.retryCount).toBeGreaterThanOrEqual(3);
  });

  it("flags mid-flight crash (sends exist but no progress and no active job)", async () => {
    const stuck = await diagnoseStuckCampaigns();
    const row = stuck.find((s) => s.id === ids.midFlight);
    expect(row?.reason).toBe("mid_flight_crash");
    expect(row?.action).toBe("reenqueue");
  });

  it("does NOT flag a healthy campaign with a fresh processing heartbeat", async () => {
    const stuck = await diagnoseStuckCampaigns();
    expect(stuck.find((s) => s.id === ids.healthyControl)).toBeUndefined();
  });

  it("counts per reason are mutually exclusive (each campaign appears at most once)", async () => {
    const stuck = await diagnoseStuckCampaigns();
    const seen = new Set<string>();
    for (const s of stuck) {
      expect(seen.has(s.id)).toBe(false);
      seen.add(s.id);
    }
  });
});
