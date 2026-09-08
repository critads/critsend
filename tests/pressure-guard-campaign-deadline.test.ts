import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CAMPAIGN_PRESSURE_FORCE_AFTER_HOURS,
  isCampaignPressureDeadlineReached,
} from "../server/services/pressure-guard";

describe("Pressure Guard — campaign deadline boundary", () => {
  it("starts at the exact configured force boundary and ignores NULL", () => {
    const now = Date.UTC(2026, 8, 8, 12, 0, 0);
    const boundaryMs = CAMPAIGN_PRESSURE_FORCE_AFTER_HOURS * 60 * 60 * 1000;

    expect(isCampaignPressureDeadlineReached(new Date(now - boundaryMs), now)).toBe(true);
    expect(isCampaignPressureDeadlineReached(new Date(now - boundaryMs + 1), now)).toBe(false);
    expect(isCampaignPressureDeadlineReached(null, now)).toBe(false);
  });
});

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

d("Pressure Guard — 72h campaign deadline", () => {
  let db: any;
  let drainCampaign: (id: string) => Promise<void>;

  const suffix = Date.now();
  const userId = `pg-deadline-user-${suffix}`;
  const mtaId = `pg-deadline-mta-${suffix}`;
  const subscriberId = `pg-deadline-sub-${suffix}`;
  const legacySentSubscriberId = `pg-deadline-legacy-sent-sub-${suffix}`;
  const campaignId = `pg-deadline-campaign-${suffix}`;
  const hardCutoffCampaignId = `pg-hard-cutoff-campaign-${suffix}`;
  const legacyCampaignId = `pg-legacy-deadline-campaign-${suffix}`;

  beforeAll(async () => {
    ({ db } = await import("../server/db"));
    const { runPressureGuardBootstrap } = await import("../server/services/pressure-guard");
    await runPressureGuardBootstrap();
    ({ drainCampaign } = await import("../server/workers/pressure-guard-worker"));

    await db.execute(sql`
      INSERT INTO users (id, username, password)
      VALUES (${userId}, ${userId}, 'x')
      ON CONFLICT (id) DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO mtas (id, name, hostname, port, mode, from_email, from_name)
      VALUES (${mtaId}, 'deadline-nullsink', 'localhost', 25, 'nullsink', 'test@example.com', 'T')
      ON CONFLICT (id) DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO subscribers (id, email, tags, last_sent_at)
      VALUES (${subscriberId}, ${`${subscriberId}@example.com`}, ARRAY[]::text[], NOW())
      ON CONFLICT (id) DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO subscribers (id, email, tags, last_sent_at)
      VALUES (
        ${legacySentSubscriberId},
        ${`${legacySentSubscriberId}@example.com`},
        ARRAY[]::text[],
        NOW() - INTERVAL '80 hours'
      )
      ON CONFLICT (id) DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO campaigns (
        id, user_id, mta_id, name, subject, html_content, from_email, from_name,
        status, started_at, first_send_at, pending_count, deferred_count
      )
      VALUES (
        ${campaignId}, ${userId}, ${mtaId}, 'deadline campaign', 's', '<p>x</p>',
        'a@b.c', 'T', 'sending', NOW(), NOW() - INTERVAL '72 hours', 1, 1
      )
    `);
    await db.execute(sql`
      INSERT INTO campaign_sends (
        id, campaign_id, subscriber_id, status, sent_at, eligible_at, first_deferred_at
      )
      VALUES (
        gen_random_uuid(), ${campaignId}, ${subscriberId}, 'pending', NOW(),
        NOW() + INTERVAL '2 hours', NOW()
      )
    `);
    await db.execute(sql`
      INSERT INTO campaigns (
        id, user_id, mta_id, name, subject, html_content, from_email, from_name,
        status, started_at, first_send_at, pending_count, deferred_count
      )
      VALUES (
        ${hardCutoffCampaignId}, ${userId}, ${mtaId}, 'hard cutoff campaign', 's', '<p>x</p>',
        'a@b.c', 'T', 'sending', NOW(), NOW() - INTERVAL '73 hours', 1, 1
      )
    `);
    await db.execute(sql`
      INSERT INTO campaign_sends (
        id, campaign_id, subscriber_id, status, sent_at, eligible_at, first_deferred_at
      )
      VALUES (
        gen_random_uuid(), ${hardCutoffCampaignId}, ${subscriberId}, 'pending', NOW(),
        NOW() + INTERVAL '2 hours', NOW()
      )
    `);
    await db.execute(sql`
      INSERT INTO campaign_jobs (id, campaign_id, status)
      VALUES (gen_random_uuid(), ${hardCutoffCampaignId}, 'processing')
    `);
    await db.execute(sql`
      INSERT INTO campaigns (
        id, user_id, mta_id, name, subject, html_content, from_email, from_name,
        status, started_at, first_send_at, last_send_at, sent_count,
        pending_count, deferred_count
      )
      VALUES (
        ${legacyCampaignId}, ${userId}, ${mtaId}, 'legacy deadline campaign', 's', '<p>x</p>',
        'a@b.c', 'T', 'sending', NOW() - INTERVAL '80 hours', NULL,
        NOW() - INTERVAL '80 hours', 1, 1, 1
      )
    `);
    await db.execute(sql`
      INSERT INTO campaign_sends (
        id, campaign_id, subscriber_id, status, sent_at, eligible_at, first_deferred_at
      )
      VALUES
        (
          gen_random_uuid(), ${legacyCampaignId}, ${legacySentSubscriberId},
          'sent', NOW() - INTERVAL '80 hours', NULL, NULL
        ),
        (
          gen_random_uuid(), ${legacyCampaignId}, ${subscriberId},
          'pending', NOW(), NOW() + INTERVAL '2 hours', NOW()
        )
    `);
  }, 60_000);

  afterAll(async () => {
    await db.execute(sql`
      DELETE FROM campaign_jobs
      WHERE campaign_id IN (${campaignId}, ${hardCutoffCampaignId}, ${legacyCampaignId})
    `);
    await db.execute(sql`DELETE FROM nullsink_captures WHERE subscriber_id = ${subscriberId}`);
    await db.execute(sql`
      DELETE FROM campaign_sends
      WHERE campaign_id IN (${campaignId}, ${hardCutoffCampaignId}, ${legacyCampaignId})
    `);
    await db.execute(sql`
      DELETE FROM campaigns
      WHERE id IN (${campaignId}, ${hardCutoffCampaignId}, ${legacyCampaignId})
    `);
    await db.execute(sql`DELETE FROM mtas WHERE id = ${mtaId}`);
    await db.execute(sql`DELETE FROM subscribers WHERE id = ${subscriberId}`);
    await db.execute(sql`DELETE FROM subscribers WHERE id = ${legacySentSubscriberId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
  }, 120_000);

  it("force-sends a future held row and completes before the deadline", async () => {
    await drainCampaign(campaignId);

    const send = await db.execute(sql`
      SELECT status, eligible_at
      FROM campaign_sends
      WHERE campaign_id = ${campaignId} AND subscriber_id = ${subscriberId}
    `);
    const campaign = await db.execute(sql`
      SELECT status, pending_count, sent_count
      FROM campaigns
      WHERE id = ${campaignId}
    `);

    expect(send.rows[0]).toMatchObject({ status: "sent", eligible_at: null });
    expect(campaign.rows[0]).toMatchObject({
      status: "completed",
      pending_count: 0,
      sent_count: 1,
    });
  }, 60_000);

  it("hard-closes a held-only tail after 72h without starting SMTP", async () => {
    const { completePressureHeldCampaignsPastDeadline } = await import(
      "../server/repositories/campaign-repository"
    );
    const blockedWhileEnumerating = await completePressureHeldCampaignsPastDeadline(72, 500);
    const stillSending = await db.execute(sql`
      SELECT status
      FROM campaigns
      WHERE id = ${hardCutoffCampaignId}
    `);

    expect(blockedWhileEnumerating).not.toContainEqual(
      expect.objectContaining({ campaignId: hardCutoffCampaignId }),
    );
    expect(stillSending.rows[0]?.status).toBe("sending");

    await db.execute(sql`
      DELETE FROM campaign_jobs
      WHERE campaign_id = ${hardCutoffCampaignId}
    `);
    const completed = await completePressureHeldCampaignsPastDeadline(72, 500);

    const send = await db.execute(sql`
      SELECT status, eligible_at
      FROM campaign_sends
      WHERE campaign_id = ${hardCutoffCampaignId}
    `);
    const campaign = await db.execute(sql`
      SELECT status, pending_count, deferred_count, failed_count, completed_at
      FROM campaigns
      WHERE id = ${hardCutoffCampaignId}
    `);
    const captures = await db.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM nullsink_captures
      WHERE campaign_id = ${hardCutoffCampaignId}
    `);

    expect(completed).toContainEqual({
      campaignId: hardCutoffCampaignId,
      terminalizedCount: 1,
    });
    expect(send.rows[0]).toMatchObject({
      status: "failed",
      eligible_at: null,
    });
    expect(campaign.rows[0]).toMatchObject({
      status: "completed",
      pending_count: 0,
      deferred_count: 0,
      failed_count: 1,
    });
    expect(campaign.rows[0]?.completed_at).toBeTruthy();
    expect(Number(captures.rows[0]?.n ?? 0)).toBe(0);
  }, 60_000);

  it("reconciles a legacy NULL timestamp from the earliest real delivery", async () => {
    const {
      reconcileLegacyPressureTailFirstSendAt,
    } = await import("../server/services/pressure-guard");
    const {
      completePressureHeldCampaignsPastDeadline,
    } = await import("../server/repositories/campaign-repository");

    await reconcileLegacyPressureTailFirstSendAt();
    const reconciled = await db.execute(sql`
      SELECT first_send_at
      FROM campaigns
      WHERE id = ${legacyCampaignId}
    `);
    const firstSendAt = new Date(reconciled.rows[0]?.first_send_at as string).getTime();
    expect(firstSendAt).toBeLessThan(Date.now() - 79 * 60 * 60 * 1000);

    const completed = await completePressureHeldCampaignsPastDeadline(72, 500);
    const campaign = await db.execute(sql`
      SELECT status, sent_count, failed_count, pending_count, deferred_count
      FROM campaigns
      WHERE id = ${legacyCampaignId}
    `);

    expect(completed).toContainEqual({
      campaignId: legacyCampaignId,
      terminalizedCount: 1,
    });
    expect(campaign.rows[0]).toMatchObject({
      status: "completed",
      sent_count: 1,
      failed_count: 1,
      pending_count: 0,
      deferred_count: 0,
    });
  }, 60_000);
});