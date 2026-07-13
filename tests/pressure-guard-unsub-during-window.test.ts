import { sql } from "drizzle-orm";
/**
 * Task #145 R9: end-to-end test for the real reserve → defer →
 * unsubscribe → dispatch timeline.
 *
 * Sequence:
 *   1. Reserve subscriber against c1 → wins, c1 row immediate, last_sent_at stamped.
 *   2. Reserve subscriber against c2 (same subscriber) → loses (within
 *      the 5-min window), so a deferred row is queued for c2.
 *   3. Subscriber gets the c2 unsubscribeTag (mid-window unsubscribe).
 *   4. Backdate last_sent_at to expire the window so c2's deferred row
 *      becomes drainable.
 *   5. Run drainCampaign(c2). The dispatch path must NOT call
 *      sendEmailWithNullsink for the unsubbed subscriber and must mark
 *      the row 'failed' + bump campaigns.failed_count.
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

d("Pressure Guard worker — full reserve→defer→unsub→dispatch timeline (Task #145 R9)", () => {
  let db: any;
  let storage: any;
  let drainCampaign: (id: string) => Promise<void>;

  const subId = `pg-unsub-sub-${Date.now()}`;
  const userId = `pg-unsub-user-${Date.now()}`;
  const mtaId = `pg-unsub-mta-${Date.now()}`;
  const c1 = `pg-unsub-c1-${Date.now()}`;
  const c2 = `pg-unsub-c2-${Date.now()}`;
  const unsubTag = `UNSUB-${Date.now()}`;

  beforeAll(async () => {
    // Strict-bounds compliant 5-minute window.
    process.env.PRESSURE_WINDOW_HOURS = "0.0833";
    ({ db } = await import("../server/db"));
    ({ storage } = await import("../server/storage"));
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
    const t1 = new Date(Date.now() - 60_000);
    const t2 = new Date(Date.now() - 30_000);
    await db.execute(sql`INSERT INTO campaigns (id, user_id, mta_id, name, subject, html_content, from_email, from_name, status, started_at, unsubscribe_tag)
      VALUES (${c1}, ${userId}, ${mtaId}, 'unsub-c1', 's', '<p>x</p>', 'a@b.c', 'T', 'sending', ${t1}, 'UNUSED-1'),
             (${c2}, ${userId}, ${mtaId}, 'unsub-c2', 's', '<p>x</p>', 'a@b.c', 'T', 'sending', ${t2}, ${unsubTag})
      ON CONFLICT (id) DO NOTHING`);
  }, 60000);

  afterAll(async () => {
    await db.execute(sql`DELETE FROM campaign_sends WHERE campaign_id IN (${c1}, ${c2})`);
    await db.execute(sql`DELETE FROM nullsink_captures WHERE subscriber_id = ${subId}`);
    await db.execute(sql`DELETE FROM campaigns WHERE id IN (${c1}, ${c2})`);
    await db.execute(sql`DELETE FROM mtas WHERE id = ${mtaId}`);
    await db.execute(sql`DELETE FROM subscribers WHERE id = ${subId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    delete process.env.PRESSURE_WINDOW_HOURS;
  }, 60000);

  it("reserve→defer→unsub→drain: drain skips send and marks the deferred row failed", async () => {
    sendSpy.mockClear();

    // 1. Reserve for c1 (oldest) — wins, stamps last_sent_at.
    const wonC1 = await storage.pressureGuardReserveSendSlots(c1, [subId]);
    expect(wonC1).toEqual([subId]);

    // 2. Reserve for c2 — loses; deferred row queued.
    const wonC2 = await storage.pressureGuardReserveSendSlots(c2, [subId]);
    expect(wonC2).toEqual([]);
    const deferredCheck = await db.execute(sql`
      SELECT status, eligible_at FROM campaign_sends
      WHERE campaign_id = ${c2} AND subscriber_id = ${subId}
    `);
    expect(deferredCheck.rows.length).toBe(1);
    expect((deferredCheck.rows[0] as { status: string }).status).toBe("pending");
    expect((deferredCheck.rows[0] as { eligible_at: unknown }).eligible_at).not.toBeNull();

    // 3. Mid-window: subscriber unsubscribes (gains c2's tag).
    await db.execute(sql`UPDATE subscribers SET tags = ARRAY[${unsubTag}]::text[] WHERE id = ${subId}`);

    // 4. Expire the window so c2's deferred row becomes drainable.
    await db.execute(sql`UPDATE subscribers SET last_sent_at = NOW() - interval '10 minutes' WHERE id = ${subId}`);
    await db.execute(sql`UPDATE campaign_sends SET eligible_at = NOW()
      WHERE campaign_id = ${c2} AND subscriber_id = ${subId} AND status = 'pending'`);

    // 5. Drain c2 — must skip send and mark row failed.
    await drainCampaign(c2);

    expect(sendSpy).not.toHaveBeenCalled();

    const r = await db.execute(sql`
      SELECT status FROM campaign_sends WHERE campaign_id = ${c2} AND subscriber_id = ${subId}
    `);
    expect((r.rows[0] as { status: string }).status).toBe("failed");

    const c = await db.execute(sql`SELECT failed_count FROM campaigns WHERE id = ${c2}`);
    expect(Number((c.rows[0] as { failed_count: number }).failed_count)).toBeGreaterThanOrEqual(1);
  });
});
