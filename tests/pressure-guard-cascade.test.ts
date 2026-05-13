/**
 * Task #145 R2: end-to-end cascade test driving the real deferred-drain
 * worker (`drainCampaign`).
 *
 * Setup: 3 campaigns over the same subscriber, all with a nullsink MTA
 * so `sendEmailWithNullsink` returns success without external IO.
 * `PRESSURE_WINDOW_HOURS=0` is set BEFORE module import so the loser-
 * bump puts deferred rows back to `eligible_at <= NOW()` immediately.
 * We then call `drainCampaign(...)` in started_at order and assert that
 * each wave produces exactly one new sent row and reaches a terminal
 * state with no rows stuck in 'pending' or 'attempting'.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

d("Pressure Guard — drainCampaign cascades across 3 campaigns (Task #145 R2)", () => {
  let db: any;
  let sql: any;
  let drainCampaign: any;

  const subId = `pg-cascade-sub-${Date.now()}`;
  const userId = `pg-cascade-user-${Date.now()}`;
  const mtaId = `pg-cascade-mta-${Date.now()}`;
  const c1 = `pg-cascade-c1-${Date.now()}`;
  const c2 = `pg-cascade-c2-${Date.now()}`;
  const c3 = `pg-cascade-c3-${Date.now()}`;

  beforeAll(async () => {
    // R14 escape hatch: window=0 lets the loser-bump put rows back to
    // eligible_at <= NOW() immediately, so the cascade unfolds in-test.
    process.env.PRESSURE_WINDOW_HOURS = "0";
    ({ db, sql } = await import("../server/db"));
    const { runPressureGuardBootstrap } = await import("../server/services/pressure-guard");
    await runPressureGuardBootstrap();
    ({ drainCampaign } = await import("../server/workers/pressure-guard-worker"));

    await db.execute(sql`INSERT INTO users (id, username, password) VALUES (${userId}, ${userId}, 'x')
      ON CONFLICT (id) DO NOTHING`);
    await db.execute(sql`INSERT INTO mtas (id, name, hostname, port, mode, from_email, from_name)
      VALUES (${mtaId}, 'cascade-nullsink', 'localhost', 25, 'nullsink', 'test@example.com', 'T')
      ON CONFLICT (id) DO NOTHING`);
    await db.execute(sql`INSERT INTO subscribers (id, email, tags, last_sent_at)
      VALUES (${subId}, ${`${subId}@example.com`}, ARRAY[]::text[], NULL)
      ON CONFLICT (id) DO NOTHING`);
    const t1 = new Date(Date.now() - 90_000);
    const t2 = new Date(Date.now() - 60_000);
    const t3 = new Date(Date.now() - 30_000);
    for (const [id, name, started] of [[c1, "cascade-1", t1], [c2, "cascade-2", t2], [c3, "cascade-3", t3]] as const) {
      await db.execute(sql`INSERT INTO campaigns (id, user_id, mta_id, name, subject, html_content, status, started_at)
        VALUES (${id}, ${userId}, ${mtaId}, ${name}, 's', '<p>x</p>', 'sending', ${started})
        ON CONFLICT (id) DO NOTHING`);
      await db.execute(sql`
        INSERT INTO campaign_sends (id, campaign_id, subscriber_id, status, sent_at, eligible_at)
        VALUES (gen_random_uuid(), ${id}, ${subId}, 'pending', NOW(), NOW())
      `);
    }
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM campaign_sends WHERE subscriber_id = ${subId}`);
    await db.execute(sql`DELETE FROM nullsink_captures WHERE subscriber_id = ${subId}`);
    await db.execute(sql`DELETE FROM campaigns WHERE id IN (${c1}, ${c2}, ${c3})`);
    await db.execute(sql`DELETE FROM mtas WHERE id = ${mtaId}`);
    await db.execute(sql`DELETE FROM subscribers WHERE id = ${subId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    delete process.env.PRESSURE_WINDOW_HOURS;
  });

  async function statusFor(cid: string): Promise<string> {
    const r = await db.execute(sql`
      SELECT status FROM campaign_sends WHERE campaign_id = ${cid} AND subscriber_id = ${subId}
    `);
    return (r.rows[0] as any)?.status as string;
  }

  it("3 sequential drains in started_at order send each campaign exactly once (FIFO cascade)", async () => {
    // Wave 1 — c1 (oldest). Should win the CAS and send; c1 row → 'sent'.
    await drainCampaign(c1);
    expect(await statusFor(c1)).toBe("sent");

    // c2 and c3 are still pending and (with window=0) re-eligible immediately.
    expect(await statusFor(c2)).toBe("pending");
    expect(await statusFor(c3)).toBe("pending");

    // Wave 2 — c2 wins.
    await drainCampaign(c2);
    expect(await statusFor(c2)).toBe("sent");
    expect(await statusFor(c3)).toBe("pending");

    // Wave 3 — c3 wins.
    await drainCampaign(c3);
    expect(await statusFor(c3)).toBe("sent");

    // Terminal invariant: no row stuck in 'attempting'; all three sent.
    const r = await db.execute(sql`
      SELECT status, COUNT(*)::int AS n FROM campaign_sends
      WHERE subscriber_id = ${subId}
      GROUP BY status ORDER BY status
    `);
    const byStatus = new Map<string, number>();
    for (const row of r.rows) byStatus.set((row as any).status, Number((row as any).n));
    expect(byStatus.get("sent")).toBe(3);
    expect(byStatus.get("attempting") ?? 0).toBe(0);
    expect(byStatus.get("pending") ?? 0).toBe(0);
  });
});
