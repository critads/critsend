/**
 * In-memory tracking-event buffer with batched flusher.
 *
 * The HTTP tracking endpoints (open pixel, click redirect, unsubscribe page)
 * push events into this buffer and respond to the client immediately. A timer
 * drains the buffer every FLUSH_INTERVAL_MS into batched multi-row INSERTs
 * against the dedicated trackingPool, turning N synchronous DB writes per
 * second into ~one batched write per type per flush window.
 *
 * Properties:
 *   • Never blocks the request path — enqueue is O(1) and synchronous.
 *   • (campaignId, subscriberId, type) dedupe window collapses Gmail's
 *     "fetch the same open pixel 4 times in 2 seconds" behavior into one row.
 *   • Bounded queue length with drop-oldest + throttled warn — memory-safe
 *     during sustained overload.
 *   • Inside the flusher, the openTag / clickTag / unsubscribeTag side effects
 *     fire only for events that recordFirstOpen/Click marked as truly first
 *     (UPDATE … RETURNING semantics preserved).
 *   • Process-local LRU for getCampaignLinkDestination keeps warm clicks
 *     entirely off the database.
 */
import type { TrackingContext } from "./repositories/campaign-repository";
import { trackingPool, getTrackingPoolStats } from "./tracking-pool";
import { logger } from "./logger";
import {
  trackingBufferEnqueued,
  trackingBufferFlushed,
  trackingBufferDropped,
  trackingBufferDeduped,
  trackingBufferQueueDepth,
  trackingPoolInUse,
  trackingLinkCacheHits,
} from "./metrics";

export type TrackingEventType = "open" | "click" | "unsubscribe" | "complaint";

interface BaseEvent {
  type: TrackingEventType;
  campaignId: string;
  subscriberId: string;
  link?: string;
  ctx?: TrackingContext;
  enqueuedAt: number;
  // Side-effect hints used by the flusher
  openTag?: string | null;
  clickTag?: string | null;
  unsubscribeTag?: string | null;
}

const FLUSH_INTERVAL_MS = Number(process.env.TRACKING_FLUSH_INTERVAL_MS || 1500);
const MAX_QUEUE = Number(process.env.TRACKING_BUFFER_MAX || 50_000);
const MAX_BATCH_PER_TYPE = Number(process.env.TRACKING_FLUSH_BATCH_MAX || 5_000);
// (campaignId, subscriberId, type) dedupe window. Gmail/iCloud fetch the same
// open pixel 2-4 times within seconds; collapse those into one DB row.
const DEDUPE_WINDOW_MS = Number(process.env.TRACKING_DEDUPE_WINDOW_MS || 60_000);
// Throttle dropped-event warnings so an overloaded buffer doesn't itself
// flood the log.
const DROP_WARN_INTERVAL_MS = 10_000;
// LRU cache for link destinations (immutable after preregisterCampaignLinks)
const LINK_CACHE_MAX = Number(process.env.TRACKING_LINK_CACHE_MAX || 5_000);

// ── Queue ────────────────────────────────────────────────────────────────
let queue: BaseEvent[] = [];
let lastDropWarnAt = 0;
let droppedSinceLastWarn = 0;

// ── Dedupe map: key → timestamp of last accepted event ──────────────────
// Pruned opportunistically inside enqueue + on flush.
const dedupe = new Map<string, number>();

// ── LRU for link destinations (Map preserves insertion order) ───────────
const linkCache = new Map<string, string>();

function dedupeKey(e: { campaignId: string; subscriberId: string; type: TrackingEventType; link?: string }): string {
  // Clicks include the link so a subscriber clicking two different links in
  // the same email within the dedupe window still records both events
  // (otherwise per-link click analytics regress). Opens have no link, and
  // unsubscribes/complaints are intrinsically per-subscriber-per-campaign.
  if (e.type === "click") return `${e.campaignId}|${e.subscriberId}|click|${e.link ?? ""}`;
  return `${e.campaignId}|${e.subscriberId}|${e.type}`;
}

function pruneDedupe(now: number): void {
  // Cheap full sweep is fine — entries auto-expire after DEDUPE_WINDOW_MS,
  // and we cap growth so the map can't balloon unbounded.
  if (dedupe.size < 100_000) return;
  const cutoff = now - DEDUPE_WINDOW_MS;
  for (const [k, ts] of dedupe) {
    if (ts < cutoff) dedupe.delete(k);
  }
}

/**
 * Enqueue a tracking event. Returns true if accepted, false if dropped
 * (queue full or duplicate inside the dedupe window).
 *
 * Always non-blocking and exception-safe so callers can ignore the result.
 */
export function enqueueTrackingEvent(event: Omit<BaseEvent, "enqueuedAt">): boolean {
  try {
    const now = Date.now();

    // Dedupe (non-bot opens are the main offenders; bot complaints are rare
    // enough that we don't dedupe them — passing { skipDedupe: true } via the
    // existing complaint path is unnecessary because complaints route through
    // a different type).
    const key = dedupeKey(event);
    const last = dedupe.get(key);
    if (last !== undefined && now - last < DEDUPE_WINDOW_MS) {
      trackingBufferDeduped.inc({ type: event.type });
      return false;
    }
    dedupe.set(key, now);
    pruneDedupe(now);

    if (queue.length >= MAX_QUEUE) {
      // Drop oldest to make room — newer events are more useful (closer to
      // the user's actual behavior right now). Also clear its dedupe entry so
      // a subsequent retry isn't silently suppressed for the next 60s.
      const evicted = queue.shift();
      if (evicted) dedupe.delete(dedupeKey(evicted));
      droppedSinceLastWarn++;
      trackingBufferDropped.inc({ reason: "queue_full" });
      if (now - lastDropWarnAt > DROP_WARN_INTERVAL_MS) {
        logger.warn(
          `[TRACKING BUFFER] Queue full (${MAX_QUEUE}); dropped ${droppedSinceLastWarn} events in last ${Math.round((now - lastDropWarnAt) / 1000)}s`,
        );
        lastDropWarnAt = now;
        droppedSinceLastWarn = 0;
      }
    }

    queue.push({ ...event, enqueuedAt: now });
    trackingBufferEnqueued.inc({ type: event.type });
    trackingBufferQueueDepth.set(queue.length);
    return true;
  } catch (err: any) {
    // Never throw out of a tracking endpoint
    logger.error(`[TRACKING BUFFER] enqueue failed: ${err?.message || err}`);
    return false;
  }
}

// ── Link destination cache ───────────────────────────────────────────────

/**
 * LRU lookup for campaign_links.destination_url. On a miss, fetches from the
 * tracking pool (so the main pool is never touched by tracking traffic).
 */
export async function getLinkDestinationCached(linkId: string): Promise<string | null> {
  if (linkCache.has(linkId)) {
    // touch for LRU
    const url = linkCache.get(linkId)!;
    linkCache.delete(linkId);
    linkCache.set(linkId, url);
    trackingLinkCacheHits.inc({ result: "hit" });
    return url;
  }
  trackingLinkCacheHits.inc({ result: "miss" });
  const result = await trackingPool.query(
    `SELECT destination_url FROM campaign_links WHERE id = $1`,
    [linkId],
  );
  if (result.rows.length === 0) return null;
  const url = result.rows[0].destination_url as string;
  linkCache.set(linkId, url);
  if (linkCache.size > LINK_CACHE_MAX) {
    const oldest = linkCache.keys().next().value;
    if (oldest !== undefined) linkCache.delete(oldest);
  }
  return url;
}

export function primeLinkCache(entries: Iterable<[string, string]>): void {
  for (const [id, url] of entries) {
    if (!linkCache.has(id)) linkCache.set(id, url);
    if (linkCache.size > LINK_CACHE_MAX) {
      const oldest = linkCache.keys().next().value;
      if (oldest !== undefined) linkCache.delete(oldest);
    }
  }
}

// ── Flusher ──────────────────────────────────────────────────────────────

let flushTimer: NodeJS.Timeout | null = null;
let flushing = false;
// Side-effect promises (recordFirstOpen tag enqueues, suppression UPDATEs)
// fired by the current flusher cycle. Tracked so graceful shutdown can
// await them before closing the tracking pool — otherwise the pool can
// close mid-write and we lose first-open marks / suppressions.
let pendingSideEffects: Promise<unknown>[] = [];

/**
 * Drain the buffer and persist events in batched multi-row INSERTs.
 * Groups events by type so we issue one INSERT per type per cycle.
 *
 * Side effects (recordFirstOpen tag, recordFirstClick tag, suppressed_until,
 * tag operations) are batched too — see _processSideEffects.
 */
async function flush(): Promise<void> {
  if (flushing) return;
  if (queue.length === 0) {
    trackingBufferQueueDepth.set(0);
    return;
  }
  flushing = true;
  // Snapshot up to MAX_BATCH_PER_TYPE * 4 events; whatever is left will be
  // picked up on the next tick. Snapshot then rebuild to avoid mutation
  // during async work.
  const batch = queue.length > MAX_BATCH_PER_TYPE * 4
    ? queue.splice(0, MAX_BATCH_PER_TYPE * 4)
    : (() => { const b = queue; queue = []; return b; })();
  trackingBufferQueueDepth.set(queue.length);

  try {
    // Group by type; collapse intra-batch duplicates by (campaign,subscriber)
    // (the dedupe window already filtered cross-batch duplicates inside the
    // window — this guards against the case where the window expired but
    // multiple events landed in the same batch).
    const buckets: Record<TrackingEventType, Map<string, BaseEvent>> = {
      open: new Map(),
      click: new Map(),
      unsubscribe: new Map(),
      complaint: new Map(),
    };
    for (const ev of batch) {
      const k = `${ev.campaignId}|${ev.subscriberId}|${ev.link ?? ""}`;
      // First write wins (preserves the original open/click context)
      if (!buckets[ev.type].has(k)) buckets[ev.type].set(k, ev);
    }

    await Promise.allSettled([
      flushType("open", [...buckets.open.values()]),
      flushType("click", [...buckets.click.values()]),
      flushType("unsubscribe", [...buckets.unsubscribe.values()]),
      flushType("complaint", [...buckets.complaint.values()]),
    ]);
  } catch (err: any) {
    logger.error(`[TRACKING BUFFER] flush failed: ${err?.message || err}`);
  } finally {
    flushing = false;
    trackingPoolInUse.set(getTrackingPoolStats().total - getTrackingPoolStats().idle);
  }
}

async function flushType(type: TrackingEventType, events: BaseEvent[]): Promise<void> {
  if (events.length === 0) return;
  // Cap a single flush so a giant burst doesn't construct a 100k-row INSERT.
  // Excess goes back to the queue for the next tick.
  let toWrite = events;
  if (toWrite.length > MAX_BATCH_PER_TYPE) {
    const overflow = toWrite.slice(MAX_BATCH_PER_TYPE);
    toWrite = toWrite.slice(0, MAX_BATCH_PER_TYPE);
    // Push overflow back to head of queue
    queue.unshift(...overflow);
    trackingBufferQueueDepth.set(queue.length);
  }

  try {
    await insertBatch(type, toWrite);
    trackingBufferFlushed.inc({ type }, toWrite.length);
    // Side effects (first-open/click marker + tag ops + suppressed_until) —
    // tracked in pendingSideEffects so graceful shutdown can await them
    // before the tracking pool is closed.
    const sideEffectPromise = processSideEffects(type, toWrite).catch((err) => {
      logger.error(`[TRACKING BUFFER] side-effects (${type}) failed: ${err?.message || err}`);
    });
    pendingSideEffects.push(sideEffectPromise);
  } catch (err: any) {
    trackingBufferDropped.inc({ reason: "flush_error" }, toWrite.length);
    // Clear dedupe entries for the failed batch so legitimate retries from
    // the email client are not silently suppressed for the rest of the
    // dedupe window.
    for (const ev of toWrite) dedupe.delete(dedupeKey(ev));
    logger.error(`[TRACKING BUFFER] insert ${type} batch (${toWrite.length} rows) failed: ${err?.message || err}`);
  }
}

/**
 * Batched multi-row INSERT into campaign_stats. Builds the parameter list
 * dynamically because pg-node doesn't let us bind an array of ROWs.
 *
 * Schema (campaign_stats):
 *   id (default uuid), campaign_id, subscriber_id, type, link, timestamp,
 *   ip_address, user_agent, country, city, device_type, browser, os
 */
async function insertBatch(type: TrackingEventType, events: BaseEvent[]): Promise<void> {
  if (events.length === 0) return;
  const columns = [
    "campaign_id", "subscriber_id", "type", "link", "timestamp",
    "ip_address", "user_agent", "country", "city", "device_type", "browser", "os",
  ];
  const values: any[] = [];
  const placeholders: string[] = [];
  let p = 1;
  for (const e of events) {
    const ts = new Date(e.enqueuedAt);
    placeholders.push(
      `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`,
    );
    values.push(
      e.campaignId,
      e.subscriberId,
      type,
      e.link ?? null,
      ts,
      e.ctx?.ipAddress ?? null,
      e.ctx?.userAgent ?? null,
      e.ctx?.country ?? null,
      e.ctx?.city ?? null,
      e.ctx?.deviceType ?? null,
      e.ctx?.browser ?? null,
      e.ctx?.os ?? null,
    );
  }
  const sql = `INSERT INTO campaign_stats (${columns.join(", ")}) VALUES ${placeholders.join(", ")}`;
  await trackingPool.query(sql, values);
}

/**
 * Per-type side effects:
 *   open       → bulk recordFirstOpen via UPDATE…FROM…RETURNING; for each
 *                returned (campaign,subscriber) fire openTag if present.
 *   click      → same as open with recordFirstClick + clickTag.
 *   unsubscribe → bulk setSuppressedUntil + per-event unsubscribeTag.
 *   complaint   → bulk setSuppressedUntil + per-event STOP-tag.
 *
 * Tag operations are enqueued via storage.enqueueTagOperation. That call
 * itself writes to the DB, but the volume is at most one per first-open or
 * per unsubscribe — orders of magnitude less than raw open events, so it's
 * safe on the main pool. We still fire-and-forget to keep the flusher
 * responsive.
 */
async function processSideEffects(type: TrackingEventType, events: BaseEvent[]): Promise<void> {
  if (events.length === 0) return;

  if (type === "open") {
    const firsts = await bulkMarkFirstOpen(events);
    if (firsts.size > 0) {
      const { storage } = await import("./storage");
      for (const ev of events) {
        const k = `${ev.campaignId}|${ev.subscriberId}`;
        if (firsts.has(k) && ev.openTag) {
          storage
            .enqueueTagOperation(ev.subscriberId, ev.openTag, "open", ev.campaignId)
            .catch((err) => logger.error(`[TRACKING BUFFER] enqueue open tag failed: ${err?.message || err}`));
        }
      }
    }
    return;
  }

  if (type === "click") {
    const firsts = await bulkMarkFirstClick(events);
    if (firsts.size > 0) {
      const { storage } = await import("./storage");
      for (const ev of events) {
        const k = `${ev.campaignId}|${ev.subscriberId}`;
        if (firsts.has(k) && ev.clickTag) {
          storage
            .enqueueTagOperation(ev.subscriberId, ev.clickTag, "click", ev.campaignId)
            .catch((err) => logger.error(`[TRACKING BUFFER] enqueue click tag failed: ${err?.message || err}`));
        }
      }
    }
    return;
  }

  if (type === "unsubscribe" || type === "complaint") {
    // Bulk-suppress: deduped by subscriber.
    const subscriberIds = [...new Set(events.map((e) => e.subscriberId))];
    if (subscriberIds.length > 0) {
      try {
        await trackingPool.query(
          `UPDATE subscribers SET suppressed_until = NOW() + INTERVAL '30 days'
           WHERE id = ANY($1::varchar[])
             AND (suppressed_until IS NULL OR suppressed_until < NOW() + INTERVAL '30 days')`,
          [subscriberIds],
        );
      } catch (err: any) {
        logger.error(`[TRACKING BUFFER] bulk setSuppressedUntil failed: ${err?.message || err}`);
      }
    }

    const { storage } = await import("./storage");
    for (const ev of events) {
      if (!ev.unsubscribeTag) continue;
      const tagValue = type === "complaint" ? `STOP-${ev.unsubscribeTag}` : ev.unsubscribeTag;
      storage
        .enqueueTagOperation(ev.subscriberId, tagValue, "unsubscribe", ev.campaignId)
        .catch((err) => logger.error(`[TRACKING BUFFER] enqueue ${type} tag failed: ${err?.message || err}`));
    }
  }
}

/**
 * Bulk recordFirstOpen via UPDATE…FROM(VALUES…)…RETURNING.
 * Returns the set of "campaignId|subscriberId" keys that were marked first
 * (i.e. first_open_at was previously NULL).
 */
async function bulkMarkFirstOpen(events: BaseEvent[]): Promise<Set<string>> {
  const pairs = uniquePairs(events);
  if (pairs.length === 0) return new Set();
  // Build VALUES list
  const values: any[] = [];
  const placeholders: string[] = [];
  let p = 1;
  for (const [c, s] of pairs) {
    placeholders.push(`($${p++}::varchar, $${p++}::varchar)`);
    values.push(c, s);
  }
  const sql = `
    UPDATE campaign_sends cs
    SET first_open_at = NOW()
    FROM (VALUES ${placeholders.join(", ")}) AS v(campaign_id, subscriber_id)
    WHERE cs.campaign_id = v.campaign_id
      AND cs.subscriber_id = v.subscriber_id
      AND cs.first_open_at IS NULL
    RETURNING cs.campaign_id, cs.subscriber_id
  `;
  const result = await trackingPool.query(sql, values);
  const out = new Set<string>();
  for (const row of result.rows) out.add(`${row.campaign_id}|${row.subscriber_id}`);
  return out;
}

async function bulkMarkFirstClick(events: BaseEvent[]): Promise<Set<string>> {
  const pairs = uniquePairs(events);
  if (pairs.length === 0) return new Set();
  const values: any[] = [];
  const placeholders: string[] = [];
  let p = 1;
  for (const [c, s] of pairs) {
    placeholders.push(`($${p++}::varchar, $${p++}::varchar)`);
    values.push(c, s);
  }
  const sql = `
    UPDATE campaign_sends cs
    SET first_click_at = NOW()
    FROM (VALUES ${placeholders.join(", ")}) AS v(campaign_id, subscriber_id)
    WHERE cs.campaign_id = v.campaign_id
      AND cs.subscriber_id = v.subscriber_id
      AND cs.first_click_at IS NULL
    RETURNING cs.campaign_id, cs.subscriber_id
  `;
  const result = await trackingPool.query(sql, values);
  const out = new Set<string>();
  for (const row of result.rows) out.add(`${row.campaign_id}|${row.subscriber_id}`);
  return out;
}

function uniquePairs(events: BaseEvent[]): Array<[string, string]> {
  const seen = new Set<string>();
  const out: Array<[string, string]> = [];
  for (const e of events) {
    const k = `${e.campaignId}|${e.subscriberId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([e.campaignId, e.subscriberId]);
  }
  return out;
}

// ── Lifecycle ────────────────────────────────────────────────────────────

export function startTrackingBufferFlusher(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flush().catch((err) => logger.error(`[TRACKING BUFFER] tick failed: ${err?.message || err}`));
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref();
  logger.info(
    `[TRACKING BUFFER] flusher started: interval=${FLUSH_INTERVAL_MS}ms, maxQueue=${MAX_QUEUE}, maxBatchPerType=${MAX_BATCH_PER_TYPE}, dedupeWindow=${DEDUPE_WINDOW_MS}ms`,
  );
}

export async function stopTrackingBufferFlusher(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  // Final drain so we don't lose buffered events on graceful shutdown.
  // We also need to drain side-effect promises from previous cycles AND
  // from this final flush — otherwise the tracking pool can be closed
  // before bulkMarkFirstOpen / setSuppressedUntil / tag enqueues finish,
  // which would silently lose first-open marks and suppressions.
  if (queue.length > 0) {
    logger.info(`[TRACKING BUFFER] draining ${queue.length} events on shutdown`);
    try {
      await flush();
    } catch (err: any) {
      logger.error(`[TRACKING BUFFER] final drain failed: ${err?.message || err}`);
    }
  }
  if (pendingSideEffects.length > 0) {
    logger.info(`[TRACKING BUFFER] awaiting ${pendingSideEffects.length} pending side-effect cycle(s)`);
    try {
      await Promise.allSettled(pendingSideEffects);
    } catch {}
    pendingSideEffects = [];
  }
}

export function getTrackingBufferStats() {
  return {
    queueDepth: queue.length,
    maxQueue: MAX_QUEUE,
    dedupeMapSize: dedupe.size,
    linkCacheSize: linkCache.size,
  };
}
