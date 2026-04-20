import {
  subscribers,
  segments,
  pendingTagOperations,
  type Subscriber,
  type InsertSubscriber,
  type Segment,
  type InsertSegment,
} from "@shared/schema";
import { db, pool } from "../db";
import { eq, like, or, sql, desc, and, not, inArray } from "drizzle-orm";
import { logger } from "../logger";
import { compileSegmentRules } from "../services/segment-compiler";
import { type SegmentRulesV2, migrateRulesV1toV2 } from "@shared/schema";
import { redisConnection, isRedisConfigured } from "../redis";

// ─── Segment count cache ────────────────────────────────────────────────────
// Primary: Redis (shared across instances). Fallback: in-memory Map when
// Redis is not configured.
const SEGMENT_COUNT_CACHE_TTL = 300_000; // 5 minutes (ms, in-memory fallback)
const SEGMENT_COUNT_CACHE_TTL_SEC = 300; // 5 minutes (Redis EXPIRE)
const REDIS_SEGMENT_COUNT_PREFIX = "segment:count:";

const segmentCountCache = new Map<string, { count: number; timestamp: number }>();

// Auto-prune expired in-memory entries every 5 minutes (no-op when Redis is used)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of segmentCountCache) {
    if (now - entry.timestamp > SEGMENT_COUNT_CACHE_TTL) segmentCountCache.delete(key);
  }
}, 300_000).unref();

async function redisGetSegmentCount(segmentId: string): Promise<number | null> {
  if (!redisConnection) return null;
  try {
    const v = await redisConnection.get(REDIS_SEGMENT_COUNT_PREFIX + segmentId);
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch (err) {
    logger.warn(`[segmentCount] Redis get failed: ${(err as Error).message}`);
    return null;
  }
}

async function redisSetSegmentCount(segmentId: string, count: number): Promise<void> {
  if (!redisConnection) return;
  try {
    await redisConnection.set(
      REDIS_SEGMENT_COUNT_PREFIX + segmentId,
      String(count),
      "EX",
      SEGMENT_COUNT_CACHE_TTL_SEC,
    );
  } catch (err) {
    logger.warn(`[segmentCount] Redis set failed: ${(err as Error).message}`);
  }
}

async function redisDeleteSegmentCount(segmentId?: string): Promise<void> {
  if (!redisConnection) return;
  try {
    if (segmentId) {
      await redisConnection.del(REDIS_SEGMENT_COUNT_PREFIX + segmentId);
      return;
    }
    let cursor = "0";
    do {
      const [next, keys] = await redisConnection.scan(
        cursor,
        "MATCH",
        `${REDIS_SEGMENT_COUNT_PREFIX}*`,
        "COUNT",
        100,
      );
      cursor = next;
      if (keys.length > 0) await redisConnection.del(...keys);
    } while (cursor !== "0");
  } catch (err) {
    logger.warn(`[segmentCount] Redis del failed: ${(err as Error).message}`);
  }
}

function normalizeRules(rules: any): SegmentRulesV2 | null {
  if (!rules) return null;
  if (rules.version === 2) return rules as SegmentRulesV2;
  if (Array.isArray(rules) && rules.length > 0) return migrateRulesV1toV2(rules);
  return null;
}

// ═══════════════════════════════════════════════════════════════
// SUBSCRIBER CRUD
// ═══════════════════════════════════════════════════════════════

export async function getSubscribers(page: number, limit: number, search?: string): Promise<{ subscribers: Subscriber[]; total: number }> {
  const offset = (page - 1) * limit;
  let query = db.select().from(subscribers);
  let countQuery = db.select({ count: sql<number>`count(*)` }).from(subscribers);

  if (search) {
    const searchUpper = search.toUpperCase();
    const searchCondition = or(
      like(subscribers.email, `%${search}%`),
      sql`${searchUpper} = ANY(${subscribers.tags})`,
      sql`${searchUpper} = ANY(${subscribers.refs})`
    );
    query = query.where(searchCondition) as typeof query;
    countQuery = countQuery.where(searchCondition) as typeof countQuery;
  }

  const [subs, [{ count }]] = await Promise.all([
    query.orderBy(desc(subscribers.importDate)).limit(limit).offset(offset),
    countQuery,
  ]);

  return { subscribers: subs, total: Number(count) };
}

export async function getSubscriber(id: string): Promise<Subscriber | undefined> {
  const [sub] = await db.select().from(subscribers).where(eq(subscribers.id, id));
  return sub;
}

export async function getSubscriberByEmail(email: string): Promise<Subscriber | undefined> {
  const [sub] = await db.select().from(subscribers).where(eq(subscribers.email, email.toLowerCase()));
  return sub;
}

export async function getSubscribersByEmails(emails: string[]): Promise<Map<string, Subscriber>> {
  const result = new Map<string, Subscriber>();
  if (emails.length === 0) return result;
  const lowerEmails = emails.map(e => e.toLowerCase());
  const rows = await db.select().from(subscribers).where(inArray(subscribers.email, lowerEmails));
  for (const row of rows) {
    result.set(row.email.toLowerCase(), row);
  }
  return result;
}

export async function createSubscriber(data: InsertSubscriber): Promise<Subscriber> {
  const [sub] = await db.insert(subscribers).values({
    ...data,
    email: data.email.toLowerCase(),
  }).returning();
  return sub;
}

export async function updateSubscriber(id: string, data: Partial<InsertSubscriber>): Promise<Subscriber | undefined> {
  const [sub] = await db.update(subscribers).set(data).where(eq(subscribers.id, id)).returning();
  return sub;
}

export async function setSuppressedUntil(subscriberId: string): Promise<void> {
  await db.execute(
    sql`UPDATE subscribers SET suppressed_until = NOW() + INTERVAL '30 days' WHERE id = ${subscriberId}`
  );
}

export async function deleteSubscriber(id: string): Promise<void> {
  // campaign_sends and campaign_stats cascade from subscriber FK
  await db.execute(sql`DELETE FROM nullsink_captures WHERE subscriber_id = ${id}`);
  await db.execute(sql`DELETE FROM error_logs WHERE subscriber_id = ${id}`);
  await db.delete(subscribers).where(eq(subscribers.id, id));
}

export async function deleteAllSubscribers(): Promise<number> {
  await db.execute(sql`DELETE FROM error_logs WHERE subscriber_id IS NOT NULL`);
  await db.execute(sql`DELETE FROM nullsink_captures`);
  await db.execute(sql`DELETE FROM automation_enrollments`);
  // campaign_sends, campaign_stats, pending_tag_operations cascade from subscribers FK
  const result = await db.execute(sql`DELETE FROM subscribers`);
  return result.rowCount || 0;
}

export async function bulkDeleteByEmails(emails: string[]): Promise<{ deleted: number; notFound: number }> {
  if (emails.length === 0) return { deleted: 0, notFound: 0 };
  const lowerEmails = [...new Set(emails.map(e => e.toLowerCase().trim()).filter(Boolean))];
  const BATCH = 5000;
  let totalDeleted = 0;

  for (let i = 0; i < lowerEmails.length; i += BATCH) {
    const batch = lowerEmails.slice(i, i + BATCH);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const idResult = await client.query(
        `SELECT id FROM subscribers WHERE email = ANY($1::text[])`,
        [batch]
      );
      const ids = idResult.rows.map((r: { id: string }) => r.id);
      if (ids.length > 0) {
        await client.query(`DELETE FROM error_logs WHERE subscriber_id = ANY($1::text[])`, [ids]);
        await client.query(`DELETE FROM nullsink_captures WHERE subscriber_id = ANY($1::text[])`, [ids]);
        await client.query(`DELETE FROM automation_enrollments WHERE subscriber_id = ANY($1::text[])`, [ids]);
        const delResult = await client.query(
          `DELETE FROM subscribers WHERE id = ANY($1::text[])`,
          [ids]
        );
        totalDeleted += delResult.rowCount || 0;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  return { deleted: totalDeleted, notFound: lowerEmails.length - totalDeleted };
}

export async function countByEmails(emails: string[]): Promise<number> {
  if (emails.length === 0) return 0;
  const lowerEmails = [...new Set(emails.map(e => e.toLowerCase().trim()).filter(Boolean))];
  const result = await pool.query(
    `SELECT COUNT(*) AS cnt FROM subscribers WHERE email = ANY($1::text[])`,
    [lowerEmails]
  );
  return parseInt(result.rows[0]?.cnt || '0', 10);
}

// ═══════════════════════════════════════════════════════════════
// SEGMENT OPERATIONS
// ═══════════════════════════════════════════════════════════════

export async function getSubscribersForSegment(segmentId: string, limit?: number, offset?: number): Promise<Subscriber[]> {
  const segment = await getSegment(segmentId);
  if (!segment) return [];

  const normalized = normalizeRules(segment.rules);
  if (!normalized) return [];

  const whereCondition = compileSegmentRules(normalized);
  let query = db.select().from(subscribers).where(
    and(not(sql`'BCK' = ANY(${subscribers.tags})`), whereCondition)
  );

  if (limit !== undefined) query = query.limit(limit) as typeof query;
  if (offset !== undefined) query = query.offset(offset) as typeof query;

  return query;
}

export async function getSubscribersForSegmentCursor(segmentId: string, limit: number, afterId?: string): Promise<Subscriber[]> {
  const segment = await getSegment(segmentId);
  if (!segment) return [];

  const normalized = normalizeRules(segment.rules);
  if (!normalized) return [];

  const segmentCondition = compileSegmentRules(normalized);
  const baseCondition = and(not(sql`'BCK' = ANY(${subscribers.tags})`), segmentCondition);

  if (afterId) {
    return db.select().from(subscribers).where(
      and(baseCondition, sql`${subscribers.id} > ${afterId}`)
    ).orderBy(subscribers.id).limit(limit);
  }
  return db.select().from(subscribers).where(baseCondition).orderBy(subscribers.id).limit(limit);
}

export async function countSubscribersForSegment(segmentId: string): Promise<number> {
  const segment = await getSegment(segmentId);
  if (!segment) return 0;

  const normalized = normalizeRules(segment.rules);
  if (!normalized) return 0;

  const whereCondition = compileSegmentRules(normalized);
  const [{ count }] = await db.select({ count: sql<number>`count(*)` })
    .from(subscribers)
    .where(and(not(sql`'BCK' = ANY(${subscribers.tags})`), whereCondition));

  return Number(count);
}

export async function countSubscribersForRules(rules: any[]): Promise<number> {
  const normalized = normalizeRules(rules);
  if (!normalized) return 0;

  const whereCondition = compileSegmentRules(normalized);
  const [{ count }] = await db.select({ count: sql<number>`count(*)` })
    .from(subscribers)
    .where(and(not(sql`'BCK' = ANY(${subscribers.tags})`), whereCondition));

  return Number(count);
}

export async function previewSegmentRules(rules: SegmentRulesV2, sampleLimit: number = 10): Promise<{ count: number; sample: Subscriber[] }> {
  const normalized = normalizeRules(rules);
  if (!normalized) return { count: 0, sample: [] };

  const whereCondition = compileSegmentRules(normalized);
  const condition = and(not(sql`'BCK' = ANY(${subscribers.tags})`), whereCondition);

  const [{ count }, sample] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(subscribers).where(condition).then(r => r[0]),
    db.select().from(subscribers).where(condition).limit(sampleLimit),
  ]);

  return { count: Number(count), sample };
}

export async function duplicateSegment(id: string): Promise<Segment | undefined> {
  const original = await getSegment(id);
  if (!original) return undefined;
  return createSegment({
    name: `${original.name} (Copy)`,
    description: original.description,
    rules: original.rules as any,
  });
}

export async function getSegments(): Promise<Segment[]> {
  return db.select().from(segments).orderBy(desc(segments.createdAt));
}

export async function getSegment(id: string): Promise<Segment | undefined> {
  const [segment] = await db.select().from(segments).where(eq(segments.id, id));
  return segment;
}

export async function createSegment(data: InsertSegment): Promise<Segment> {
  const [segment] = await db.insert(segments).values(data).returning();
  return segment;
}

export async function updateSegment(id: string, data: Partial<InsertSegment>): Promise<Segment | undefined> {
  const [segment] = await db.update(segments).set(data).where(eq(segments.id, id)).returning();
  return segment;
}

export async function deleteSegment(id: string): Promise<void> {
  await db.delete(segments).where(eq(segments.id, id));
}

export async function getSegmentSubscriberCountCached(segmentId: string): Promise<number> {
  if (isRedisConfigured) {
    const fromRedis = await redisGetSegmentCount(segmentId);
    if (fromRedis !== null) return fromRedis;
    const count = await countSubscribersForSegment(segmentId);
    await redisSetSegmentCount(segmentId, count);
    return count;
  }
  // In-memory fallback when Redis is not configured
  const cached = segmentCountCache.get(segmentId);
  if (cached && Date.now() - cached.timestamp < SEGMENT_COUNT_CACHE_TTL) {
    return cached.count;
  }
  const count = await countSubscribersForSegment(segmentId);
  segmentCountCache.set(segmentId, { count, timestamp: Date.now() });
  return count;
}

export async function invalidateSegmentCountCache(segmentId?: string): Promise<void> {
  if (segmentId) {
    segmentCountCache.delete(segmentId);
  } else {
    segmentCountCache.clear();
  }
  // Awaiting Redis deletion guarantees that any subsequent read on this or
  // any other instance will miss the cache and recompute the count. This is
  // required by callers like `?refresh=true` that immediately re-read the
  // count right after invalidating.
  await redisDeleteSegmentCount(segmentId);
}

// ═══════════════════════════════════════════════════════════════
// DATABASE INDEX MANAGEMENT
// ═══════════════════════════════════════════════════════════════

export async function dropSubscriberGinIndexes(): Promise<void> {
  logger.info('Dropping GIN indexes for large import optimization');
  await db.execute(sql`DROP INDEX IF EXISTS tags_gin_idx`);
  await db.execute(sql`DROP INDEX IF EXISTS refs_gin_idx`);
  logger.info('GIN indexes dropped');
}

export async function recreateSubscriberGinIndexes(): Promise<void> {
  logger.info('Recreating GIN indexes after import');
  try {
    await db.execute(sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS tags_gin_idx ON subscribers USING gin (tags)`);
  } catch {
    await db.execute(sql`CREATE INDEX IF NOT EXISTS tags_gin_idx ON subscribers USING gin (tags)`);
  }
  try {
    await db.execute(sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS refs_gin_idx ON subscribers USING gin (refs)`);
  } catch {
    await db.execute(sql`CREATE INDEX IF NOT EXISTS refs_gin_idx ON subscribers USING gin (refs)`);
  }
  logger.info('GIN indexes recreated');
}

export async function areGinIndexesPresent(): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT COUNT(*) as count FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'subscribers' AND indexname = 'tags_gin_idx'
  `);
  return parseInt((result.rows[0] as any)?.count || '0', 10) >= 1;
}

export async function ensureTrigramIndex(): Promise<void> {
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  await db.execute(sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS email_trgm_idx ON subscribers USING gin (email gin_trgm_ops)`);
}

// ═══════════════════════════════════════════════════════════════
// TAG OPERATIONS
// ═══════════════════════════════════════════════════════════════

export async function enqueueTagOperation(
  subscriberId: string,
  tagValue: string,
  eventType: "open" | "click" | "unsubscribe",
  campaignId?: string
): Promise<void> {
  await db.insert(pendingTagOperations).values({
    subscriberId,
    tagType: "tags",
    tagValue,
    eventType,
    campaignId,
    status: "pending",
  });
}

export async function claimPendingTagOperations(limit: number = 100): Promise<Array<{
  id: string; subscriberId: string; tagValue: string; eventType: string; retryCount: number;
}>> {
  const result = await db.execute(sql`
    UPDATE pending_tag_operations
    SET status = 'processing'
    WHERE id IN (
      SELECT id FROM pending_tag_operations
      WHERE status = 'pending'
        AND (next_retry_at IS NULL OR next_retry_at <= NOW())
      ORDER BY created_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, subscriber_id, tag_value, event_type, retry_count
  `);

  return result.rows.map((row: any) => ({
    id: row.id,
    subscriberId: row.subscriber_id,
    tagValue: row.tag_value,
    eventType: row.event_type,
    retryCount: Number(row.retry_count),
  }));
}

export async function completeTagOperation(operationId: string): Promise<void> {
  await db.update(pendingTagOperations)
    .set({ status: "completed", processedAt: new Date() })
    .where(eq(pendingTagOperations.id, operationId));
}

export async function failTagOperation(operationId: string, error: string): Promise<void> {
  await db.execute(sql`
    UPDATE pending_tag_operations
    SET
      status = CASE WHEN retry_count >= max_retries - 1 THEN 'failed' ELSE 'pending' END,
      retry_count = retry_count + 1,
      last_error = ${error},
      next_retry_at = CASE
        WHEN retry_count >= max_retries - 1 THEN NULL
        ELSE NOW() + (POWER(2, retry_count) * INTERVAL '1 second')
      END
    WHERE id = ${operationId}
  `);
}

export async function getTagQueueStats(): Promise<{ pending: number; processing: number; completed: number; failed: number }> {
  const result = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending') as pending,
      COUNT(*) FILTER (WHERE status = 'processing') as processing,
      COUNT(*) FILTER (WHERE status = 'completed') as completed,
      COUNT(*) FILTER (WHERE status = 'failed') as failed
    FROM pending_tag_operations
  `);
  const row = result.rows[0] as any;
  return {
    pending: Number(row?.pending || 0),
    processing: Number(row?.processing || 0),
    completed: Number(row?.completed || 0),
    failed: Number(row?.failed || 0),
  };
}

export async function cleanupCompletedTagOperations(olderThanDays: number = 7): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
  const result = await db.delete(pendingTagOperations)
    .where(and(
      eq(pendingTagOperations.status, "completed"),
      sql`${pendingTagOperations.processedAt} < ${cutoffDate}`
    ));
  return result.rowCount || 0;
}

export async function addTagToSubscriber(subscriberId: string, tagValue: string): Promise<boolean> {
  await db.execute(sql`
    UPDATE subscribers
    SET tags = array_append(array_remove(tags, ${tagValue}), ${tagValue})
    WHERE id = ${subscriberId} AND NOT (${tagValue} = ANY(tags))
    RETURNING id
  `);
  return true;
}

export async function bulkAddTagToSubscribers(subscriberIds: string[], tagValue: string): Promise<number> {
  if (subscriberIds.length === 0) return 0;
  const result = await pool.query(
    `UPDATE subscribers
     SET tags = array_append(array_remove(tags, $1), $1)
     WHERE id = ANY($2::text[]) AND NOT ($1 = ANY(tags))`,
    [tagValue, subscriberIds]
  );
  return result.rowCount || 0;
}

export async function bulkAddTags(subscriberIds: string[], tags: string[]): Promise<void> {
  if (subscriberIds.length === 0 || tags.length === 0) return;
  for (const tag of tags) {
    await bulkAddTagToSubscribers(subscriberIds, tag);
  }
}
