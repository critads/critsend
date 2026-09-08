import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

d("campaign restart pending-send recovery", () => {
  let db: any;
  let storage: any;

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const userId = `restart-user-${suffix}`;
  const subscriberId = `restart-sub-${suffix}`;
  const campaignId = `restart-campaign-${suffix}`;

  beforeAll(async () => {
    ({ db } = await import("../server/db"));
    ({ storage } = await import("../server/storage"));

    await db.execute(sql`
      INSERT INTO users (id, username, password)
      VALUES (${userId}, ${userId}, 'x')
    `);
    await db.execute(sql`
      INSERT INTO subscribers (id, email)
      VALUES (${subscriberId}, ${`${subscriberId}@example.com`})
    `);
    await db.execute(sql`
      INSERT INTO campaigns (
        id, user_id, name, subject, html_content, from_email, from_name,
        status, pending_count
      )
      VALUES (
        ${campaignId}, ${userId}, 'restart recovery', 'subject', '<p>x</p>',
        'sender@example.com', 'Sender', 'sending', 1
      )
    `);
    await db.execute(sql`
      INSERT INTO campaign_sends (
        id, campaign_id, subscriber_id, status, sent_at, eligible_at,
        retry_count, last_retry_at
      )
      VALUES (
        gen_random_uuid(), ${campaignId}, ${subscriberId}, 'pending',
        NOW() - INTERVAL '1 hour', NULL, 0, NULL
      )
    `);
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await db.execute(sql`DELETE FROM campaign_sends WHERE campaign_id = ${campaignId}`);
    await db.execute(sql`DELETE FROM campaigns WHERE id = ${campaignId}`);
    await db.execute(sql`DELETE FROM subscribers WHERE id = ${subscriberId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
  }, 60_000);

  it("preserves an old ordinary pending reservation across restart", async () => {
    await expect(
      storage.recoverRetryCarryoverPendingSends(campaignId),
    ).resolves.toBe(0);

    const row = await db.execute(sql`
      SELECT status FROM campaign_sends
      WHERE campaign_id = ${campaignId} AND subscriber_id = ${subscriberId}
    `);
    expect(row.rows[0]).toMatchObject({ status: "pending" });
  });

  it("recovers a pending row carrying explicit retry history", async () => {
    await db.execute(sql`
      UPDATE campaign_sends
      SET retry_count = 1, last_retry_at = NOW()
      WHERE campaign_id = ${campaignId} AND subscriber_id = ${subscriberId}
    `);

    await expect(
      storage.recoverRetryCarryoverPendingSends(campaignId),
    ).resolves.toBe(1);

    const send = await db.execute(sql`
      SELECT status FROM campaign_sends
      WHERE campaign_id = ${campaignId} AND subscriber_id = ${subscriberId}
    `);
    const campaign = await db.execute(sql`
      SELECT pending_count, failed_count FROM campaigns WHERE id = ${campaignId}
    `);
    expect(send.rows[0]).toMatchObject({ status: "failed" });
    expect(campaign.rows[0]).toMatchObject({
      pending_count: 0,
      failed_count: 1,
    });
  });
});