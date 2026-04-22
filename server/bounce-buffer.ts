/**
 * In-memory bounce-webhook buffer with batched flusher.
 *
 * Mirror of tracking-buffer.ts. The /api/webhooks/bounce[/batch] endpoints
 * push events here and respond 202 immediately; a background flusher drains
 * the queue every BOUNCE_FLUSH_INTERVAL_MS into batched UPDATE/INSERT
 * statements against the dedicated tracking pool.
 *
 * Why share the tracking pool? Bounce traffic is bursty (Mailgun/SES retries
 * can spike to hundreds/sec for a few minutes). Sharing the tracking pool
 * keeps the connection budget tight and reuses the same isolation guarantee:
 * a bounce flood can never drain the user-facing main pool.
 *
 * Idempotency contract preserved: dedupe key (email|type) inside a 60 s
 * window; the in-flush "skip if subscriber already has BCK / bounce:soft"
 * check then handles cross-batch idempotency just like the synchronous
 * path used to.
 */
import { trackingPool } from "./tracking-pool";
import { logger } from "./logger";
import {
  bounceBufferEnqueued,
  bounceBufferFlushed,
  bounceBufferDropped,
  bounceBufferDeduped,
  bounceBufferQueueDepth,
} from "./metrics";

export type BounceType = "hard_bounce" | "soft_bounce" | "complaint" | "unsubscribe";

interface BounceEvent {
  email: string;
  type: BounceType;
  reason?: string;
  campaignId?: string | null;
  // ESP-supplied unique message id (Mailgun: Message-Id header,
  // SES: mail.messageId). When present, dedupe is keyed on (email|messageId)
  // so legitimate retries collapse to one event regardless of ESP reorder.
  // When absent, falls back to (email|type) to preserve prior behavior.
  messageId?: string | null;
  enqueuedAt: number;
}

const FLUSH_INTERVAL_MS = Number(process.env.BOUNCE_FLUSH_INTERVAL_MS || 1500);
const MAX_QUEUE = Number(process.env.BOUNCE_BUFFER_MAX || 25_000);
const MAX_BATCH = Number(process.env.BOUNCE_FLUSH_BATCH_MAX || 2_000);
const DEDUPE_WINDOW_MS = Number(process.env.BOUNCE_DEDUPE_WINDOW_MS || 60_000);
const DROP_WARN_INTERVAL_MS = 10_000;

let queue: BounceEvent[] = [];
let lastDropWarnAt = 0;
let droppedSinceLastWarn = 0;
const dedupe = new Map<string, number>();

function dedupeKey(e: { email: string; type: BounceType; messageId?: string | null }): string {
  const email = e.email.toLowerCase();
  // Prefer (email|messageId) — that's the contract: duplicate webhooks for
  // the same ESP message must collapse to a single processed event. Fall
  // back to (email|type) when no messageId is supplied (older ESP / batch
  // imports), preserving previous behavior.
  if (e.messageId) return `${email}|${e.messageId}`;
  return `${email}|${e.type}`;
}

function pruneDedupe(now: number): void {
  if (dedupe.size < 50_000) return;
  const cutoff = now - DEDUPE_WINDOW_MS;
  for (const [k, ts] of dedupe) {
    if (ts < cutoff) dedupe.delete(k);
  }
}

export type EnqueueResult = "accepted" | "deduped" | "dropped";

/**
 * Enqueue a bounce. Returns:
 *   "accepted" — appended to the queue, will be flushed.
 *   "deduped"  — collapsed by (email|messageId) (or fallback) inside the
 *                dedupe window; client should NOT retry.
 *   "dropped"  — queue full and the oldest event was evicted to make room
 *                for this one; observability bumps bounce_buffer_dropped.
 *                Returned to the caller so 202 responses + metrics are
 *                accurate (the new event itself IS enqueued — only the
 *                evicted one was lost).
 * Always non-blocking.
 */
export function enqueueBounce(event: Omit<BounceEvent, "enqueuedAt">): EnqueueResult {
  try {
    const now = Date.now();
    const key = dedupeKey(event);
    const last = dedupe.get(key);
    if (last !== undefined && now - last < DEDUPE_WINDOW_MS) {
      bounceBufferDeduped.inc({ type: event.type });
      return "deduped";
    }
    dedupe.set(key, now);
    pruneDedupe(now);

    let dropped = false;
    if (queue.length >= MAX_QUEUE) {
      const evicted = queue.shift();
      if (evicted) dedupe.delete(dedupeKey(evicted));
      droppedSinceLastWarn++;
      dropped = true;
      bounceBufferDropped.inc({ reason: "queue_full" });
      if (now - lastDropWarnAt > DROP_WARN_INTERVAL_MS) {
        logger.warn(
          `[BOUNCE BUFFER] Queue full (${MAX_QUEUE}); dropped ${droppedSinceLastWarn} events in last ${Math.round((now - lastDropWarnAt) / 1000)}s`,
        );
        lastDropWarnAt = now;
        droppedSinceLastWarn = 0;
      }
    }

    queue.push({ ...event, email: event.email.toLowerCase(), enqueuedAt: now });
    bounceBufferEnqueued.inc({ type: event.type });
    bounceBufferQueueDepth.set(queue.length);
    return dropped ? "dropped" : "accepted";
  } catch (err: any) {
    logger.error(`[BOUNCE BUFFER] enqueue failed: ${err?.message || err}`);
    return "dropped";
  }
}

let flushTimer: NodeJS.Timeout | null = null;
let flushing = false;

async function flush(): Promise<void> {
  if (flushing) return;
  if (queue.length === 0) {
    bounceBufferQueueDepth.set(0);
    return;
  }
  flushing = true;
  const batch = queue.length > MAX_BATCH
    ? queue.splice(0, MAX_BATCH)
    : (() => { const b = queue; queue = []; return b; })();
  bounceBufferQueueDepth.set(queue.length);

  try {
    // Collapse intra-batch duplicates using the same (email|messageId)
    // (or fallback) key — keep the latest reason.
    const collapsed = new Map<string, BounceEvent>();
    for (const ev of batch) {
      const k = dedupeKey(ev);
      collapsed.set(k, ev);
    }
    const events = [...collapsed.values()];

    // Resolve subscribers in one query
    const emails = [...new Set(events.map((e) => e.email))];
    const subscribers = await trackingPool.query(
      `SELECT id, email, tags FROM subscribers WHERE email = ANY($1::text[])`,
      [emails],
    );
    const subscriberMap = new Map<string, { id: string; tags: string[] | null }>();
    for (const row of subscribers.rows) {
      subscriberMap.set(String(row.email).toLowerCase(), { id: row.id, tags: row.tags });
    }

    const hardBounceIds: string[] = [];
    const complaintIds: string[] = [];
    const softBounceIds: string[] = [];
    const errorRows: Array<{ email: string; subscriberId: string; type: string; reason: string; campaignId: string | null; details: string }> = [];

    for (const ev of events) {
      const sub = subscriberMap.get(ev.email);
      if (!sub) continue;
      const tags = sub.tags || [];
      if (ev.type === "hard_bounce" || ev.type === "complaint") {
        if (tags.includes("BCK")) continue;
        if (ev.type === "hard_bounce") hardBounceIds.push(sub.id);
        else complaintIds.push(sub.id);
      } else if (ev.type === "soft_bounce") {
        if (tags.includes("bounce:soft")) continue;
        softBounceIds.push(sub.id);
      } else if (ev.type === "unsubscribe") {
        if (tags.includes("BCK")) continue;
        // Unsubscribes only get logged; the tracking buffer's
        // setSuppressedUntil + tag-queue handles the suppression side.
      }
      errorRows.push({
        email: ev.email,
        subscriberId: sub.id,
        type: ev.type,
        reason: ev.reason || "No reason provided",
        campaignId: ev.campaignId || null,
        details: JSON.stringify({ email: ev.email, type: ev.type, reason: ev.reason, campaignId: ev.campaignId, messageId: ev.messageId || null }),
      });
    }

    await Promise.allSettled([
      bulkAddTagsViaTrackingPool(hardBounceIds, ["BCK", "bounce:hard_bounce"]),
      bulkAddTagsViaTrackingPool(complaintIds, ["BCK", "bounce:complaint"]),
      bulkAddTagsViaTrackingPool(softBounceIds, ["bounce:soft"]),
      bulkInsertErrorLogs(errorRows),
    ]);

    bounceBufferFlushed.inc({ type: "hard_bounce" }, hardBounceIds.length);
    bounceBufferFlushed.inc({ type: "complaint" }, complaintIds.length);
    bounceBufferFlushed.inc({ type: "soft_bounce" }, softBounceIds.length);
    bounceBufferFlushed.inc({ type: "unsubscribe" }, events.filter((e) => e.type === "unsubscribe").length);
  } catch (err: any) {
    bounceBufferDropped.inc({ reason: "flush_error" }, batch.length);
    // Clear dedupe entries so legitimate retries are not silently suppressed.
    for (const ev of batch) dedupe.delete(dedupeKey(ev));
    logger.error(`[BOUNCE BUFFER] flush failed: ${err?.message || err}`);
  } finally {
    flushing = false;
  }
}

/**
 * Append tags via the tracking pool (mirrors storage.bulkAddTags but stays
 * off the main pool). Uses array_cat with deduplication so we don't add
 * a tag that's already present, matching the existing semantics.
 */
async function bulkAddTagsViaTrackingPool(subscriberIds: string[], tags: string[]): Promise<void> {
  if (subscriberIds.length === 0 || tags.length === 0) return;
  await trackingPool.query(
    `UPDATE subscribers
        SET tags = (
          SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(tags, '{}'::text[]) || $2::text[]))
        )
      WHERE id = ANY($1::varchar[])`,
    [subscriberIds, tags],
  );
}

async function bulkInsertErrorLogs(rows: Array<{ email: string; subscriberId: string; type: string; reason: string; campaignId: string | null; details: string }>): Promise<void> {
  if (rows.length === 0) return;
  const values: any[] = [];
  const placeholders: string[] = [];
  let p = 1;
  for (const r of rows) {
    placeholders.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, NOW())`);
    values.push(
      "send_failed",
      "warning",
      `${r.type}: ${r.reason}`,
      r.email,
      r.subscriberId,
      r.campaignId,
      r.details,
    );
  }
  await trackingPool.query(
    `INSERT INTO error_logs (type, severity, message, email, subscriber_id, campaign_id, details, created_at)
     VALUES ${placeholders.join(", ")}`,
    values,
  );
}

export function startBounceBufferFlusher(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flush().catch((err) => logger.error(`[BOUNCE BUFFER] tick failed: ${err?.message || err}`));
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref();
  logger.info(
    `[BOUNCE BUFFER] flusher started: interval=${FLUSH_INTERVAL_MS}ms, maxQueue=${MAX_QUEUE}, maxBatch=${MAX_BATCH}, dedupeWindow=${DEDUPE_WINDOW_MS}ms`,
  );
}

export async function stopBounceBufferFlusher(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  if (queue.length > 0) {
    logger.info(`[BOUNCE BUFFER] draining ${queue.length} events on shutdown`);
    try {
      await flush();
    } catch (err: any) {
      logger.error(`[BOUNCE BUFFER] final drain failed: ${err?.message || err}`);
    }
  }
}

export function getBounceBufferStats() {
  return {
    queueDepth: queue.length,
    maxQueue: MAX_QUEUE,
    dedupeMapSize: dedupe.size,
  };
}
