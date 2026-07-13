import { sql } from "drizzle-orm";
/**
 * Task #145 R4: deferred_count idempotency regression test.
 *
 * The reserve-path CAS already increments `campaigns.deferred_count`
 * by `COUNT(*)` of `deferred_ins RETURNING` rows (rows ACTUALLY
 * inserted), and the worker's loser-defer path now increments by
 * `RETURNING.rowCount` of the eligible_at bump. This test proves
 * that semantics: when the SAME subscriber is reserved against the
 * same campaign twice (simulating a retry-after-transient-error),
 * deferred_count is bumped at most once for that contact.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

d("Pressure Guard — deferred_count is idempotent across reserve retries (Task #145 R4)", () => {
  let db: any;
  let storage: any;

  const userId = `pg-r4-user-${Date.now()}`;
  const subId = `pg-r4-sub-${Date.now()}`;
  const c1 = `pg-r4-c1-${Date.now()}`;
  const c2 = `pg-r4-c2-${Date.now()}`;

  beforeAll(async () => {
    process.env.PRESSURE_WINDOW_HOURS = "0.0833";
    ({ db } = await import("../server/db"));
    ({ storage } = await import("../server/storage"));
    const { runPressureGuardBootstrap } = await import("../server/services/pressure-guard");
    await runPressureGuardBootstrap();

    await db.execute(sql`INSERT INTO users (id, username, password) VALUES (${userId}, ${userId}, 'x')
      ON CONFLICT (id) DO NOTHING`);
    await db.execute(sql`INSERT INTO subscribers (id, email, last_sent_at)
      VALUES (${subId}, ${`${subId}@example.com`}, NULL) ON CONFLICT (id) DO NOTHING`);
    const t1 = new Date(Date.now() - 60_000);
    const t2 = new Date(Date.now() - 30_000);
    await db.execute(sql`INSERT INTO campaigns (id, user_id, name, subject, html_content, from_email, from_name, status, started_at)
      VALUES (${c1}, ${userId}, 'r4-c1', 's', '<p>x</p>', 'a@b.c', 'T', 'sending', ${t1}),
             (${c2}, ${userId}, 'r4-c2', 's', '<p>x</p>', 'a@b.c', 'T', 'sending', ${t2})
      ON CONFLICT (id) DO NOTHING`);
  }, 60000);

  afterAll(async () => {
    await db.execute(sql`DELETE FROM campaign_sends WHERE subscriber_id = ${subId}`);
    await db.execute(sql`DELETE FROM campaigns WHERE id IN (${c1}, ${c2})`);
    await db.execute(sql`DELETE FROM subscribers WHERE id = ${subId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    delete process.env.PRESSURE_WINDOW_HOURS;
  }, 60000);

  it("re-reserving the same subscriber on a deferred campaign does not double-count deferred_count", async () => {
    // Wave 1: reserve on c1 (winner) — c1.deferred_count remains 0.
    const w1 = await storage.pressureGuardReserveSendSlots(c1, [subId]);
    expect(w1).toEqual([subId]);

    // Wave 2: reserve on c2 — loses, c2 gets +1 deferred_count.
    const w2a = await storage.pressureGuardReserveSendSlots(c2, [subId]);
    expect(w2a).toEqual([]);
    const after2a = await db.execute(sql`SELECT deferred_count FROM campaigns WHERE id = ${c2}`);
    expect(Number((after2a.rows[0] as { deferred_count: number }).deferred_count)).toBe(1);

    // Simulate a transient-error retry: the same caller re-runs the same
    // reserve. The deferred_ins INSERT hits the unique (campaign, sub)
    // index → 0 rows returned → deferred_count must NOT bump again.
    const w2b = await storage.pressureGuardReserveSendSlots(c2, [subId]);
    expect(w2b).toEqual([]);
    const after2b = await db.execute(sql`SELECT deferred_count FROM campaigns WHERE id = ${c2}`);
    expect(Number((after2b.rows[0] as { deferred_count: number }).deferred_count)).toBe(1);

    // And once more for good measure — still 1.
    await storage.pressureGuardReserveSendSlots(c2, [subId]);
    const after2c = await db.execute(sql`SELECT deferred_count FROM campaigns WHERE id = ${c2}`);
    expect(Number((after2c.rows[0] as { deferred_count: number }).deferred_count)).toBe(1);

    // Exactly one deferred row exists for this subscriber on c2.
    const rows = await db.execute(sql`
      SELECT id FROM campaign_sends WHERE campaign_id = ${c2} AND subscriber_id = ${subId}
    `);
    expect(rows.rows.length).toBe(1);
  });
});
