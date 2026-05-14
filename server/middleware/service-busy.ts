/**
 * Unified 503 ("service_busy") emission for the entire HTTP surface.
 *
 * Every code-path that returns 503 because the server is under pressure
 * MUST funnel through `emitServiceBusy()` so we get:
 *
 *   - One structured log line per emission containing: rid, method, path,
 *     route bucket, source, pool snapshot, optional DB error code/kind,
 *     current MAX_CONNECTIONS_PER_REQUEST hold count.
 *   - The matching Prometheus counter incremented exactly once.
 *   - The canonical response body  `{ "error": "service_busy", ... }` and
 *     `Retry-After: 1` header.
 *   - An entry appended to an in-memory ring buffer that powers the
 *     `/api/admin/503-attribution` triage endpoint.
 *
 * Logging is rate-limited per (source,route) bucket to one full line per
 * second; bursts are coalesced into a single summary line at the end of
 * the second.  A 503 is NEVER silently swallowed — every emission is at
 * minimum reflected in the ring buffer + Prometheus counter.
 *
 * This module is the single source of truth for the 503 contract — see
 * Task #148 (Eradicate unexplained 503s on /campaigns).
 */
import type { Request, Response } from "express";
import { pool, getPoolSaturation } from "../db";
import { MAIN_POOL_MAX } from "../connection-budget";
import { logger } from "../logger";
import {
  poolLoadShedTotal,
  poolCheckoutTimeoutTotal,
  poolRequestLeaseExceededTotal,
  campaignsListTransient503Total,
  memoryPressure503Total,
  serviceBusy503Total,
} from "../metrics";
import { routeBucket } from "./route-bucket";
import { leaseStore } from "./request-lease";

export type ServiceBusySource =
  | "load_shed"
  | "lease_exceeded"
  | "checkout_timeout"
  | "handler_transient"
  | "memory_pressure";

export interface ServiceBusyContext {
  /** Why the 503 was emitted. */
  source: ServiceBusySource;
  /** Optional sub-classification (e.g. load-shed reason `saturation|waiting`,
   *  or DB error kind `timeout|connection|disk_full|admin_shutdown`). */
  kind?: string;
  /** Optional DB SQLSTATE when applicable (handler_transient only). */
  code?: string;
  /** Optional original error message — included in the structured log only,
   *  never in the response body. */
  errorMessage?: string;
  /** Override the default Retry-After: 1 (seconds). */
  retryAfterSeconds?: number;
}

interface AttributionRecord {
  ts: number;            // unix ms
  rid: string;
  method: string;
  path: string;
  route: string;
  source: ServiceBusySource;
  kind?: string;
  code?: string;
  poolActive: number;
  poolIdle: number;
  poolTotal: number;
  poolMax: number;
  poolWaiting: number;
  poolSaturation: number;
  leaseHolding: number;
}

// Timestamped per-emission event log, implemented as a fixed-capacity
// ring buffer so push is O(1) (no Array.splice on the hot 503 path).
//
// Sizing: 5 000 events at sustained ~1.4 events/s covers a busy hour
// comfortably. Capacity is the hard cap; older records are overwritten
// in place when the head wraps. EVENT_RETENTION_MS is enforced ONLY on
// read (`getEventsWithinWindow`) — the buffer itself never scans for
// time-based eviction, eliminating the previous O(n) front-splice that
// was flagged as a hot-path risk under saturation.
//
// The legacy "last 50" recent-events view returned by the admin
// endpoint is derived from the tail of the same buffer.
const EVENT_BUFFER_CAPACITY = 5000;
const EVENT_RETENTION_MS = 60 * 60 * 1000; // 1 h
const ring: Array<AttributionRecord | undefined> = new Array(EVENT_BUFFER_CAPACITY);
let ringHead = 0;   // next write slot
let ringSize = 0;   // current number of valid records (≤ capacity)

function pushEvent(rec: AttributionRecord): void {
  ring[ringHead] = rec;
  ringHead = (ringHead + 1) % EVENT_BUFFER_CAPACITY;
  if (ringSize < EVENT_BUFFER_CAPACITY) ringSize++;
}

/**
 * Iterate ring entries in chronological order (oldest → newest) and
 * return them as a fresh array. Cost is O(ringSize) but with no
 * allocations beyond the result array — suitable for the once-per-
 * admin-poll snapshot path. NOT called on the hot 503 emission path.
 */
function snapshotRing(): AttributionRecord[] {
  if (ringSize === 0) return [];
  const out: AttributionRecord[] = new Array(ringSize);
  // Oldest record is at (head - size + capacity) % capacity. When the
  // buffer hasn't wrapped yet (ringSize < capacity), oldest is at 0.
  const start = ringSize < EVENT_BUFFER_CAPACITY
    ? 0
    : ringHead;
  for (let i = 0; i < ringSize; i++) {
    out[i] = ring[(start + i) % EVENT_BUFFER_CAPACITY] as AttributionRecord;
  }
  return out;
}

/** Snapshot of the last 50 503 emissions (newest last). */
export function getRecentServiceBusyEvents(): AttributionRecord[] {
  if (ringSize === 0) return [];
  const n = Math.min(50, ringSize);
  const out: AttributionRecord[] = new Array(n);
  // Walk backwards from the most-recently-written slot.
  for (let i = 0; i < n; i++) {
    const idx = (ringHead - 1 - i + EVENT_BUFFER_CAPACITY) % EVENT_BUFFER_CAPACITY;
    out[n - 1 - i] = ring[idx] as AttributionRecord;
  }
  return out;
}

/** All events emitted within the last `windowMs` ms (default 1 h). Used
 *  by the admin attribution endpoint for the rolling-window breakdown.
 *  Snapshots once and filters in place to avoid mutating the ring. */
export function getEventsWithinWindow(windowMs: number = EVENT_RETENTION_MS): AttributionRecord[] {
  if (ringSize === 0) return [];
  const cutoff = Date.now() - windowMs;
  const snap = snapshotRing();
  // Snapshot is already chronological (oldest first); find the first
  // record newer than the cutoff and slice from there.
  for (let i = 0; i < snap.length; i++) {
    if (snap[i].ts >= cutoff) return snap.slice(i);
  }
  return [];
}

// ── Per-event structured logging.
//
// Earlier iterations of this module coalesced bursts into a single
// summary line per (source,route)/second to limit log volume. Code
// review for Task #148 flagged that as lossy: an operator handed a
// user's request-id could not always resolve it to a source from logs
// alone, because only the first event of each burst carried rid /
// method / path. We now log EVERY emission as one compact structured
// line so per-request attribution is guaranteed (Prometheus counters
// + the in-process ring buffer + the dashboard remain unchanged).
//
// Volume bound: 503 emission is itself a load-shed signal — the safety
// net only fires under pressure, and pressure is what we want logged.
// At full saturation (~MAIN_POOL_MAX requests rejected per second) this
// is a few hundred lines/sec at worst, well within logger throughput.
function logEmission(rec: AttributionRecord, errorMessage?: string): void {
  logger.warn(
    `[503] source=${rec.source} method=${rec.method} path=${rec.path} ` +
      `route=${rec.route} rid=${rec.rid} kind=${rec.kind ?? "-"} ` +
      `code=${rec.code ?? "-"} pool active=${rec.poolActive}/${rec.poolMax} ` +
      `idle=${rec.poolIdle} total=${rec.poolTotal} ` +
      `waiting=${rec.poolWaiting} sat=${rec.poolSaturation.toFixed(2)} ` +
      `lease=${rec.leaseHolding}` +
      (errorMessage ? ` err="${errorMessage.slice(0, 200)}"` : ""),
  );
}

function bumpCounter(source: ServiceBusySource, kind: string | undefined, route: string): void {
  // Always bump the global meta-counter so dashboards have a single
  // source-of-truth for "total 503s emitted by the safety net".
  serviceBusy503Total.inc({ source, route });
  switch (source) {
    case "load_shed":
      // load-shed counter takes a `reason` label — fall back to "saturation"
      // if the caller didn't provide one (defensive only; loadShed always
      // does).
      poolLoadShedTotal.inc({ reason: kind ?? "saturation", route });
      break;
    case "lease_exceeded":
      poolRequestLeaseExceededTotal.inc({ route });
      break;
    case "checkout_timeout":
      poolCheckoutTimeoutTotal.inc();
      break;
    case "handler_transient":
      campaignsListTransient503Total.inc({ kind: kind ?? "unknown", route });
      break;
    case "memory_pressure":
      memoryPressure503Total.inc({ route });
      break;
  }
}

/**
 * Canonical 503 emitter. Sets headers + body, increments the source's
 * Prometheus counter, writes one structured log line (or coalesces it
 * into the active 1 s burst window for the (source,route) bucket), and
 * records the event in the in-memory ring buffer.
 *
 * Idempotent on already-sent responses: the log/counter/ring still fire
 * (so we never lose attribution), but the body write is skipped.
 */
export function emitServiceBusy(
  req: Request,
  res: Response,
  ctx: ServiceBusyContext,
): void {
  const route = (req.route?.path as string) || routeBucket(req.path || "/");
  const idle = pool.idleCount;
  const total = pool.totalCount;
  const active = total - idle;
  const saturation = getPoolSaturation();
  const leaseHolding = leaseStore.getStore()?.count ?? 0;
  const rid = (req as any).requestId || "-";

  const rec: AttributionRecord = {
    ts: Date.now(),
    rid,
    method: req.method,
    path: req.path || "",
    route,
    source: ctx.source,
    kind: ctx.kind,
    code: ctx.code,
    poolActive: active,
    poolIdle: idle,
    poolTotal: total,
    poolMax: MAIN_POOL_MAX,
    poolWaiting: pool.waitingCount,
    poolSaturation: saturation,
    leaseHolding,
  };

  bumpCounter(ctx.source, ctx.kind, route);
  pushEvent(rec);
  logEmission(rec, ctx.errorMessage);

  if (res.headersSent) return;
  res.setHeader("Retry-After", String(ctx.retryAfterSeconds ?? 1));
  res.status(503).json({
    error: "service_busy",
    source: ctx.source,
    ...(ctx.kind ? { kind: ctx.kind } : {}),
    retryable: true,
  });
}

/**
 * Same as `emitServiceBusy` but only the log + counter + ring side-effects
 * (NEVER touches the response). Used by `poolErrorResponseUpgrade` where
 * the response was already mutated in-place via the patched `res.status`
 * setter and we just need to attribute the emission.
 */
export function recordServiceBusy(
  req: Request,
  ctx: ServiceBusyContext,
): void {
  const route = (req.route?.path as string) || routeBucket(req.path || "/");
  const idle = pool.idleCount;
  const total = pool.totalCount;
  const active = total - idle;
  const saturation = getPoolSaturation();
  const leaseHolding = leaseStore.getStore()?.count ?? 0;
  const rid = (req as any).requestId || "-";
  const rec: AttributionRecord = {
    ts: Date.now(),
    rid,
    method: req.method,
    path: req.path || "",
    route,
    source: ctx.source,
    kind: ctx.kind,
    code: ctx.code,
    poolActive: active,
    poolIdle: idle,
    poolTotal: total,
    poolMax: MAIN_POOL_MAX,
    poolWaiting: pool.waitingCount,
    poolSaturation: saturation,
    leaseHolding,
  };
  bumpCounter(ctx.source, ctx.kind, route);
  pushEvent(rec);
  logEmission(rec, ctx.errorMessage);
}

/**
 * Rolling-window aggregation for the admin attribution endpoint. The
 * per-source Prometheus counters are the cumulative source-of-truth
 * (returned in `cumulative`), but the breakdown returned here is the
 * rolling 1 h slice of the in-process event buffer — which is what
 * operators actually want during incident triage ("what's blowing up
 * RIGHT NOW").
 */
export interface AttributionSnapshot {
  windowMs: number;
  total: number;
  bySource: Record<string, number>;
  byRoute: Record<string, number>;
  byPair: Array<{ source: string; route: string; count: number }>;
  recent: AttributionRecord[];
  cumulative: {
    total: number;
    bySource: Record<string, number>;
    byRoute: Record<string, number>;
  };
}

export async function getAttributionSnapshot(
  windowMs: number = EVENT_RETENTION_MS,
): Promise<AttributionSnapshot> {
  // ── Rolling window slice ────────────────────────────────────────────
  const slice = getEventsWithinWindow(windowMs);
  const bySource: Record<string, number> = {};
  const byRoute: Record<string, number> = {};
  const pairKey = new Map<string, { source: string; route: string; count: number }>();
  for (const e of slice) {
    bySource[e.source] = (bySource[e.source] ?? 0) + 1;
    byRoute[e.route] = (byRoute[e.route] ?? 0) + 1;
    const k = `${e.source}|${e.route}`;
    const existing = pairKey.get(k);
    if (existing) existing.count++;
    else pairKey.set(k, { source: e.source, route: e.route, count: 1 });
  }
  const byPair = Array.from(pairKey.values()).sort((a, b) => b.count - a.count);

  // ── Cumulative-since-process-start (Prometheus counter) ─────────────
  const metric = await serviceBusy503Total.get();
  const cBySource: Record<string, number> = {};
  const cByRoute: Record<string, number> = {};
  let cTotal = 0;
  for (const v of metric.values) {
    const source = String(v.labels.source);
    const route = String(v.labels.route);
    cTotal += v.value;
    cBySource[source] = (cBySource[source] ?? 0) + v.value;
    cByRoute[route] = (cByRoute[route] ?? 0) + v.value;
  }

  return {
    windowMs,
    total: slice.length,
    bySource,
    byRoute,
    byPair,
    recent: getRecentServiceBusyEvents(),
    cumulative: { total: cTotal, bySource: cBySource, byRoute: cByRoute },
  };
}
