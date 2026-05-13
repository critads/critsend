/**
 * Task #145 R2: end-to-end cascade test driving the real deferred-drain
 * worker (`drainCampaign`).
 *
 * Setup: 3 campaigns over the same subscriber, all with a nullsink MTA
 * so `sendEmailWithNullsink` returns success without external IO.
 * `PRESSURE_WINDOW_HOURS=0.0833` (5 min, the lower bound) is set BEFORE
 * module import. Between drain waves we explicitly backdate
 * `subscribers.last_sent_at` to simulate the window having elapsed —
 * this lets us observe a 3-wave cascade in seconds instead of 15min.
 *
 * Assertions per wave:
 *   - Exactly one campaign_sends row transitions to 'sent'.
 *   - `subscribers.last_sent_at` advances exactly once and only when a
 *     wave produces a winner (not on losers).
 *   - Final state: 3 'sent' rows, 0 'pending' / 'attempting'.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

d("Pressure Guard — drainCampaign cascades across 3 campaigns (Task #145 R2)", () => {
  let db: any;
  let sql: any;
  let drainCampaign: (id: string) => Promise<void>;

  const subId = `pg-cascade-sub-${Date.now()}`;
  const userId = `pg-cascade-user-${Date.now()}`;
  const mtaId = `pg-cascade-mta-${Date.now()}`;
  const c1 = `pg-cascade-c1-${Date.now()}`;
  const c2 = `pg-cascade-c2-${Date.now()}`;
  const c3 = `pg-cascade-c3-${Date.now()}`;

  beforeAll(async () => {
    // Strict-bounds compliant: 5-minute window (0.0833h). Between waves
    // we backdate last_sent_at by 10min to simulate window expiry.
    process.env.PRESSURE_WINDOW_HOURS = "0.0833";
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
    return (r.rows[0] as { status: string } | undefined)?.status ?? "missing";
  }
  async function lastSentAt(): Promise<Date | null> {
    const r = await db.execute(sql`SELECT last_sent_at FROM subscribers WHERE id = ${subId}`);
    const v = (r.rows[0] as { last_sent_at: Date | string | null } | undefined)?.last_sent_at ?? null;
    return v ? new Date(v) : null;
  }
  async function expireWindow() {
    // Push last_sent_at 10min into the past so the next CAS wave is eligible
    // (window = 5min). Also bump deferred eligible_at backwards so the
    // SKIP LOCKED claim picks them up.
    await db.execute(sql`UPDATE subscribers SET last_sent_at = NOW() - interval '10 minutes' WHERE id = ${subId}`);
    await db.execute(sql`UPDATE campaign_sends SET eligible_at = NOW()
      WHERE subscriber_id = ${subId} AND status = 'pending' AND eligible_at IS NOT NULL`);
  }

  it("3 sequential waves produce exactly one new sent row each, in started_at order", async () => {
    // Wave 1 — c1 (oldest).
    const before1 = await lastSentAt();
    await drainCampaign(c1);
    expect(await statusFor(c1)).toBe("sent");
    expect(await statusFor(c2)).toBe("pending");
    expect(await statusFor(c3)).toBe("pending");
    const after1 = await lastSentAt();
    expect(after1).not.toBeNull();
    if (before1) expect(after1!.getTime()).toBeGreaterThan(before1.getTime());

    await expireWindow();

    // Wave 2 — c2 wins. last_sent_at must advance exactly once more.
    await drainCampaign(c2);
    expect(await statusFor(c2)).toBe("sent");
    expect(await statusFor(c3)).toBe("pending");
    const after2 = await lastSentAt();
    expect(after2!.getTime()).toBeGreaterThanOrEqual(after1!.getTime());

    await expireWindow();

    // Wave 3 — c3 wins.
    await drainCampaign(c3);
    expect(await statusFor(c3)).toBe("sent");

    // Terminal invariant: exactly 3 sent rows, none stuck.
    const r = await db.execute(sql`
      SELECT status, COUNT(*)::int AS n FROM campaign_sends
      WHERE subscriber_id = ${subId}
      GROUP BY status ORDER BY status
    `);
    const byStatus = new Map<string, number>();
    for (const row of r.rows) {
      const x = row as { status: string; n: number };
      byStatus.set(x.status, Number(x.n));
    }
    expect(byStatus.get("sent")).toBe(3);
    expect(byStatus.get("attempting") ?? 0).toBe(0);
    expect(byStatus.get("pending") ?? 0).toBe(0);
  });

  it("a wave with no eligible rows leaves last_sent_at unchanged", async () => {
    const before = await lastSentAt();
    // No deferred rows remain after the cascade; draining a finished
    // campaign must be a no-op against the subscriber's last_sent_at.
    await drainCampaign(c1);
    const after = await lastSentAt();
    expect(after?.getTime()).toBe(before?.getTime());
  });
});
