/**
 * scripts/analytics-health.ts — diagnostic for the /advanced-analytics page.
 *
 * Reports:
 *   1. Validity of every index that the analytics routes depend on.
 *   2. Freshness of analytics_daily (row count + MAX(date)) and analytics_totals.
 *   3. Wall-clock timing of each heavy query.
 *   4. EXPLAIN (ANALYZE, BUFFERS) for one representative query per analytics
 *      endpoint, so you can spot seq-scans / heap fetches in production.
 *   5. Optional cold + cached HTTP timing of every analytics endpoint.
 *
 * Usage:
 *   npx tsx scripts/analytics-health.ts
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
  "/api/analytics/top-campaigns?limit=10&sortBy=openRate",
  "/api/analytics/cohort?period=monthly",
];

// One representative SQL per analytics endpoint, mirroring what the route
// actually executes. Kept identical in shape so EXPLAIN output matches the
// hot path. Each entry: { label, sql, params }.
const REPRESENTATIVE_QUERIES: Array<{ label: string; sql: string; params: unknown[] }> = [
  {
    label: "overview (analytics_totals PK lookup)",
    sql: `SELECT total_subscribers, total_campaigns, total_sent, total_bounces,
                 total_opens, total_clicks, total_unsubscribes, updated_at
          FROM analytics_totals WHERE id = 'global' LIMIT 1`,
    params: [],
  },
  {
    label: "engagement (rollup, 30d)",
    sql: `SELECT date::date,
                 SUM(total_sent)::int  AS total_sent,
                 SUM(total_opens)::int AS total_opens,
                 SUM(total_clicks)::int AS total_clicks
          FROM analytics_daily
          WHERE date >= NOW() - $1::int * INTERVAL '1 day'
          GROUP BY date::date
          ORDER BY date::date`,
    params: [30],
  },
  {
    label: "deliverability (campaign_sends, 30d)",
    sql: `SELECT COUNT(*)::int AS total_sent,
                 COUNT(*) FILTER (WHERE status = 'sent')::int AS total_delivered,
                 COUNT(*) FILTER (WHERE status = 'bounced')::int AS total_bounced,
                 COUNT(*) FILTER (WHERE status = 'failed')::int AS total_failed
          FROM campaign_sends
          WHERE sent_at >= NOW() - $1::int * INTERVAL '1 day'`,
    params: [30],
  },
  {
    label: "subscriber-growth (subscribers, 30d)",
    sql: `SELECT date_trunc('day', import_date)::date AS day, COUNT(*)::int AS adds
          FROM subscribers
          WHERE import_date >= NOW() - $1::int * INTERVAL '1 day'
          GROUP BY day
          ORDER BY day`,
    params: [30],
  },
  {
    label: "top-campaigns (CTE, 90d)",
    sql: `WITH sends AS (
            SELECT campaign_id, COUNT(*)::int AS total_sent
            FROM campaign_sends
            WHERE sent_at >= NOW() - $1::int * INTERVAL '1 day'
            GROUP BY campaign_id
          ),
          opens AS (
            SELECT campaign_id, COUNT(*)::int AS total_opens
            FROM campaign_stats
            WHERE type = 'open' AND timestamp >= NOW() - $1::int * INTERVAL '1 day'
            GROUP BY campaign_id
          ),
          clicks AS (
            SELECT campaign_id, COUNT(*)::int AS total_clicks
            FROM campaign_stats
            WHERE type = 'click' AND timestamp >= NOW() - $1::int * INTERVAL '1 day'
            GROUP BY campaign_id
          )
          SELECT c.id, s.total_sent,
                 COALESCE(o.total_opens, 0) AS total_opens,
                 COALESCE(cl.total_clicks, 0) AS total_clicks
          FROM campaigns c
          JOIN sends s ON s.campaign_id = c.id
          LEFT JOIN opens o ON o.campaign_id = c.id
          LEFT JOIN clicks cl ON cl.campaign_id = c.id
          WHERE s.total_sent > 0
          LIMIT 10`,
    params: [90],
  },
  {
    label: "cohort (denormalized subscribers scan, monthly)",
    sql: `SELECT
            date_trunc('month', import_date)::date AS cohort,
            COUNT(*)::int AS total_subscribers,
            COUNT(*) FILTER (WHERE suppressed_until IS NULL OR suppressed_until < NOW())::int AS active_subscribers,
            COUNT(*) FILTER (WHERE last_engaged_at IS NOT NULL)::int AS engaged_subscribers
          FROM subscribers
          GROUP BY date_trunc('month', import_date)::date
          ORDER BY date_trunc('month', import_date)::date DESC`,
    params: [],
  },
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
  ).catch((err: any) => {
    if (err?.code === "42P01") return { rowCount: 0, rows: [] as any[] };
    throw err;
  });
  if (!totals.rowCount) {
    console.log("  analytics_totals: missing — overview falls back to live counts");
  } else {
    const ageSec = Math.round(
      (Date.now() - new Date(totals.rows[0].updated_at).getTime()) / 1000
    );
    console.log(
      `  analytics_totals: updated ${ageSec}s ago, totalSubscribers=${totals.rows[0].total_subscribers}`
    );
  }

  const daily = await pool.query(
    `SELECT COUNT(*)::int AS row_count, MAX(date)::text AS max_date FROM analytics_daily`
  ).catch((err: any) => {
    if (err?.code === "42P01") return { rows: [{ row_count: 0, max_date: null }] };
    throw err;
  });
  const { row_count, max_date } = daily.rows[0];
  if (!row_count) {
    console.log("  analytics_daily: empty — engagement falls back to live CTE");
  } else {
    console.log(`  analytics_daily: ${row_count} rows, MAX(date)=${max_date ?? "(null)"}`);
  }

  const backfill = await pool.query(
    `SELECT updated_at FROM dashboard_cache WHERE key = 'analytics_engaged_backfill_done'`
  ).catch((err: any) => {
    if (err?.code === "42P01") return { rowCount: 0, rows: [] as any[] };
    throw err;
  });
  console.log(
    `  last_engaged_at backfill: ${backfill.rowCount ? backfill.rows[0].updated_at.toISOString() : "NOT YET RUN"}`
  );
}

async function timeRawQueries(): Promise<void> {
  console.log("\n=== Raw query timing (DB only, no HTTP/cache) ===");
  for (const q of REPRESENTATIVE_QUERIES) {
    const t0 = Date.now();
    try {
      await pool.query(q.sql, q.params);
      console.log(`  ${(Date.now() - t0).toString().padStart(5)}ms  ${q.label}`);
    } catch (err: any) {
      console.log(`  ERR        ${q.label}: ${err.message}`);
    }
  }
}

async function explainQueries(): Promise<void> {
  console.log("\n=== EXPLAIN (ANALYZE, BUFFERS) per endpoint ===");
  for (const q of REPRESENTATIVE_QUERIES) {
    console.log(`\n--- ${q.label} ---`);
    try {
      const res = await pool.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${q.sql}`,
        q.params
      );
      for (const row of res.rows) {
        // pg returns each plan line as its own row with the column name
        // "QUERY PLAN".
        console.log("  " + (row["QUERY PLAN"] ?? Object.values(row)[0]));
      }
    } catch (err: any) {
      console.log(`  ERR: ${err.message}`);
    }
  }
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
      const url =
        base.replace(/\/$/, "") +
        path +
        (phase === "cold" ? (path.includes("?") ? "&" : "?") + "refresh=true" : "");
      const t0 = Date.now();
      try {
        const res = await fetch(url, { headers: cookie ? { cookie } : {} });
        const ok = res.ok ? "OK " : `${res.status}`;
        console.log(
          `  ${(Date.now() - t0).toString().padStart(5)}ms  ${phase.padEnd(6)} ${ok} ${path}`
        );
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
    await explainQueries();
    await timeHttpEndpoints();
  } catch (err) {
    console.error("Diagnostic failed:", err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
