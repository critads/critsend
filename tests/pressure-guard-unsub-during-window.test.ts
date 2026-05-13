/**
 * Task #145 R9: end-to-end test that drives the real `drainCampaign`
 * worker. A subscriber is reserved (so a deferred row exists with
 * eligible_at <= NOW()), then tagged with the campaign's unsubscribeTag
 * BEFORE the worker dispatches. We assert the worker:
 *   - does NOT call `sendEmailWithNullsink` for the unsubscribed row
 *   - transitions the campaign_sends row to 'failed' (not 'sent')
 *   - increments campaigns.failed_count
 *
 * The send call is intercepted with vi.mock so we never hit a real SMTP
 * stub; if the dispatch path is ever reached for this subscriber the
 * spy assertion fails loudly.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

// Mock email-service BEFORE importing the worker so the worker captures
// our spy. We assert the spy is NEVER called for the unsubbed contact.
const sendSpy = vi.fn(async () => ({ success: true }));
vi.mock("../server/email-service", () => ({
  sendEmailWithNullsink: sendSpy,
}));

d("Pressure Guard worker — unsubscribe during window drops the contact (Task #145 R9)", () => {
  let db: any;
  let sql: any;
  let drainCampaign: any;

  const subId = `pg-unsub-sub-${Date.now()}`;
  const userId = `pg-unsub-user-${Date.now()}`;
  const mtaId = `pg-unsub-mta-${Date.now()}`;
  const campaignId = `pg-unsub-camp-${Date.now()}`;
  const unsubTag = `UNSUB-${Date.now()}`;

  beforeAll(async () => {
    process.env.PRESSURE_WINDOW_HOURS = "0";
    ({ db, sql } = await import("../server/db"));
    const { runPressureGuardBootstrap } = await import("../server/services/pressure-guard");
    await runPressureGuardBootstrap();
    ({ drainCampaign } = await import("../server/workers/pressure-guard-worker"));

    await db.execute(sql`INSERT INTO users (id, username, password) VALUES (${userId}, ${userId}, 'x')
      ON CONFLICT (id) DO NOTHING`);
    await db.execute(sql`INSERT INTO mtas (id, name, hostname, port, mode, from_email, from_name)
      VALUES (${mtaId}, 'unsub-nullsink', 'localhost', 25, 'nullsink', 'test@example.com', 'T')
      ON CONFLICT (id) DO NOTHING`);
    await db.execute(sql`INSERT INTO subscribers (id, email, tags, last_sent_at)
      VALUES (${subId}, ${`${subId}@example.com`}, ARRAY[]::text[], NULL)
      ON CONFLICT (id) DO NOTHING`);
    await db.execute(sql`INSERT INTO campaigns (id, user_id, mta_id, name, subject, html_content, status, started_at, unsubscribe_tag)
      VALUES (${campaignId}, ${userId}, ${mtaId}, 'unsub-test', 's', '<p>x</p>', 'sending', NOW(), ${unsubTag})
      ON CONFLICT (id) DO NOTHING`);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM campaign_sends WHERE campaign_id = ${campaignId}`);
    await db.execute(sql`DELETE FROM nullsink_captures WHERE subscriber_id = ${subId}`);
    await db.execute(sql`DELETE FROM campaigns WHERE id = ${campaignId}`);
    await db.execute(sql`DELETE FROM mtas WHERE id = ${mtaId}`);
    await db.execute(sql`DELETE FROM subscribers WHERE id = ${subId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    delete process.env.PRESSURE_WINDOW_HOURS;
  });

  it("subscriber unsubscribed mid-window is skipped at dispatch and marked failed", async () => {
    sendSpy.mockClear();

    // Stage a deferred send that's already eligible.
    await db.execute(sql`
      INSERT INTO campaign_sends (id, campaign_id, subscriber_id, status, sent_at, eligible_at)
      VALUES (gen_random_uuid(), ${campaignId}, ${subId}, 'pending', NOW(), NOW())
    `);

    // Mid-window: the subscriber unsubscribes (gains the campaign tag).
    await db.execute(sql`
      UPDATE subscribers SET tags = ARRAY[${unsubTag}]::text[] WHERE id = ${subId}
    `);

    // Run drain. Expect: no send call, row → 'failed'.
    await drainCampaign(campaignId);

    expect(sendSpy).not.toHaveBeenCalled();

    const r = await db.execute(sql`
      SELECT status FROM campaign_sends WHERE campaign_id = ${campaignId} AND subscriber_id = ${subId}
    `);
    expect((r.rows[0] as any).status).toBe("failed");

    const c = await db.execute(sql`SELECT failed_count FROM campaigns WHERE id = ${campaignId}`);
    expect(Number((c.rows[0] as any).failed_count)).toBeGreaterThanOrEqual(1);
  });
});
