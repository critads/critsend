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
  poolMax: number;
  poolWaiting: number;
  poolSaturation: number;
  leaseHolding: number;
}

const RING_CAPACITY = 50;
const ring: AttributionRecord[] = [];
let ringHead = 0;

function pushRing(rec: AttributionRecord): void {
  if (ring.length < RING_CAPACITY) {
    ring.push(rec);
    return;
  }
  ring[ringHead] = rec;
  ringHead = (ringHead + 1) % RING_CAPACITY;
}

/** Snapshot of the last 50 503 emissions (newest last). */
export function getRecentServiceBusyEvents(): AttributionRecord[] {
  if (ring.length < RING_CAPACITY) return [...ring];
  return [...ring.slice(ringHead), ...ring.slice(0, ringHead)];
}

// ── Per-(source,route) log throttling: 1 full line per second; bursts
//    coalesced into a single summary line emitted at the end of the second.
interface BurstAgg {
  count: number;
  firstAt: number;
  lastSnapshot: AttributionRecord;
  flushTimer: NodeJS.Timeout;
}
const bursts = new Map<string, BurstAgg>();

function bucketKey(source: string, route: string): string {
  return `${source}|${route}`;
}

function flushBurst(key: string): void {
  const agg = bursts.get(key);
  if (!agg) return;
  bursts.delete(key);
  const elapsed = Date.now() - agg.firstAt;
  if (agg.count > 1) {
    logger.warn(
      `[503] ${agg.lastSnapshot.source} route=${agg.lastSnapshot.route} ` +
        `coalesced count=${agg.count} over ${elapsed}ms ` +
        `(last rid=${agg.lastSnapshot.rid} kind=${agg.lastSnapshot.kind ?? "-"} ` +
        `pool active=${agg.lastSnapshot.poolActive}/${agg.lastSnapshot.poolMax} ` +
        `waiting=${agg.lastSnapshot.poolWaiting} sat=${agg.lastSnapshot.poolSaturation.toFixed(2)})`,
    );
  }
}

function logEmission(rec: AttributionRecord, errorMessage?: string): void {
  const key = bucketKey(rec.source, rec.route);
  const existing = bursts.get(key);
  if (existing) {
    existing.count++;
    existing.lastSnapshot = rec;
    return;
  }
  // First emission in this second → log the full structured line and
  // start a 1 s aggregation window for any follow-up bursts.
  logger.warn(
    `[503] source=${rec.source} method=${rec.method} path=${rec.path} ` +
      `route=${rec.route} rid=${rec.rid} kind=${rec.kind ?? "-"} ` +
      `code=${rec.code ?? "-"} pool active=${rec.poolActive}/${rec.poolMax} ` +
      `waiting=${rec.poolWaiting} sat=${rec.poolSaturation.toFixed(2)} ` +
      `lease=${rec.leaseHolding}` +
      (errorMessage ? ` err="${errorMessage.slice(0, 200)}"` : ""),
  );
  const flushTimer = setTimeout(() => flushBurst(key), 1000);
  flushTimer.unref();
  bursts.set(key, {
    count: 1,
    firstAt: Date.now(),
    lastSnapshot: rec,
    flushTimer,
  });
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
  const active = pool.totalCount - pool.idleCount;
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
    poolMax: MAIN_POOL_MAX,
    poolWaiting: pool.waitingCount,
    poolSaturation: saturation,
    leaseHolding,
  };

  bumpCounter(ctx.source, ctx.kind, route);
  pushRing(rec);
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
  const active = pool.totalCount - pool.idleCount;
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
    poolMax: MAIN_POOL_MAX,
    poolWaiting: pool.waitingCount,
    poolSaturation: saturation,
    leaseHolding,
  };
  bumpCounter(ctx.source, ctx.kind, route);
  pushRing(rec);
  logEmission(rec, ctx.errorMessage);
}

/**
 * Aggregated counters for the admin attribution endpoint. The per-source
 * Prometheus counters are the canonical totals; this returns a snapshot
 * of `serviceBusy503Total` partitioned by (source, route).
 */
export interface AttributionSnapshot {
  total: number;
  bySource: Record<string, number>;
  byRoute: Record<string, number>;
  byPair: Array<{ source: string; route: string; count: number }>;
  recent: AttributionRecord[];
}

export async function getAttributionSnapshot(): Promise<AttributionSnapshot> {
  const metric = await serviceBusy503Total.get();
  const bySource: Record<string, number> = {};
  const byRoute: Record<string, number> = {};
  const byPair: Array<{ source: string; route: string; count: number }> = [];
  let total = 0;
  for (const v of metric.values) {
    const source = String(v.labels.source);
    const route = String(v.labels.route);
    const count = v.value;
    total += count;
    bySource[source] = (bySource[source] ?? 0) + count;
    byRoute[route] = (byRoute[route] ?? 0) + count;
    byPair.push({ source, route, count });
  }
  byPair.sort((a, b) => b.count - a.count);
  return { total, bySource, byRoute, byPair, recent: getRecentServiceBusyEvents() };
}
