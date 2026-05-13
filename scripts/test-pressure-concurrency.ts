/**
 * Concurrency test for Marketing Pressure Guard (Task #144).
 *
 * Spawns N workers all attempting to "send" to the SAME small set of
 * subscribers concurrently and verifies that the atomic CAS in
 * pressureGuardReserveSendSlots() guarantees:
 *
 *   - Each subscriber is reserved by AT MOST ONE worker per pressure window.
 *   - Every loser is enqueued as a deferred send (status='pending',
 *     eligible_at IS NOT NULL).
 *   - subscribers.last_sent_at is updated exactly once per winner.
 *
 * Run with:
 *   PRESSURE_WINDOW_HOURS=1 tsx scripts/test-pressure-concurrency.ts
 *
 * (You can drop the window to a long duration to make sure no contact is
 * double-sent across the campaigns spawned by this test. The script cleans
 * up after itself.)
 */

import { db, pool } from "../server/db";
import { sql } from "drizzle-orm";
import {
  PRESSURE_WINDOW_HOURS,
  pressureGuardReserveSendSlots,
  runPressureGuardBootstrap,
} from "../server/services/pressure-guard";

const SUBSCRIBER_COUNT = 50;
const CONCURRENT_CAMPAIGNS = 8;
const TEST_PREFIX = "presstest";

async function main() {
  console.log(`[TEST] Pressure window = ${PRESSURE_WINDOW_HOURS}h`);
  await runPressureGuardBootstrap();

  // Reset any prior test contacts.
  await db.execute(sql`DELETE FROM subscribers WHERE email LIKE ${TEST_PREFIX + "-%@test.local"}`);

  // Insert N fresh subscribers with last_sent_at NULL → all eligible.
  const subIds: string[] = [];
  for (let i = 0; i < SUBSCRIBER_COUNT; i++) {
    const email = `${TEST_PREFIX}-${i}-${Date.now()}@test.local`;
    const r = await db.execute(sql`
      INSERT INTO subscribers (id, email, tags, refs, last_sent_at)
      VALUES (gen_random_uuid(), ${email}, ARRAY[]::text[], ARRAY[]::text[], NULL)
      RETURNING id
    `);
    subIds.push((r.rows[0] as any).id);
  }
  console.log(`[TEST] Inserted ${subIds.length} subscribers`);

  // Insert N test campaigns.
  const campaignIds: string[] = [];
  for (let i = 0; i < CONCURRENT_CAMPAIGNS; i++) {
    const r = await db.execute(sql`
      INSERT INTO campaigns (
        id, name, status, sent_count, pending_count, failed_count, deferred_count,
        track_opens, track_clicks, started_at, html_content, subject, from_email, from_name
      ) VALUES (
        gen_random_uuid(), ${`${TEST_PREFIX}-camp-${i}`}, 'sending',
        0, 0, 0, 0,
        false, false, NOW() + (${i} || ' seconds')::interval,
        '<p>x</p>', 'subj', 'no-reply@test.local', 'Test'
      )
      RETURNING id
    `);
    campaignIds.push((r.rows[0] as any).id);
  }
  console.log(`[TEST] Inserted ${campaignIds.length} campaigns`);

  // Fire all reserve calls in parallel — same subscribers across all campaigns.
  const t0 = Date.now();
  const results = await Promise.all(
    campaignIds.map((cid) => pressureGuardReserveSendSlots(cid, subIds)),
  );
  const elapsed = Date.now() - t0;

  const winnersFlat = results.flat();
  const winnersBySub = new Map<string, number>();
  for (const w of winnersFlat) winnersBySub.set(w, (winnersBySub.get(w) ?? 0) + 1);
  const doubleWinners = [...winnersBySub.entries()].filter(([, n]) => n > 1);

  console.log(`[TEST] ${CONCURRENT_CAMPAIGNS} campaigns × ${SUBSCRIBER_COUNT} subscribers in ${elapsed}ms`);
  console.log(`[TEST] Total winners: ${winnersFlat.length}`);
  console.log(`[TEST] Subscribers with > 1 winning campaign: ${doubleWinners.length}`);

  // Cross-check: each subscriber must have last_sent_at set exactly once.
  const lsCheck = await db.execute(sql`
    SELECT COUNT(*) FILTER (WHERE last_sent_at IS NOT NULL) AS reserved,
           COUNT(*) AS total
    FROM subscribers WHERE id = ANY(${subIds}::text[])
  `);
  const lsRow = lsCheck.rows[0] as any;
  console.log(`[TEST] Subscribers reserved (last_sent_at != NULL): ${lsRow.reserved}/${lsRow.total}`);

  // Total sends inserted (winners + deferred) must equal N×K.
  const sendsCheck = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE eligible_at IS NULL) AS active,
      COUNT(*) FILTER (WHERE eligible_at IS NOT NULL) AS deferred
    FROM campaign_sends WHERE campaign_id = ANY(${campaignIds}::text[])
  `);
  const sRow = sendsCheck.rows[0] as any;
  console.log(`[TEST] campaign_sends inserted: active=${sRow.active}, deferred=${sRow.deferred}, expected total=${SUBSCRIBER_COUNT * CONCURRENT_CAMPAIGNS}`);

  // Cleanup.
  await db.execute(sql`DELETE FROM campaign_sends WHERE campaign_id = ANY(${campaignIds}::text[])`);
  await db.execute(sql`DELETE FROM campaigns WHERE id = ANY(${campaignIds}::text[])`);
  await db.execute(sql`DELETE FROM subscribers WHERE id = ANY(${subIds}::text[])`);
  console.log(`[TEST] Cleanup done`);

  // Verdict.
  const ok = doubleWinners.length === 0
    && Number(lsRow.reserved) === SUBSCRIBER_COUNT
    && Number(sRow.active) === SUBSCRIBER_COUNT
    && (Number(sRow.active) + Number(sRow.deferred)) === SUBSCRIBER_COUNT * CONCURRENT_CAMPAIGNS;
  console.log(ok ? "[TEST] ✅ PASS" : "[TEST] ❌ FAIL");
  await pool.end();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("[TEST] crashed", err);
  process.exit(2);
});
