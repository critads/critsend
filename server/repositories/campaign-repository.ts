import {
  campaigns,
  campaignStats,
  campaignSends,
  campaignJobs,
  nullsinkCaptures,
  errorLogs,
  importJobs,
  mtas,
  segments,
  campaignSegments,
  type Campaign,
  type CampaignListItem,
  type CampaignCalendarItem,
  type CampaignSendStateTotals,
  type InsertCampaign,
  type CampaignStat,
  type CampaignSend,
  type NullsinkCapture,
  type InsertNullsinkCapture,
} from "@shared/schema";
import { TAG_SUGGEST_STOPWORDS } from "../services/tag-suggestions";
import { db, pool } from "../db";
import { eq, desc, and, or, sql, ilike, isNull, isNotNull, ne, gte, gt, lt, inArray } from "drizzle-orm";
import crypto from "crypto";
import { logger } from "../logger";
import { campaignQueue } from "../queues";
import { mapWithConcurrency } from "../utils";
import { classifyDbError, isDiskFullError } from "../db-errors";
import { withAdvisoryLock, indexExistsAndValid, LOCK_KEYS, type LockResult } from "../bootstrap-lock";
import { toPgTextArray } from "../utils/pg-array";
import { publishCampaignsListInvalidation } from "./campaigns-list-cache";
import { zeroDupSendGuardEnabled, type SmtpOutcomeClass } from "../config/send-guard";
import {
  isTrackingTokensPartitioned,
  relationExists,
  ensureTrackingTokenPartitions,
  buildPartitionedTableDDL,
  legacyTokensTableExists,
  noteLegacyTokensTableGone,
  LEGACY_TOKENS_TABLE,
} from "../tracking-partitions";

const USE_BULLMQ = process.env.USE_BULLMQ === "true";

// ═══════════════════════════════════════════════════════════════
// CAMPAIGN MANAGEMENT
// ═══════════════════════════════════════════════════════════════

export type CampaignWithSegmentIds = Campaign & { segmentIds: string[] };

async function attachSegmentIds<T extends Campaign>(rows: T[]): Promise<(T & { segmentIds: string[] })[]> {
  if (!rows.length) return rows.map((row) => ({ ...row, segmentIds: row.segmentId ? [row.segmentId] : [] }));
  const ids = rows.map((row) => row.id);
  const relationRows = await db.select().from(campaignSegments)
    .where(inArray(campaignSegments.campaignId, ids))
    .orderBy(campaignSegments.campaignId, campaignSegments.position);
  const grouped = new Map<string, string[]>();
  for (const row of relationRows) {
    const values = grouped.get(row.campaignId) ?? [];
    values.push(row.segmentId);
    grouped.set(row.campaignId, values);
  }
  // A legacy row can predate bootstrap; exposing its legacy primary is the
  // compatibility fallback until bootstrap backfills it.
  return rows.map((row) => ({ ...row, segmentIds: grouped.get(row.id) ?? (row.segmentId ? [row.segmentId] : []) }));
}

export async function getCampaigns(): Promise<CampaignWithSegmentIds[]> {
  return attachSegmentIds(await db.select().from(campaigns).orderBy(desc(campaigns.createdAt)));
}

export type LowOpenCampaignAlert = {
  id: string;
  name: string;
  mtaName: string;
  startedAt: Date;
  sentCount: number;
  uniqueOpens: number;
  openRate: number;
};

/**
 * Recent campaigns that have had enough time to collect opens, but are still
 * within the operator's immediate-response window. Cached counters are used
 * deliberately: they are maintained by the tracking flusher/reconciler and
 * avoid scanning the large campaign_sends and campaign_stats tables on every
 * Campaigns page load.
 */
export async function getRecentLowOpenCampaignAlerts(): Promise<LowOpenCampaignAlert[]> {
  const result = await db.execute<{
    id: string;
    name: string;
    mta_name: string | null;
    started_at: Date | string;
    sent_count: number | string;
    unique_opens_count: number | string;
    open_rate: number | string;
  }>(sql`
    SELECT
      c.id,
      c.name,
      m.name AS mta_name,
      c.first_send_at AS started_at,
      c.sent_count,
      c.unique_opens_count,
      (c.unique_opens_count::numeric * 100 / c.sent_count)::float AS open_rate
    FROM campaigns c
    LEFT JOIN mtas m ON m.id = c.mta_id
    WHERE c.first_send_at >= NOW() - INTERVAL '48 hours'
      AND c.first_send_at < NOW() - INTERVAL '12 hours'
      AND c.sent_count > 0
      AND (c.unique_opens_count::numeric * 100 / c.sent_count) < 10
    ORDER BY open_rate ASC, c.first_send_at ASC
  `);

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    mtaName: row.mta_name ?? "Unknown MTA",
    startedAt: new Date(row.started_at),
    sentCount: Number(row.sent_count),
    uniqueOpens: Number(row.unique_opens_count),
    openRate: Number(row.open_rate),
  }));
}

export type SegmentPerformanceHistoryCandidate = {
  campaignId: string;
  name: string;
  segmentId: string;
  segmentName: string;
  totalClicks: number;
  deliveredCount: number;
  firstSentAt: Date;
};

function campaignBrandKeySql(alias: string, stopwordsParam: string, useUnaccent: boolean): string {
  const section = `(regexp_split_to_array(regexp_replace(${alias}.name, '^\\s*#\\s*\\d+\\s*', ''), '\\s+(?:-|–|—|\\|)\\s+'))[1]`;
  const normalizedSection = useUnaccent ? `f_unaccent(${section})` : section;
  return `(
    SELECT string_agg(token, chr(31) ORDER BY ordinal)
    FROM (
      SELECT token, min(ordinal) AS ordinal
      FROM regexp_split_to_table(lower(${normalizedSection}), '[^a-z0-9]+')
        WITH ORDINALITY AS parts(token, ordinal)
      WHERE length(token) >= 3
        AND token !~ '^\\d+$'
        AND NOT (token = ANY(${stopwordsParam}::text[]))
      GROUP BY token
      ORDER BY min(ordinal)
      LIMIT 8
    ) normalized_tokens
  )`;
}

/**
 * Fetches the small set of fields needed to rank segments for campaigns whose
 * names could match a requested brand. SQL reproduces the service's normalized
 * brand key and resolves the longest historical prefix before limiting history,
 * so brands sharing a first word cannot crowd one another out.
 */
export async function getSegmentPerformanceHistoryCandidates(
  requestedBrandKeys: string[],
  excludeId?: string | null,
): Promise<SegmentPerformanceHistoryCandidate[]> {
  const unaccentReady = isCampaignNameUnaccentIndexReady();
  const nameExpr = (alias: string) => unaccentReady ? `f_unaccent(${alias}.name)` : `${alias}.name`;
  const stopwords = [...TAG_SUGGEST_STOPWORDS];
  let resolvedKey: string | null = null;
  let anchorId: string | null = null;

  for (const key of requestedBrandKeys) {
    const pattern = `%${key.split("\u001f").join("%")}%`;
    const anchorParams: unknown[] = [pattern, key, stopwords];
    let anchorExcludeClause = "";
    if (excludeId) {
      anchorParams.push(excludeId);
      anchorExcludeClause = ` AND c.id != $4`;
    }
    const anchor = await pool.query<{ id: string }>(
      `SELECT c.id
       FROM campaigns c
       WHERE ${nameExpr("c")} ILIKE $1
          AND ${campaignBrandKeySql("c", "$3", unaccentReady)} = $2
         AND c.status IN ('completed', 'sent')
         AND c.first_send_at IS NOT NULL
         AND c.sent_count > 0${anchorExcludeClause}
       ORDER BY c.first_send_at DESC, c.id ASC
       LIMIT 1`,
      anchorParams,
    );
    if (anchor.rows[0]) {
      resolvedKey = key;
      anchorId = anchor.rows[0].id;
      break;
    }
  }

  if (!resolvedKey || !anchorId) return [];

  const resolvedPattern = `%${resolvedKey.split("\u001f").join("%")}%`;
  const params: unknown[] = [resolvedPattern, resolvedKey, stopwords, anchorId];
  const normalizedBrandKey = campaignBrandKeySql("c", "$3", unaccentReady);
  const brandMatchClause = resolvedKey.includes("\u001f")
    ? `(${normalizedBrandKey} = $2 OR ${normalizedBrandKey} LIKE $2 || chr(31) || '%')`
    : `${normalizedBrandKey} = $2`;
  let excludeClause = "";
  if (excludeId) {
    params.push(excludeId);
    excludeClause = ` AND c.id != $5`;
  }

  const result = await pool.query<{
    campaign_id: string;
    name: string;
    segment_id: string;
    segment_name: string;
    total_clicks_count: number | string | null;
    sent_count: number | string;
    first_send_at: Date | string;
  }>(
    `WITH recent_campaigns AS (
       SELECT c.id, c.name, c.segment_id, c.total_clicks_count, c.sent_count, c.first_send_at
       FROM campaigns c
       WHERE ${nameExpr("c")} ILIKE $1
         AND ${brandMatchClause}
         AND c.status IN ('completed', 'sent')
         AND c.first_send_at IS NOT NULL
         AND c.sent_count > 0${excludeClause}
       ORDER BY c.first_send_at DESC, c.id ASC
       LIMIT 250
     ),
     candidate_campaigns AS (
       SELECT * FROM recent_campaigns
       UNION ALL
       SELECT c.id, c.name, c.segment_id, c.total_clicks_count, c.sent_count, c.first_send_at
       FROM campaigns c
       WHERE c.id = $4
         AND NOT EXISTS (SELECT 1 FROM recent_campaigns rc WHERE rc.id = c.id)
     )
     SELECT
       c.id AS campaign_id,
       c.name,
       audience.segment_id,
       audience.segment_name,
       c.total_clicks_count,
       c.sent_count,
       c.first_send_at
     FROM candidate_campaigns c
     INNER JOIN LATERAL (
       SELECT cs.segment_id, s.name AS segment_name, cs.position
       FROM campaign_segments cs
       INNER JOIN segments s ON s.id = cs.segment_id
       WHERE cs.campaign_id = c.id
       UNION ALL
       SELECT c.segment_id, s.name AS segment_name, 0 AS position
       FROM segments s
       WHERE s.id = c.segment_id
         AND NOT EXISTS (SELECT 1 FROM campaign_segments cs WHERE cs.campaign_id = c.id)
     ) audience ON true
     ORDER BY c.first_send_at DESC, c.id ASC, audience.position ASC`,
    params,
  );

  return result.rows.map((row) => ({
    campaignId: row.campaign_id,
    name: row.name,
    segmentId: row.segment_id,
    segmentName: row.segment_name,
    totalClicks: Number(row.total_clicks_count) || 0,
    deliveredCount: Number(row.sent_count) || 0,
    firstSentAt: new Date(row.first_send_at),
  }));
}

export async function getCampaignsPaginated(opts: {
  page: number;
  limit: number;
  search?: string;
  originalsOnly?: boolean;
  scheduledFrom?: Date;
  scheduledTo?: Date;
}): Promise<{ campaigns: (Campaign & { mtaName: string | null })[]; total: number }> {
  const { page, limit, search, originalsOnly, scheduledFrom, scheduledTo } = opts;
  const offset = (page - 1) * limit;

  // Task #185: hide synthetic "automation_internal" campaigns from the
  // user-facing list. These rows exist only as FK targets for tracking
  // events generated by automation send_email steps.
  const conditions: any[] = [ne(campaigns.status, "automation_internal")];
  if (search) {
    const pattern = `%${search}%`;
    conditions.push(or(
      ilike(campaigns.name, pattern),
      ilike(campaigns.subject, pattern),
      sql`EXISTS (SELECT 1 FROM ${segments} WHERE ${segments.id} = ${campaigns.segmentId} AND ${segments.name} ILIKE ${pattern})`,
    ));
  }
  if (originalsOnly) {
    conditions.push(isNull(campaigns.parentCampaignId));
  }
  // Task #188: scheduled-date filter. When either bound is set we also
  // require scheduled_at IS NOT NULL so draft/unscheduled rows fall out
  // (they have no meaningful date to filter against). Drafts remain
  // visible when neither bound is set, preserving prior behaviour.
  if (scheduledFrom || scheduledTo) {
    if (scheduledFrom) conditions.push(gte(campaigns.scheduledAt, scheduledFrom));
    if (scheduledTo) conditions.push(lt(campaigns.scheduledAt, scheduledTo));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [countResult] = await db.select({ count: sql<number>`count(*)::int` })
    .from(campaigns)
    .where(whereClause);
  const total = countResult?.count ?? 0;

  // Phase-1 perf fix (audit 2026-05-26): replaced the two per-row correlated
  // subqueries (`pressureHeldCount` + `realPendingCount`) on
  // `campaign_sends` (~67M rows) with a SINGLE aggregate query scoped to
  // the page's campaign ids. Before: 2 sub-selects × 20 rows = 40
  // partial-index lookups per /api/campaigns hit. After: 1 grouped scan
  // over the partial index `campaign_sends_campaign_status_idx` filtered
  // to ≤ 20 ids. Total handler DB time drops ~70-80%, which removes the
  // dominant cause of `load_shed` 503s on this endpoint without touching
  // pool sizes, indexes, or Neon. The semantics of both columns are
  // preserved (still live values, not the drift-prone cached counters).
  const rows = await db.select({
      id: campaigns.id,
      name: campaigns.name,
      mtaId: campaigns.mtaId,
      mtaName: mtas.name,
      segmentId: campaigns.segmentId,
      fromName: campaigns.fromName,
      fromEmail: campaigns.fromEmail,
      replyEmail: campaigns.replyEmail,
      subject: campaigns.subject,
      preheader: campaigns.preheader,
      trackClicks: campaigns.trackClicks,
      trackOpens: campaigns.trackOpens,
      unsubscribeText: campaigns.unsubscribeText,
      companyAddress: campaigns.companyAddress,
      sendingSpeed: campaigns.sendingSpeed,
      scheduledAt: campaigns.scheduledAt,
      status: campaigns.status,
      pauseReason: campaigns.pauseReason,
      retryUntil: campaigns.retryUntil,
      openTag: campaigns.openTag,
      clickTag: campaigns.clickTag,
      unsubscribeTag: campaigns.unsubscribeTag,
      sentCount: campaigns.sentCount,
      pendingCount: campaigns.pendingCount,
      failedCount: campaigns.failedCount,
      // Cumulative defer count — kept for back-compat / metrics. Do NOT use
      // this for "currently held by pressure guard" UX, it only grows.
      deferredCount: campaigns.deferredCount,
      autoRetryCount: campaigns.autoRetryCount,
      uniqueOpensCount: campaigns.uniqueOpensCount,
      totalOpensCount: campaigns.totalOpensCount,
      uniqueClicksCount: campaigns.uniqueClicksCount,
      totalClicksCount: campaigns.totalClicksCount,
      unsubscribesCount: campaigns.unsubscribesCount,
      complaintsCount: campaigns.complaintsCount,
      parentCampaignId: campaigns.parentCampaignId,
      followUpEnabled: campaigns.followUpEnabled,
      followUpDelayHours: campaigns.followUpDelayHours,
      followUpSubject: campaigns.followUpSubject,
      followUpScheduledAt: campaigns.followUpScheduledAt,
      followUpCampaignId: campaigns.followUpCampaignId,
      stepSendLimit: campaigns.stepSendLimit,
      stepProcessedCount: campaigns.stepProcessedCount,
      stepCursorId: campaigns.stepCursorId,
      createdAt: campaigns.createdAt,
      startedAt: campaigns.startedAt,
      completedAt: campaigns.completedAt,
    })
    .from(campaigns)
    .leftJoin(mtas, eq(campaigns.mtaId, mtas.id))
    .where(whereClause)
    .orderBy(desc(campaigns.createdAt))
    .limit(limit)
    .offset(offset);

  // Single aggregate scoped to the page's ids — replaces N correlated
  // subqueries. Uses `campaign_sends_campaign_status_idx` (filtered by
  // status='pending') so even on a 67M-row table this is index-only and
  // returns only as many groups as there are sending campaigns in the
  // page (typically 0-5).
  const pageIds = rows.map((r) => r.id);
  const liveCountsMap = new Map<string, { pressureHeld: number; realPending: number }>();
  if (pageIds.length > 0) {
    const liveCountsRes = await db.execute<{
      campaign_id: string;
      pressure_held: string | number;
      real_pending: string | number;
    }>(sql`
      SELECT
        campaign_id,
        COUNT(*) FILTER (WHERE eligible_at IS NOT NULL)::int AS pressure_held,
        COUNT(*)::int AS real_pending
      FROM ${campaignSends}
      WHERE campaign_id = ANY(${toPgTextArray(pageIds)}::text[])
        AND status = 'pending'
      GROUP BY campaign_id
    `);
    for (const r of liveCountsRes.rows) {
      liveCountsMap.set(r.campaign_id, {
        pressureHeld: Number(r.pressure_held) || 0,
        realPending: Number(r.real_pending) || 0,
      });
    }
  }
  const segmentIdsMap = new Map<string, string[]>();
  if (pageIds.length > 0) {
    const audienceRows = await db.select().from(campaignSegments)
      .where(inArray(campaignSegments.campaignId, pageIds))
      .orderBy(campaignSegments.campaignId, campaignSegments.position);
    for (const row of audienceRows) {
      const ids = segmentIdsMap.get(row.campaignId) ?? [];
      ids.push(row.segmentId);
      segmentIdsMap.set(row.campaignId, ids);
    }
  }

  const enriched = rows.map((row) => {
    const live = liveCountsMap.get(row.id);
    return {
      ...row,
      segmentIds: segmentIdsMap.get(row.id) ?? (row.segmentId ? [row.segmentId] : []),
      pressureHeldCount: live?.pressureHeld ?? 0,
      realPendingCount: live?.realPending ?? 0,
    };
  });

  return { campaigns: enriched as unknown as CampaignListItem[], total };
}

export async function getCampaignCalendar(
  from: Date,
  to: Date,
  asOf = new Date(),
): Promise<CampaignCalendarItem[]> {
  const actualStart = sql<Date>`COALESCE(${campaigns.firstSendAt}, ${campaigns.startedAt}, ${campaigns.scheduledAt})`;
  const actualEnd = sql<Date>`COALESCE(${campaigns.lastSendAt}, ${campaigns.completedAt}, ${campaigns.firstSendAt}, ${campaigns.startedAt}, ${campaigns.scheduledAt})`;
  const finishedStatuses = ["paused", "failed", "completed", "sent", "cancelled"];

  return db.select({
    id: campaigns.id,
    name: campaigns.name,
    mtaId: campaigns.mtaId,
    mtaName: mtas.name,
    status: campaigns.status,
    scheduledAt: campaigns.scheduledAt,
    firstSendAt: campaigns.firstSendAt,
    lastSendAt: campaigns.lastSendAt,
    startedAt: campaigns.startedAt,
    completedAt: campaigns.completedAt,
  })
    .from(campaigns)
    .leftJoin(mtas, eq(campaigns.mtaId, mtas.id))
    .where(and(
      inArray(campaigns.status, [
        "scheduled",
        "sending",
        "paused",
        "failed",
        "completed",
        "sent",
        "cancelled",
      ]),
      or(
        and(
          eq(campaigns.status, "scheduled"),
          gte(campaigns.scheduledAt, from),
          lt(campaigns.scheduledAt, to),
        ),
        and(
          eq(campaigns.status, "sending"),
          sql`${actualStart} IS NOT NULL`,
          lt(actualStart, to),
          gt(sql`${asOf}`, from),
        ),
        and(
          inArray(campaigns.status, finishedStatuses),
          sql`${actualStart} IS NOT NULL`,
          lt(actualStart, to),
          gt(actualEnd, from),
        ),
      ),
    ))
    .orderBy(sql`COALESCE(${campaigns.scheduledAt}, ${campaigns.firstSendAt}, ${campaigns.startedAt}) ASC`);
}

/**
 * Partial covering index for the hot `/api/campaigns?originalsOnly=true`
 * list path (the default Campaigns screen view). Without it, Postgres falls
 * back to a sequential scan + sort for every page render, which under load
 * holds a main-pool connection long enough to push the pool over 90%
 * saturation and trip the load-shed middleware.
 *
 * Filtered on `parent_campaign_id IS NULL` (A/B variant children excluded)
 * so the index only carries the rows users actually browse, and ordered by
 * `created_at DESC` to satisfy the ORDER BY without a sort step.
 */
export async function ensureCampaignOriginalsListIndex(): Promise<LockResult | "exists"> {
  if (await indexExistsAndValid("campaigns_originals_created_at_idx")) {
    logger.info("[INDEX] campaigns_originals_created_at_idx already exists — skipping");
    return "exists";
  }
  const result = await withAdvisoryLock(
    LOCK_KEYS.CAMPAIGN_ORIGINALS_LIST,
    "CAMPAIGN_ORIGINALS_LIST",
    async (_lockClient) => {
      await pool.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS campaigns_originals_created_at_idx
           ON campaigns (created_at DESC)
           WHERE parent_campaign_id IS NULL`,
      );
    },
  );
  if (result === "ran") {
    logger.info("[INDEX] campaigns_originals_created_at_idx created successfully");
  } else if (result === "skipped") {
    logger.info("[INDEX] campaigns_originals_created_at_idx creation skipped — another process is handling it");
  } else {
    logger.warn("[INDEX] campaigns_originals_created_at_idx creation encountered an error during advisory lock");
  }
  return result;
}

/**
 * Per-campaign partial index used by the live "held by pressure guard" count
 * surfaced on the `/api/campaigns` list (UI progress bar — Task #163 follow-up).
 *
 * The existing `campaign_sends_pressure_deferred_idx` is keyed on
 * `(eligible_at)` and is great for the FIFO drain poll, but it forces
 * Postgres to scan every deferred row in the system when we want a
 * per-campaign count. This index narrows that to a per-campaign lookup.
 *
 * `WHERE status='pending' AND eligible_at IS NOT NULL` matches exactly the
 * predicate of the subquery in `listCampaignsPaginated`, so the planner can
 * use this as a covering index and answer the count from the index alone.
 */
export async function ensureCampaignSendsPressureHeldIndex(): Promise<LockResult | "exists"> {
  if (await indexExistsAndValid("campaign_sends_pressure_held_per_campaign_idx")) {
    logger.info("[INDEX] campaign_sends_pressure_held_per_campaign_idx already exists — skipping");
    return "exists";
  }
  const result = await withAdvisoryLock(
    LOCK_KEYS.CAMPAIGN_SENDS_PRESSURE_HELD,
    "CAMPAIGN_SENDS_PRESSURE_HELD",
    async (_lockClient) => {
      await pool.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_sends_pressure_held_per_campaign_idx
           ON campaign_sends (campaign_id)
           WHERE status = 'pending' AND eligible_at IS NOT NULL`,
      );
    },
  );
  if (result === "ran") {
    logger.info("[INDEX] campaign_sends_pressure_held_per_campaign_idx created successfully");
  } else if (result === "skipped") {
    logger.info("[INDEX] campaign_sends_pressure_held_per_campaign_idx creation skipped — another process is handling it");
  } else {
    logger.warn("[INDEX] campaign_sends_pressure_held_per_campaign_idx creation encountered an error during advisory lock");
  }
  return result;
}

/**
 * B-tree index on `campaigns.scheduled_at` to keep the Task #188 date-range
 * filter on the `/campaigns` list fast. The list endpoint orders by
 * `created_at DESC` and adds `scheduled_at >= :from AND scheduled_at < :to`
 * when a preset (Today / Yesterday / Custom) is active. Without this index,
 * the count + page queries fall back to a seq scan over every campaign row,
 * which under load holds a main-pool connection long enough to trip the
 * load-shed middleware.
 *
 * `WHERE scheduled_at IS NOT NULL` keeps the index narrow (drafts and never-
 * scheduled rows are excluded anyway when a date bound is set — see the
 * conditions block in `getCampaignsPaginated`).
 */
export async function ensureCampaignsScheduledAtIndex(): Promise<LockResult | "exists"> {
  if (await indexExistsAndValid("campaigns_scheduled_at_idx")) {
    logger.info("[INDEX] campaigns_scheduled_at_idx already exists — skipping");
    return "exists";
  }
  const result = await withAdvisoryLock(
    LOCK_KEYS.CAMPAIGNS_SCHEDULED_AT,
    "CAMPAIGNS_SCHEDULED_AT",
    async (_lockClient) => {
      await pool.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS campaigns_scheduled_at_idx
           ON campaigns (scheduled_at)
           WHERE scheduled_at IS NOT NULL`,
      );
    },
  );
  if (result === "ran") {
    logger.info("[INDEX] campaigns_scheduled_at_idx created successfully");
  } else if (result === "skipped") {
    logger.info("[INDEX] campaigns_scheduled_at_idx creation skipped — another process is handling it");
  } else {
    logger.warn("[INDEX] campaigns_scheduled_at_idx creation encountered an error during advisory lock");
  }
  return result;
}

/**
 * Expression indexes matching the calendar's bounded interval predicates.
 * They keep historical completed campaigns and long-running live campaigns
 * from turning calendar navigation into a growing sequential table scan.
 */
export async function ensureCampaignCalendarIndexes(): Promise<LockResult | "exists"> {
  const definitions = [
    {
      name: "campaigns_calendar_actual_end_idx",
      sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS campaigns_calendar_actual_end_idx
            ON campaigns (
              (COALESCE(last_send_at, completed_at, first_send_at, started_at, scheduled_at))
            )
            WHERE status IN ('paused', 'failed', 'completed', 'sent', 'cancelled')`,
    },
    {
      name: "campaigns_calendar_sending_start_idx",
      sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS campaigns_calendar_sending_start_idx
            ON campaigns (
              (COALESCE(first_send_at, started_at, scheduled_at))
            )
            WHERE status = 'sending'`,
    },
  ];
  const validity = await Promise.all(
    definitions.map(({ name }) => indexExistsAndValid(name)),
  );
  if (validity.every(Boolean)) {
    logger.info("[INDEX] Campaign calendar indexes already exist — skipping");
    return "exists";
  }
  const result = await withAdvisoryLock(
    LOCK_KEYS.CAMPAIGN_CALENDAR_INDEXES,
    "CAMPAIGN_CALENDAR_INDEXES",
    async (_lockClient) => {
      for (const definition of definitions) {
        const invalidIndex = await pool.query<{ invalid: boolean }>(`
          SELECT EXISTS (
            SELECT 1
            FROM pg_index
            WHERE indexrelid = to_regclass('${definition.name}')
              AND indisvalid = false
          ) AS invalid
        `);
        if (invalidIndex.rows[0]?.invalid) {
          logger.warn(`[INDEX] ${definition.name} is invalid — rebuilding`);
          await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS ${definition.name}`);
        }
        await pool.query(definition.sql);
      }
    },
  );
  if (result === "ran") {
    logger.info("[INDEX] Campaign calendar indexes created successfully");
  } else if (result === "skipped") {
    logger.info("[INDEX] Campaign calendar index creation skipped — another process is handling it");
  } else {
    logger.warn("[INDEX] Campaign calendar index creation encountered an error during advisory lock");
  }
  return result;
}

/**
 * Supports the bounded low-open campaign alert query. The partial predicate
 * excludes drafts and campaigns that never delivered anything, keeping this
 * index small even when the campaign table grows.
 */
export async function ensureCampaignsFirstSendAtIndex(): Promise<LockResult | "exists" | "not_ready"> {
  const columnExists = await pool.query<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'campaigns'
        AND column_name = 'first_send_at'
    ) AS exists
  `);
  if (!columnExists.rows[0]?.exists) {
    logger.warn("[INDEX] campaigns.first_send_at is not ready — skipping low-open alert index for this boot");
    return "not_ready";
  }
  if (await indexExistsAndValid("campaigns_first_send_at_idx")) {
    logger.info("[INDEX] campaigns_first_send_at_idx already exists — skipping");
    return "exists";
  }
  const result = await withAdvisoryLock(
    LOCK_KEYS.CAMPAIGNS_FIRST_SEND_AT,
    "CAMPAIGNS_FIRST_SEND_AT",
    async (_lockClient) => {
      const invalidIndex = await pool.query<{ invalid: boolean }>(`
        SELECT EXISTS (
          SELECT 1
          FROM pg_index
          WHERE indexrelid = to_regclass('campaigns_first_send_at_idx')
            AND indisvalid = false
        ) AS invalid
      `);
      if (invalidIndex.rows[0]?.invalid) {
        // This new index is never used while INVALID, so replacing it cannot
        // regress current query plans. This repairs an interrupted first
        // deployment before retrying the concurrent build.
        logger.warn("[INDEX] campaigns_first_send_at_idx is invalid — rebuilding");
        await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS campaigns_first_send_at_idx`);
      }
      await pool.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS campaigns_first_send_at_idx
         ON campaigns (first_send_at)
         WHERE first_send_at IS NOT NULL AND sent_count > 0`,
      );
    },
  );
  if (result === "ran") {
    logger.info("[INDEX] campaigns_first_send_at_idx created successfully");
  } else if (result === "skipped") {
    logger.info("[INDEX] campaigns_first_send_at_idx creation skipped — another process is handling it");
  } else {
    logger.warn("[INDEX] campaigns_first_send_at_idx creation encountered an error during advisory lock");
  }
  return result;
}

export async function ensureCampaignNameTrigramIndex(): Promise<LockResult | "exists"> {
  if (await indexExistsAndValid("campaign_name_trgm_idx")) {
    logger.info("[TRIGRAM] campaign_name_trgm_idx already exists — skipping");
    return "exists";
  }
  const result = await withAdvisoryLock(
    LOCK_KEYS.CAMPAIGN_NAME_TRGM,
    "CAMPAIGN_NAME_TRGM",
    async (_lockClient) => {
      await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
      await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_name_trgm_idx ON campaigns USING gin (name gin_trgm_ops)`);
    },
  );
  if (result === "ran") {
    logger.info("[TRIGRAM] campaign_name_trgm_idx created successfully");
  } else if (result === "skipped") {
    logger.info("[TRIGRAM] campaign_name_trgm_idx creation skipped — another process is handling it");
  } else {
    logger.warn("[TRIGRAM] campaign_name_trgm_idx creation encountered an error during advisory lock");
  }
  return result;
}

/**
 * Tag suggestions (Task #237): accent-insensitive brand matching on campaign
 * names. Provisions, under an advisory lock:
 *   1. the `unaccent` extension (and `pg_trgm`, in case this runs before the
 *      plain-name trigram bootstrap on a fresh deployment),
 *   2. `f_unaccent(text)` — an IMMUTABLE wrapper required to index the
 *      folded expression,
 *   3. a trigram GIN index on `f_unaccent(name)`, built CONCURRENTLY so
 *      campaign inserts/updates are never blocked by the build.
 * Readiness (checked via `isCampaignNameUnaccentIndexReady`) is only set
 * after the index is confirmed to exist AND be valid, so a failed
 * CONCURRENTLY build never routes queries to a broken index. When the DB
 * role can't install extensions, the tag-suggestion route degrades to
 * accent-sensitive matching on campaign_name_trgm_idx.
 */
let campaignNameUnaccentIndexReady = false;
export function isCampaignNameUnaccentIndexReady(): boolean {
  return campaignNameUnaccentIndexReady;
}
export async function ensureCampaignNameUnaccentTrigramIndex(): Promise<LockResult | "exists"> {
  const validate = async (): Promise<boolean> => {
    if (!(await indexExistsAndValid("campaign_name_unaccent_trgm_idx"))) return false;
    // The index alone isn't enough — queries also call f_unaccent directly.
    try {
      await pool.query(`SELECT f_unaccent('é')`);
      return true;
    } catch {
      return false;
    }
  };
  if (await validate()) {
    campaignNameUnaccentIndexReady = true;
    logger.info("[TRIGRAM] campaign_name_unaccent_trgm_idx already exists — skipping");
    return "exists";
  }
  const result = await withAdvisoryLock(
    LOCK_KEYS.CAMPAIGN_NAME_UNACCENT_TRGM,
    "CAMPAIGN_NAME_UNACCENT_TRGM",
    async (_lockClient) => {
      await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
      await pool.query(`CREATE EXTENSION IF NOT EXISTS unaccent`);
      await pool.query(
        `CREATE OR REPLACE FUNCTION f_unaccent(text)
         RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
         AS $func$ SELECT public.unaccent('public.unaccent', $1) $func$`,
      );
      await pool.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_name_unaccent_trgm_idx
           ON campaigns USING gin (f_unaccent(name) gin_trgm_ops)`,
      );
    },
  );
  // Validate regardless of who built it (this process or a concurrent boot).
  campaignNameUnaccentIndexReady = await validate();
  if (result === "ran" && campaignNameUnaccentIndexReady) {
    logger.info("[TRIGRAM] campaign_name_unaccent_trgm_idx created successfully");
  } else if (result === "skipped") {
    logger.info("[TRIGRAM] campaign_name_unaccent_trgm_idx creation skipped — another process is handling it");
  } else if (!campaignNameUnaccentIndexReady) {
    logger.warn("[TRIGRAM] campaign_name_unaccent_trgm_idx not ready — tag suggestions fall back to accent-sensitive matching");
  }
  return result;
}

export async function ensureCampaignSubjectTrigramIndex(): Promise<LockResult | "exists"> {
  if (await indexExistsAndValid("campaign_subject_trgm_idx")) {
    logger.info("[TRIGRAM] campaign_subject_trgm_idx already exists — skipping");
    return "exists";
  }
  const result = await withAdvisoryLock(
    LOCK_KEYS.CAMPAIGN_SUBJECT_TRGM,
    "CAMPAIGN_SUBJECT_TRGM",
    async (_lockClient) => {
      await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
      await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_subject_trgm_idx ON campaigns USING gin (subject gin_trgm_ops)`);
    },
  );
  if (result === "ran") {
    logger.info("[TRIGRAM] campaign_subject_trgm_idx created successfully");
  } else if (result === "skipped") {
    logger.info("[TRIGRAM] campaign_subject_trgm_idx creation skipped — another process is handling it");
  } else {
    logger.warn("[TRIGRAM] campaign_subject_trgm_idx creation encountered an error during advisory lock");
  }
  return result;
}

export async function getCampaign(id: string): Promise<CampaignWithSegmentIds | undefined> {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  return campaign ? (await attachSegmentIds([campaign]))[0] : undefined;
}

export async function getCampaignStatus(id: string): Promise<string | null> {
  const result = await db.execute(sql`SELECT status FROM campaigns WHERE id = ${id} LIMIT 1`);
  return result.rows.length > 0 ? (result.rows[0] as any).status : null;
}

export async function getCampaignsByPauseReason(reason: string): Promise<Campaign[]> {
  return db.select().from(campaigns)
    .where(and(eq(campaigns.status, "paused"), eq(campaigns.pauseReason, reason)));
}

export async function createCampaign(data: InsertCampaign): Promise<Campaign> {
  const [campaign] = await db.insert(campaigns).values(data).returning();
  // New campaign must appear in the list immediately — drop the short cache.
  publishCampaignsListInvalidation();
  return campaign;
}

export async function updateCampaign(id: string, data: Partial<Campaign>): Promise<Campaign | undefined> {
  const [campaign] = await db.update(campaigns).set(data).where(eq(campaigns.id, id)).returning();
  // State transition (status/edit/schedule/etc.) — drop the short list cache.
  // Per-send counters never flow through here (they use atomic SQL helpers),
  // so this does NOT thrash the cache during active sending.
  publishCampaignsListInvalidation();
  return campaign;
}

// Bounded timeouts for the campaign delete cascade. Without these a genuinely
// large cascade or a hot row-lock (e.g. the live sender holding `campaigns`)
// can make the DELETE hang indefinitely, turning the UI into an infinite
// spinner with no feedback (the original symptom of Task #211). `lock_timeout`
// caps how long we wait to ACQUIRE a contended lock; `statement_timeout` caps
// total runtime of any single statement. On breach Postgres raises 55P03
// (lock_not_available) / 57014 (query_canceled) and the whole transaction
// rolls back atomically — an infinite spinner becomes a clear, retryable error.
const DELETE_LOCK_TIMEOUT_MS = Number(process.env.CAMPAIGN_DELETE_LOCK_TIMEOUT_MS) || 5000;
const DELETE_STATEMENT_TIMEOUT_MS = Number(process.env.CAMPAIGN_DELETE_STATEMENT_TIMEOUT_MS) || 30000;

export async function deleteCampaign(id: string): Promise<void> {
  // Run the whole cascade in ONE transaction so SET LOCAL applies to every
  // statement (SET LOCAL only lives for the current transaction) and so a
  // timeout mid-cascade rolls back cleanly instead of leaving orphan rows.
  // SET LOCAL is also the only correct choice under Neon's PgBouncer
  // transaction pooling, which strips connection-level startup parameters.
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = ${DELETE_LOCK_TIMEOUT_MS}`));
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${DELETE_STATEMENT_TIMEOUT_MS}`));
    await tx.delete(nullsinkCaptures).where(eq(nullsinkCaptures.campaignId, id));
    // campaign_sends and campaign_stats cascade from campaign FK
    await tx.delete(campaignJobs).where(eq(campaignJobs.campaignId, id));
    await tx.delete(errorLogs).where(eq(errorLogs.campaignId, id));
    await tx.execute(sql`DELETE FROM pending_tag_operations WHERE campaign_id = ${id}`);
    await tx.execute(sql`DELETE FROM analytics_daily WHERE campaign_id = ${id}`);
    await tx.delete(campaigns).where(eq(campaigns.id, id));
  });
  publishCampaignsListInvalidation();
}

export async function copyCampaign(id: string): Promise<Campaign | undefined> {
  const original = await getCampaign(id);
  if (!original) return undefined;
  const sourceSegmentIds = original.segmentIds.length
    ? original.segmentIds
    : (original.segmentId ? [original.segmentId] : []);
  // Strip identity, timing, counters, AND follow-up linkage. A copy is a
  // brand-new original — never inherit parent/child references because the
  // partial-unique index on parent_campaign_id would block the insert if
  // the parent already had its single child spawned.
  const {
    id: _,
    createdAt,
    startedAt,
    completedAt,
    firstSendAt: _fsa,
    lastSendAt: _lsa,
    sentCount,
    pendingCount,
    failedCount,
    autoRetryCount: _arc,
    totalOpensCount: _toc,
    uniqueOpensCount: _uoc,
    totalClicksCount: _tcc,
    uniqueClicksCount: _ucc,
    unsubscribesCount: _uc,
    complaintsCount: _cc,
    parentCampaignId: _p,
    followUpCampaignId: _fc,
    followUpScheduledAt: _fs,
    // Urgent mode is an operator-scoped bypass on a specific live send;
    // copying must NEVER inherit it. A copied draft starts in normal
    // pressure-guard mode and the operator can re-enable urgent on the
    // new campaign explicitly if needed.
    urgentMode: _um,
    // A copy must not inherit the original's schedule — default it to the
    // moment of the copy (operator request 2026-08-09).
    scheduledAt: _sched,
    segmentIds: _segmentIds,
    ...copyData
  } = original;
  const copied = await db.transaction(async (tx) => {
    const [campaign] = await tx.insert(campaigns).values({
      ...copyData,
      segmentId: sourceSegmentIds[0] ?? null,
      scheduledAt: new Date(),
      // Keep the operator's original campaign name unchanged. The duplicate is
      // already identifiable as a distinct draft by its own ID and creation
      // time; adding "(Copy)" breaks naming conventions used for tag history.
      name: original.name,
      status: "draft",
      sendingSpeed: original.sendingSpeed as "drip" | "very_slow" | "slow" | "medium" | "fast" | "godzilla",
    }).returning();
    if (sourceSegmentIds.length) {
      await tx.insert(campaignSegments).values(
        sourceSegmentIds.map((segmentId, position) => ({
          campaignId: campaign.id,
          segmentId,
          position,
        })),
      );
    }
    return campaign;
  });
  publishCampaignsListInvalidation();
  return copied;
}

// ═══════════════════════════════════════════════════════════════
// AUTO-RESEND TO OPENERS — Task #56 helpers
// ═══════════════════════════════════════════════════════════════

/**
 * Stamp followUpScheduledAt = now() + delayHours on the parent. Called from
 * campaign-sender.ts when the parent transitions to "completed". Idempotent:
 * only stamps if the column is currently NULL so a manual rerun cannot
 * accidentally double-trigger the spawner.
 */
export async function markFollowUpScheduled(parentCampaignId: string, delayHours: number): Promise<void> {
  await db.execute(sql`
    UPDATE campaigns
    SET follow_up_scheduled_at = NOW() + (${delayHours} || ' hours')::interval
    WHERE id = ${parentCampaignId}
      AND follow_up_enabled = true
      AND follow_up_campaign_id IS NULL
      AND follow_up_scheduled_at IS NULL
  `);
}

/**
 * Returns parents whose follow-up should be SPAWNED (not yet sent — the
 * spawn happens immediately after the parent completes). The child is
 * created in `scheduled` state with scheduledAt = parent.completedAt +
 * delayHours so it lives in the campaigns list for the entire delay
 * window and the user can pause / edit / cancel it through the standard
 * scheduled-campaign controls. Promotion to `sending` is then handled by
 * `pollScheduledCampaigns` when the scheduled time arrives.
 *
 * We deliberately DO NOT require `follow_up_scheduled_at <= NOW()` — that
 * would defer creation until the very moment of send and rob users of
 * the ability to interact with the queued follow-up beforehand.
 *
 * Caps at `limit` so a massive backlog (e.g. after a multi-day worker
 * outage) drains over time rather than overwhelming the queue in one tick.
 */
export async function findFollowUpCandidates(limit: number = 25): Promise<Campaign[]> {
  return db.select().from(campaigns).where(
    and(
      eq(campaigns.followUpEnabled, true),
      sql`${campaigns.followUpCampaignId} IS NULL`,
      sql`${campaigns.followUpScheduledAt} IS NOT NULL`,
      // Only originals — a child cannot itself spawn a follow-up.
      sql`${campaigns.parentCampaignId} IS NULL`,
      // Parent must have FINISHED sending. We refuse to follow-up a
      // paused/aborted parent because openers would be a partial sample.
      sql`${campaigns.status} IN ('completed', 'sent')`,
    ),
  ).limit(limit);
}

/**
 * Spawn the follow-up child campaign for `parent`. The child is created in
 * "draft" state and linked back via `followUpCampaignId`. Audience iteration
 * for the child is handled by the sender (see parentCampaignId branch in
 * campaign-sender.ts). Returns the new child, or undefined when the parent
 * already has a child (race-safe via the partial-unique index on
 * parent_campaign_id).
 */
export async function spawnFollowUpCampaign(
  parent: Campaign,
): Promise<Campaign | undefined> {
  // Child is created as 'scheduled' so the standard scheduled-campaign
  // poller promotes it at scheduledAt and the user can edit/cancel during
  // the delay window. Audience is resolved at send time by the sender.
  const delayMs = (parent.followUpDelayHours ?? 36) * 60 * 60 * 1000;
  const scheduledAt =
    parent.followUpScheduledAt ??
    (parent.completedAt ? new Date(parent.completedAt.getTime() + delayMs) : new Date(Date.now() + delayMs));

  const child = {
    name: `${parent.name} (Follow-up)`,
    mtaId: parent.mtaId,
    // Per spec: follow-up children are NOT segment-sourced — their audience
    // is the openers of the parent campaign (resolved at send time via
    // countOpenersForParentCampaign / getOpenersForParentCampaignCursor in
    // campaign-sender.ts). Setting segmentId=null avoids any UI/code path
    // that would otherwise try to resolve recipients from a segment for a
    // follow-up. List/detail rendering already labels follow-up rows by
    // their parentCampaignId rather than by segment.
    segmentId: null,
    fromName: parent.fromName,
    fromEmail: parent.fromEmail,
    replyEmail: parent.replyEmail ?? null,
    subject: parent.followUpSubject ?? parent.subject,
    preheader: parent.preheader ?? null,
    htmlContent: parent.htmlContent,
    trackOpens: parent.trackOpens,
    trackClicks: parent.trackClicks,
    unsubscribeText: parent.unsubscribeText ?? "Unsubscribe",
    companyAddress: parent.companyAddress ?? null,
    sendingSpeed: parent.sendingSpeed,
    openTag: parent.openTag ?? null,
    clickTag: parent.clickTag ?? null,
    unsubscribeTag: parent.unsubscribeTag ?? null,
    parentCampaignId: parent.id,
    followUpEnabled: false,
    followUpDelayHours: 36,
    scheduledAt,
    status: "scheduled",
    completedAt: null,
  } as typeof campaigns.$inferInsert;

  // Atomic spawn + parent-link. We do the INSERT and the parent UPDATE in a
  // single transaction so we never end up with an orphan child + unset
  // parent.followUpCampaignId (which would deadlock subsequent polls because
  // the partial unique index on parent_campaign_id would block re-spawn).
  try {
    const created = await db.transaction(async (tx) => {
      const [row] = await tx.insert(campaigns).values(child).returning();
      await tx.execute(sql`
        UPDATE campaigns
        SET follow_up_campaign_id = ${row.id}
        WHERE id = ${parent.id} AND follow_up_campaign_id IS NULL
      `);
      return row;
    });
    // New scheduled child must appear in the list immediately — drop the cache.
    publishCampaignsListInvalidation();
    return created;
  } catch (err: any) {
    // Unique-violation on the partial index = another worker already
    // spawned the child. Find the existing child and ensure the parent
    // link points to it (defensive: heals a stale partial-failure state).
    if (err?.code === "23505") {
      logger.warn(`[FOLLOWUP] Child already exists for parent=${parent.id}, healing link`);
      const [existing] = await db
        .select()
        .from(campaigns)
        .where(eq(campaigns.parentCampaignId, parent.id))
        .limit(1);
      if (existing) {
        await db.execute(sql`
          UPDATE campaigns
          SET follow_up_campaign_id = ${existing.id}
          WHERE id = ${parent.id} AND follow_up_campaign_id IS NULL
        `);
        return existing;
      }
      return undefined;
    }
    throw err;
  }
}

/**
 * For a given campaign, return its linked counterpart (parent if this is a
 * child, child if this is a parent). Used by the campaign-detail UI.
 */
export async function getLinkedFollowUp(campaignId: string): Promise<{ parent: Campaign | null; child: Campaign | null }> {
  const c = await getCampaign(campaignId);
  if (!c) return { parent: null, child: null };

  const idsToFetch: string[] = [];
  if (c.parentCampaignId) idsToFetch.push(c.parentCampaignId);
  if (c.followUpCampaignId) idsToFetch.push(c.followUpCampaignId);
  if (idsToFetch.length === 0) return { parent: null, child: null };

  const linked = await db
    .select()
    .from(campaigns)
    .where(sql`${campaigns.id} = ANY(${toPgTextArray(idsToFetch)}::text[])`);

  const byId = new Map(linked.map(r => [r.id, r]));
  return {
    parent: c.parentCampaignId ? byId.get(c.parentCampaignId) ?? null : null,
    child: c.followUpCampaignId ? byId.get(c.followUpCampaignId) ?? null : null,
  };
}

// ═══════════════════════════════════════════════════════════════
// CAMPAIGN SENDING & TRACKING
// ═══════════════════════════════════════════════════════════════

export interface TrackingContext {
  ipAddress?: string;
  userAgent?: string;
  country?: string;
  city?: string;
  deviceType?: string;
  browser?: string;
  os?: string;
}

export async function addCampaignStat(campaignId: string, subscriberId: string, type: string, link?: string, ctx?: TrackingContext): Promise<void> {
  await db.insert(campaignStats).values({
    campaignId,
    subscriberId,
    type,
    link,
    ...(ctx ?? {}),
  });
}

export async function getCampaignStats(campaignId: string): Promise<CampaignStat[]> {
  return db.select().from(campaignStats).where(eq(campaignStats.campaignId, campaignId)).orderBy(desc(campaignStats.timestamp));
}

/**
 * Resolves the longest exact historical brand key represented by a sent
 * campaign. This mirrors the tag/segment historical suggestion convention.
 */
export async function findCampaignBrandAnchor(requestedBrandKeys: string[]): Promise<string | null> {
  if (!requestedBrandKeys.length) return null;
  if (!isCampaignNameUnaccentIndexReady()) {
    throw new Error("Campaign brand index is not ready");
  }
  const stopwords = [...TAG_SUGGEST_STOPWORDS];
  const brandKey = campaignBrandKeySql("c", "$3", true);
  for (const key of requestedBrandKeys) {
    const pattern = `%${key.split("\u001f").join("%")}%`;
    const result = await pool.query<{ name: string }>(
      `SELECT c.name
         FROM campaigns c
        WHERE f_unaccent(c.name) ILIKE $1
          AND ${brandKey} = $2
          AND c.status IN ('completed', 'sent')
          AND c.first_send_at IS NOT NULL
          AND c.sent_count > 0
        ORDER BY c.first_send_at DESC, c.id ASC
        LIMIT 1`,
      [pattern, key, stopwords],
    );
    if (result.rows[0]?.name) return result.rows[0].name;
  }
  return null;
}

/**
 * Counts distinct subscribers who unsubscribed from campaigns whose canonical
 * name-based brand matches `brandKey`, over Europe/Paris calendar boundaries.
 * Campaign IDs are materialized first so the large stats table is reached via
 * its campaign_id index.
 */
export async function countBrandUnsubscribes(brandKey: string, windowDays: number): Promise<number> {
  if (!brandKey) return 0;
  if (!isCampaignNameUnaccentIndexReady()) {
    throw new Error("Campaign brand index is not ready");
  }
  const days = Math.max(1, Math.floor(windowDays));
  const stopwords = [...TAG_SUGGEST_STOPWORDS];
  const normalizedBrandKey = campaignBrandKeySql("c", "$3", true);
  const brandMatch = brandKey.includes("\u001f")
    ? `(${normalizedBrandKey} = $2 OR ${normalizedBrandKey} LIKE $2 || chr(31) || '%')`
    : `${normalizedBrandKey} = $2`;
  const pattern = `%${brandKey.split("\u001f").join("%")}%`;
  const result = await pool.query<{ count: number | string }>(
    `WITH brand_campaigns AS MATERIALIZED (
       SELECT c.id
         FROM campaigns c
        WHERE f_unaccent(c.name) ILIKE $1
          AND ${brandMatch}
     )
     SELECT COUNT(DISTINCT cs.subscriber_id)::int AS count
       FROM campaign_stats cs
       JOIN brand_campaigns bc ON cs.campaign_id = bc.id
      WHERE cs.type = 'unsubscribe'
        AND cs.timestamp >= (
          (
            date_trunc('day', now() AT TIME ZONE 'Europe/Paris')
            - make_interval(days => $4::int - 1)
          ) AT TIME ZONE 'Europe/Paris'
        ) AT TIME ZONE 'UTC'`,
    [pattern, brandKey, stopwords, days],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function recordCampaignSend(_campaignId: string, _subscriberId: string, _status: string = "sent"): Promise<boolean> {
  throw new Error("DEPRECATED: recordCampaignSend() is no longer supported. Use reserveSendSlot() + finalizeSend() for proper two-phase send.");
}

export async function wasEmailSent(campaignId: string, subscriberId: string): Promise<boolean> {
  const [result] = await db.select({ count: sql<number>`count(*)` })
    .from(campaignSends)
    .where(and(eq(campaignSends.campaignId, campaignId), eq(campaignSends.subscriberId, subscriberId)));
  return Number(result.count) > 0;
}

export async function getCampaignSendCount(campaignId: string): Promise<number> {
  const [result] = await db.select({ count: sql<number>`count(*)` })
    .from(campaignSends).where(eq(campaignSends.campaignId, campaignId));
  return Number(result.count);
}

export async function incrementCampaignSentCount(campaignId: string, increment: number = 1): Promise<void> {
  await db.execute(sql`UPDATE campaigns SET sent_count = sent_count + ${increment} WHERE id = ${campaignId}`);
}

export async function incrementCampaignFailedCount(campaignId: string, increment: number = 1): Promise<void> {
  await db.execute(sql`UPDATE campaigns SET failed_count = failed_count + ${increment} WHERE id = ${campaignId}`);
}

export async function decrementCampaignPendingCount(campaignId: string, decrement: number = 1): Promise<void> {
  await db.execute(sql`UPDATE campaigns SET pending_count = GREATEST(pending_count - ${decrement}, 0) WHERE id = ${campaignId}`);
}

export async function updateCampaignStatusAtomic(campaignId: string, newStatus: string, expectedStatus?: string): Promise<boolean> {
  let result;
  if (expectedStatus) {
    result = await db.execute(sql`
      UPDATE campaigns SET status = ${newStatus}
      WHERE id = ${campaignId} AND status = ${expectedStatus}
      RETURNING id
    `);
  } else {
    result = await db.execute(sql`
      UPDATE campaigns SET status = ${newStatus} WHERE id = ${campaignId} RETURNING id
    `);
  }
  const changed = result.rows.length > 0;
  // Only fan out when a status actually flipped — keeps the cache alive when
  // a CAS loses (no-op) but drops it on every real transition.
  if (changed) publishCampaignsListInvalidation();
  return changed;
}

// Atomically flip 'sending' → 'completed' ONLY when the campaign is genuinely
// drained: no active (pending/attempting) rows AND no retryable failed rows
// (failed rows are retryable while auto_retry_count < maxAutoRetries). This is
// the race-safe completion primitive used by BOTH finalization paths
// (campaign-sender.ts and pressure-guard-worker.ts).
//
// Why this exists (2026-06-09): a plain CAS `status='sending' → 'completed'`
// is a non-atomic check-then-act when the caller first reads failed/active
// counts in separate statements. The two completion paths could interleave so
// that path A requeues (failed → pending) in the window between path B's
// count-read and B's completion CAS — and B would then complete a campaign that
// now has live pending retry rows, stranding them (a requeued job aborts when
// the campaign is no longer 'sending'). Folding both guards INTO the UPDATE's
// WHERE clause makes the decision atomic: if anything is still in flight or
// retryable-with-budget, the UPDATE matches 0 rows and we hold 'sending'.
export async function completeCampaignIfDrained(campaignId: string, maxAutoRetries: number): Promise<boolean> {
  // Zero-Duplicate Send Guard: ambiguous rows are terminal 'failed' rows that are
  // never retried, so they must NOT block completion — otherwise the campaign
  // stays stranded in 'sending' forever. No-op when the flag is OFF.
  const klassPredicate = zeroDupSendGuardEnabled() ? sql` AND cs.smtp_outcome_class IS DISTINCT FROM 'ambiguous'` : sql``;
  const result = await db.execute(sql`
    WITH c AS (
      SELECT auto_retry_count FROM campaigns WHERE id = ${campaignId} AND status = 'sending'
    )
    UPDATE campaigns
    SET status = 'completed'
    WHERE id = ${campaignId}
      AND status = 'sending'
      AND NOT EXISTS (
        SELECT 1 FROM campaign_sends
        WHERE campaign_id = ${campaignId} AND status IN ('pending', 'attempting')
      )
      AND NOT EXISTS (
        SELECT 1 FROM campaign_sends cs, c
        WHERE cs.campaign_id = ${campaignId} AND cs.status = 'failed'${klassPredicate}
          AND c.auto_retry_count < ${maxAutoRetries}
      )
    RETURNING id
  `);
  const changed = result.rows.length > 0;
  if (changed) publishCampaignsListInvalidation();
  return changed;
}

export async function reserveSendSlot(campaignId: string, subscriberId: string): Promise<boolean> {
  const result = await db.execute(sql`
    INSERT INTO campaign_sends (id, campaign_id, subscriber_id, status, sent_at)
    VALUES (gen_random_uuid(), ${campaignId}, ${subscriberId}, 'pending', NOW())
    ON CONFLICT (campaign_id, subscriber_id) DO NOTHING
    RETURNING id
  `);
  return result.rows.length > 0;
}

export async function finalizeSend(campaignId: string, subscriberId: string, success: boolean, outcomeClass?: SmtpOutcomeClass): Promise<void> {
  // Zero-Duplicate Send Guard: write the discriminator ONLY when the flag is ON
  // AND the caller explicitly classified the outcome. Legacy callers (no
  // outcomeClass) stay byte-identical — a failed row with NULL class is treated
  // as retryable, exactly as before the guard existed.
  const writeClass = zeroDupSendGuardEnabled() && outcomeClass != null;
  const result = await db.execute(sql`
    WITH updated_send AS (
      UPDATE campaign_sends SET status = ${success ? 'sent' : 'failed'}${writeClass ? sql`, smtp_outcome_class = ${outcomeClass}` : sql``}
      WHERE campaign_id = ${campaignId}
        AND subscriber_id = ${subscriberId}
        AND status IN ('pending', 'attempting')
      RETURNING id
    ),
    counter_update AS (
      UPDATE campaigns SET
        sent_count = CASE WHEN ${success} THEN sent_count + 1 ELSE sent_count END,
        failed_count = CASE WHEN NOT ${success} THEN failed_count + 1 ELSE failed_count END,
        pending_count = GREATEST(pending_count - 1, 0),
        first_send_at = CASE WHEN ${success} THEN COALESCE(first_send_at, NOW()) ELSE first_send_at END,
        last_send_at = CASE WHEN ${success} THEN NOW() ELSE last_send_at END
      WHERE id = ${campaignId} AND (SELECT COUNT(*) FROM updated_send) > 0
      RETURNING id
    )
    SELECT (SELECT COUNT(*) FROM updated_send) as updated_count
  `);
  const updatedCount = Number(result.rows[0]?.updated_count ?? 0);
  if (updatedCount === 0) {
    throw new Error(`finalizeSend invariant violation: No active row found for campaign=${campaignId}, subscriber=${subscriberId}.`);
  }
}

export async function recordSendAndUpdateCounters(campaignId: string, subscriberId: string, success: boolean): Promise<boolean> {
  const reserved = await reserveSendSlot(campaignId, subscriberId);
  if (!reserved) return false;
  await finalizeSend(campaignId, subscriberId, success);
  return true;
}

export async function recoverOrphanedPendingSends(campaignId: string, maxAgeMinutes: number = 5): Promise<number> {
  // Pressure-guard rows (eligible_at IS NOT NULL) are owned by the
  // pressure-guard worker — they are intentionally `pending` and the
  // worker is responsible for draining them as `eligible_at` matures.
  // We MUST NOT touch any row with `eligible_at IS NOT NULL` here, even
  // if its eligible_at moment has just arrived: the drain worker is
  // already racing to claim it and force-failing under it would lose
  // sends. Pure orphans (status='pending' AND eligible_at IS NULL AND
  // sent_at older than threshold) remain in scope.
  const result = await db.execute(sql`
    WITH orphaned AS (
      UPDATE campaign_sends SET status = 'failed'
      WHERE campaign_id = ${campaignId} AND status = 'pending'
        AND sent_at < NOW() - INTERVAL '1 minute' * ${maxAgeMinutes}
        AND eligible_at IS NULL
      RETURNING id
    ),
    counter_update AS (
      UPDATE campaigns SET
        failed_count = failed_count + (SELECT COUNT(*) FROM orphaned),
        pending_count = GREATEST(pending_count - (SELECT COUNT(*) FROM orphaned), 0)
      WHERE id = ${campaignId} AND (SELECT COUNT(*) FROM orphaned) > 0
      RETURNING id
    )
    SELECT (SELECT COUNT(*) FROM orphaned) as recovered_count
  `);
  const recoveredCount = Number(result.rows[0]?.recovered_count ?? 0);
  if (recoveredCount > 0) logger.info('Recovered orphaned pending sends', { recoveredCount, campaignId });
  return recoveredCount;
}

/**
 * Atomically reset all failed sends to pending, flip the campaign back to 'sending',
 * clear retryUntil (so campaign-sender sets a fresh 12-hour window), increment
 * autoRetryCount, and insert a new campaign_job (skipped if one is already queued).
 * Returns true when the new job was enqueued, false when there were no failed rows.
 */
export async function autoRequeueCampaignFailed(campaignId: string, newAutoRetryCount: number): Promise<boolean> {
  // Zero-Duplicate Send Guard: never resurrect ambiguous (possibly delivered)
  // rows back to 'pending', and keep failed_count reflecting the ambiguous rows
  // that legitimately remain 'failed'. Both no-ops when the flag is OFF.
  const guardOn = zeroDupSendGuardEnabled();
  const klassPredicate = guardOn ? sql` AND smtp_outcome_class IS DISTINCT FROM 'ambiguous'` : sql``;
  const failedCountExpr = guardOn
    ? sql`(SELECT COUNT(*) FROM campaign_sends WHERE campaign_id = ${campaignId} AND status = 'failed' AND smtp_outcome_class = 'ambiguous')`
    : sql`0`;
  const result = await db.execute(sql`
    WITH eligible AS (
      -- Guard (2026-06-04): only auto-requeue while the campaign is STILL
      -- 'sending'. If an operator ended (status='completed') or paused it
      -- (status='paused') while the sender's finalization pass was mid-flight
      -- (the sender's shouldStop flag lags by up to one STATUS_CHECK_INTERVAL),
      -- this CTE yields no rows and nothing below fires — so a manual End/Pause
      -- can no longer be silently resurrected back to 'sending' by the
      -- failed-send auto-requeue.
      SELECT 1 AS ok
      FROM campaigns
      WHERE id = ${campaignId} AND status = 'sending'
    ),
    reset AS (
      UPDATE campaign_sends
      SET status = 'pending',
          retry_count = retry_count + 1,
          last_retry_at = NOW(),
          sent_at = NOW()
      WHERE campaign_id = ${campaignId} AND status = 'failed'${klassPredicate}
        AND EXISTS (SELECT 1 FROM eligible)
      RETURNING id
    ),
    campaign_update AS (
      -- 2026-05-22: urgent_mode cleared on auto-requeue (failed → sending).
      -- Same rationale as the manual /retry-failed and /requeue routes:
      -- a past urgent flush must not silently resurrect on a fresh
      -- automated retry. Operator can re-click /urgent if needed.
      UPDATE campaigns
      SET status = 'sending',
          failed_count = ${failedCountExpr},
          retry_until = NULL,
          auto_retry_count = ${newAutoRetryCount},
          urgent_mode = false,
          urgent_flush_job_id = NULL
      WHERE id = ${campaignId} AND status = 'sending' AND (SELECT COUNT(*) FROM reset) > 0
      RETURNING id
    ),
    job_insert AS (
      INSERT INTO campaign_jobs (id, campaign_id, status)
      SELECT gen_random_uuid(), ${campaignId}, 'pending'
      WHERE EXISTS (SELECT 1 FROM campaign_update)
        AND NOT EXISTS (
          SELECT 1 FROM campaign_jobs
          WHERE campaign_id = ${campaignId} AND status IN ('pending', 'processing')
        )
      ON CONFLICT DO NOTHING
      RETURNING id
    )
    SELECT (SELECT COUNT(*) FROM reset) AS reset_count
  `);
  const resetCount = Number(result.rows[0]?.reset_count ?? 0);
  // failed → sending transition: refresh the list so the status is current.
  if (resetCount > 0) publishCampaignsListInvalidation();
  return resetCount > 0;
}

export async function resetOrphanedFailedSends(campaignId: string): Promise<number> {
  // Zero-Duplicate Send Guard: never DELETE an ambiguous (possibly delivered)
  // row — removing it would make the subscriber eligible for a fresh send and
  // risk a duplicate. No-op when the flag is OFF.
  const klassPredicate = zeroDupSendGuardEnabled() ? sql` AND smtp_outcome_class IS DISTINCT FROM 'ambiguous'` : sql``;
  const result = await db.execute(sql`
    WITH orphaned AS (
      DELETE FROM campaign_sends
      WHERE campaign_id = ${campaignId} AND status = 'failed'${klassPredicate}
        AND retry_count = 0 AND first_open_at IS NULL AND first_click_at IS NULL
      RETURNING id
    ),
    counter_update AS (
      UPDATE campaigns
      SET failed_count = GREATEST(failed_count - (SELECT COUNT(*) FROM orphaned), 0)
      WHERE id = ${campaignId} AND (SELECT COUNT(*) FROM orphaned) > 0
      RETURNING id
    )
    SELECT (SELECT COUNT(*) FROM orphaned) as reset_count
  `);
  const resetCount = Number(result.rows[0]?.reset_count ?? 0);
  if (resetCount > 0) logger.info(`[RESUME] Deleted ${resetCount} orphaned failed sends for campaign ${campaignId}`);
  return resetCount;
}

export async function forceFailPendingSend(campaignId: string, subscriberId: string, outcomeClass?: SmtpOutcomeClass): Promise<boolean> {
  // Zero-Duplicate Send Guard: see finalizeSend — class is written only when the
  // flag is ON and the caller passed an explicit outcomeClass (the ambiguous
  // fallback path); otherwise byte-identical to legacy force-fail.
  const writeClass = zeroDupSendGuardEnabled() && outcomeClass != null;
  const result = await db.execute(sql`
    WITH updated AS (
      UPDATE campaign_sends SET status = 'failed'${writeClass ? sql`, smtp_outcome_class = ${outcomeClass}` : sql``}
      WHERE campaign_id = ${campaignId}
        AND subscriber_id = ${subscriberId}
        AND status IN ('pending', 'attempting')
      RETURNING id
    ),
    counter_update AS (
      UPDATE campaigns SET
        failed_count = failed_count + 1,
        pending_count = GREATEST(pending_count - 1, 0)
      WHERE id = ${campaignId} AND (SELECT COUNT(*) FROM updated) > 0
      RETURNING id
    )
    SELECT (SELECT COUNT(*) FROM updated) as updated_count
  `);
  return Number(result.rows[0]?.updated_count ?? 0) > 0;
}

export async function bulkReserveSendSlots(campaignId: string, subscriberIds: string[]): Promise<string[]> {
  if (subscriberIds.length === 0) return [];
  const CHUNK_SIZE = 1000;
  const allReserved: string[] = [];
  for (let i = 0; i < subscriberIds.length; i += CHUNK_SIZE) {
    const chunk = subscriberIds.slice(i, i + CHUNK_SIZE);
    const arrayLiteral = `{${chunk.map(id => `"${id}"`).join(',')}}`;
    const result = await db.execute(sql`
      INSERT INTO campaign_sends (id, campaign_id, subscriber_id, status, sent_at)
      SELECT gen_random_uuid(), ${campaignId}, unnest_id, 'pending', NOW()
      FROM unnest(${arrayLiteral}::text[]) AS unnest_id
      ON CONFLICT (campaign_id, subscriber_id) DO NOTHING
      RETURNING subscriber_id
    `);
    for (const r of result.rows) allReserved.push((r as any).subscriber_id);
  }
  return allReserved;
}

export async function bulkInsertCampaignSendAttempts(campaignId: string, subscriberIds: string[]): Promise<void> {
  if (subscriberIds.length === 0) return;
  const CHUNK_SIZE = 1000;
  for (let i = 0; i < subscriberIds.length; i += CHUNK_SIZE) {
    const chunk = subscriberIds.slice(i, i + CHUNK_SIZE);
    const arrayLiteral = `{${chunk.map(id => `"${id}"`).join(',')}}`;
    await db.execute(sql`
      INSERT INTO campaign_sends (id, campaign_id, subscriber_id, status, sent_at)
      SELECT gen_random_uuid(), ${campaignId}, unnest_id, 'attempting', NOW()
      FROM unnest(${arrayLiteral}::text[]) AS unnest_id
      ON CONFLICT (campaign_id, subscriber_id) DO UPDATE
        SET status = 'attempting'
        WHERE campaign_sends.status = 'pending'
    `);
  }
}

export async function bulkFinalizeSends(
  campaignId: string,
  successIds: string[],
  failedIds: string[],
  // Zero-Duplicate Send Guard: rows whose SMTP outcome was AMBIGUOUS (possibly
  // delivered). They are persisted as status='failed' + smtp_outcome_class=
  // 'ambiguous' so every resend selector excludes them. Always empty when the
  // flag is OFF (callers never populate it), so OFF behaviour is unchanged.
  ambiguousIds: string[] = [],
): Promise<void> {
  const guardOn = zeroDupSendGuardEnabled();
  const sentCount = successIds.length;
  // Ambiguous rows are status='failed' too, so they count toward failed_count.
  const failCount = failedIds.length + (guardOn ? ambiguousIds.length : 0);
  const totalProcessed = sentCount + failCount;
  if (totalProcessed === 0) return;

  const CHUNK_SIZE = 1000;
  await db.transaction(async (tx) => {
    if (successIds.length > 0) {
      for (let i = 0; i < successIds.length; i += CHUNK_SIZE) {
        const chunk = successIds.slice(i, i + CHUNK_SIZE);
        const arr = `{${chunk.map(id => `"${id}"`).join(',')}}`;
        await tx.execute(sql`
          UPDATE campaign_sends SET status = 'sent'${guardOn ? sql`, smtp_outcome_class = 'delivered'` : sql``}
          WHERE campaign_id = ${campaignId} AND subscriber_id = ANY(${arr}::text[]) AND status IN ('pending', 'attempting')
        `);
      }
    }
    if (failedIds.length > 0) {
      for (let i = 0; i < failedIds.length; i += CHUNK_SIZE) {
        const chunk = failedIds.slice(i, i + CHUNK_SIZE);
        const arr = `{${chunk.map(id => `"${id}"`).join(',')}}`;
        await tx.execute(sql`
          UPDATE campaign_sends SET status = 'failed'${guardOn ? sql`, smtp_outcome_class = 'pre_data_retryable'` : sql``}
          WHERE campaign_id = ${campaignId} AND subscriber_id = ANY(${arr}::text[]) AND status IN ('pending', 'attempting')
        `);
      }
    }
    if (guardOn && ambiguousIds.length > 0) {
      for (let i = 0; i < ambiguousIds.length; i += CHUNK_SIZE) {
        const chunk = ambiguousIds.slice(i, i + CHUNK_SIZE);
        const arr = `{${chunk.map(id => `"${id}"`).join(',')}}`;
        await tx.execute(sql`
          UPDATE campaign_sends SET status = 'failed', smtp_outcome_class = 'ambiguous'
          WHERE campaign_id = ${campaignId} AND subscriber_id = ANY(${arr}::text[]) AND status IN ('pending', 'attempting')
        `);
      }
    }
    await tx.execute(sql`
      UPDATE campaigns SET
        sent_count = sent_count + ${sentCount},
        failed_count = failed_count + ${failCount},
        pending_count = GREATEST(pending_count - ${totalProcessed}, 0),
        first_send_at = CASE WHEN ${sentCount} > 0 THEN COALESCE(first_send_at, NOW()) ELSE first_send_at END,
        last_send_at = CASE WHEN ${sentCount} > 0 THEN NOW() ELSE last_send_at END
      WHERE id = ${campaignId}
    `);
  });
}

export async function heartbeatJob(jobId: string): Promise<void> {
  await db.execute(sql`
    UPDATE campaign_jobs SET started_at = NOW() WHERE id = ${jobId} AND status = 'processing'
  `);
}

export async function getCampaignSend(campaignId: string, subscriberId: string): Promise<CampaignSend | undefined> {
  const [send] = await db.select().from(campaignSends)
    .where(and(eq(campaignSends.campaignId, campaignId), eq(campaignSends.subscriberId, subscriberId)));
  return send;
}

export async function recordFirstOpen(campaignId: string, subscriberId: string): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE campaign_sends SET first_open_at = NOW()
    WHERE campaign_id = ${campaignId} AND subscriber_id = ${subscriberId} AND first_open_at IS NULL
    RETURNING id
  `);
  return result.rows.length > 0;
}

export async function recordFirstClick(campaignId: string, subscriberId: string): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE campaign_sends SET first_click_at = NOW()
    WHERE campaign_id = ${campaignId} AND subscriber_id = ${subscriberId} AND first_click_at IS NULL
    RETURNING id
  `);
  return result.rows.length > 0;
}

export async function getUniqueOpenCount(campaignId: string): Promise<number> {
  const result = await db.execute(sql`
    SELECT COUNT(*) as count FROM campaign_sends WHERE campaign_id = ${campaignId} AND first_open_at IS NOT NULL
  `);
  return Number((result.rows[0] as any)?.count || 0);
}

export async function getUniqueClickCount(campaignId: string): Promise<number> {
  const result = await db.execute(sql`
    SELECT COUNT(*) as count FROM campaign_sends WHERE campaign_id = ${campaignId} AND first_click_at IS NOT NULL
  `);
  return Number((result.rows[0] as any)?.count || 0);
}

type CampaignSendStateRow = {
  sent?: string | number | null;
  failed?: string | number | null;
  pending?: string | number | null;
  deferred?: string | number | null;
};

export function buildCampaignSendStateTotals(row: CampaignSendStateRow | undefined): CampaignSendStateTotals {
  const sent = Math.max(0, Number(row?.sent ?? 0));
  const failed = Math.max(0, Number(row?.failed ?? 0));
  const pending = Math.max(0, Number(row?.pending ?? 0));
  const deferred = Math.min(pending, Math.max(0, Number(row?.deferred ?? 0)));
  const finalized = sent + failed;
  return {
    processed: finalized + pending,
    finalized,
    sent,
    failed,
    pending,
    deferred,
  };
}

/**
 * Authoritative live snapshot for user-facing progress and analytics.
 * Deferred rows are deliberately included in pending and never added twice.
 */
export async function getCampaignSendStateTotals(campaignId: string): Promise<CampaignSendStateTotals> {
  const result = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'sent')::bigint AS sent,
      COUNT(*) FILTER (WHERE status IN ('failed', 'bounced'))::bigint AS failed,
      COUNT(*) FILTER (WHERE status IN ('pending', 'reserved', 'attempting'))::bigint AS pending,
      COUNT(*) FILTER (
        WHERE status = 'pending' AND eligible_at IS NOT NULL
      )::bigint AS deferred
    FROM campaign_sends
    WHERE campaign_id = ${campaignId}
  `);
  return buildCampaignSendStateTotals(result.rows[0] as CampaignSendStateRow | undefined);
}

export async function getCampaignSendCounts(campaignId: string): Promise<{total: number, sent: number, failed: number, pending: number, attempting: number}> {
  const result = await db.execute(sql`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'sent') as sent,
      COUNT(*) FILTER (WHERE status = 'failed') as failed,
      COUNT(*) FILTER (WHERE status = 'pending' OR status = 'reserved') as pending,
      COUNT(*) FILTER (WHERE status = 'attempting') as attempting
    FROM campaign_sends WHERE campaign_id = ${campaignId}
  `);
  const row = result.rows[0] as any;
  return {
    total: Number(row?.total || 0),
    sent: Number(row?.sent || 0),
    failed: Number(row?.failed || 0),
    pending: Number(row?.pending || 0),
    attempting: Number(row?.attempting || 0),
  };
}

// ═══════════════════════════════════════════════════════════════
// NULLSINK
// ═══════════════════════════════════════════════════════════════

export async function createNullsinkCapture(data: InsertNullsinkCapture): Promise<NullsinkCapture> {
  const [capture] = await db.insert(nullsinkCaptures).values(data).returning();
  return capture;
}

export async function bulkCreateNullsinkCaptures(data: InsertNullsinkCapture[]): Promise<void> {
  if (data.length === 0) return;
  const CHUNK_SIZE = 500;
  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    await db.insert(nullsinkCaptures).values(data.slice(i, i + CHUNK_SIZE));
  }
}

export async function getNullsinkCaptures(options?: {
  campaignId?: string; limit?: number; offset?: number;
}): Promise<{ captures: NullsinkCapture[]; total: number }> {
  const limit = options?.limit || 100;
  const offset = options?.offset || 0;
  const whereClause = options?.campaignId ? eq(nullsinkCaptures.campaignId, options.campaignId) : undefined;

  const [captures, [{ count }]] = await Promise.all([
    whereClause
      ? db.select().from(nullsinkCaptures).where(whereClause).orderBy(desc(nullsinkCaptures.timestamp)).limit(limit).offset(offset)
      : db.select().from(nullsinkCaptures).orderBy(desc(nullsinkCaptures.timestamp)).limit(limit).offset(offset),
    whereClause
      ? db.select({ count: sql<number>`count(*)` }).from(nullsinkCaptures).where(whereClause)
      : db.select({ count: sql<number>`count(*)` }).from(nullsinkCaptures),
  ]);
  return { captures, total: Number(count) };
}

export async function getNullsinkMetrics(campaignId?: string): Promise<{
  totalEmails: number; successfulEmails: number; failedEmails: number;
  avgHandshakeTimeMs: number; avgTotalTimeMs: number; emailsPerSecond: number;
}> {
  const whereClause = campaignId ? sql`WHERE campaign_id = ${campaignId}` : sql``;
  const result = await db.execute(sql`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'captured') as successful,
      COUNT(*) FILTER (WHERE status = 'simulated_failure') as failed,
      COALESCE(AVG(handshake_time_ms), 0) as avg_handshake,
      COALESCE(AVG(total_time_ms), 0) as avg_total,
      COALESCE(COUNT(*) / NULLIF(EXTRACT(EPOCH FROM (MAX(timestamp) - MIN(timestamp))), 0), 0) as emails_per_second
    FROM nullsink_captures
    ${whereClause}
  `);
  const row = result.rows[0] as any;
  return {
    totalEmails: Number(row?.total || 0),
    successfulEmails: Number(row?.successful || 0),
    failedEmails: Number(row?.failed || 0),
    avgHandshakeTimeMs: Number(row?.avg_handshake || 0),
    avgTotalTimeMs: Number(row?.avg_total || 0),
    emailsPerSecond: Number(row?.emails_per_second || 0),
  };
}

export async function clearNullsinkCaptures(campaignId?: string): Promise<number> {
  if (campaignId) {
    const result = await db.delete(nullsinkCaptures).where(eq(nullsinkCaptures.campaignId, campaignId));
    return result.rowCount || 0;
  }
  const result = await db.delete(nullsinkCaptures);
  return result.rowCount || 0;
}

// ═══════════════════════════════════════════════════════════════
// CAMPAIGN LINKS (opaque token registry for click tracking)
// ═══════════════════════════════════════════════════════════════

/**
 * Batch-insert missing links and return a Map<destinationUrl, linkId> for all provided URLs.
 * Uses ON CONFLICT DO NOTHING so this is fully idempotent.
 */
export async function batchGetOrCreateCampaignLinks(
  campaignId: string,
  urls: string[]
): Promise<Map<string, string>> {
  if (urls.length === 0) return new Map();

  // Deduplicate before hitting the DB
  const uniqueUrls = [...new Set(urls)];

  // Insert any new links; existing ones are silently skipped
  await pool.query(
    `INSERT INTO campaign_links (id, campaign_id, destination_url)
     SELECT gen_random_uuid(), $1, unnest($2::text[])
     ON CONFLICT (campaign_id, destination_url) DO NOTHING`,
    [campaignId, uniqueUrls]
  );

  // Fetch all (existing + newly created) rows for this campaign + url set
  const result = await pool.query(
    `SELECT id, destination_url FROM campaign_links
     WHERE campaign_id = $1 AND destination_url = ANY($2::text[])`,
    [campaignId, uniqueUrls]
  );

  const map = new Map<string, string>();
  for (const row of result.rows) {
    map.set(row.destination_url, row.id);
  }
  return map;
}

/**
 * Look up the destination URL for a given link ID.
 * Returns null if the link does not exist (e.g. corrupted token).
 */
export async function getCampaignLinkDestination(linkId: string): Promise<string | null> {
  const result = await pool.query(
    `SELECT destination_url FROM campaign_links WHERE id = $1`,
    [linkId]
  );
  return result.rows.length > 0 ? result.rows[0].destination_url : null;
}

// ═══════════════════════════════════════════════════════════════
// DASHBOARD & ANALYTICS (campaign-scoped, no subscriber-repo dep)
// ═══════════════════════════════════════════════════════════════

let dashboardCache: { data: any; expiresAt: number } | null = null;
const DASHBOARD_CACHE_TTL_MS = 30_000;

export async function getDashboardStats() {
  if (dashboardCache && Date.now() < dashboardCache.expiresAt) {
    return dashboardCache.data;
  }

  const [
    subEstimateResult,
    aggregateResult,
    recentCampaignsResult,
    recentImportsResult,
  ] = await Promise.all([
    db.execute(sql`
      SELECT reltuples::bigint AS count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = 'subscribers' AND n.nspname = 'public'
    `),
    db.execute(sql`
      SELECT
        COUNT(*)::int AS campaign_count,
        COALESCE(SUM(total_opens_count), 0)::int AS total_opens,
        COALESCE(SUM(total_clicks_count), 0)::int AS total_clicks,
        COALESCE(SUM(unsubscribes_count), 0)::int AS total_unsubs
      FROM campaigns
    `),
    db.execute(sql`
      SELECT id, name, status, sent_count, scheduled_at, segment_id, created_at
      FROM campaigns
      ORDER BY created_at DESC
      LIMIT 5
    `),
    db.select().from(importJobs).orderBy(desc(importJobs.createdAt)).limit(5),
  ]);

  const aggRow = aggregateResult.rows[0] as any;
  let subscriberCount = Number((subEstimateResult.rows[0] as any)?.count ?? -1);

  if (subscriberCount < 0) {
    const exact = await db.execute(sql`SELECT COUNT(*) AS count FROM subscribers`);
    subscriberCount = Number((exact.rows[0] as any)?.count || 0);
  }

  const data = {
    totalSubscribers: subscriberCount,
    totalCampaigns: Number(aggRow?.campaign_count || 0),
    totalOpens: Number(aggRow?.total_opens || 0),
    totalClicks: Number(aggRow?.total_clicks || 0),
    totalUnsubscribes: Number(aggRow?.total_unsubs || 0),
    recentCampaigns: (recentCampaignsResult.rows as any[]).map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      sentCount: r.sent_count ?? 0,
      scheduledAt: r.scheduled_at,
      segmentId: r.segment_id,
    })),
    recentImports: recentImportsResult,
  };

  dashboardCache = { data, expiresAt: Date.now() + DASHBOARD_CACHE_TTL_MS };
  return data;
}

export async function getDashboardChartData() {
  const result = await db.execute(sql`
    SELECT
      to_char(date_trunc('month', date), 'Mon YY') AS label,
      SUM(total_opens)::int  AS opens,
      SUM(total_clicks)::int AS clicks
    FROM analytics_daily
    WHERE date >= date_trunc('month', NOW()) - INTERVAL '11 months'
      AND date < date_trunc('month', NOW()) + INTERVAL '1 month'
    GROUP BY date_trunc('month', date), to_char(date_trunc('month', date), 'Mon YY')
    ORDER BY date_trunc('month', date) ASC
  `);

  return (result.rows as any[]).map((row) => ({
    name: String(row.label),
    opens: Number(row.opens || 0),
    clicks: Number(row.clicks || 0),
  }));
}

// ═══════════════════════════════════════════════════════════════
// TRACKING TOKENS  (short branded /c/ and /u/ URLs)
// ═══════════════════════════════════════════════════════════════

// ─── Ensure tracking_tokens table exists (idempotent bootstrap) ─────────────
// Called once on module load.  drizzle-kit push silently no-ops on complex
// expression indexes, so we manage this table entirely via raw SQL.
//
// If the database is short on disk (53100 disk_full / "could not write" /
// "Disk quota exceeded"), the bootstrap is *deferred* rather than fatal:
// we log a warning, expose the deferred state, and let the rest of the
// web server come up so unrelated reads (e.g. /api/campaigns) keep
// serving. The migration is re-runnable via runTrackingTokensBootstrap().
let trackingTokensBootstrapState: "pending" | "ready" | "deferred" = "pending";
let trackingTokensBootstrapDeferReason: string | null = null;

export function getTrackingTokensBootstrapState(): {
  state: "pending" | "ready" | "deferred";
  deferReason: string | null;
} {
  return {
    state: trackingTokensBootstrapState,
    deferReason: trackingTokensBootstrapDeferReason,
  };
}

export async function runTrackingTokensBootstrap(): Promise<"ready" | "deferred"> {
  let result: "ready" | "deferred" = "ready";

  const lockResult = await withAdvisoryLock(
    LOCK_KEYS.TRACKING_TOKENS,
    "tracking_tokens",
    async (_lockClient) => {
      try {
        const tableExists = await relationExists(pool, "tracking_tokens");
        const partitioned = tableExists && (await isTrackingTokensPartitioned(pool));

        if (!tableExists) {
          // Fresh install: create the partitioned parent + its indexes + an
          // initial buffer of day-partitions. Index builds run non-concurrently
          // but are instant on an empty table.
          for (const ddl of buildPartitionedTableDDL("tracking_tokens")) {
            await pool.query(ddl);
          }
          await ensureTrackingTokenPartitions(pool);
          logger.info("[tracking_tokens] Created partitioned table + initial partitions (fresh install)");
        } else if (partitioned) {
          // Already migrated to the partitioned layout: keep the forward buffer of
          // day-partitions topped up so inserts never hit a missing partition.
          // Parent indexes already exist (created by the migration).
          await ensureTrackingTokenPartitions(pool);
        } else {
          // Legacy non-partitioned table (pre-migration). Leave the table as-is and
          // only ensure the historical indexes exist — the conversion to partitions
          // is performed out-of-band by scripts/migrate-tracking-tokens-partitioning.ts.
          // Keeping this branch means the partition-aware code is safe to deploy
          // BEFORE the data migration runs.
          if (!(await indexExistsAndValid("tracking_tokens_unique_idx"))) {
            try {
              await pool.query(`
                CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS tracking_tokens_unique_idx
                  ON tracking_tokens (type, campaign_id, subscriber_id, COALESCE(link_id, ''))
              `);
            } catch (idxErr: any) {
              if (isDiskFullError(idxErr)) {
                const reason = `Disk pressure during unique_idx build: ${idxErr?.message || idxErr}`;
                logger.warn(`[tracking_tokens] Bootstrap deferred (unique_idx): ${reason}`);
                trackingTokensBootstrapState = "deferred";
                trackingTokensBootstrapDeferReason = reason;
                result = "deferred";
                return;
              }
              logger.warn(`[tracking_tokens] CONCURRENTLY unique_idx build failed, will retry on next start: ${idxErr?.message || idxErr}`);
              try {
                await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS tracking_tokens_unique_idx`);
              } catch { /* ignore */ }
            }
          }
          if (!(await indexExistsAndValid("tracking_tokens_campaign_idx"))) {
            await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS tracking_tokens_campaign_idx ON tracking_tokens (campaign_id)`);
          }
          if (!(await indexExistsAndValid("tracking_tokens_subscriber_idx"))) {
            await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS tracking_tokens_subscriber_idx ON tracking_tokens (subscriber_id)`);
          }
          if (!(await indexExistsAndValid("tracking_tokens_created_at_idx"))) {
            try {
              await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS tracking_tokens_created_at_idx ON tracking_tokens (created_at)`);
            } catch (idxErr: any) {
              if (isDiskFullError(idxErr)) {
                const reason = `Disk pressure during created_at index build: ${idxErr?.message || idxErr}`;
                logger.warn(
                  `[tracking_tokens] Bootstrap deferred (created_at index): ${reason}. ` +
                  `Web server will continue starting; rerun reclamation (see docs/reclaim-tracking-tokens.md), ` +
                  `then restart or call runTrackingTokensBootstrap() to retry.`
                );
                trackingTokensBootstrapState = "deferred";
                trackingTokensBootstrapDeferReason = reason;
                result = "deferred";
                return;
              }
              logger.warn(`[tracking_tokens] CONCURRENTLY created_at index build failed, will retry on next start: ${idxErr?.message || idxErr}`);
              try {
                await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS tracking_tokens_created_at_idx`);
              } catch { /* ignore */ }
            }
          }
        }
        trackingTokensBootstrapState = "ready";
        trackingTokensBootstrapDeferReason = null;
        result = "ready";
      } catch (err: any) {
        const classified = classifyDbError(err);
        if (classified.kind === "disk_full") {
          const reason = `Database is out of disk space: ${classified.message}`;
          logger.warn(
            `[tracking_tokens] Bootstrap deferred — database disk pressure. ` +
            `code=${classified.code ?? "n/a"} reason="${classified.message}". ` +
            `Web server will continue starting; reclaim tracking_tokens space ` +
            `(see docs/reclaim-tracking-tokens.md) and restart, or call ` +
            `runTrackingTokensBootstrap() to retry without a restart.`
          );
          trackingTokensBootstrapState = "deferred";
          trackingTokensBootstrapDeferReason = reason;
          result = "deferred";
          return;
        }
        logger.error('[tracking_tokens] Table bootstrap failed:', err.message);
        trackingTokensBootstrapState = "deferred";
        trackingTokensBootstrapDeferReason = err?.message || String(err);
        result = "deferred";
      }
    },
  );

  if (lockResult === "skipped") {
    trackingTokensBootstrapState = "ready";
    result = "ready";
  } else if (lockResult === "error") {
    trackingTokensBootstrapState = "deferred";
    trackingTokensBootstrapDeferReason = "Failed to acquire bootstrap lock";
    result = "deferred";
  }
  return result;
}

// Fire-and-forget bootstrap on module load. Errors never crash the boot —
// runTrackingTokensBootstrap() always resolves, even when it has to defer.
void runTrackingTokensBootstrap();

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function generateToken(): string {
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes).map(b => BASE62[b % 62]).join('');
}

const MAX_UNNEST_ROWS = 50000;

/**
 * Batch-create click tokens for all (subscriberId × linkId) pairs.
 * Returns Map<subscriberId, Map<linkId, token>>.
 * Idempotent: ON CONFLICT DO NOTHING, then re-fetch existing tokens.
 */
export async function batchCreateClickTokens(
  campaignId: string,
  subscriberIds: string[],
  linkIds: string[]
): Promise<Map<string, Map<string, string>>> {
  if (subscriberIds.length === 0 || linkIds.length === 0) return new Map();

  const allTokens: string[] = [];
  const allTypes: string[] = [];
  const allCampaigns: string[] = [];
  const allSubscribers: string[] = [];
  const allLinks: string[] = [];

  for (const sid of subscriberIds) {
    for (const lid of linkIds) {
      allTokens.push(generateToken());
      allTypes.push('click');
      allCampaigns.push(campaignId);
      allSubscribers.push(sid);
      allLinks.push(lid);
    }
  }

  // Chunk inserts to avoid huge unnest payloads
  for (let i = 0; i < allTokens.length; i += MAX_UNNEST_ROWS) {
    const chunk = allTokens.slice(i, i + MAX_UNNEST_ROWS);
    const types = allTypes.slice(i, i + MAX_UNNEST_ROWS);
    const camps = allCampaigns.slice(i, i + MAX_UNNEST_ROWS);
    const subs = allSubscribers.slice(i, i + MAX_UNNEST_ROWS);
    const links = allLinks.slice(i, i + MAX_UNNEST_ROWS);
    await pool.query(
      `INSERT INTO tracking_tokens (token, type, campaign_id, subscriber_id, link_id)
       SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::text[]), unnest($4::text[]), unnest($5::text[])
       ON CONFLICT DO NOTHING`,
      [chunk, types, camps, subs, links]
    );
  }

  const result = await pool.query(
    `SELECT token, subscriber_id, link_id
     FROM tracking_tokens
     WHERE type = 'click'
       AND campaign_id = $1
       AND subscriber_id = ANY($2::text[])
       AND link_id = ANY($3::text[])`,
    [campaignId, subscriberIds, linkIds]
  );

  const map = new Map<string, Map<string, string>>();
  for (const row of result.rows) {
    if (!map.has(row.subscriber_id)) map.set(row.subscriber_id, new Map());
    map.get(row.subscriber_id)!.set(row.link_id, row.token);
  }
  return map;
}

/**
 * Batch-create unsubscribe tokens for a list of subscribers.
 * Returns Map<subscriberId, token>.
 */
export async function batchCreateUnsubscribeTokens(
  campaignId: string,
  subscriberIds: string[]
): Promise<Map<string, string>> {
  if (subscriberIds.length === 0) return new Map();

  const tokens = subscriberIds.map(() => generateToken());
  const types = subscriberIds.map(() => 'unsubscribe');
  const camps = subscriberIds.map(() => campaignId);

  for (let i = 0; i < tokens.length; i += MAX_UNNEST_ROWS) {
    const chunk = tokens.slice(i, i + MAX_UNNEST_ROWS);
    const typChunk = types.slice(i, i + MAX_UNNEST_ROWS);
    const campChunk = camps.slice(i, i + MAX_UNNEST_ROWS);
    const subChunk = subscriberIds.slice(i, i + MAX_UNNEST_ROWS);
    await pool.query(
      `INSERT INTO tracking_tokens (token, type, campaign_id, subscriber_id)
       SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::text[]), unnest($4::text[])
       ON CONFLICT DO NOTHING`,
      [chunk, typChunk, campChunk, subChunk]
    );
  }

  const result = await pool.query(
    `SELECT token, subscriber_id
     FROM tracking_tokens
     WHERE type = 'unsubscribe'
       AND campaign_id = $1
       AND subscriber_id = ANY($2::text[])`,
    [campaignId, subscriberIds]
  );

  const map = new Map<string, string>();
  for (const row of result.rows) {
    map.set(row.subscriber_id, row.token);
  }
  return map;
}

/**
 * Resolve a short token to its campaign/subscriber/link metadata.
 * Returns null if the token does not exist.
 */
export async function resolveTrackingToken(token: string): Promise<{
  type: string;
  campaignId: string;
  subscriberId: string;
  linkId: string | null;
} | null> {
  const result = await pool.query(
    // ORDER BY created_at DESC + LIMIT 1: deterministic resolution on the rare
    // cross-day token collision (uniqueness intentionally not enforced on the
    // partitioned table). Served as a backward scan of PK (token, created_at).
    `SELECT type, campaign_id, subscriber_id, link_id
     FROM tracking_tokens WHERE token = $1 ORDER BY created_at DESC LIMIT 1`,
    [token]
  );
  if (result.rows.length === 0) {
    // Dual-read fallback: during the partition migration recent tokens may still
    // live only in tracking_tokens_legacy. Self-disables once the legacy table is
    // dropped (existence cache TTL + 42P01 latch).
    if (await legacyTokensTableExists(pool)) {
      try {
        const legacy = await pool.query(
          `SELECT type, campaign_id, subscriber_id, link_id
           FROM ${LEGACY_TOKENS_TABLE} WHERE token = $1 ORDER BY created_at DESC LIMIT 1`,
          [token]
        );
        if (legacy.rows.length > 0) {
          const lr = legacy.rows[0];
          return {
            type: lr.type,
            campaignId: lr.campaign_id,
            subscriberId: lr.subscriber_id,
            linkId: lr.link_id ?? null,
          };
        }
      } catch (err: any) {
        if (err?.code === "42P01") {
          noteLegacyTokensTableGone();
        } else {
          throw err;
        }
      }
    }
    return null;
  }
  const row = result.rows[0];
  return {
    type: row.type,
    campaignId: row.campaign_id,
    subscriberId: row.subscriber_id,
    linkId: row.link_id ?? null,
  };
}

// Supported date-range filters for the overall analytics view. Boundaries are
// computed in Europe/Paris local time (the operator's calendar) so "today",
// "this week", etc. line up with what the user sees on a wall clock.
export const ANALYTICS_RANGES = [
  "all",
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

// Builds the UTC half-open bounds [lower, upper) for an engagement-scoped
// period. Boundaries are computed against the operator's Europe/Paris wall
// clock (so "today"/"this week"/etc. match the calendar the user sees), then
// converted back to naive-UTC instants to match how `campaign_stats.timestamp`
// is stored. Comparing the raw column against plain UTC bounds lets Postgres
// use `campaign_stats_timestamp_idx` directly instead of a functional scan.
// Returns null for "all" (no time bound). date_trunc('week') starts Monday,
// which matches the French calendar; the day/week/month boundaries are all at
// local midnight, which is never the DST switch instant in Europe/Paris.
function analyticsPeriodBoundsUtc(range: AnalyticsRange) {
  const now = sql`(now() AT TIME ZONE 'Europe/Paris')`;
  const day = sql`date_trunc('day', ${now})`;
  const week = sql`date_trunc('week', ${now})`;
  const month = sql`date_trunc('month', ${now})`;
  // A Paris wall-clock timestamp -> the equivalent naive-UTC instant.
  const toUtc = (parisWall: ReturnType<typeof sql>) =>
    sql`((${parisWall}) AT TIME ZONE 'Europe/Paris') AT TIME ZONE 'UTC'`;
  switch (range) {
    case "today":
      return { lower: toUtc(day), upper: toUtc(sql`${day} + interval '1 day'`) };
    case "yesterday":
      return { lower: toUtc(sql`${day} - interval '1 day'`), upper: toUtc(day) };
    case "this_week":
      return { lower: toUtc(week), upper: toUtc(sql`${week} + interval '1 week'`) };
    case "last_week":
      return { lower: toUtc(sql`${week} - interval '1 week'`), upper: toUtc(week) };
    case "this_month":
      return { lower: toUtc(month), upper: toUtc(sql`${month} + interval '1 month'`) };
    case "last_month":
      return { lower: toUtc(sql`${month} - interval '1 month'`), upper: toUtc(month) };
    default:
      return null;
  }
}

// Normalizes the two SQL result sets (aggregate row + top-N rows) into the
// shape the /analytics overview expects. Shared by both the "all time" and the
// bounded-period branches so the response contract stays identical.
function shapeOverallAnalytics(aggResult: any, topResult: any) {
  const agg = aggResult.rows[0] as any;
  const recentCampaigns = (topResult.rows as any[]).map((r) => ({
    id: r.id,
    name: r.name,
    sentCount: Number(r.sent_count || 0),
    uniqueOpens: Number(r.unique_opens || 0),
    uniqueClicks: Number(r.unique_clicks || 0),
    openRate: Number(r.open_rate || 0),
    clickRate: Number(r.click_rate || 0),
  }));
  return {
    totalOpens: Number(agg?.total_opens || 0),
    totalClicks: Number(agg?.total_clicks || 0),
    totalCampaigns: Number(agg?.total_campaigns || 0),
    avgOpenRate: Number(agg?.avg_open_rate || 0),
    avgClickRate: Number(agg?.avg_click_rate || 0),
    recentCampaigns,
  };
}

export async function getOverallAnalytics(range: AnalyticsRange = "all", search?: string) {
  const normalizedRange: AnalyticsRange = (ANALYTICS_RANGES as readonly string[]).includes(range)
    ? range
    : "all";
  const TOP_N = 20;
  const bounds = analyticsPeriodBoundsUtc(normalizedRange);

  // Optional campaign-name search. Applied ONLY to the Top-N campaign list, not
  // the aggregate stat cards (those stay scoped to the whole period). Empty when
  // no search term so the SQL is unchanged. The term is bound as a parameter
  // (no string concatenation into SQL).
  const term = (search ?? "").trim();
  const likePattern = `%${term}%`;
  const nameFilterAll = term ? sql`AND name ILIKE ${likePattern}` : sql``;
  const nameFilterC = term ? sql`AND c.name ILIKE ${likePattern}` : sql``;

  // ── "All time" ──────────────────────────────────────────────────────────
  // No time bound, so read the small `campaigns` table via its cached
  // engagement counters (unique_opens_count / unique_clicks_count / sent_count,
  // kept fresh by the counter-reconciler). This deliberately avoids scanning the
  // large campaign_stats / ~89M-row campaign_sends tables on every page load.
  // Only campaigns that actually received engagement are shown, ranked by traffic.
  if (!bounds) {
    const [aggResult, topResult] = await Promise.all([
      db.execute(sql`
        SELECT
          COUNT(*)::int AS total_campaigns,
          COALESCE(SUM(unique_opens_count), 0)::int  AS total_opens,
          COALESCE(SUM(unique_clicks_count), 0)::int AS total_clicks,
          COALESCE(AVG(unique_opens_count::float  / NULLIF(sent_count, 0) * 100), 0)::float AS avg_open_rate,
          COALESCE(AVG(unique_clicks_count::float / NULLIF(sent_count, 0) * 100), 0)::float AS avg_click_rate
        FROM campaigns
        WHERE sent_count > 0 AND (unique_opens_count > 0 OR unique_clicks_count > 0)
      `),
      db.execute(sql`
        SELECT
          id,
          name,
          sent_count,
          COALESCE(unique_opens_count, 0)  AS unique_opens,
          COALESCE(unique_clicks_count, 0) AS unique_clicks,
          COALESCE(unique_opens_count::float  / NULLIF(sent_count, 0) * 100, 0) AS open_rate,
          COALESCE(unique_clicks_count::float / NULLIF(sent_count, 0) * 100, 0) AS click_rate
        FROM campaigns
        WHERE sent_count > 0 AND (unique_opens_count > 0 OR unique_clicks_count > 0) ${nameFilterAll}
        ORDER BY unique_clicks_count DESC, unique_opens_count DESC
        LIMIT ${TOP_N}
      `),
    ]);
    return shapeOverallAnalytics(aggResult, topResult);
  }

  // ── Bounded period ──────────────────────────────────────────────────────
  // Scope by ENGAGEMENT event time: only campaigns that received open/click
  // traffic inside [lower, upper) are included, and the unique open/click
  // counts are the DISTINCT subscribers who engaged DURING the window (not
  // lifetime). We range-scan campaign_stats by its `timestamp`
  // (campaign_stats_timestamp_idx) and join the tiny campaigns table for the
  // name + sent_count (the rate denominator). Heavier than the cached-counter
  // path, but bounded by the window's event volume.
  const periodCte = sql`
    period AS (
      SELECT
        campaign_id,
        COUNT(DISTINCT subscriber_id) FILTER (WHERE type = 'open')::int  AS unique_opens,
        COUNT(DISTINCT subscriber_id) FILTER (WHERE type = 'click')::int AS unique_clicks
      FROM campaign_stats
      WHERE timestamp >= ${bounds.lower} AND timestamp < ${bounds.upper}
        AND type IN ('open', 'click')
      GROUP BY campaign_id
    )
  `;
  const [aggResult, topResult] = await Promise.all([
    db.execute(sql`
      WITH ${periodCte}
      SELECT
        COUNT(*)::int AS total_campaigns,
        COALESCE(SUM(p.unique_opens), 0)::int  AS total_opens,
        COALESCE(SUM(p.unique_clicks), 0)::int AS total_clicks,
        COALESCE(AVG(p.unique_opens::float  / NULLIF(c.sent_count, 0) * 100), 0)::float AS avg_open_rate,
        COALESCE(AVG(p.unique_clicks::float / NULLIF(c.sent_count, 0) * 100), 0)::float AS avg_click_rate
      FROM period p
      JOIN campaigns c ON c.id = p.campaign_id
      WHERE p.unique_opens > 0 OR p.unique_clicks > 0
    `),
    db.execute(sql`
      WITH ${periodCte}
      SELECT
        c.id,
        c.name,
        c.sent_count,
        p.unique_opens,
        p.unique_clicks,
        COALESCE(p.unique_opens::float  / NULLIF(c.sent_count, 0) * 100, 0) AS open_rate,
        COALESCE(p.unique_clicks::float / NULLIF(c.sent_count, 0) * 100, 0) AS click_rate
      FROM period p
      JOIN campaigns c ON c.id = p.campaign_id
      WHERE (p.unique_opens > 0 OR p.unique_clicks > 0) ${nameFilterC}
      ORDER BY p.unique_clicks DESC, p.unique_opens DESC
      LIMIT ${TOP_N}
    `),
  ]);
  return shapeOverallAnalytics(aggResult, topResult);
}

export async function getCampaignBatchOpenStats(
  campaignId: string,
  batchSize: number = 10000
): Promise<Array<{
  batchNum: number;
  sent: number;
  opened: number;
  openRate: number;
  batchStart: string;
  batchEnd: string;
}>> {
  type BatchRow = {
    batch_num: string | number;
    sent: string | number;
    opened: string | number;
    open_rate: string | number;
    batch_start: Date | string;
    batch_end: Date | string;
  };
  const result = await db.execute(sql`
    SELECT
      batch_num,
      COUNT(*)::int AS sent,
      COUNT(first_open_at)::int AS opened,
      ROUND(COUNT(first_open_at)::numeric / NULLIF(COUNT(*), 0) * 100, 2)::float AS open_rate,
      MIN(sent_at) AS batch_start,
      MAX(sent_at) AS batch_end
    FROM (
      SELECT
        first_open_at,
        sent_at,
        CEIL(ROW_NUMBER() OVER (ORDER BY sent_at) / ${batchSize}::float)::int AS batch_num
      FROM campaign_sends
      WHERE campaign_id = ${campaignId}
        AND status IN ('sent', 'bounced', 'failed')
    ) batched
    GROUP BY batch_num
    ORDER BY batch_num
  `);
  return (result.rows as BatchRow[]).map((row) => ({
    batchNum: Number(row.batch_num),
    sent: Number(row.sent),
    opened: Number(row.opened),
    openRate: Number(row.open_rate),
    batchStart: row.batch_start instanceof Date ? row.batch_start.toISOString() : String(row.batch_start),
    batchEnd: row.batch_end instanceof Date ? row.batch_end.toISOString() : String(row.batch_end),
  }));
}
