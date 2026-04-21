/**
 * scripts/analytics-health.ts — diagnostic for the /advanced-analytics page.
 *
 * Reports:
 *   1. Validity of every index that the analytics routes depend on.
 *   2. Freshness of analytics_daily and analytics_totals.
 *   3. Wall-clock timing of each analytics endpoint (cold + cached).
 *   4. EXPLAIN ANALYZE for the heaviest cohort + top-campaigns queries.
 *
 * Run on the OVH server (or locally pointed at the prod DB) with:
 *   npx tsx scripts/analytics-health.ts
 *
 * Optionally pass a base URL to time the actual HTTP endpoints:
 *   BASE_URL=https://app.example.com COOKIE="connect.sid=..." npx tsx scripts/analytics-health.ts
 */
import { pool } from "../server/db";

const REQUIRED_INDEXES = [
  "campaign_stats_campaign_type_idx",
  "campaign_stats_timestamp_idx",
  "campaign_sends_sent_at_idx",
  "subscribers_import_date_idx",
  "subscribers_suppressed_partial_idx",
  "subscribers_engaged_partial_idx",
];

const ENDPOINTS = [
  "/api/analytics/overview",
  "/api/analytics/engagement?days=30",
  "/api/analytics/deliverability?days=30",
  "/api/analytics/subscriber-growth?days=30",
  "/api/analytics/top-campaigns",
  "/api/analytics/cohort?period=monthly",
];

async function checkIndexes(): Promise<void> {
  console.log("\n=== Index validity ===");
  const { rows } = await pool.query(
    `SELECT c.relname AS index_name, i.indisvalid AS valid, i.indisready AS ready
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = ANY($1::text[])`,
    [REQUIRED_INDEXES]
  );
  const found = new Map(rows.map((r: any) => [r.index_name, r]));
  for (const name of REQUIRED_INDEXES) {
    const r = found.get(name);
    if (!r) {
      console.log(`  MISSING  ${name}`);
    } else if (!r.valid || !r.ready) {
      console.log(`  INVALID  ${name} (valid=${r.valid} ready=${r.ready})`);
    } else {
      console.log(`  OK       ${name}`);
    }
  }
}

async function checkFreshness(): Promise<void> {
  console.log("\n=== Rollup freshness ===");
  const totals = await pool.query(
    `SELECT updated_at, total_subscribers FROM analytics_totals WHERE id = 'global'`
  );
  if (totals.rowCount === 0) {
    console.log("  analytics_totals: row missing — overview will fall back to live counts");
  } else {
    const ageSec = Math.round(
      (Date.now() - new Date(totals.rows[0].updated_at).getTime()) / 1000
    );
    console.log(
      `  analytics_totals: updated ${ageSec}s ago, totalSubscribers=${totals.rows[0].total_subscribers}`
    );
  }

  const daily = await pool.query(
    `SELECT MAX(updated_at) AS last_update, COUNT(*)::int AS rows FROM analytics_daily`
  );
  if (!daily.rows[0]?.last_update) {
    console.log("  analytics_daily: empty — engagement endpoint will use live CTE fallback");
  } else {
    const ageSec = Math.round(
      (Date.now() - new Date(daily.rows[0].last_update).getTime()) / 1000
    );
    console.log(
      `  analytics_daily: ${daily.rows[0].rows} rows, last updated ${ageSec}s ago`
    );
  }

  const backfill = await pool.query(
    `SELECT updated_at FROM dashboard_cache WHERE key = 'analytics_engaged_backfill_done'`
  );
  console.log(
    `  last_engaged_at backfill: ${backfill.rowCount ? backfill.rows[0].updated_at.toISOString() : "NOT YET RUN"}`
  );
}

async function timeQuery(label: string, sql: string, params: unknown[] = []): Promise<void> {
  const t0 = Date.now();
  await pool.query(sql, params);
  console.log(`  ${(Date.now() - t0).toString().padStart(5)}ms  ${label}`);
}

async function timeRawQueries(): Promise<void> {
  console.log("\n=== Raw query timing (DB only, no HTTP/cache) ===");
  await timeQuery(
    "overview (analytics_totals PK lookup)",
    `SELECT * FROM analytics_totals WHERE id = 'global'`
  );
  await timeQuery(
    "engagement 30d (rollup)",
    `SELECT date::date, SUM(total_sent)::int FROM analytics_daily
     WHERE date >= NOW() - 30 * INTERVAL '1 day' GROUP BY date::date`
  );
  await timeQuery(
    "cohort (denormalized, monthly)",
    `SELECT date_trunc('month', import_date)::date AS cohort, COUNT(*)
     FROM subscribers GROUP BY 1 ORDER BY 1 DESC`
  );
  await timeQuery(
    "top-campaigns 90d",
    `WITH sends AS (SELECT campaign_id, COUNT(*)::int AS n FROM campaign_sends
       WHERE sent_at >= NOW() - 90 * INTERVAL '1 day' GROUP BY campaign_id)
     SELECT c.id FROM campaigns c JOIN sends s ON s.campaign_id = c.id LIMIT 10`
  );
}

async function timeHttpEndpoints(): Promise<void> {
  const base = process.env.BASE_URL;
  if (!base) {
    console.log("\n=== HTTP timing skipped (set BASE_URL=… COOKIE=… to enable) ===");
    return;
  }
  const cookie = process.env.COOKIE ?? "";
  console.log(`\n=== HTTP timing against ${base} ===`);
  for (const path of ENDPOINTS) {
    for (const phase of ["cold", "cached"] as const) {
      const url = base.replace(/\/$/, "") + path + (phase === "cold" ? (path.includes("?") ? "&" : "?") + "refresh=true" : "");
      const t0 = Date.now();
      try {
        const res = await fetch(url, { headers: cookie ? { cookie } : {} });
        const ok = res.ok ? "OK " : `${res.status}`;
        console.log(`  ${(Date.now() - t0).toString().padStart(5)}ms  ${phase.padEnd(6)} ${ok} ${path}`);
      } catch (err: any) {
        console.log(`  ERR    ${phase.padEnd(6)} ${path}: ${err.message}`);
      }
    }
  }
}

(async () => {
  try {
    await checkIndexes();
    await checkFreshness();
    await timeRawQueries();
    await timeHttpEndpoints();
  } catch (err) {
    console.error("Diagnostic failed:", err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
