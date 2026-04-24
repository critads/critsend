/**
 * analytics-ops.ts — bootstrap, rollup, and short-cache helpers for analytics.
 *
 * Three responsibilities:
 *   1. runAnalyticsBootstrapMigrations() — idempotent CREATE INDEX CONCURRENTLY
 *      for the four composite/secondary indexes that every analytics route
 *      depends on. Safe to call repeatedly; safe to fire-and-forget on startup.
 *   2. runAnalyticsRollup(days) — rebuild the analytics_daily rollup for the
 *      last N days. Called from the worker scheduler and from the manual
 *      /api/analytics/rollup endpoint.
 *   3. getAnalyticsCached / invalidateAnalyticsCache — 5-minute in-process
 *      cache mirroring the segment-count pattern, used by all heavy analytics
 *      routes. `?refresh=true` callers invalidate and re-read.
 */
import { pool } from "../db";
import { logger } from "../logger";

// ─────────────────────────────────────────────────────────────────────────────
// Index bootstrap
// ─────────────────────────────────────────────────────────────────────────────

const REQUIRED_INDEXES: Array<{ name: string; ddl: string }> = [
  {
    name: "campaign_stats_campaign_type_idx",
    ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_stats_campaign_type_idx
          ON campaign_stats (campaign_id, type)`,
  },
  {
    name: "campaign_stats_timestamp_idx",
    ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_stats_timestamp_idx
          ON campaign_stats (timestamp)`,
  },
  {
    name: "campaign_sends_sent_at_idx",
    ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_sends_sent_at_idx
          ON campaign_sends (sent_at)`,
  },
  {
    name: "subscribers_import_date_idx",
    ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS subscribers_import_date_idx
          ON subscribers (import_date)`,
  },
  // Cohort analysis: COUNT(*) FILTER on these two columns drives the
  // "active" and "engagement" rates. Partial indexes keep them tiny —
  // most subscribers never unsubscribe and most are not engaged.
  {
    name: "subscribers_suppressed_partial_idx",
    ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS subscribers_suppressed_partial_idx
          ON subscribers (suppressed_until) WHERE suppressed_until IS NOT NULL`,
  },
  {
    name: "subscribers_engaged_partial_idx",
    ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS subscribers_engaged_partial_idx
          ON subscribers (last_engaged_at) WHERE last_engaged_at IS NOT NULL`,
  },
  {
    name: "campaign_sends_campaign_first_open_idx",
    ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_sends_campaign_first_open_idx
          ON campaign_sends (campaign_id, first_open_at) WHERE first_open_at IS NOT NULL`,
  },
];

let bootstrapStarted = false;

/**
 * Fire-and-forget. CREATE INDEX CONCURRENTLY can take many minutes on a
 * 14M-row table, so we never await this on the request path. The
 * `IF NOT EXISTS` guard makes this idempotent across restarts.
 *
 * Each statement runs on its own pool connection — CONCURRENTLY is rejected
 * inside an explicit transaction, but pool.query() is autocommit per call.
 */
export function runAnalyticsBootstrapMigrations(): void {
  if (bootstrapStarted) return;
  bootstrapStarted = true;

  (async () => {
    // Idempotent DDL for the new analytics fast-path objects. These run
    // before the index loop so that writer paths (rollup, totals refresh,
    // engagement backfill) never see "relation does not exist" if code
    // ships ahead of `npm run db:push`. ALTER/CREATE IF NOT EXISTS are
    // cheap no-ops on already-migrated databases.
    try {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS analytics_totals (
           id VARCHAR PRIMARY KEY DEFAULT 'global',
           total_subscribers INT NOT NULL DEFAULT 0,
           total_campaigns INT NOT NULL DEFAULT 0,
           total_sent INT NOT NULL DEFAULT 0,
           total_bounces INT NOT NULL DEFAULT 0,
           total_opens INT NOT NULL DEFAULT 0,
           total_clicks INT NOT NULL DEFAULT 0,
           total_unsubscribes INT NOT NULL DEFAULT 0,
           updated_at TIMESTAMP NOT NULL DEFAULT NOW()
         )`
      );
      await pool.query(
        `ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS last_engaged_at TIMESTAMP`
      );
      logger.info("[ANALYTICS_BOOTSTRAP] DDL ready: analytics_totals + subscribers.last_engaged_at");
    } catch (err: any) {
      logger.error(`[ANALYTICS_BOOTSTRAP] DDL bootstrap FAILED: ${err?.message || err}`);
    }

    for (const idx of REQUIRED_INDEXES) {
      const t0 = Date.now();
      try {
        await pool.query(idx.ddl);
        const ms = Date.now() - t0;
        logger.info(`[ANALYTICS_BOOTSTRAP] Index ready: ${idx.name} (${ms}ms)`);
      } catch (err: any) {
        // A previous failed CONCURRENTLY can leave an INVALID index behind.
        // Drop it and let the next startup retry. Don't crash the process.
        logger.warn(`[ANALYTICS_BOOTSTRAP] Failed to create ${idx.name}: ${err?.message || err}`);
        try {
          await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS ${idx.name}`);
        } catch {
          /* ignore */
        }
      }
    }
    logger.info("[ANALYTICS_BOOTSTRAP] All required analytics indexes processed");
  })().catch((err) => {
    logger.error("[ANALYTICS_BOOTSTRAP] Unexpected bootstrap error", { error: String(err) });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Rollup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Smart startup rollup: checks the most recent date in analytics_daily and
 * only rolls up the gap since then (plus a 1-day overlap for safety). Falls
 * back to a full `fallbackDays` backfill only when the table is completely
 * empty. This avoids the multi-minute full-table scan that previously ran
 * on every PM2 restart, saturating Neon's compute budget.
 */
export async function runAnalyticsRollupSmart(fallbackDays: number = 3650): Promise<void> {
  const result = await pool.query(`SELECT MAX(date) AS max_date FROM analytics_daily`);
  const maxDate = result.rows[0]?.max_date;
  if (!maxDate) {
    logger.info(`[ANALYTICS_ROLLUP] analytics_daily is empty — full ${fallbackDays}-day backfill`);
    return runAnalyticsRollup(fallbackDays);
  }
  const lastDate = new Date(maxDate);
  const now = new Date();
  const gapDays = Math.ceil((now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  const effectiveDays = Math.max(2, Math.min(gapDays, fallbackDays));
  logger.info(`[ANALYTICS_ROLLUP] Last rollup date: ${lastDate.toISOString().slice(0, 10)} — gap-filling ${effectiveDays} days`);
  return runAnalyticsRollup(effectiveDays);
}

/**
 * Aggregate the last `days` days of campaign_sends + campaign_stats into the
 * analytics_daily rollup table. ON CONFLICT (date, campaign_id) DO UPDATE
 * makes this idempotent — a 7-day incremental rollup overwrites whatever the
 * previous 7-day rollup wrote, which is exactly what we want.
 *
 * Pass a large `days` value (e.g. 3650) for an initial all-time backfill.
 */
export async function runAnalyticsRollup(days: number): Promise<void> {
  const t0 = Date.now();

  await pool.query(
    `INSERT INTO analytics_daily (id, date, campaign_id, total_sent, total_delivered,
        total_opens, unique_opens, total_clicks, unique_clicks, total_bounces,
        total_unsubscribes, total_complaints, subscriber_growth, subscriber_churn, updated_at)
    SELECT
      gen_random_uuid(),
      d.date,
      d.campaign_id,
      COALESCE(sends.total_sent, 0),
      COALESCE(sends.total_delivered, 0),
      COALESCE(stats.total_opens, 0),
      COALESCE(stats.unique_opens, 0),
      COALESCE(stats.total_clicks, 0),
      COALESCE(stats.unique_clicks, 0),
      COALESCE(sends.total_bounces, 0),
      COALESCE(stats.total_unsubscribes, 0),
      COALESCE(stats.total_complaints, 0),
      0, 0, NOW()
    FROM (
      SELECT DISTINCT sent_at::date AS date, campaign_id
      FROM campaign_sends
      WHERE sent_at >= NOW() - $1::int * INTERVAL '1 day'
      UNION
      SELECT DISTINCT timestamp::date AS date, campaign_id
      FROM campaign_stats
      WHERE timestamp >= NOW() - $1::int * INTERVAL '1 day'
    ) d
    LEFT JOIN (
      SELECT
        sent_at::date AS date,
        campaign_id,
        COUNT(*)::int AS total_sent,
        COUNT(*) FILTER (WHERE status = 'sent')::int AS total_delivered,
        COUNT(*) FILTER (WHERE status = 'bounced')::int AS total_bounces
      FROM campaign_sends
      WHERE sent_at >= NOW() - $1::int * INTERVAL '1 day'
      GROUP BY sent_at::date, campaign_id
    ) sends ON sends.date = d.date AND sends.campaign_id = d.campaign_id
    LEFT JOIN (
      SELECT
        timestamp::date AS date,
        campaign_id,
        COUNT(*) FILTER (WHERE type = 'open')::int AS total_opens,
        COUNT(DISTINCT subscriber_id) FILTER (WHERE type = 'open')::int AS unique_opens,
        COUNT(*) FILTER (WHERE type = 'click')::int AS total_clicks,
        COUNT(DISTINCT subscriber_id) FILTER (WHERE type = 'click')::int AS unique_clicks,
        COUNT(*) FILTER (WHERE type = 'unsubscribe')::int AS total_unsubscribes,
        COUNT(*) FILTER (WHERE type = 'complaint')::int AS total_complaints
      FROM campaign_stats
      WHERE timestamp >= NOW() - $1::int * INTERVAL '1 day'
      GROUP BY timestamp::date, campaign_id
    ) stats ON stats.date = d.date AND stats.campaign_id = d.campaign_id
    ON CONFLICT (date, campaign_id) DO UPDATE SET
      total_sent = EXCLUDED.total_sent,
      total_delivered = EXCLUDED.total_delivered,
      total_opens = EXCLUDED.total_opens,
      unique_opens = EXCLUDED.unique_opens,
      total_clicks = EXCLUDED.total_clicks,
      unique_clicks = EXCLUDED.unique_clicks,
      total_bounces = EXCLUDED.total_bounces,
      total_unsubscribes = EXCLUDED.total_unsubscribes,
      total_complaints = EXCLUDED.total_complaints,
      updated_at = NOW()`,
    [days]
  );

  await pool.query(
    `INSERT INTO analytics_daily (id, date, campaign_id, total_sent, total_delivered,
        total_opens, unique_opens, total_clicks, unique_clicks, total_bounces,
        total_unsubscribes, total_complaints, subscriber_growth, subscriber_churn, updated_at)
    SELECT
      gen_random_uuid(), import_date::date, NULL,
      0, 0, 0, 0, 0, 0, 0, 0, 0,
      COUNT(*)::int, 0, NOW()
    FROM subscribers
    WHERE import_date >= NOW() - $1::int * INTERVAL '1 day'
    GROUP BY import_date::date
    ON CONFLICT (date, campaign_id) DO UPDATE SET
      subscriber_growth = EXCLUDED.subscriber_growth,
      updated_at = NOW()`,
    [days]
  );

  // Refresh per-subscriber engagement timestamp from the same window so
  // cohort analytics never have to scan campaign_stats. Bounded to the
  // rollup window (the bootstrap takes care of the historical backfill).
  await pool.query(
    `UPDATE subscribers s
     SET last_engaged_at = e.max_ts
     FROM (
       SELECT subscriber_id, MAX(timestamp) AS max_ts
       FROM campaign_stats
       WHERE timestamp >= NOW() - $1::int * INTERVAL '1 day'
         AND type IN ('open', 'click')
       GROUP BY subscriber_id
     ) e
     WHERE e.subscriber_id = s.id
       AND (s.last_engaged_at IS NULL OR e.max_ts > s.last_engaged_at)`,
    [days]
  );

  // Materialize the single-row totals view used by /api/analytics/overview.
  // Done in the worker process so the read endpoint is a PK lookup that
  // never blocks on a 14M-row COUNT(*).
  await runAnalyticsTotalsRefresh();

  logger.info(`[ANALYTICS_ROLLUP] Completed for last ${days} days in ${Date.now() - t0}ms`);

  // Cached metrics derived from the rollup are now stale.
  // Use the cross-process publisher: rollup runs in the worker process but
  // analytics reads happen in the web process — each has its own in-memory
  // cache. publishAnalyticsInvalidation() clears the local cache and fans
  // the invalidation out via Redis so the web instance drops its cache too.
  publishAnalyticsInvalidation();
}

/**
 * Refresh the single-row analytics_totals table. Each query is a single
 * COUNT(*) (or seq scan) that's not cheap on its own, but it runs in the
 * worker process every 15 minutes — totally off the request path. The
 * /api/analytics/overview endpoint then becomes a 1-row PK lookup.
 */
export async function runAnalyticsTotalsRefresh(): Promise<void> {
  const t0 = Date.now();
  const [subs, camps, sends, stats] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS n FROM subscribers`),
    pool.query(`SELECT COUNT(*)::int AS n FROM campaigns`),
    pool.query(`SELECT COUNT(*)::int AS total_sent,
                       COUNT(*) FILTER (WHERE status = 'bounced')::int AS total_bounces
                FROM campaign_sends`),
    pool.query(`SELECT COUNT(*) FILTER (WHERE type = 'open')::int AS total_opens,
                       COUNT(*) FILTER (WHERE type = 'click')::int AS total_clicks,
                       COUNT(*) FILTER (WHERE type = 'unsubscribe')::int AS total_unsubscribes
                FROM campaign_stats`),
  ]);

  await pool.query(
    `INSERT INTO analytics_totals (id, total_subscribers, total_campaigns,
        total_sent, total_bounces, total_opens, total_clicks, total_unsubscribes, updated_at)
     VALUES ('global', $1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (id) DO UPDATE SET
       total_subscribers = EXCLUDED.total_subscribers,
       total_campaigns = EXCLUDED.total_campaigns,
       total_sent = EXCLUDED.total_sent,
       total_bounces = EXCLUDED.total_bounces,
       total_opens = EXCLUDED.total_opens,
       total_clicks = EXCLUDED.total_clicks,
       total_unsubscribes = EXCLUDED.total_unsubscribes,
       updated_at = NOW()`,
    [
      subs.rows[0]?.n ?? 0,
      camps.rows[0]?.n ?? 0,
      sends.rows[0]?.total_sent ?? 0,
      sends.rows[0]?.total_bounces ?? 0,
      stats.rows[0]?.total_opens ?? 0,
      stats.rows[0]?.total_clicks ?? 0,
      stats.rows[0]?.total_unsubscribes ?? 0,
    ]
  );
  logger.info(`[ANALYTICS_TOTALS] Refreshed in ${Date.now() - t0}ms`);
}

/**
 * One-shot backfill of subscribers.last_engaged_at from the full history of
 * campaign_stats. Idempotent: a marker row in dashboard_cache prevents the
 * heavy scan from running on every startup. The incremental rollup keeps
 * the column up to date afterwards.
 */
export async function runEngagementBackfillOnce(): Promise<void> {
  const marker = await pool.query(
    `SELECT 1 FROM dashboard_cache WHERE key = 'analytics_engaged_backfill_done' LIMIT 1`
  );
  if (marker.rowCount && marker.rowCount > 0) return;

  const t0 = Date.now();
  logger.info("[ANALYTICS_BACKFILL] Backfilling subscribers.last_engaged_at from full campaign_stats history…");
  await pool.query(
    `UPDATE subscribers s
     SET last_engaged_at = e.max_ts
     FROM (
       SELECT subscriber_id, MAX(timestamp) AS max_ts
       FROM campaign_stats
       WHERE type IN ('open', 'click')
       GROUP BY subscriber_id
     ) e
     WHERE e.subscriber_id = s.id
       AND s.last_engaged_at IS NULL`
  );
  await pool.query(
    `INSERT INTO dashboard_cache (key, value, updated_at)
     VALUES ('analytics_engaged_backfill_done', $1::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JSON.stringify({ completedAt: new Date().toISOString() })]
  );
  logger.info(`[ANALYTICS_BACKFILL] last_engaged_at backfill complete in ${Date.now() - t0}ms`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Short cache (mirrors getSegmentSubscriberCountCached pattern)
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function pruneExpired(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}

/**
 * Read-through cache. Pass `forceRefresh=true` to bypass the lookup; the
 * recomputed value still populates the cache for subsequent callers.
 */
export async function getAnalyticsCached<T>(
  key: string,
  fn: () => Promise<T>,
  forceRefresh = false
): Promise<T> {
  const now = Date.now();
  if (!forceRefresh) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) return hit.value as T;
  }
  const value = await fn();
  cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
  // Opportunistic cleanup so the map doesn't grow unbounded with stale keys.
  if (cache.size > 100) pruneExpired(now);
  return value;
}

/**
 * Invalidate by exact key, by prefix, or (no arg) the whole cache. Called
 * from the rollup completion hook and from any code path that materially
 * changes the underlying data (e.g. campaign send completion).
 *
 * IMPORTANT: this clears the *local* in-process cache only. In split-process
 * mode (web + worker), data-mutating events happen in the worker but reads
 * happen in the web process — each has its own cache. Use
 * `publishAnalyticsInvalidation()` instead to fan out via Redis pub/sub so
 * both processes drop their cached values.
 */
export function invalidateAnalyticsCache(prefix?: string): void {
  if (!prefix) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

const ANALYTICS_INVALIDATION_CHANNEL = "analytics-invalidation";

/**
 * Cross-process invalidation. Clears the local cache immediately and, when
 * Redis is wired up, publishes to a channel that both web and worker
 * processes subscribe to so every instance drops the same keys.
 */
export function publishAnalyticsInvalidation(prefix?: string): void {
  invalidateAnalyticsCache(prefix);
  // Lazy-require so this module remains usable in unit tests without Redis.
  // The worker-side publisher uses the regular ioredis client (not a
  // dedicated subscriber connection — only subscriptions need that).
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { redisConnection, isRedisConfigured } = require("../redis");
    if (isRedisConfigured && redisConnection) {
      redisConnection
        .publish(ANALYTICS_INVALIDATION_CHANNEL, JSON.stringify({ prefix: prefix ?? null }))
        .catch(() => { /* best-effort fan-out */ });
    }
  } catch {
    // Redis module unavailable — local-only invalidation is the best we can do.
  }
}

/**
 * Subscribe a *dedicated* Redis subscriber connection to the analytics
 * invalidation channel. Subscriptions block the connection from issuing
 * other commands, so callers must pass a connection used only for pub/sub.
 * Call once from server/index.ts (web) and worker-main.ts (worker).
 */
export function startAnalyticsInvalidationSubscriber(redisSubscriber: any): void {
  redisSubscriber.subscribe(ANALYTICS_INVALIDATION_CHANNEL);
  redisSubscriber.on("message", (channel: string, message: string) => {
    if (channel !== ANALYTICS_INVALIDATION_CHANNEL) return;
    try {
      const { prefix } = JSON.parse(message) as { prefix: string | null };
      invalidateAnalyticsCache(prefix ?? undefined);
    } catch {
      // Malformed message — drop entire cache to be safe.
      invalidateAnalyticsCache();
    }
  });
}

export function parseRefreshFlag(query: any): boolean {
  return query?.refresh === "true" || query?.refresh === "1";
}
