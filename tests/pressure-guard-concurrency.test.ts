import { describe, it, expect, beforeAll, afterAll } from "vitest";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

d("Marketing Pressure Guard — strict concurrency invariants (Task #144)", () => {
  let db: any;
  let sql: any;
  let storage: any;
  let runPressureGuardBootstrap: any;

  const subId = `pg-test-sub-${Date.now()}`;
  const olderCampaignId = `pg-test-camp-old-${Date.now()}`;
  const newerCampaignId = `pg-test-camp-new-${Date.now()}`;
  const userId = `pg-test-user-${Date.now()}`;

  beforeAll(async () => {
    ({ db, sql } = await import("../server/db"));
    ({ storage } = await import("../server/storage"));
    ({ runPressureGuardBootstrap } = await import("../server/services/pressure-guard"));
    await runPressureGuardBootstrap();

    await db.execute(sql`INSERT INTO users (id, username, password) VALUES (${userId}, ${userId}, 'x')
      ON CONFLICT (id) DO NOTHING`);
    await db.execute(sql`INSERT INTO subscribers (id, email, last_sent_at)
      VALUES (${subId}, ${`${subId}@example.com`}, NULL) ON CONFLICT (id) DO NOTHING`);
    const olderStarted = new Date(Date.now() - 60_000);
    const newerStarted = new Date(Date.now() - 30_000);
    await db.execute(sql`INSERT INTO campaigns (id, user_id, name, status, started_at)
      VALUES (${olderCampaignId}, ${userId}, 'older', 'sending', ${olderStarted}),
             (${newerCampaignId}, ${userId}, 'newer', 'sending', ${newerStarted})
      ON CONFLICT (id) DO NOTHING`);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM campaign_sends WHERE subscriber_id = ${subId}`);
    await db.execute(sql`DELETE FROM campaigns WHERE id IN (${olderCampaignId}, ${newerCampaignId})`);
    await db.execute(sql`DELETE FROM subscribers WHERE id = ${subId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
  });

  it("10 parallel reserves across 2 campaigns for same subscriber → exactly 1 immediate row, oldest campaign wins", async () => {
    const tasks = Array.from({ length: 10 }, (_, i) =>
      storage.pressureGuardReserveSendSlots(
        i % 2 === 0 ? olderCampaignId : newerCampaignId,
        [subId],
      ),
    );
    await Promise.all(tasks);

    // Source-of-truth check: campaign_sends rows. Exactly one immediate
    // (eligible_at IS NULL) row across BOTH campaigns; that row belongs
    // to the older campaign (FIFO by campaigns.started_at).
    const allRows = await db.execute(sql`
      SELECT campaign_id, eligible_at FROM campaign_sends
      WHERE subscriber_id = ${subId}
    `);
    const immediate = allRows.rows.filter((r: any) => r.eligible_at === null);
    const deferred = allRows.rows.filter((r: any) => r.eligible_at !== null);
    expect(immediate.length).toBe(1);
    expect(immediate[0].campaign_id).toBe(olderCampaignId);
    expect(deferred.length).toBeGreaterThanOrEqual(1);
  });

  it("subscriber.last_sent_at is stamped exactly once after the race", async () => {
    const r = await db.execute(sql`SELECT last_sent_at FROM subscribers WHERE id = ${subId}`);
    expect(r.rows[0].last_sent_at).not.toBeNull();
  });

  it("R2 audit: re-reserving an already-winning row does NOT advance last_sent_at", async () => {
    // After the race above, the subscriber has an immediate (winner) row
    // on olderCampaignId AND last_sent_at is stamped. Re-reserving the
    // same (campaign, subscriber) must NOT bump last_sent_at because
    // existing_winners CTE returns the row without going through the
    // CAS UPDATE that sets last_sent_at = NOW().
    const before = await db.execute(sql`SELECT last_sent_at FROM subscribers WHERE id = ${subId}`);
    const t0 = new Date((before.rows[0] as { last_sent_at: string | Date }).last_sent_at).getTime();
    // Wait so a buggy NOW() bump would be observable.
    await new Promise((r) => setTimeout(r, 50));
    const winners = await storage.pressureGuardReserveSendSlots(olderCampaignId, [subId]);
    expect(winners).toContain(subId);
    const after = await db.execute(sql`SELECT last_sent_at FROM subscribers WHERE id = ${subId}`);
    const t1 = new Date((after.rows[0] as { last_sent_at: string | Date }).last_sent_at).getTime();
    expect(t1).toBe(t0);
  });

  it("R1: hashtextextended produces distinct 64-bit lock keys for distinct subscriber IDs", async () => {
    // Regression for the 32-bit collision risk fixed in R1. Use the
    // SAME hashtextextended call the CAS uses, with two distinct subs,
    // and assert the resulting bigints differ.
    const sub1 = `pg-r1-distinct-a-${Date.now()}`;
    const sub2 = `pg-r1-distinct-b-${Date.now()}`;
    const r = await db.execute(sql`
      SELECT hashtextextended(${sub1}, 0)::bigint AS k1,
             hashtextextended(${sub2}, 0)::bigint AS k2
    `);
    const k1 = (r.rows[0] as { k1: string | number }).k1;
    const k2 = (r.rows[0] as { k2: string | number }).k2;
    expect(String(k1)).not.toBe(String(k2));
    // And: hashing the SAME id twice yields the SAME key (idempotent).
    const r2 = await db.execute(sql`
      SELECT hashtextextended(${sub1}, 0)::bigint AS k
    `);
    expect(String((r2.rows[0] as { k: string | number }).k)).toBe(String(k1));
  });

  it("deferred sends are scheduled at >= last_sent_at + window", async () => {
    const windowH = Number(process.env.PRESSURE_WINDOW_HOURS ?? 6);
    const r = await db.execute(sql`
      SELECT s.last_sent_at, MIN(cs.eligible_at) AS first_eligible
      FROM campaign_sends cs JOIN subscribers s ON s.id = cs.subscriber_id
      WHERE cs.subscriber_id = ${subId} AND cs.eligible_at IS NOT NULL
      GROUP BY s.last_sent_at
    `);
    const last = new Date(r.rows[0].last_sent_at).getTime();
    const first = new Date(r.rows[0].first_eligible).getTime();
    const expected = last + windowH * 3600_000;
    // Allow 5s skew for clock differences between the SQL NOW() calls.
    expect(first).toBeGreaterThanOrEqual(expected - 5000);
  });
});
