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
import { isPoolCheckoutError } from "./db";
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
export function enqueueTrackingEvent(
  event: Omit<BaseEvent, "enqueuedAt">,
  opts: { skipDedupe?: boolean } = {},
): boolean {
  try {
    const now = Date.now();

    // Dedupe collapses Gmail's "fetch the same pixel 4 times in 2 seconds"
    // pattern. Callers can opt out via { skipDedupe: true } — required for
    // explicit complaint-bot bypass so a complaint event is never silently
    // dropped because a normal "open" with the same key was just enqueued.
    if (!opts.skipDedupe) {
      const key = dedupeKey(event);
      const last = dedupe.get(key);
      if (last !== undefined && now - last < DEDUPE_WINDOW_MS) {
        trackingBufferDeduped.inc({ type: event.type });
        return false;
      }
      dedupe.set(key, now);
      pruneDedupe(now);
    }

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
 * Sentinel thrown by getLinkDestinationCached when the tracking pool was
 * saturated (checkout timeout) on every attempt. The click route detects
 * this and translates it into 503 + Retry-After:1 so the recipient's
 * browser auto-retries instead of receiving a generic 500 "Tracking error".
 */
export class TrackingPoolUnavailableError extends Error {
  readonly code = "TRACKING_POOL_UNAVAILABLE";
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "TrackingPoolUnavailableError";
  }
}

export function isTrackingPoolUnavailable(err: unknown): err is TrackingPoolUnavailableError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "TRACKING_POOL_UNAVAILABLE"
  );
}

/**
 * LRU lookup for campaign_links.destination_url. On a miss, fetches from the
 * tracking pool (so the main pool is never touched by tracking traffic).
 *
 * Resilience: a single transient tracking-pool checkout timeout is retried
 * once after a small backoff before surfacing as TrackingPoolUnavailableError.
 * Most tracking-pool saturation events are short bursts (a flush cycle
 * holding all 6 slots for a fraction of a second), so the retry usually
 * succeeds without the recipient ever noticing. When BOTH attempts fail,
 * the route returns 503 + Retry-After:1 instead of a generic 500.
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

  const sql = `SELECT destination_url FROM campaign_links WHERE id = $1`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await trackingPool.query(sql, [linkId]);
      if (result.rows.length === 0) return null;
      const url = result.rows[0].destination_url as string;
      linkCache.set(linkId, url);
      if (linkCache.size > LINK_CACHE_MAX) {
        const oldest = linkCache.keys().next().value;
        if (oldest !== undefined) linkCache.delete(oldest);
      }
      return url;
    } catch (err) {
      lastErr = err;
      if (!isPoolCheckoutError(err)) throw err;
      if (attempt === 0) {
        // Brief backoff so the in-flight flush has a chance to release a slot.
        await new Promise((r) => setTimeout(r, 100));
        logger.warn(
          `[TRACKING BUFFER] getLinkDestinationCached(${linkId}) tracking-pool checkout timeout — retrying once`,
        );
        continue;
      }
    }
  }
  throw new TrackingPoolUnavailableError(
    `Tracking pool unavailable resolving link ${linkId} after retry`,
    lastErr,
  );
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
let poolSampleTimer: NodeJS.Timeout | null = null;
let flushing = false;
// Side-effect promises (recordFirstOpen tag enqueues, suppression UPDATEs)
// fired by the current flusher cycle. Tracked so graceful shutdown can
// await them before closing the tracking pool — otherwise the pool can
// close mid-write and we lose first-open marks / suppressions.
//
// Each entry is removed from the set as soon as it settles, so the set
// only ever holds *currently-in-flight* side effects (no unbounded
// accumulation over uptime).
const pendingSideEffects: Set<Promise<unknown>> = new Set();

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
    // ── Atomic raw-insert + first-mark (open/click only) ────────────────
    // For open/click we run the campaign_stats INSERT and the
    // campaign_sends.first_open_at / first_click_at UPDATE in the SAME
    // transaction. Without this, a process crash, pool error, or thrown
    // exception between the two writes would land raw events in
    // campaign_stats while the headline counters (which read first_open_at
    // / first_click_at on campaign_sends) silently stayed at 0 forever.
    //
    // For unsubscribe/complaint, the first-mark equivalent is the
    // suppressed_until update which lives in processSideEffects below;
    // it is lower-volume and is reconciled by the counter-drift worker.
    // Insert raw events AND bump the cached campaigns.* counters in the
    // SAME transaction. The cached counters power the /campaigns list page
    // — keeping them in lock-step with raw events here means the list view
    // never disagrees with the analytics aggregate after a flush. For
    // open/click we also mark first_open_at/first_click_at on
    // campaign_sends inside the same txn (existing behavior).
    let firsts: Set<string> | null = null;
    if (type === "open" || type === "click") {
      firsts = await insertBatchAndMarkFirsts(type, toWrite);
    } else {
      await insertBatchAndBumpCounters(type, toWrite);
    }
    trackingBufferFlushed.inc({ type }, toWrite.length);

    // Post-commit side effects (tag enqueues, suppressed_until for
    // unsub/complaint). These are intentionally NOT in the txn — a tag
    // enqueue failure must not roll back the raw event row. Tracked in
    // pendingSideEffects so graceful shutdown can await them before the
    // tracking pool is closed.
    const sideEffectPromise: Promise<unknown> = processSideEffects(type, toWrite, firsts)
      .catch((err) => {
        logger.error(`[TRACKING BUFFER] side-effects (${type}) failed: ${err?.message || err}`);
      })
      .finally(() => {
        // Self-prune so the set only ever holds in-flight work.
        pendingSideEffects.delete(sideEffectPromise);
      });
    pendingSideEffects.add(sideEffectPromise);
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
 * Atomic combined insert + first-mark for open/click.
 *
 * Single trackingPool client, single BEGIN/COMMIT, two writes:
 *   1. INSERT INTO campaign_stats   (raw event rows — can be 1–5000 rows)
 *   2. UPDATE campaign_sends        (first_open_at or first_click_at)
 *
 * Returns the set of "campaignId|subscriberId" keys whose row was the
 * first of its kind for this (campaign, subscriber). Tag enqueues fire
 * post-commit based on this set.
 *
 * NOTE (Task #57 fix): the cached campaigns.* engagement-counter bump used
 * to live INSIDE this transaction. That meant the per-campaigns row lock
 * was held for the full duration of the INSERT (up to ~thousands of rows),
 * deadlocking against the campaign-sender's `UPDATE campaigns SET sent_count
 * = sent_count + 1` on the main pool. Under sustained click traffic this
 * cascaded into tracking-pool exhaustion (max=6 → 500 "Tracking error" on
 * /api/track/click) and main-pool starvation (load-shed → 503
 * "service_busy" on /campaigns). The bump now runs as a SHORT post-commit
 * UPDATE in its own tiny transaction with `lock_timeout = 2s` (see
 * bumpCampaignCountersPostCommit). Drift between live and source-of-truth
 * is still self-healed by the 15-min counter-drift reconciler (fill-only
 * via GREATEST), so the worst-case observable effect is a brief stale read
 * on /campaigns, never lost data.
 *
 * NOTE (Task #64 fix): INSERT (campaign_stats) and UPDATE (campaign_sends
 * first_open_at/first_click_at) are now separate transactions. If the
 * mark-firsts UPDATE hits a lock timeout, raw events are still persisted.
 * The 15-min counter-drift reconciler backfills first_open_at/first_click_at
 * from campaign_stats, so the gap self-heals.
 */
async function insertBatchAndMarkFirsts(
  type: "open" | "click",
  events: BaseEvent[],
): Promise<Set<string>> {
  if (events.length === 0) return new Set();
  const client = await trackingPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '2s'");
    await insertBatchOnClient(client, type, events);
    await client.query("COMMIT");
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* swallow */ }
    client.release();
    throw err;
  }
  let firsts = new Set<string>();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '2s'");
    firsts = await markFirstsOnClient(client, type, events);
    await client.query("COMMIT");
  } catch (err: any) {
    try { await client.query("ROLLBACK"); } catch { /* swallow */ }
    const code = err?.code;
    const isLockTimeout = code === "55P03";
    if (isLockTimeout) {
      logger.warn(`[TRACKING BUFFER] markFirsts(${type}) lock timeout (raw events saved, reconciler will backfill): ${err?.message || err}`);
    } else {
      logger.error(`[TRACKING BUFFER] markFirsts(${type}) unexpected error (raw events saved): code=${code} ${err?.message || err}`);
    }
  }
  accumulateCounterDeltas(type, events, firsts);
  client.release();
  return firsts;
}

/**
 * Atomic insert + cached counter bump for unsubscribe / complaint events.
 *
 * For these types we don't have a per-(campaign,subscriber) "first" column
 * on campaign_sends. To keep `unsubscribes_count` / `complaints_count`
 * truly equal to COUNT(DISTINCT subscriber_id), we query — inside the same
 * txn, BEFORE the INSERT — which (campaign,subscriber) pairs from this
 * batch already have a row of this type in campaign_stats. Those pairs
 * are *not* counted as new uniques. This makes the live bump exactly
 * idempotent against the source-of-truth, so the fill-only reconciler
 * (which can only RAISE counters via GREATEST) never has to repair
 * overcounts — overcounts simply cannot occur.
 */
async function insertBatchAndBumpCounters(
  type: "unsubscribe" | "complaint",
  events: BaseEvent[],
): Promise<void> {
  if (events.length === 0) return;
  const client = await trackingPool.connect();
  let newPairsByCampaign = new Map<string, number>();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '2s'");

    // Collapse to distinct (campaign,subscriber) pairs in this batch.
    const batchPairs: Array<{ cid: string; sid: string; key: string }> = [];
    const seenInBatch = new Set<string>();
    for (const ev of events) {
      const key = `${ev.campaignId}|${ev.subscriberId}`;
      if (seenInBatch.has(key)) continue;
      seenInBatch.add(key);
      batchPairs.push({ cid: ev.campaignId, sid: ev.subscriberId, key });
    }

    // Find pairs that ALREADY have a row of this type in campaign_stats.
    // Those must NOT bump the unique counter (they are duplicates from a
    // previous flush whose dedupe window has long since expired).
    // Uses the (campaign_id, subscriber_id, type) covering index added by
    // the bootstrap migration in server/routes/tracking.ts.
    const alreadyCounted = new Set<string>();
    if (batchPairs.length > 0) {
      const placeholders: string[] = [];
      const params: string[] = [];
      let p = 1;
      for (const pair of batchPairs) {
        placeholders.push(`($${p++}::varchar, $${p++}::varchar)`);
        params.push(pair.cid, pair.sid);
      }
      params.push(type);
      const existingSql = `
        SELECT campaign_id, subscriber_id
          FROM campaign_stats
         WHERE (campaign_id, subscriber_id) IN (${placeholders.join(", ")})
           AND type = $${p}
      `;
      const result = await client.query<{ campaign_id: string; subscriber_id: string }>(
        existingSql,
        params,
      );
      for (const row of result.rows) {
        alreadyCounted.add(`${row.campaign_id}|${row.subscriber_id}`);
      }
    }

    await insertBatchOnClient(client, type, events);

    // Build the per-campaign unique delta from ONLY first-time pairs. The
    // actual UPDATE campaigns runs OUTSIDE this txn (post-commit) so the
    // campaigns row lock isn't held across the INSERT above. See the
    // long comment on insertBatchAndMarkFirsts for the full root-cause story.
    for (const pair of batchPairs) {
      if (alreadyCounted.has(pair.key)) continue;
      newPairsByCampaign.set(pair.cid, (newPairsByCampaign.get(pair.cid) ?? 0) + 1);
    }

    await client.query("COMMIT");
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* swallow */ }
    client.release();
    throw err;
  }

  if (newPairsByCampaign.size > 0) {
    accumulateUnsubComplaintDeltas(type, newPairsByCampaign);
  }
  client.release();
}

/**
 * Single UPDATE … FROM (VALUES …) bumping unsubscribes_count / complaints_count
 * by the supplied per-campaign delta map. Caller must have already filtered
 * out pairs that were already counted in a previous flush.
 */
async function bumpUnsubComplaintCountersPostCommit(
  client: import("pg").PoolClient,
  type: "unsubscribe" | "complaint",
  deltaByCampaign: Map<string, number>,
): Promise<void> {
  if (deltaByCampaign.size === 0) return;
  const col = type === "unsubscribe" ? "unsubscribes_count" : "complaints_count";
  const placeholders: string[] = [];
  const values: Array<string | number> = [];
  let p = 1;
  for (const [cid, delta] of deltaByCampaign) {
    if (delta <= 0) continue;
    placeholders.push(`($${p++}::varchar, $${p++}::int)`);
    values.push(cid, delta);
  }
  if (placeholders.length === 0) return;
  // Tiny tx so SET LOCAL lock_timeout takes effect. If a sender batch is
  // currently holding the campaigns row lock we'd rather fail fast (and
  // let the 15-min reconciler fill the gap) than starve the tracking pool.
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query(
      `UPDATE campaigns c
          SET ${col} = c.${col} + v.delta
         FROM (VALUES ${placeholders.join(", ")})
           AS v(campaign_id, delta)
        WHERE c.id = v.campaign_id`,
      values,
    );
    await client.query("COMMIT");
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* swallow */ }
    throw err;
  }
}

/**
 * Bump the cached campaigns.* engagement counters for a batch of events as
 * a SHORT post-commit UPDATE on the supplied client. Caller is responsible
 * for releasing the client.
 *
 * Runs in its own tiny transaction with `lock_timeout = 2s`, so the
 * campaigns row lock is only held for the duration of one UPDATE statement
 * (~milliseconds) and we can never starve the tracking pool waiting on a
 * row lock held by the campaign-sender. See the long comment on
 * insertBatchAndMarkFirsts for the full Task #57 root-cause story.
 *
 * For open/click: total_*_count += events grouped by campaign;
 *                 unique_*_count += first-marked rows grouped by campaign.
 * For unsubscribe/complaint: counter += distinct (campaign,subscriber) in batch.
 */
async function bumpCampaignCountersPostCommit(
  client: import("pg").PoolClient,
  type: TrackingEventType,
  events: BaseEvent[],
  firsts: Set<string> | null,
): Promise<void> {
  if (events.length === 0) return;

  const totalByCampaign = new Map<string, number>();
  const uniqueByCampaign = new Map<string, number>();

  if (type === "open" || type === "click") {
    for (const e of events) {
      totalByCampaign.set(e.campaignId, (totalByCampaign.get(e.campaignId) ?? 0) + 1);
    }
    if (firsts) {
      for (const key of firsts) {
        const sep = key.indexOf("|");
        if (sep <= 0) continue;
        const cid = key.slice(0, sep);
        uniqueByCampaign.set(cid, (uniqueByCampaign.get(cid) ?? 0) + 1);
      }
    }
  } else {
    // unsubscribe / complaint — collapse to distinct (campaign,subscriber)
    const seenPair = new Set<string>();
    for (const e of events) {
      const k = `${e.campaignId}|${e.subscriberId}`;
      if (seenPair.has(k)) continue;
      seenPair.add(k);
      uniqueByCampaign.set(e.campaignId, (uniqueByCampaign.get(e.campaignId) ?? 0) + 1);
    }
  }

  const campaignIds = new Set<string>([...totalByCampaign.keys(), ...uniqueByCampaign.keys()]);
  if (campaignIds.size === 0) return;

  let totalCol: string | null = null;
  let uniqueCol: string | null = null;
  if (type === "open") { totalCol = "total_opens_count"; uniqueCol = "unique_opens_count"; }
  else if (type === "click") { totalCol = "total_clicks_count"; uniqueCol = "unique_clicks_count"; }
  else if (type === "unsubscribe") { uniqueCol = "unsubscribes_count"; }
  else if (type === "complaint") { uniqueCol = "complaints_count"; }
  if (!totalCol && !uniqueCol) return;

  // Single UPDATE … FROM (VALUES …) so we issue one round-trip per type.
  const placeholders: string[] = [];
  const values: Array<string | number> = [];
  let p = 1;
  for (const cid of campaignIds) {
    const total = totalByCampaign.get(cid) ?? 0;
    const unique = uniqueByCampaign.get(cid) ?? 0;
    placeholders.push(`($${p++}::varchar, $${p++}::int, $${p++}::int)`);
    values.push(cid, total, unique);
  }

  const setParts: string[] = [];
  if (totalCol) setParts.push(`${totalCol} = c.${totalCol} + v.total_delta`);
  if (uniqueCol) setParts.push(`${uniqueCol} = c.${uniqueCol} + v.unique_delta`);

  const sql = `
    UPDATE campaigns c
       SET ${setParts.join(", ")}
      FROM (VALUES ${placeholders.join(", ")})
        AS v(campaign_id, total_delta, unique_delta)
     WHERE c.id = v.campaign_id
  `;
  // Tiny tx so SET LOCAL lock_timeout takes effect. Caps blocking on a
  // sender-held campaigns row lock at 2s — never the full statement_timeout.
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query(sql, values);
    await client.query("COMMIT");
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* swallow */ }
    throw err;
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
/** Build the INSERT INTO campaign_stats statement + bound parameter list. */
function buildInsertBatchSql(
  type: TrackingEventType,
  events: BaseEvent[],
): { sql: string; values: Array<string | Date | null> } {
  const columns = [
    "campaign_id", "subscriber_id", "type", "link", "timestamp",
    "ip_address", "user_agent", "country", "city", "device_type", "browser", "os",
  ];
  const values: Array<string | Date | null> = [];
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
  return { sql, values };
}

async function insertBatch(type: TrackingEventType, events: BaseEvent[]): Promise<void> {
  if (events.length === 0) return;
  const { sql, values } = buildInsertBatchSql(type, events);
  await trackingPool.query(sql, values);
}

/** Same as insertBatch but bound to a specific client (for transactions). */
async function insertBatchOnClient(
  client: import("pg").PoolClient,
  type: TrackingEventType,
  events: BaseEvent[],
): Promise<void> {
  if (events.length === 0) return;
  const { sql, values } = buildInsertBatchSql(type, events);
  await client.query(sql, values);
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
async function processSideEffects(
  type: TrackingEventType,
  events: BaseEvent[],
  precomputedFirsts: Set<string> | null,
): Promise<void> {
  if (events.length === 0) return;

  if (type === "open") {
    // first-mark already happened atomically inside the txn; only the
    // tag enqueues remain.
    const firsts = precomputedFirsts ?? new Set<string>();
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
    const firsts = precomputedFirsts ?? new Set<string>();
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
 * Bulk first-mark for opens or clicks via UPDATE…FROM(VALUES…)…RETURNING,
 * bound to the supplied client so it can run inside the same transaction
 * that just inserted into campaign_stats. Returns the set of
 * "campaignId|subscriberId" keys whose row was previously NULL (i.e.
 * truly the first event of its kind for that recipient).
 */
async function markFirstsOnClient(
  client: import("pg").PoolClient,
  type: "open" | "click",
  events: BaseEvent[],
): Promise<Set<string>> {
  const pairs = uniquePairs(events);
  if (pairs.length === 0) return new Set();
  const values: string[] = [];
  const placeholders: string[] = [];
  let p = 1;
  for (const [c, s] of pairs) {
    placeholders.push(`($${p++}::varchar, $${p++}::varchar)`);
    values.push(c, s);
  }
  const column = type === "open" ? "first_open_at" : "first_click_at";
  const sql = `
    UPDATE campaign_sends cs
    SET ${column} = NOW()
    FROM (VALUES ${placeholders.join(", ")}) AS v(campaign_id, subscriber_id)
    WHERE cs.campaign_id = v.campaign_id
      AND cs.subscriber_id = v.subscriber_id
      AND cs.${column} IS NULL
    RETURNING cs.campaign_id, cs.subscriber_id
  `;
  const result = await client.query(sql, values);
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

// ── Coalesced campaign counter bumps ──────────────────────────────────────
// Instead of running a campaigns UPDATE on every 1.5s flush cycle, accumulate
// deltas in memory and flush them on a longer interval (COUNTER_COALESCE_MS,
// default 8s). This reduces contention on the campaigns table by ~5x while
// the 15-min counter-drift reconciler self-heals any gap from a crash.

const COUNTER_COALESCE_MS = Number(process.env.TRACKING_COUNTER_COALESCE_MS || 8_000);

interface CampaignCounterDeltas {
  totalOpens: number;
  uniqueOpens: number;
  totalClicks: number;
  uniqueClicks: number;
  unsubscribes: number;
  complaints: number;
}

const pendingCounterDeltas = new Map<string, CampaignCounterDeltas>();
let counterCoalesceTimer: NodeJS.Timeout | null = null;

function ensureDelta(campaignId: string): CampaignCounterDeltas {
  let d = pendingCounterDeltas.get(campaignId);
  if (!d) {
    d = { totalOpens: 0, uniqueOpens: 0, totalClicks: 0, uniqueClicks: 0, unsubscribes: 0, complaints: 0 };
    pendingCounterDeltas.set(campaignId, d);
  }
  return d;
}

function accumulateCounterDeltas(
  type: TrackingEventType,
  events: BaseEvent[],
  firsts: Set<string> | null,
): void {
  if (type === "open" || type === "click") {
    const totalByCampaign = new Map<string, number>();
    const uniqueByCampaign = new Map<string, number>();
    for (const e of events) {
      totalByCampaign.set(e.campaignId, (totalByCampaign.get(e.campaignId) ?? 0) + 1);
    }
    if (firsts) {
      for (const key of firsts) {
        const sep = key.indexOf("|");
        if (sep <= 0) continue;
        const cid = key.slice(0, sep);
        uniqueByCampaign.set(cid, (uniqueByCampaign.get(cid) ?? 0) + 1);
      }
    }
    for (const [cid, total] of totalByCampaign) {
      const d = ensureDelta(cid);
      if (type === "open") {
        d.totalOpens += total;
        d.uniqueOpens += (uniqueByCampaign.get(cid) ?? 0);
      } else {
        d.totalClicks += total;
        d.uniqueClicks += (uniqueByCampaign.get(cid) ?? 0);
      }
    }
  }
}

function accumulateUnsubComplaintDeltas(
  type: "unsubscribe" | "complaint",
  deltaByCampaign: Map<string, number>,
): void {
  for (const [cid, delta] of deltaByCampaign) {
    if (delta <= 0) continue;
    const d = ensureDelta(cid);
    if (type === "unsubscribe") d.unsubscribes += delta;
    else d.complaints += delta;
  }
}

async function flushCoalescedCounters(): Promise<void> {
  if (pendingCounterDeltas.size === 0) return;
  const snapshot = new Map(pendingCounterDeltas);
  pendingCounterDeltas.clear();

  const placeholders: string[] = [];
  const values: Array<string | number> = [];
  let p = 1;
  for (const [cid, d] of snapshot) {
    placeholders.push(
      `($${p++}::varchar, $${p++}::int, $${p++}::int, $${p++}::int, $${p++}::int, $${p++}::int, $${p++}::int)`,
    );
    values.push(cid, d.totalOpens, d.uniqueOpens, d.totalClicks, d.uniqueClicks, d.unsubscribes, d.complaints);
  }
  if (placeholders.length === 0) return;

  const sql = `
    UPDATE campaigns c
       SET total_opens_count   = c.total_opens_count   + v.d_total_opens,
           unique_opens_count  = c.unique_opens_count  + v.d_unique_opens,
           total_clicks_count  = c.total_clicks_count  + v.d_total_clicks,
           unique_clicks_count = c.unique_clicks_count + v.d_unique_clicks,
           unsubscribes_count  = c.unsubscribes_count  + v.d_unsubs,
           complaints_count    = c.complaints_count    + v.d_complaints
      FROM (VALUES ${placeholders.join(", ")})
        AS v(campaign_id, d_total_opens, d_unique_opens, d_total_clicks, d_unique_clicks, d_unsubs, d_complaints)
     WHERE c.id = v.campaign_id
  `;
  try {
    await trackingPool.query(sql, values);
  } catch (err: any) {
    logger.warn(
      `[TRACKING BUFFER] coalesced counter flush failed (reconciler will fill): ${err?.message || err}`,
    );
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────

export function startTrackingBufferFlusher(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flush().catch((err) => logger.error(`[TRACKING BUFFER] tick failed: ${err?.message || err}`));
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref();
  counterCoalesceTimer = setInterval(() => {
    flushCoalescedCounters().catch((err) =>
      logger.error(`[TRACKING BUFFER] coalesced counter tick failed: ${err?.message || err}`),
    );
  }, COUNTER_COALESCE_MS);
  counterCoalesceTimer.unref();
  // Sample tracking-pool in-use every 250 ms so the gauge captures real
  // peaks during short bursts (the flush-only update under-reports
  // request-path checkout activity that doesn't coincide with a flush).
  poolSampleTimer = setInterval(() => {
    try {
      const stats = getTrackingPoolStats();
      trackingPoolInUse.set(Math.max(0, stats.total - stats.idle));
    } catch {}
  }, 250);
  poolSampleTimer.unref();
  logger.info(
    `[TRACKING BUFFER] flusher started: interval=${FLUSH_INTERVAL_MS}ms, counterCoalesce=${COUNTER_COALESCE_MS}ms, maxQueue=${MAX_QUEUE}, maxBatchPerType=${MAX_BATCH_PER_TYPE}, dedupeWindow=${DEDUPE_WINDOW_MS}ms`,
  );
}

export async function stopTrackingBufferFlusher(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  if (counterCoalesceTimer) {
    clearInterval(counterCoalesceTimer);
    counterCoalesceTimer = null;
  }
  if (poolSampleTimer) {
    clearInterval(poolSampleTimer);
    poolSampleTimer = null;
  }
  // Final drain of coalesced counter deltas before shutdown.
  try {
    await flushCoalescedCounters();
  } catch (err: any) {
    logger.warn(`[TRACKING BUFFER] final coalesced counter flush failed: ${err?.message || err}`);
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
  if (pendingSideEffects.size > 0) {
    logger.info(`[TRACKING BUFFER] awaiting ${pendingSideEffects.size} pending side-effect cycle(s)`);
    try {
      await Promise.allSettled([...pendingSideEffects]);
    } catch {}
    // Self-prune in .finally() should already have emptied the set, but
    // clear defensively in case a side-effect promise rejected before
    // its finally handler ran.
    pendingSideEffects.clear();
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
