/**
 * Data Consolidation — manual refs ↔ tags reconciliation pass.
 *
 * Three business rules over `subscribers` (ref = brand code, e.g. `1CT`;
 * tags `U<ref>` / `C<ref>` / `O<ref>` = unsubscribed / clicked / opened that
 * brand):
 *
 *   Rule 3  Every complaint-IP event in `campaign_stats` (type open/complaint,
 *           ip_address = COMPLAINT_IP) on a campaign of brand <ref> adds the
 *           tag `U<ref>` — ONLY when the subscriber currently carries the
 *           campaign's open tag `O<ref>` (operator decision 2026-11-02).
 *   Rule 1  A subscriber carrying `U<ref>` loses the ref <ref>.
 *   Rule 2  A subscriber carrying `C<ref>` (and not `U<ref>`) gains <ref>.
 *
 * Processing order is 3 → 1 → 2 so the U tags written by rule 3 are honoured
 * by rules 1 and 2 in the same pass.
 *
 * Incrementality without a full-table rescan:
 *   - Rule 3 walks `campaign_stats` by `timestamp` from a persisted cursor
 *     (minus a safety overlap for late flusher inserts) up to the run start,
 *     over the existing partial index (timestamp, subscriber_id) WHERE
 *     ip_address = COMPLAINT_IP. The cursor only advances after a successful
 *     run.
 *   - Rules 1 and 2 are expressed PER REF through the GIN indexes on `tags`
 *     and `refs` (`tags @> ARRAY['U1CT'] AND refs @> ARRAY['1CT']`, …): only
 *     rows that are still inconsistent are ever selected or written, so a
 *     run on an already-consolidated table costs index lookups only, and
 *     inconsistencies re-created by later imports are caught regardless of
 *     when they appeared.
 *   - The ref universe (which refs rules 1 and 2 iterate) is rebuilt on
 *     every run from a full distinct scan of U/C tags plus campaign tags and
 *     the brands directory: a cheap parallel seq scan, and the only
 *     exhaustive source since tag imports onto existing subscribers leave no
 *     dated trace (see buildRefsUniverse).
 *
 * Safety:
 *   - Every write is a bounded batch (BATCH_SIZE ids per UPDATE, short
 *     transactions, a pause between batches) and is guarded ("add only if
 *     absent", "remove only if present") so re-runs and races never create
 *     duplicates.
 *   - One run at a time cluster-wide via a lease table (never session-level
 *     advisory locks — transaction-pooled backends). A heartbeat timer
 *     renews the lease; a run whose heartbeat goes stale is marked
 *     `interrupted` and can simply be relaunched.
 *   - Tag/ref writes bypass `pending_tag_operations` on purpose (bulk SQL).
 *
 * The service is written against a small `ConsolidationExecutor` interface so
 * the DB-backed tests can run it on a throwaway schema.
 */
import os from "node:os";
import { pool } from "../db";
import { logger } from "../logger";
import { COMPLAINT_IPS } from "../config/suppression";
import { dataConsolidationChangesTotal, dataConsolidationLastRunTimestamp } from "../metrics";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ConsolidationMode = "incremental" | "full";
export type ConsolidationRunStatus = "running" | "completed" | "failed" | "interrupted" | "cancelled";
export type ConsolidationPhase =
  | "starting"
  | "refs_universe"
  | "rule3_complaint_u_tags"
  | "rule1_remove_refs"
  | "rule2_add_refs"
  | "finalizing"
  | "done";

export interface ConsolidationQueryable {
  query<T extends Record<string, any> = any>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export interface ConsolidationExecutor extends ConsolidationQueryable {
  /** Runs `fn` inside BEGIN/COMMIT on one pinned connection (SET LOCAL safe). */
  transaction<T>(fn: (q: ConsolidationQueryable) => Promise<T>): Promise<T>;
}

export interface ConsolidationCounters {
  refsUniverseSize: number;
  rule3EventsTotal: number;
  rule3EventsScanned: number;
  rule3PairsSeen: number;
  rule3TagsAdded: number;
  rule3SkippedNoCampaignTag: number;
  rule3SkippedNoOpenTag: number;
  rule3AlreadyTagged: number;
  rule1RefsRemoved: number;
  rule2RefsAdded: number;
}

export interface ConsolidationProgress {
  phase: ConsolidationPhase;
  /** Rule 3: events scanned / total; rules 1-2: refs done / total. */
  done: number;
  total: number | null;
  currentRef?: string | null;
  message?: string;
}

export interface ConsolidationRun {
  id: string;
  mode: ConsolidationMode;
  status: ConsolidationRunStatus;
  triggeredBy: string | null;
  holder: string | null;
  startedAt: string;
  completedAt: string | null;
  heartbeatAt: string | null;
  cancelRequested: boolean;
  phase: ConsolidationPhase;
  progress: ConsolidationProgress | null;
  cursorFrom: string | null;
  cursorTo: string | null;
  counters: ConsolidationCounters;
  durationMs: number | null;
  error: string | null;
}

export interface ConsolidationState {
  cursorAt: string | null;
  knownRefsCount: number;
  lastFullRunAt: string | null;
}

export interface ConsolidationStatus {
  current: ConsolidationRun | null;
  last: ConsolidationRun | null;
  state: ConsolidationState;
  config: {
    complaintIps: string[];
    batchSize: number;
    eventBatchSize: number;
    overlapMinutes: number;
    staleHeartbeatMs: number;
  };
}

export interface ConsolidationOptions {
  executor?: ConsolidationExecutor;
  complaintIps?: readonly string[];
  batchSize?: number;
  eventBatchSize?: number;
  batchPauseMs?: number;
  overlapMinutes?: number;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  staleHeartbeatMs?: number;
  fullScanTimeoutMs?: number;
  batchStatementTimeoutMs?: number;
  /** Identifies this process in lease/run rows. */
  holderId?: string;
  /** Test hook: called after every batch. */
  onBatch?: (phase: ConsolidationPhase) => void | Promise<void>;
}

export type StartRunResult =
  | { started: true; run: ConsolidationRun }
  | { started: false; reason: "already_running" | "not_leader"; run: ConsolidationRun | null };

// ─── Config ─────────────────────────────────────────────────────────────────

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

export const DATA_CONSOLIDATION_DEFAULTS = {
  batchSize: envInt("DATA_CONSOLIDATION_BATCH_SIZE", 5000, 100, 20_000),
  eventBatchSize: envInt("DATA_CONSOLIDATION_EVENT_BATCH_SIZE", 5000, 100, 50_000),
  batchPauseMs: envInt("DATA_CONSOLIDATION_BATCH_PAUSE_MS", 50, 0, 10_000),
  overlapMinutes: envInt("DATA_CONSOLIDATION_OVERLAP_MINUTES", 60, 0, 24 * 60),
  leaseTtlMs: envInt("DATA_CONSOLIDATION_LEASE_TTL_MS", 5 * 60_000, 60_000, 60 * 60_000),
  heartbeatIntervalMs: envInt("DATA_CONSOLIDATION_HEARTBEAT_MS", 30_000, 1_000, 5 * 60_000),
  staleHeartbeatMs: envInt("DATA_CONSOLIDATION_STALE_HEARTBEAT_MS", 3 * 60_000, 30_000, 60 * 60_000),
  fullScanTimeoutMs: envInt("DATA_CONSOLIDATION_FULL_SCAN_TIMEOUT_MS", 15 * 60_000, 60_000, 2 * 60 * 60_000),
  batchStatementTimeoutMs: envInt("DATA_CONSOLIDATION_BATCH_STATEMENT_TIMEOUT_MS", 5 * 60_000, 10_000, 60 * 60_000),
} as const;

const LOCK_KEY = "global";
const STATE_KEY = "global";

/**
 * Shape of a brand ref as it appears in subscriber tags/refs: a digit then
 * 2–7 uppercase alphanumerics (`1CT`, `4BE`, `3CED`). Applied to refs derived
 * from subscriber tags so free-form tags (`UNSUB-AOSOM`, `UNSUB_2BT`,
 * `CONFIRMED`…) never become a "brand". Exact case — `US1CT`/`E1CT` variants
 * are deliberately out of scope.
 */
export const SUBSCRIBER_REF_PATTERN = /^[0-9][A-Z0-9]{2,7}$/;
/** Refs configured on campaigns/brands are operator input: alphanumeric, exact case. */
export const CONFIGURED_REF_PATTERN = /^[A-Za-z0-9]{2,16}$/;

const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/;

// ─── Pure helpers (exported for tests) ──────────────────────────────────────

/** `O1CT` → `1CT` when the tag starts with the expected prefix, else null. */
export function refFromTag(tag: string | null | undefined, prefix: "O" | "C" | "U"): string | null {
  if (!tag) return null;
  const trimmed = tag.trim();
  if (trimmed.length < 2 || trimmed[0] !== prefix) return null;
  const ref = trimmed.slice(1);
  return CONFIGURED_REF_PATTERN.test(ref) ? ref : null;
}

/**
 * Brand ref of a campaign for rule 3: the open tag is authoritative (the
 * rule requires the subscriber to carry it); click/unsubscribe tags are the
 * fallback when a campaign has no open tag but still names its brand.
 */
export function campaignBrandRef(c: {
  open_tag?: string | null;
  click_tag?: string | null;
  unsubscribe_tag?: string | null;
}): string | null {
  return (
    refFromTag(c.open_tag, "O") ??
    refFromTag(c.click_tag, "C") ??
    refFromTag(c.unsubscribe_tag, "U")
  );
}

/** Refs derivable from one campaign's three tags (universe building). */
export function campaignRefs(c: {
  open_tag?: string | null;
  click_tag?: string | null;
  unsubscribe_tag?: string | null;
}): string[] {
  const out = new Set<string>();
  for (const r of [refFromTag(c.open_tag, "O"), refFromTag(c.click_tag, "C"), refFromTag(c.unsubscribe_tag, "U")]) {
    if (r) out.add(r);
  }
  return [...out];
}

export function emptyCounters(): ConsolidationCounters {
  return {
    refsUniverseSize: 0,
    rule3EventsTotal: 0,
    rule3EventsScanned: 0,
    rule3PairsSeen: 0,
    rule3TagsAdded: 0,
    rule3SkippedNoCampaignTag: 0,
    rule3SkippedNoOpenTag: 0,
    rule3AlreadyTagged: 0,
    rule1RefsRemoved: 0,
    rule2RefsAdded: 0,
  };
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

export class ConsolidationCancelled extends Error {
  constructor() {
    super("Run cancelled by operator");
    this.name = "ConsolidationCancelled";
  }
}

// ─── Executor over the application pool ─────────────────────────────────────

export function poolExecutor(p: typeof pool = pool): ConsolidationExecutor {
  return {
    query: (text, values) => p.query(text, values as any[]),
    async transaction(fn) {
      const client = await p.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({ query: (t, v) => client.query(t, v as any[]) });
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try { await client.query("ROLLBACK"); } catch { /* best-effort */ }
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

// ─── Service ────────────────────────────────────────────────────────────────

export class DataConsolidationService {
  private readonly exec: ConsolidationExecutor;
  private readonly complaintIps: string[];
  private readonly batchSize: number;
  private readonly eventBatchSize: number;
  private readonly batchPauseMs: number;
  private readonly overlapMinutes: number;
  private readonly leaseTtlMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly staleHeartbeatMs: number;
  private readonly fullScanTimeoutMs: number;
  private readonly batchStatementTimeoutMs: number;
  private readonly holder: string;
  private readonly onBatch?: ConsolidationOptions["onBatch"];
  private schemaPromise: Promise<void> | null = null;
  private runningLocally = false;

  constructor(opts: ConsolidationOptions = {}) {
    this.exec = opts.executor ?? poolExecutor();
    const ips = [...(opts.complaintIps ?? COMPLAINT_IPS)].filter((ip) => IPV4_PATTERN.test(ip));
    if (ips.length === 0) throw new Error("Data consolidation needs at least one valid complaint IPv4 address");
    this.complaintIps = ips;
    this.batchSize = opts.batchSize ?? DATA_CONSOLIDATION_DEFAULTS.batchSize;
    this.eventBatchSize = opts.eventBatchSize ?? DATA_CONSOLIDATION_DEFAULTS.eventBatchSize;
    this.batchPauseMs = opts.batchPauseMs ?? DATA_CONSOLIDATION_DEFAULTS.batchPauseMs;
    this.overlapMinutes = opts.overlapMinutes ?? DATA_CONSOLIDATION_DEFAULTS.overlapMinutes;
    this.leaseTtlMs = opts.leaseTtlMs ?? DATA_CONSOLIDATION_DEFAULTS.leaseTtlMs;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DATA_CONSOLIDATION_DEFAULTS.heartbeatIntervalMs;
    this.staleHeartbeatMs = opts.staleHeartbeatMs ?? DATA_CONSOLIDATION_DEFAULTS.staleHeartbeatMs;
    this.fullScanTimeoutMs = opts.fullScanTimeoutMs ?? DATA_CONSOLIDATION_DEFAULTS.fullScanTimeoutMs;
    this.batchStatementTimeoutMs = opts.batchStatementTimeoutMs ?? DATA_CONSOLIDATION_DEFAULTS.batchStatementTimeoutMs;
    this.holder = opts.holderId ?? `${os.hostname()}:${process.pid}`;
    this.onBatch = opts.onBatch;
  }

  /** SQL literal for the complaint-IP predicate — inlined (validated IPv4s) so
   *  the planner can prove the partial index predicate on campaign_stats. */
  private ipPredicate(alias: string): string {
    if (this.complaintIps.length === 1) return `${alias}.ip_address = '${this.complaintIps[0]}'`;
    return `${alias}.ip_address IN (${this.complaintIps.map((ip) => `'${ip}'`).join(", ")})`;
  }

  /**
   * Runs one statement in its own short transaction with the planner pinned
   * to index access. The batch queries pair a GIN containment lookup with a
   * LIMIT; left alone, the planner sometimes bets on a seq scan "finding
   * LIMIT rows early", which on an already-consolidated 2M-row table means
   * a full heap scan per ref per batch. SET LOCAL is transaction-scoped, so
   * it is safe on transaction-pooled backends and never leaks.
   */
  private indexedQuery<T extends Record<string, any> = any>(
    text: string,
    values: unknown[],
    timeoutMs = this.batchStatementTimeoutMs,
  ): Promise<{ rows: T[]; rowCount: number | null }> {
    return this.exec.transaction(async (q) => {
      await q.query(`SET LOCAL enable_seqscan = off`);
      await q.query(`SET LOCAL statement_timeout = '${Math.trunc(timeoutMs)}ms'`);
      return q.query<T>(text, values);
    });
  }

  // ── Schema ────────────────────────────────────────────────────────────────

  ensureSchema(): Promise<void> {
    if (!this.schemaPromise) {
      this.schemaPromise = this.createSchema().catch((err) => {
        this.schemaPromise = null;
        throw err;
      });
    }
    return this.schemaPromise;
  }

  private async createSchema(): Promise<void> {
    await this.exec.query(`
      CREATE TABLE IF NOT EXISTS data_consolidation_leader (
        lock_key TEXT PRIMARY KEY,
        holder TEXT NOT NULL,
        acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      )
    `);
    await this.exec.query(`
      CREATE TABLE IF NOT EXISTS data_consolidation_state (
        state_key TEXT PRIMARY KEY,
        cursor_at TIMESTAMPTZ,
        known_refs TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        last_full_run_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.exec.query(`
      CREATE TABLE IF NOT EXISTS data_consolidation_runs (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        mode TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        triggered_by TEXT,
        holder TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
        phase TEXT NOT NULL DEFAULT 'starting',
        progress JSONB,
        cursor_from TIMESTAMPTZ,
        cursor_to TIMESTAMPTZ,
        refs_universe_size INTEGER NOT NULL DEFAULT 0,
        rule3_events_total INTEGER NOT NULL DEFAULT 0,
        rule3_events_scanned INTEGER NOT NULL DEFAULT 0,
        rule3_pairs_seen INTEGER NOT NULL DEFAULT 0,
        rule3_tags_added INTEGER NOT NULL DEFAULT 0,
        rule3_skipped_no_campaign_tag INTEGER NOT NULL DEFAULT 0,
        rule3_skipped_no_open_tag INTEGER NOT NULL DEFAULT 0,
        rule3_already_tagged INTEGER NOT NULL DEFAULT 0,
        rule1_refs_removed INTEGER NOT NULL DEFAULT 0,
        rule2_refs_added INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        error TEXT
      )
    `);
    await this.exec.query(
      `CREATE INDEX IF NOT EXISTS data_consolidation_runs_started_idx ON data_consolidation_runs (started_at DESC)`,
    );
    await this.exec.query(
      `INSERT INTO data_consolidation_state (state_key) VALUES ($1) ON CONFLICT (state_key) DO NOTHING`,
      [STATE_KEY],
    );
    await this.reapStaleRuns();
  }

  /** Marks runs whose heartbeat went stale (crashed/restarted process) as interrupted. */
  async reapStaleRuns(): Promise<number> {
    const res = await this.exec.query(
      `UPDATE data_consolidation_runs
          SET status = 'interrupted',
              completed_at = NOW(),
              duration_ms = GREATEST(0, (EXTRACT(EPOCH FROM (heartbeat_at - started_at)) * 1000))::int,
              error = COALESCE(error, 'Run interrupted: heartbeat stale (process restarted or crashed)')
        WHERE status = 'running'
          AND heartbeat_at < NOW() - ($1::int * INTERVAL '1 millisecond')`,
      [this.staleHeartbeatMs],
    );
    return res.rowCount ?? 0;
  }

  // ── Lease ─────────────────────────────────────────────────────────────────

  private async tryAcquireLease(): Promise<boolean> {
    const res = await this.exec.query<{ holder: string }>(
      `INSERT INTO data_consolidation_leader (lock_key, holder, acquired_at, expires_at)
         VALUES ($1, $2, NOW(), NOW() + ($3::int * INTERVAL '1 millisecond'))
       ON CONFLICT (lock_key) DO UPDATE
         SET holder = EXCLUDED.holder,
             acquired_at = EXCLUDED.acquired_at,
             expires_at = EXCLUDED.expires_at
         WHERE data_consolidation_leader.expires_at <= NOW()
            OR data_consolidation_leader.holder = EXCLUDED.holder
       RETURNING holder`,
      [LOCK_KEY, this.holder, this.leaseTtlMs],
    );
    return (res.rowCount ?? 0) > 0 && res.rows[0].holder === this.holder;
  }

  private async renewLease(): Promise<void> {
    await this.exec.query(
      `UPDATE data_consolidation_leader
          SET expires_at = NOW() + ($3::int * INTERVAL '1 millisecond')
        WHERE lock_key = $1 AND holder = $2`,
      [LOCK_KEY, this.holder, this.leaseTtlMs],
    );
  }

  private async releaseLease(): Promise<void> {
    await this.exec
      .query(`DELETE FROM data_consolidation_leader WHERE lock_key = $1 AND holder = $2`, [LOCK_KEY, this.holder])
      .catch(() => undefined);
  }

  // ── Run bookkeeping ───────────────────────────────────────────────────────

  private static readonly RUN_SELECT = `
    SELECT id, mode, status, triggered_by, holder,
           started_at, completed_at, heartbeat_at, cancel_requested, phase, progress,
           cursor_from, cursor_to,
           refs_universe_size, rule3_events_total, rule3_events_scanned, rule3_pairs_seen,
           rule3_tags_added, rule3_skipped_no_campaign_tag, rule3_skipped_no_open_tag,
           rule3_already_tagged, rule1_refs_removed, rule2_refs_added,
           duration_ms, error
      FROM data_consolidation_runs`;

  private static mapRun(row: any): ConsolidationRun {
    const iso = (v: any): string | null => (v == null ? null : new Date(v).toISOString());
    return {
      id: row.id,
      mode: row.mode,
      status: row.status,
      triggeredBy: row.triggered_by ?? null,
      holder: row.holder ?? null,
      startedAt: iso(row.started_at)!,
      completedAt: iso(row.completed_at),
      heartbeatAt: iso(row.heartbeat_at),
      cancelRequested: Boolean(row.cancel_requested),
      phase: row.phase,
      progress: row.progress ?? null,
      cursorFrom: iso(row.cursor_from),
      cursorTo: iso(row.cursor_to),
      counters: {
        refsUniverseSize: Number(row.refs_universe_size ?? 0),
        rule3EventsTotal: Number(row.rule3_events_total ?? 0),
        rule3EventsScanned: Number(row.rule3_events_scanned ?? 0),
        rule3PairsSeen: Number(row.rule3_pairs_seen ?? 0),
        rule3TagsAdded: Number(row.rule3_tags_added ?? 0),
        rule3SkippedNoCampaignTag: Number(row.rule3_skipped_no_campaign_tag ?? 0),
        rule3SkippedNoOpenTag: Number(row.rule3_skipped_no_open_tag ?? 0),
        rule3AlreadyTagged: Number(row.rule3_already_tagged ?? 0),
        rule1RefsRemoved: Number(row.rule1_refs_removed ?? 0),
        rule2RefsAdded: Number(row.rule2_refs_added ?? 0),
      },
      durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
      error: row.error ?? null,
    };
  }

  async getRun(id: string): Promise<ConsolidationRun | null> {
    const res = await this.exec.query(`${DataConsolidationService.RUN_SELECT} WHERE id = $1`, [id]);
    return res.rows[0] ? DataConsolidationService.mapRun(res.rows[0]) : null;
  }

  async listRuns(limit = 20): Promise<ConsolidationRun[]> {
    const lim = Math.min(Math.max(Math.trunc(limit) || 20, 1), 200);
    const res = await this.exec.query(
      `${DataConsolidationService.RUN_SELECT} ORDER BY started_at DESC LIMIT $1`,
      [lim],
    );
    return res.rows.map(DataConsolidationService.mapRun);
  }

  async getState(): Promise<ConsolidationState> {
    const res = await this.exec.query<{ cursor_at: Date | null; known_refs_count: number; last_full_run_at: Date | null }>(
      `SELECT cursor_at, COALESCE(array_length(known_refs, 1), 0)::int AS known_refs_count, last_full_run_at
         FROM data_consolidation_state WHERE state_key = $1`,
      [STATE_KEY],
    );
    const row = res.rows[0];
    return {
      cursorAt: row?.cursor_at ? new Date(row.cursor_at).toISOString() : null,
      knownRefsCount: Number(row?.known_refs_count ?? 0),
      lastFullRunAt: row?.last_full_run_at ? new Date(row.last_full_run_at).toISOString() : null,
    };
  }

  async getStatus(): Promise<ConsolidationStatus> {
    await this.ensureSchema();
    await this.reapStaleRuns();
    const [currentRes, lastRes, state] = await Promise.all([
      this.exec.query(`${DataConsolidationService.RUN_SELECT} WHERE status = 'running' ORDER BY started_at DESC LIMIT 1`),
      this.exec.query(`${DataConsolidationService.RUN_SELECT} WHERE status <> 'running' ORDER BY started_at DESC LIMIT 1`),
      this.getState(),
    ]);
    return {
      current: currentRes.rows[0] ? DataConsolidationService.mapRun(currentRes.rows[0]) : null,
      last: lastRes.rows[0] ? DataConsolidationService.mapRun(lastRes.rows[0]) : null,
      state,
      config: {
        complaintIps: [...this.complaintIps],
        batchSize: this.batchSize,
        eventBatchSize: this.eventBatchSize,
        overlapMinutes: this.overlapMinutes,
        staleHeartbeatMs: this.staleHeartbeatMs,
      },
    };
  }

  /** Flags the running run; the loop notices at its next batch boundary. */
  async requestCancel(runId?: string): Promise<ConsolidationRun | null> {
    await this.ensureSchema();
    const res = await this.exec.query(
      `UPDATE data_consolidation_runs SET cancel_requested = TRUE
        WHERE status = 'running' ${runId ? "AND id = $1" : ""}
        RETURNING id`,
      runId ? [runId] : [],
    );
    const id = res.rows[0]?.id as string | undefined;
    return id ? this.getRun(id) : null;
  }

  /**
   * Starts a run in the background (returns as soon as the run row exists).
   * Refuses when a run is already active anywhere in the cluster.
   */
  async startRun(params: { mode: ConsolidationMode; triggeredBy?: string }): Promise<StartRunResult> {
    await this.ensureSchema();
    await this.reapStaleRuns();
    const active = await this.exec.query(
      `${DataConsolidationService.RUN_SELECT} WHERE status = 'running' ORDER BY started_at DESC LIMIT 1`,
    );
    if (active.rows[0] || this.runningLocally) {
      return { started: false, reason: "already_running", run: active.rows[0] ? DataConsolidationService.mapRun(active.rows[0]) : null };
    }
    if (!(await this.tryAcquireLease())) {
      return { started: false, reason: "not_leader", run: null };
    }
    // Re-check under the lease: another instance may have inserted between our check and the upsert.
    const active2 = await this.exec.query(
      `${DataConsolidationService.RUN_SELECT} WHERE status = 'running' ORDER BY started_at DESC LIMIT 1`,
    );
    if (active2.rows[0]) {
      await this.releaseLease();
      return { started: false, reason: "already_running", run: DataConsolidationService.mapRun(active2.rows[0]) };
    }
    const inserted = await this.exec.query<{ id: string }>(
      `INSERT INTO data_consolidation_runs (mode, triggered_by, holder, phase)
       VALUES ($1, $2, $3, 'starting') RETURNING id`,
      [params.mode, params.triggeredBy ?? null, this.holder],
    );
    const runId = inserted.rows[0].id;
    this.runningLocally = true;
    void this.executeRun(runId, params.mode).finally(() => {
      this.runningLocally = false;
    });
    const run = await this.getRun(runId);
    return { started: true, run: run! };
  }

  /**
   * Synchronous variant for tests/ops: acquires the lease, runs the whole
   * pass and resolves with the final run row.
   */
  async runOnce(params: { mode: ConsolidationMode; triggeredBy?: string }): Promise<ConsolidationRun> {
    await this.ensureSchema();
    await this.reapStaleRuns();
    const active = await this.exec.query<{ id: string }>(
      `SELECT id FROM data_consolidation_runs WHERE status = 'running' LIMIT 1`,
    );
    if (active.rows[0]) throw new Error("A consolidation run is already active");
    if (!(await this.tryAcquireLease())) throw new Error("Could not acquire the consolidation lease");
    const inserted = await this.exec.query<{ id: string }>(
      `INSERT INTO data_consolidation_runs (mode, triggered_by, holder, phase)
       VALUES ($1, $2, $3, 'starting') RETURNING id`,
      [params.mode, params.triggeredBy ?? null, this.holder],
    );
    const runId = inserted.rows[0].id;
    this.runningLocally = true;
    try {
      await this.executeRun(runId, params.mode);
    } finally {
      this.runningLocally = false;
    }
    return (await this.getRun(runId))!;
  }

  // ── The pass ──────────────────────────────────────────────────────────────

  private async executeRun(runId: string, mode: ConsolidationMode): Promise<void> {
    const startedMs = Date.now();
    const counters = emptyCounters();
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let cancelRequested = false;
    let heartbeatFailures = 0;

    const heartbeat = async () => {
      try {
        const res = await this.exec.query<{ cancel_requested: boolean }>(
          `UPDATE data_consolidation_runs SET heartbeat_at = NOW() WHERE id = $1 RETURNING cancel_requested`,
          [runId],
        );
        if (res.rows[0]?.cancel_requested) cancelRequested = true;
        await this.renewLease();
        heartbeatFailures = 0;
      } catch (err: any) {
        heartbeatFailures += 1;
        logger.warn(`[DATA_CONSOLIDATION] heartbeat failed (${heartbeatFailures}): ${err?.message || err}`);
      }
    };
    heartbeatTimer = setInterval(() => void heartbeat(), this.heartbeatIntervalMs);
    heartbeatTimer.unref?.();

    const persist = async (phase: ConsolidationPhase, progress: ConsolidationProgress) => {
      const res = await this.exec.query<{ cancel_requested: boolean }>(
        `UPDATE data_consolidation_runs
            SET phase = $2, progress = $3::jsonb, heartbeat_at = NOW(),
                refs_universe_size = $4, rule3_events_total = $5, rule3_events_scanned = $6,
                rule3_pairs_seen = $7, rule3_tags_added = $8, rule3_skipped_no_campaign_tag = $9,
                rule3_skipped_no_open_tag = $10, rule3_already_tagged = $11,
                rule1_refs_removed = $12, rule2_refs_added = $13
          WHERE id = $1
          RETURNING cancel_requested`,
        [
          runId, phase, JSON.stringify(progress),
          counters.refsUniverseSize, counters.rule3EventsTotal, counters.rule3EventsScanned,
          counters.rule3PairsSeen, counters.rule3TagsAdded, counters.rule3SkippedNoCampaignTag,
          counters.rule3SkippedNoOpenTag, counters.rule3AlreadyTagged,
          counters.rule1RefsRemoved, counters.rule2RefsAdded,
        ],
      );
      if (res.rows[0]?.cancel_requested) cancelRequested = true;
      if (cancelRequested) throw new ConsolidationCancelled();
      if (this.onBatch) await this.onBatch(phase);
    };

    const pause = () => sleep(this.batchPauseMs);

    try {
      // ── Cursor window ──────────────────────────────────────────────────
      const stateRes = await this.exec.query<{ cursor_at: Date | null; known_refs: string[] | null; now: Date }>(
        `SELECT cursor_at, known_refs, NOW() AS now FROM data_consolidation_state WHERE state_key = $1`,
        [STATE_KEY],
      );
      const state = stateRes.rows[0];
      const cursorTo: Date = new Date(state.now);
      const previousCursor: Date | null = state?.cursor_at ? new Date(state.cursor_at) : null;
      const effectiveFull = mode === "full" || previousCursor === null;
      const cursorFrom: Date | null = effectiveFull
        ? null
        : new Date(previousCursor!.getTime() - this.overlapMinutes * 60_000);
      await this.exec.query(
        `UPDATE data_consolidation_runs SET cursor_from = $2, cursor_to = $3 WHERE id = $1`,
        [runId, cursorFrom, cursorTo],
      );
      logger.info(
        `[DATA_CONSOLIDATION] run ${runId} started mode=${mode}${effectiveFull && mode !== "full" ? " (first run → full history)" : ""} ` +
        `cursorFrom=${cursorFrom?.toISOString() ?? "∞"} cursorTo=${cursorTo.toISOString()}`,
      );

      // ── Refs universe ──────────────────────────────────────────────────
      await persist("refs_universe", { phase: "refs_universe", done: 0, total: null, message: "Scanning U/C tags, campaign tags and brands" });
      const knownRefs = new Set<string>((state?.known_refs ?? []).filter((r) => typeof r === "string"));
      const refs = await this.buildRefsUniverse(knownRefs);
      counters.refsUniverseSize = refs.length;
      await persist("refs_universe", { phase: "refs_universe", done: refs.length, total: refs.length });

      // ── Rule 3: complaint-IP opens → U tags ────────────────────────────
      await this.runRule3(cursorFrom, cursorTo, counters, persist, pause);

      // ── Rule 1: U tag → remove ref ─────────────────────────────────────
      await this.runRule1(refs, counters, persist, pause);

      // ── Rule 2: C tag → add ref ────────────────────────────────────────
      await this.runRule2(refs, counters, persist, pause);

      // ── Finalize ───────────────────────────────────────────────────────
      await persist("finalizing", { phase: "finalizing", done: 0, total: null });
      await this.exec.query(
        `UPDATE data_consolidation_state
            SET cursor_at = $2,
                known_refs = $3::text[],
                last_full_run_at = CASE WHEN $4::boolean THEN $2 ELSE last_full_run_at END,
                updated_at = NOW()
          WHERE state_key = $1`,
        [STATE_KEY, cursorTo, refs, effectiveFull],
      );
      const durationMs = Date.now() - startedMs;
      await this.exec.query(
        `UPDATE data_consolidation_runs
            SET status = 'completed', phase = 'done', completed_at = NOW(), heartbeat_at = NOW(),
                duration_ms = $2, progress = $3::jsonb
          WHERE id = $1`,
        [runId, durationMs, JSON.stringify({ phase: "done", done: 1, total: 1 })],
      );
      dataConsolidationChangesTotal.inc({ rule: "rule3_u_tags" }, counters.rule3TagsAdded);
      dataConsolidationChangesTotal.inc({ rule: "rule1_refs_removed" }, counters.rule1RefsRemoved);
      dataConsolidationChangesTotal.inc({ rule: "rule2_refs_added" }, counters.rule2RefsAdded);
      dataConsolidationLastRunTimestamp.set(Math.floor(Date.now() / 1000));
      logger.info(
        `[DATA_CONSOLIDATION] run ${runId} completed in ${durationMs} ms: refs=${counters.refsUniverseSize} ` +
        `rule3(events=${counters.rule3EventsScanned}/${counters.rule3EventsTotal} pairs=${counters.rule3PairsSeen} ` +
        `added=${counters.rule3TagsAdded} noCampaignTag=${counters.rule3SkippedNoCampaignTag} noOpenTag=${counters.rule3SkippedNoOpenTag} ` +
        `already=${counters.rule3AlreadyTagged}) rule1(removed=${counters.rule1RefsRemoved}) rule2(added=${counters.rule2RefsAdded})`,
      );
    } catch (err: any) {
      const cancelled = err instanceof ConsolidationCancelled;
      const msg = cancelled ? err.message : String(err?.message ?? err).slice(0, 2000);
      const durationMs = Date.now() - startedMs;
      await this.exec
        .query(
          `UPDATE data_consolidation_runs
              SET status = $2, completed_at = NOW(), heartbeat_at = NOW(), duration_ms = $3, error = $4,
                  refs_universe_size = $5, rule3_events_total = $6, rule3_events_scanned = $7,
                  rule3_pairs_seen = $8, rule3_tags_added = $9, rule3_skipped_no_campaign_tag = $10,
                  rule3_skipped_no_open_tag = $11, rule3_already_tagged = $12,
                  rule1_refs_removed = $13, rule2_refs_added = $14
            WHERE id = $1`,
          [
            runId, cancelled ? "cancelled" : "failed", durationMs, msg,
            counters.refsUniverseSize, counters.rule3EventsTotal, counters.rule3EventsScanned,
            counters.rule3PairsSeen, counters.rule3TagsAdded, counters.rule3SkippedNoCampaignTag,
            counters.rule3SkippedNoOpenTag, counters.rule3AlreadyTagged,
            counters.rule1RefsRemoved, counters.rule2RefsAdded,
          ],
        )
        .catch((e: any) => logger.error(`[DATA_CONSOLIDATION] could not record run failure: ${e?.message || e}`));
      if (cancelled) {
        logger.warn(`[DATA_CONSOLIDATION] run ${runId} cancelled after ${durationMs} ms (cursor not advanced)`);
      } else {
        logger.error(`[DATA_CONSOLIDATION] run ${runId} failed after ${durationMs} ms (cursor not advanced): ${msg}`);
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      await this.releaseLease();
    }
  }

  // ── Refs universe ─────────────────────────────────────────────────────────

  /**
   * The ref universe is rebuilt on EVERY run by a full distinct scan of the
   * U/C tags. There is no cheaper exhaustive source: the tag-import upsert
   * merges tags into an existing subscriber without touching `import_date`
   * (and bypasses `pending_tag_operations`), so a brand that only ever
   * appears as a tag on pre-existing rows has no dated trace anywhere else.
   * The scan is a read-only parallel seq scan (≈1 s per 1.7 M rows on the
   * dev copy) — negligible next to the per-ref passes — and runs in its own
   * transaction so SET LOCAL statement_timeout can exceed the pool default
   * without leaking to other users of the connection.
   */
  private async buildRefsUniverse(known: Set<string>): Promise<string[]> {
    const refs = new Set<string>(known);

    const rows = await this.exec.transaction(async (q) => {
      await q.query(`SET LOCAL statement_timeout = '${this.fullScanTimeoutMs}ms'`);
      const res = await q.query<{ ref: string }>(
        `SELECT DISTINCT substr(t, 2) AS ref
           FROM subscribers, unnest(tags) AS t
          WHERE (t LIKE 'U%' OR t LIKE 'C%')
            AND substr(t, 2) ~ '^[0-9][A-Z0-9]{2,7}$'`,
      );
      return res.rows;
    });
    for (const r of rows) if (SUBSCRIBER_REF_PATTERN.test(r.ref)) refs.add(r.ref);

    // Campaign tags (every brand ever mailed) — small table.
    const campaigns = await this.exec.query<{ open_tag: string | null; click_tag: string | null; unsubscribe_tag: string | null }>(
      `SELECT open_tag, click_tag, unsubscribe_tag FROM campaigns
        WHERE open_tag IS NOT NULL OR click_tag IS NOT NULL OR unsubscribe_tag IS NOT NULL`,
    );
    for (const c of campaigns.rows) for (const r of campaignRefs(c)) refs.add(r);

    // Brands directory (may not exist on older deployments — tolerated).
    try {
      const brands = await this.exec.query<{ ref: string }>(`SELECT DISTINCT upper(trim(ref)) AS ref FROM brands`);
      for (const b of brands.rows) if (b.ref && CONFIGURED_REF_PATTERN.test(b.ref)) refs.add(b.ref);
    } catch (err: any) {
      if (err?.code !== "42P01") throw err;
    }

    return [...refs].sort();
  }

  // ── Rule 3 ────────────────────────────────────────────────────────────────

  private async runRule3(
    cursorFrom: Date | null,
    cursorTo: Date,
    counters: ConsolidationCounters,
    persist: (phase: ConsolidationPhase, p: ConsolidationProgress) => Promise<void>,
    pause: () => Promise<void>,
  ): Promise<void> {
    const phase: ConsolidationPhase = "rule3_complaint_u_tags";
    const fromClause = cursorFrom ? `AND cs."timestamp" > ($1::timestamptz AT TIME ZONE 'UTC')` : "";
    const baseParams: unknown[] = cursorFrom ? [cursorFrom, cursorTo] : [cursorTo];
    const toIdx = cursorFrom ? 2 : 1;

    const totalRes = await this.indexedQuery<{ n: string }>(
      `SELECT COUNT(*)::bigint AS n
         FROM campaign_stats cs
        WHERE ${this.ipPredicate("cs")} AND cs.type IN ('open', 'complaint')
          ${fromClause}
          AND cs."timestamp" <= ($${toIdx}::timestamptz AT TIME ZONE 'UTC')`,
      baseParams,
    );
    counters.rule3EventsTotal = Number(totalRes.rows[0]?.n ?? 0);
    await persist(phase, { phase, done: 0, total: counters.rule3EventsTotal });

    // Campaign → brand ref cache (campaign tags are stable).
    const campaignRef = new Map<string, string | null>();
    const resolveCampaignRefs = async (ids: string[]) => {
      const missing = ids.filter((id) => !campaignRef.has(id));
      if (missing.length === 0) return;
      const res = await this.exec.query<{ id: string; open_tag: string | null; click_tag: string | null; unsubscribe_tag: string | null }>(
        `SELECT id, open_tag, click_tag, unsubscribe_tag FROM campaigns WHERE id = ANY($1::varchar[])`,
        [missing],
      );
      for (const id of missing) campaignRef.set(id, null);
      for (const c of res.rows) campaignRef.set(c.id, campaignBrandRef(c));
    };

    // Keyset pagination over the partial index (timestamp, subscriber_id).
    // The boundary timestamp travels as TEXT (naive → naive, microsecond
    // exact): a JS Date round-trip would truncate to milliseconds and re-read
    // boundary rows. `timestamp >= $ts` is the index start condition; the
    // row comparison only filters the boundary ties.
    let keyset: { ts: string; sid: string; cid: string } | null = null;
    let safety = 0;
    for (;;) {
      if (++safety > 10_000_000) throw new Error("rule 3 pagination did not converge");
      const params = [...baseParams];
      let keysetClause = "";
      if (keyset) {
        params.push(keyset.ts, keyset.sid, keyset.cid);
        const n = params.length;
        keysetClause =
          `AND cs."timestamp" >= $${n - 2}::timestamp ` +
          `AND (cs."timestamp", cs.subscriber_id, cs.campaign_id) > ($${n - 2}::timestamp, $${n - 1}, $${n})`;
      }
      params.push(this.eventBatchSize);
      const res = await this.indexedQuery<{ subscriber_id: string; campaign_id: string; ts: string }>(
        `SELECT cs.subscriber_id, cs.campaign_id, cs."timestamp"::text AS ts
           FROM campaign_stats cs
          WHERE ${this.ipPredicate("cs")} AND cs.type IN ('open', 'complaint')
            ${fromClause}
            AND cs."timestamp" <= ($${toIdx}::timestamptz AT TIME ZONE 'UTC')
            ${keysetClause}
          ORDER BY cs."timestamp", cs.subscriber_id, cs.campaign_id
          LIMIT $${params.length}`,
        params,
      );
      const rows = res.rows;
      if (rows.length === 0) break;

      await resolveCampaignRefs([...new Set(rows.map((r) => r.campaign_id))]);

      // Group (ref → subscriber ids); de-duplicate (subscriber, ref) pairs within the batch.
      const byRef = new Map<string, Set<string>>();
      let skippedNoCampaignTag = 0;
      for (const r of rows) {
        const ref = campaignRef.get(r.campaign_id) ?? null;
        if (!ref) {
          skippedNoCampaignTag += 1;
          continue;
        }
        let set = byRef.get(ref);
        if (!set) byRef.set(ref, (set = new Set()));
        set.add(r.subscriber_id);
      }
      counters.rule3EventsScanned += rows.length;
      counters.rule3SkippedNoCampaignTag += skippedNoCampaignTag;

      for (const [ref, ids] of byRef) {
        const oTag = `O${ref}`;
        const uTag = `U${ref}`;
        counters.rule3PairsSeen += ids.size;
        const upd = await this.exec.query<{ added: string; no_o_tag: string; already_u: string }>(
          `WITH tgt AS (
             SELECT id,
                    tags @> ARRAY[$2]::text[] AS has_o,
                    tags @> ARRAY[$3]::text[] AS has_u
               FROM subscribers
              WHERE id = ANY($1::varchar[])
           ),
           upd AS (
             UPDATE subscribers s
                SET tags = array_append(s.tags, $3)
               FROM tgt
              WHERE s.id = tgt.id
                AND tgt.has_o AND NOT tgt.has_u
                AND s.tags @> ARRAY[$2]::text[]
                AND NOT (s.tags @> ARRAY[$3]::text[])
              RETURNING s.id
           )
           SELECT (SELECT COUNT(*) FROM upd)::bigint AS added,
                  (SELECT COUNT(*) FROM tgt WHERE NOT has_o)::bigint AS no_o_tag,
                  (SELECT COUNT(*) FROM tgt WHERE has_o AND has_u)::bigint AS already_u`,
          [[...ids], oTag, uTag],
        );
        const row = upd.rows[0];
        counters.rule3TagsAdded += Number(row?.added ?? 0);
        counters.rule3SkippedNoOpenTag += Number(row?.no_o_tag ?? 0);
        counters.rule3AlreadyTagged += Number(row?.already_u ?? 0);
      }

      const last = rows[rows.length - 1];
      keyset = { ts: last.ts, sid: last.subscriber_id, cid: last.campaign_id };
      await persist(phase, { phase, done: counters.rule3EventsScanned, total: counters.rule3EventsTotal });
      if (rows.length < this.eventBatchSize) break;
      await pause();
    }
  }

  // ── Rule 1 ────────────────────────────────────────────────────────────────

  private async runRule1(
    refs: string[],
    counters: ConsolidationCounters,
    persist: (phase: ConsolidationPhase, p: ConsolidationProgress) => Promise<void>,
    pause: () => Promise<void>,
  ): Promise<void> {
    const phase: ConsolidationPhase = "rule1_remove_refs";
    await persist(phase, { phase, done: 0, total: refs.length, currentRef: null });
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      const uTag = `U${ref}`;
      let stalls = 0;
      for (let iter = 0; iter < 100_000; iter++) {
        const res = await this.indexedQuery<{ selected: string; updated: string }>(
          `WITH c AS (
             SELECT id FROM subscribers
              WHERE tags @> ARRAY[$1]::text[] AND refs @> ARRAY[$2]::text[]
              LIMIT $3
           ),
           u AS (
             UPDATE subscribers s
                SET refs = array_remove(s.refs, $2)
               FROM c
              WHERE s.id = c.id AND s.refs @> ARRAY[$2]::text[]
              RETURNING s.id
           )
           SELECT (SELECT COUNT(*) FROM c)::bigint AS selected,
                  (SELECT COUNT(*) FROM u)::bigint AS updated`,
          [uTag, ref, this.batchSize],
        );
        const selected = Number(res.rows[0]?.selected ?? 0);
        const updated = Number(res.rows[0]?.updated ?? 0);
        counters.rule1RefsRemoved += updated;
        if (selected < this.batchSize) break;
        if (updated === 0) {
          if (++stalls >= 3) {
            logger.warn(`[DATA_CONSOLIDATION] rule 1 stalled on ref ${ref} (selected ${selected}, updated 0) — moving on`);
            break;
          }
        } else {
          stalls = 0;
        }
        await persist(phase, { phase, done: i, total: refs.length, currentRef: ref });
        await pause();
      }
      await persist(phase, { phase, done: i + 1, total: refs.length, currentRef: ref });
    }
  }

  // ── Rule 2 ────────────────────────────────────────────────────────────────

  private async runRule2(
    refs: string[],
    counters: ConsolidationCounters,
    persist: (phase: ConsolidationPhase, p: ConsolidationProgress) => Promise<void>,
    pause: () => Promise<void>,
  ): Promise<void> {
    const phase: ConsolidationPhase = "rule2_add_refs";
    await persist(phase, { phase, done: 0, total: refs.length, currentRef: null });
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      const cTag = `C${ref}`;
      const uTag = `U${ref}`;
      let stalls = 0;
      for (let iter = 0; iter < 100_000; iter++) {
        const res = await this.indexedQuery<{ selected: string; updated: string }>(
          `WITH c AS (
             SELECT id FROM subscribers
              WHERE tags @> ARRAY[$1]::text[]
                AND NOT (tags @> ARRAY[$2]::text[])
                AND NOT (refs @> ARRAY[$3]::text[])
              LIMIT $4
           ),
           u AS (
             UPDATE subscribers s
                SET refs = array_append(s.refs, $3)
               FROM c
              WHERE s.id = c.id
                AND NOT (s.refs @> ARRAY[$3]::text[])
                AND NOT (s.tags @> ARRAY[$2]::text[])
              RETURNING s.id
           )
           SELECT (SELECT COUNT(*) FROM c)::bigint AS selected,
                  (SELECT COUNT(*) FROM u)::bigint AS updated`,
          [cTag, uTag, ref, this.batchSize],
        );
        const selected = Number(res.rows[0]?.selected ?? 0);
        const updated = Number(res.rows[0]?.updated ?? 0);
        counters.rule2RefsAdded += updated;
        if (selected < this.batchSize) break;
        if (updated === 0) {
          if (++stalls >= 3) {
            logger.warn(`[DATA_CONSOLIDATION] rule 2 stalled on ref ${ref} (selected ${selected}, updated 0) — moving on`);
            break;
          }
        } else {
          stalls = 0;
        }
        await persist(phase, { phase, done: i, total: refs.length, currentRef: ref });
        await pause();
      }
      await persist(phase, { phase, done: i + 1, total: refs.length, currentRef: ref });
    }
  }
}

// ─── Process-wide instance ──────────────────────────────────────────────────

let defaultService: DataConsolidationService | null = null;

export function getDataConsolidationService(): DataConsolidationService {
  if (!defaultService) defaultService = new DataConsolidationService();
  return defaultService;
}

/** Bootstrap hook (web startup): create tables, reap runs left behind by a restart. */
export async function ensureDataConsolidationSchema(): Promise<void> {
  try {
    await getDataConsolidationService().ensureSchema();
    logger.info("[DATA_CONSOLIDATION] schema ready");
  } catch (err: any) {
    logger.error(`[DATA_CONSOLIDATION] schema bootstrap failed (non-fatal): ${err?.message || err}`);
  }
}
