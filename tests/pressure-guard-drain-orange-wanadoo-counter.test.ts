import { sql } from "drizzle-orm";
/**
 * The deferred-drain worker is the third path that flips campaign_sends to
 * 'sent' (next to the per-send and batch finalizers in
 * campaign-repository.ts). All three must keep campaigns.orange_wanadoo_sent_count
 * in step with sent_count: it is the denominator of the /campaigns complaint
 * dot, so a drained Orange/Wanadoo send that is missing from it inflates the
 * displayed complaint rate (red dot at a real 0.08%).
 *
 * Setup: one 'sending' campaign on a nullsink MTA with three deferred rows —
 * orange.fr, Wanadoo.FR (mixed case) and gmail.com — all eligible now.
 * Assertion: after one drain, sent_count=3 and orange_wanadoo_sent_count=2.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

d("Pressure Guard — drainCampaign bumps orange_wanadoo_sent_count", () => {
  let db: any;
  let drainCampaign: (id: string) => Promise<void>;
  const stamp = Date.now();
  const userId = `pg-ow-user-${stamp}`;
  const mtaId = `pg-ow-mta-${stamp}`;
  const campaignId = `pg-ow-c-${stamp}`;
  const subs = [
    { id: `pg-ow-sub-orange-${stamp}`, email: `pg-ow-orange-${stamp}@orange.fr` },
    { id: `pg-ow-sub-wanadoo-${stamp}`, email: `pg-ow-wanadoo-${stamp}@Wanadoo.FR` },
    { id: `pg-ow-sub-gmail-${stamp}`, email: `pg-ow-gmail-${stamp}@gmail.com` },
  ];

  const previousWindow = process.env.PRESSURE_WINDOW_HOURS;
  const previousConcurrency = process.env.PRESSURE_GUARD_SMTP_CONCURRENCY;

  beforeAll(async () => {
    process.env.PRESSURE_WINDOW_HOURS = "0.0833";
    // The nullsink SMTP server starts lazily on the first send and rejects
    // concurrent starts, so drain one send at a time (read at module load,
    // hence set before the import) — exactly how the cascade test drives it.
    process.env.PRESSURE_GUARD_SMTP_CONCURRENCY = "1";
    ({ db } = await import("../server/db"));
    const { runPressureGuardBootstrap } = await import("../server/services/pressure-guard");
    await runPressureGuardBootstrap();
    ({ drainCampaign } = await import("../server/workers/pressure-guard-worker"));

    await db.execute(sql`INSERT INTO users (id, username, password) VALUES (${userId}, ${userId}, 'x')
      ON CONFLICT (id) DO NOTHING`);
    await db.execute(sql`INSERT INTO mtas (id, name, hostname, port, mode, from_email, from_name)
      VALUES (${mtaId}, 'ow-drain-nullsink', 'localhost', 25, 'nullsink', 'test@example.com', 'T')
      ON CONFLICT (id) DO NOTHING`);
    for (const sub of subs) {
      await db.execute(sql`INSERT INTO subscribers (id, email, tags, last_sent_at)
        VALUES (${sub.id}, ${sub.email}, ARRAY[]::text[], NULL)
        ON CONFLICT (id) DO NOTHING`);
    }
    await db.execute(sql`INSERT INTO campaigns (id, user_id, mta_id, name, subject, html_content, from_email, from_name, status, started_at)
      VALUES (${campaignId}, ${userId}, ${mtaId}, 'ow-drain', 's', '<p>x</p>', 'a@b.c', 'T', 'sending', NOW() - interval '1 minute')
      ON CONFLICT (id) DO NOTHING`);
    for (const sub of subs) {
      await db.execute(sql`
        INSERT INTO campaign_sends (id, campaign_id, subscriber_id, status, sent_at, eligible_at)
        VALUES (gen_random_uuid(), ${campaignId}, ${sub.id}, 'pending', NOW(), NOW())
      `);
    }
  }, 60000);

  afterAll(async () => {
    const subIds = subs.map((s) => s.id);
    // Each DELETE runs on its own so one failure cannot leave the rest of the
    // fixture behind; the first error is re-thrown once everything ran.
    const cleanup = [
      sql`DELETE FROM campaign_sends WHERE campaign_id = ${campaignId}`,
      sql`DELETE FROM nullsink_captures WHERE campaign_id = ${campaignId}`,
      sql`DELETE FROM campaigns WHERE id = ${campaignId}`,
      sql`DELETE FROM mtas WHERE id = ${mtaId}`,
      sql`DELETE FROM subscribers WHERE id = ANY(${subIds}::text[])`,
      sql`DELETE FROM users WHERE id = ${userId}`,
    ];
    let firstError: unknown = null;
    for (const statement of cleanup) {
      try {
        await db.execute(statement);
      } catch (err) {
        firstError ??= err;
      }
    }
    if (previousWindow === undefined) delete process.env.PRESSURE_WINDOW_HOURS;
    else process.env.PRESSURE_WINDOW_HOURS = previousWindow;
    if (previousConcurrency === undefined) delete process.env.PRESSURE_GUARD_SMTP_CONCURRENCY;
    else process.env.PRESSURE_GUARD_SMTP_CONCURRENCY = previousConcurrency;
    // Release the shared nullsink port as soon as this file is done.
    const { stopNullsinkServer } = await import("../server/nullsink-smtp");
    await stopNullsinkServer().catch(() => {});
    if (firstError) throw firstError;
  }, 60000);

  it("counts the Orange/Wanadoo share of drained sends (case-insensitive domain)", async () => {
    await drainCampaign(campaignId);

    const sends = await db.execute(sql`
      SELECT status, COUNT(*)::int AS n FROM campaign_sends
      WHERE campaign_id = ${campaignId} GROUP BY status
    `);
    const byStatus = new Map<string, number>();
    for (const row of sends.rows) {
      const x = row as { status: string; n: number };
      byStatus.set(x.status, Number(x.n));
    }
    expect(byStatus.get("sent")).toBe(3);

    const counters = await db.execute(sql`
      SELECT sent_count, orange_wanadoo_sent_count FROM campaigns WHERE id = ${campaignId}
    `);
    const row = counters.rows[0] as { sent_count: number; orange_wanadoo_sent_count: number };
    expect(Number(row.sent_count)).toBe(3);
    expect(Number(row.orange_wanadoo_sent_count)).toBe(2);
  }, 60000);
});
