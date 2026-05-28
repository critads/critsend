/**
 * PMTA Queue Monitoring Collector (Task #193).
 *
 * Connects over SSH to the configured PMTA host every 5 minutes, runs
 *   pmta show queue <domain>
 * for each configured domain, parses pending count + matches an error
 * pattern (error|timeout|refused|blocked|defer|421|450|451|452|550|554),
 * and persists a snapshot row per (domain, run).
 *
 * Hard rules:
 *   1. SSH is NEVER opened on a request path. The HTTP route serves cached
 *      rows from `pmta_queue_snapshots` only.
 *   2. Singleton scheduling across the 3 PM2 processes uses a lease-table
 *      leader election (`pmta_collector_leader`), NEVER pg_try_advisory_lock
 *      (which leaks on Neon's PgBouncer transaction pooling).
 *   3. Domain values are validated against `/^[a-z0-9.-]+$/i` before being
 *      interpolated into the shell command — no other characters allowed.
 *   4. The private key is read from a secret and never logged.
 */
import os from "node:os";
import { Client as SshClient, type ConnectConfig } from "ssh2";
import { pool } from "../db";
import { logger } from "../logger";
import { insertPmtaSnapshot, upsertPmtaServer } from "../repositories/pmta-repository";

const COLLECTOR_INTERVAL_MS = Math.max(
  Number(process.env.PMTA_COLLECTOR_INTERVAL_MS) || 5 * 60 * 1000,
  60_000,
);
const LEASE_TTL_MS = COLLECTOR_INTERVAL_MS * 3; // 15 min default — long enough to survive a missed tick
const SSH_TIMEOUT_MS = 20_000;
const PER_DOMAIN_EXEC_TIMEOUT_MS = 15_000;
const RAW_EXCERPT_BYTES = 8 * 1024;
const MAX_ERROR_LINES = 50;

const DOMAIN_RE = /^[a-z0-9.-]+$/i;
const ERROR_PATTERN_RE = /\b(error|timeout|refused|blocked|defer|421|450|451|452|550|554)\b/i;

const LOCK_KEY = "global";

let collectorTimer: NodeJS.Timeout | null = null;
let refreshPollTimer: NodeJS.Timeout | null = null;
let collectorRunning = false;
// How often EVERY process polls pmta_refresh_signal looking for a
// pending operator-triggered refresh. Cheap query (1 row, indexed PK),
// runs on every PM2 process but only the leader actually executes a
// tick — so cost scales with #processes, not #domains.
const REFRESH_POLL_INTERVAL_MS = 5_000;
// Cached pmta_servers.id for the host populated from PMTA_SSH_* env. Resolved
// lazily on the first tick so collector start does not block on DB readiness.
let cachedServerId: string | null = null;

interface CollectorConfig {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  domains: string[];
}

function loadConfig(): CollectorConfig | null {
  const host = process.env.PMTA_SSH_HOST?.trim();
  const username = process.env.PMTA_SSH_USER?.trim();
  const privateKey = process.env.PMTA_SSH_PRIVATE_KEY;
  const rawDomains = process.env.PMTA_DOMAINS?.trim();
  if (!host || !username || !privateKey || !rawDomains) {
    return null;
  }
  const port = Number(process.env.PMTA_SSH_PORT) || 22;
  const domains = rawDomains
    .split(/[,\s]+/)
    .map((d) => d.trim())
    .filter(Boolean);
  const invalid = domains.find((d) => !DOMAIN_RE.test(d));
  if (invalid) {
    logger.error(`[PMTA_COLLECTOR] Rejecting invalid domain "${invalid}" — must match ${DOMAIN_RE}`);
    return null;
  }
  if (domains.length === 0) {
    return null;
  }
  return { host, port, username, privateKey, domains };
}

export function isPmtaConfigured(): boolean {
  return loadConfig() !== null;
}

/**
 * Parser for `pmta show queue <domain>` output.
 *
 * PMTA queue dumps vary across versions but always include:
 *   - A "Total Messages" / "Messages: <n>" / "kmsg <n>" summary line
 *   - Per-recipient or per-host status lines that may include diagnostic text
 *
 * We grep the entire output for the error pattern and extract a pending
 * count from the first numeric token on a "messages"/"kmsg"/"queued" line
 * (case-insensitive). If we cannot find one, pendingCount falls back to 0
 * and `status` is set to "parse_error" with `errorMessage` populated.
 */
export function parsePmtaQueueOutput(raw: string): {
  pendingCount: number;
  errorCount: number;
  errorLines: string[];
  parseStatus: "ok" | "parse_error";
  parseError?: string;
} {
  const lines = raw.split(/\r?\n/);
  const errorLines: string[] = [];
  for (const line of lines) {
    if (ERROR_PATTERN_RE.test(line)) {
      errorLines.push(line.trim().slice(0, 500));
      if (errorLines.length >= MAX_ERROR_LINES) break;
    }
  }

  let pendingCount = 0;
  let parseStatus: "ok" | "parse_error" = "ok";
  let parseError: string | undefined;

  // Look for a summary line containing a number. Common PMTA wordings:
  //   "Messages: 1234", "Total messages: 1234", "1234 messages queued",
  //   "kmsg 1234", "Queued: 1234".
  const summaryRe = /(?:total\s+messages|messages\s*queued|messages|kmsg|queued|qmsg)\D{0,12}(\d+)/i;
  const altRe = /^\s*(\d+)\s+messages?\b/i;
  let matched = false;
  for (const line of lines) {
    const m = summaryRe.exec(line) ?? altRe.exec(line);
    if (m) {
      pendingCount = Number(m[1]);
      matched = true;
      break;
    }
  }
  if (!matched) {
    // Some PMTA versions print a table; fall back to counting body rows that
    // look like recipient entries (start with a date/timestamp or "rcp").
    const recipientLikeRe = /^\s*(?:\d{4}-\d{2}-\d{2}|rcp\b|[a-z0-9._-]+@[a-z0-9.-]+)/i;
    let bodyRows = 0;
    for (const line of lines) {
      if (recipientLikeRe.test(line)) bodyRows++;
    }
    if (bodyRows > 0) {
      pendingCount = bodyRows;
    } else {
      parseStatus = "parse_error";
      parseError = "no summary line found and no recipient-like rows detected";
    }
  }

  return { pendingCount, errorCount: errorLines.length, errorLines, parseStatus, parseError };
}

function shellQuoteDomain(domain: string): string {
  // Defence in depth: DOMAIN_RE is already enforced at config load, but we
  // re-validate here so a future bypass cannot reach the shell.
  if (!DOMAIN_RE.test(domain)) {
    throw new Error(`refusing to exec with invalid domain: ${domain}`);
  }
  return domain;
}

async function runSshCommand(
  cfg: CollectorConfig,
  command: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const conn = new SshClient();
    const sshConfig: ConnectConfig = {
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      privateKey: cfg.privateKey,
      readyTimeout: SSH_TIMEOUT_MS,
    };
    let resolved = false;
    const overallTimer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { conn.end(); } catch {}
      reject(new Error(`SSH exec timed out after ${PER_DOMAIN_EXEC_TIMEOUT_MS}ms`));
    }, PER_DOMAIN_EXEC_TIMEOUT_MS + SSH_TIMEOUT_MS);
    overallTimer.unref?.();

    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          if (resolved) return;
          resolved = true;
          clearTimeout(overallTimer);
          try { conn.end(); } catch {}
          return reject(err);
        }
        let stdout = "";
        let stderr = "";
        let code: number | null = null;
        stream.on("close", (exitCode: number | null) => {
          code = exitCode;
          if (resolved) return;
          resolved = true;
          clearTimeout(overallTimer);
          try { conn.end(); } catch {}
          resolve({ stdout, stderr, code });
        });
        stream.on("data", (data: Buffer) => {
          stdout += data.toString("utf8");
          if (stdout.length > 256 * 1024) stdout = stdout.slice(0, 256 * 1024);
        });
        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString("utf8");
          if (stderr.length > 32 * 1024) stderr = stderr.slice(0, 32 * 1024);
        });
      });
    });
    conn.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(overallTimer);
      reject(err);
    });
    try {
      conn.connect(sshConfig);
    } catch (err) {
      if (resolved) return;
      resolved = true;
      clearTimeout(overallTimer);
      reject(err);
    }
  });
}

async function resolveServerId(cfg: CollectorConfig): Promise<string | null> {
  if (cachedServerId) return cachedServerId;
  try {
    cachedServerId = await upsertPmtaServer({
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      sshKeySecretRef: "PMTA_SSH_PRIVATE_KEY",
    });
    return cachedServerId;
  } catch (err: any) {
    // Non-fatal: snapshots can be written with a null server_id and the
    // server row will be re-attempted on the next tick. Log without
    // touching the private key.
    logger.warn(`[PMTA_COLLECTOR] upsert pmta_servers failed (${err?.message || err}) — snapshots will carry server_id=null until resolved`);
    return null;
  }
}

async function collectOnce(cfg: CollectorConfig): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  const serverId = await resolveServerId(cfg);
  // Open one SSH connection per domain — keeps each failure isolated and
  // avoids long-lived sessions on the PMTA host.
  for (const domain of cfg.domains) {
    try {
      const safeDomain = shellQuoteDomain(domain);
      const command = `pmta show queue ${safeDomain}`;
      const { stdout, stderr, code } = await runSshCommand(cfg, command);
      if (code !== 0 && !stdout) {
        await insertPmtaSnapshot({
          serverId,
          domain,
          pendingCount: 0,
          errorCount: 0,
          status: "ssh_error",
          errorMessage: `exit=${code} stderr=${stderr.slice(0, 500)}`,
          errorLines: [],
          rawExcerpt: (stderr || stdout).slice(0, RAW_EXCERPT_BYTES),
        });
        failed++;
        continue;
      }
      const parsed = parsePmtaQueueOutput(stdout);
      await insertPmtaSnapshot({
        serverId,
        domain,
        pendingCount: parsed.pendingCount,
        errorCount: parsed.errorCount,
        status: parsed.parseStatus,
        errorMessage: parsed.parseError ?? null,
        errorLines: parsed.errorLines,
        rawExcerpt: stdout.slice(0, RAW_EXCERPT_BYTES),
      });
      ok++;
    } catch (err: any) {
      try {
        await insertPmtaSnapshot({
          serverId,
          domain,
          pendingCount: 0,
          errorCount: 0,
          status: "ssh_error",
          errorMessage: String(err?.message ?? err).slice(0, 500),
          errorLines: [],
          rawExcerpt: null,
        });
      } catch (persistErr) {
        logger.error(`[PMTA_COLLECTOR] persist failed for ${domain}:`, persistErr);
      }
      failed++;
    }
  }
  return { ok, failed };
}

async function ensureLeaderTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pmta_collector_leader (
      lock_key TEXT PRIMARY KEY,
      holder TEXT NOT NULL,
      acquired_at TIMESTAMP NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMP NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pmta_servers (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 22,
      username TEXT NOT NULL,
      ssh_key_secret_ref TEXT NOT NULL DEFAULT 'PMTA_SSH_PRIVATE_KEY',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS pmta_servers_host_port_unique ON pmta_servers(host, port)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pmta_queue_snapshots (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      server_id VARCHAR REFERENCES pmta_servers(id) ON DELETE SET NULL,
      domain TEXT NOT NULL,
      captured_at TIMESTAMP NOT NULL DEFAULT NOW(),
      pending_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ok',
      error_message TEXT,
      error_lines JSONB NOT NULL DEFAULT '[]'::jsonb,
      raw_excerpt TEXT
    )
  `);
  // Backfill server_id column on installs that pre-date the FK (idempotent).
  await pool.query(`ALTER TABLE pmta_queue_snapshots ADD COLUMN IF NOT EXISTS server_id VARCHAR REFERENCES pmta_servers(id) ON DELETE SET NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS pmta_snapshots_domain_captured_idx ON pmta_queue_snapshots(domain, captured_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS pmta_snapshots_captured_at_idx ON pmta_queue_snapshots(captured_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS pmta_snapshots_server_idx ON pmta_queue_snapshots(server_id)`);
}

function holderId(): string {
  return `${os.hostname()}:${process.pid}`;
}

/**
 * Lease-table leader election. Returns true if this process holds the lease
 * (either freshly acquired or renewed). Returns false if another process
 * holds an unexpired lease.
 */
async function tryAcquireLeader(): Promise<boolean> {
  const me = holderId();
  const ttlSec = Math.ceil(LEASE_TTL_MS / 1000);
  const result = await pool.query(
    `INSERT INTO pmta_collector_leader (lock_key, holder, acquired_at, expires_at)
       VALUES ($1, $2, NOW(), NOW() + ($3 || ' seconds')::interval)
     ON CONFLICT (lock_key) DO UPDATE
       SET holder = EXCLUDED.holder,
           acquired_at = EXCLUDED.acquired_at,
           expires_at  = EXCLUDED.expires_at
       WHERE pmta_collector_leader.expires_at <= NOW()
          OR pmta_collector_leader.holder = EXCLUDED.holder
     RETURNING holder`,
    [LOCK_KEY, me, String(ttlSec)],
  );
  return (result.rowCount ?? 0) > 0 && result.rows[0].holder === me;
}

/**
 * Runs one collector tick if and only if this process is the lease-table
 * leader (or can opportunistically acquire the lease). Returns synchronously
 * with the outcome — callers MUST NOT invoke this on a request path; use
 * `requestPmtaRefresh()` instead which schedules it off the event loop.
 */
export async function runPmtaCollectorOnce(): Promise<{
  ran: boolean;
  ok: number;
  failed: number;
  skipped?: string;
}> {
  const cfg = loadConfig();
  if (!cfg) {
    return { ran: false, ok: 0, failed: 0, skipped: "not_configured" };
  }
  if (collectorRunning) {
    return { ran: false, ok: 0, failed: 0, skipped: "already_running" };
  }
  // Architectural rule: leader election is ALWAYS enforced — even for
  // operator-triggered refreshes. Bypassing it would let multiple PM2
  // processes SSH the PMTA host in parallel for the same tick. The lease
  // upsert is opportunistic: if no current holder (or lease expired), the
  // calling process takes over immediately.
  const won = await tryAcquireLeader();
  if (!won) {
    return { ran: false, ok: 0, failed: 0, skipped: "not_leader" };
  }
  collectorRunning = true;
  try {
    const { ok, failed } = await collectOnce(cfg);
    logger.info(`[PMTA_COLLECTOR] tick complete ok=${ok} failed=${failed} domains=${cfg.domains.length}`);
    return { ran: true, ok, failed };
  } catch (err) {
    logger.error("[PMTA_COLLECTOR] tick failed:", err);
    return { ran: true, ok: 0, failed: cfg.domains.length };
  } finally {
    collectorRunning = false;
  }
}

/**
 * Operator-facing refresh trigger. Cross-process durable: writes a row to
 * `pmta_refresh_signal` from whichever PM2 process received the HTTP
 * request. The collector leader (which may be a different process — the
 * web process typically does NOT run workers) polls this table every few
 * seconds and runs an out-of-cycle collectOnce when it sees a pending
 * signal. The HTTP handler never opens SSH.
 *
 * Returns scheduled=true only AFTER the signal row is durably persisted.
 */
export async function requestPmtaRefresh(
  requestedBy: string,
): Promise<{ scheduled: boolean; reason?: string; requestedAt?: string }> {
  if (!isPmtaConfigured()) return { scheduled: false, reason: "not_configured" };
  try {
    await ensureRefreshSignalTable();
    const result = await pool.query(
      `INSERT INTO pmta_refresh_signal (id, requested_at, requested_by)
         VALUES ('global', NOW(), $1)
       ON CONFLICT (id) DO UPDATE
         SET requested_at = NOW(),
             requested_by = EXCLUDED.requested_by
       RETURNING requested_at`,
      [requestedBy],
    );
    const requestedAt = result.rows[0]?.requested_at;
    return {
      scheduled: true,
      requestedAt: requestedAt ? new Date(requestedAt).toISOString() : undefined,
    };
  } catch (err: any) {
    logger.error(`[PMTA_COLLECTOR] requestPmtaRefresh failed: ${err?.message || err}`);
    return { scheduled: false, reason: "persist_failed" };
  }
}

async function ensureRefreshSignalTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pmta_refresh_signal (
      id TEXT PRIMARY KEY,
      requested_at TIMESTAMP,
      requested_by TEXT,
      processed_at TIMESTAMP,
      processed_by TEXT
    )
  `);
}

/**
 * Polls pmta_refresh_signal. Runs on every process but only acts when
 * this process is the leader (cheap idempotent check via tryAcquireLeader).
 * If requested_at > processed_at, runs an out-of-cycle collectOnce.
 */
async function checkRefreshSignal(): Promise<void> {
  if (!isPmtaConfigured() || collectorRunning) return;
  try {
    const sig = await pool.query<{ requested_at: Date | null; processed_at: Date | null }>(
      `SELECT requested_at, processed_at FROM pmta_refresh_signal WHERE id = 'global'`,
    );
    const row = sig.rows[0];
    if (!row?.requested_at) return;
    const isStale = row.processed_at && row.processed_at >= row.requested_at;
    if (isStale) return;
    const won = await tryAcquireLeader();
    if (!won) return;
    // Mark processed BEFORE running so concurrent poll ticks on the same
    // leader can't double-fire. Use atomic UPDATE...WHERE so a race with
    // a fresh request mid-tick still gets picked up on the next poll.
    const claim = await pool.query(
      `UPDATE pmta_refresh_signal
          SET processed_at = NOW(), processed_by = $1
        WHERE id = 'global'
          AND requested_at = $2
          AND (processed_at IS NULL OR processed_at < requested_at)
        RETURNING id`,
      [holderId(), row.requested_at],
    );
    if ((claim.rowCount ?? 0) === 0) return; // lost the race — skip
    collectorRunning = true;
    try {
      const cfg = loadConfig();
      if (!cfg) return;
      const { ok, failed } = await collectOnce(cfg);
      logger.info(`[PMTA_COLLECTOR] operator-refresh tick complete ok=${ok} failed=${failed}`);
    } finally {
      collectorRunning = false;
    }
  } catch (err: any) {
    logger.error(`[PMTA_COLLECTOR] checkRefreshSignal failed: ${err?.message || err}`);
  }
}

export async function startPmtaCollector(): Promise<void> {
  if (collectorTimer) return;
  const cfg = loadConfig();
  if (!cfg) {
    logger.info("[PMTA_COLLECTOR] disabled — PMTA_SSH_HOST / PMTA_SSH_USER / PMTA_SSH_PRIVATE_KEY / PMTA_DOMAINS not all set");
    return;
  }
  try {
    await ensureLeaderTable();
  } catch (err) {
    logger.error("[PMTA_COLLECTOR] failed to ensure schema — collector will not start:", err);
    return;
  }
  logger.info(
    `[PMTA_COLLECTOR] starting (interval=${COLLECTOR_INTERVAL_MS / 1000}s, ` +
    `host=${cfg.host}:${cfg.port}, domains=${cfg.domains.length})`,
  );
  // Stagger first run by 5–15s to avoid all 3 PM2 processes racing on boot.
  const jitter = 5_000 + Math.floor(Math.random() * 10_000);
  setTimeout(() => { void runPmtaCollectorOnce(); }, jitter).unref?.();
  collectorTimer = setInterval(() => {
    void runPmtaCollectorOnce();
  }, COLLECTOR_INTERVAL_MS);
  collectorTimer.unref?.();
  // Cross-process refresh poller — runs on every PM2 process; only the
  // leader actually executes a tick (cheap SELECT otherwise).
  refreshPollTimer = setInterval(() => {
    void checkRefreshSignal();
  }, REFRESH_POLL_INTERVAL_MS);
  refreshPollTimer.unref?.();
}

export function stopPmtaCollector(): void {
  if (refreshPollTimer) {
    clearInterval(refreshPollTimer);
    refreshPollTimer = null;
  }
  if (collectorTimer) {
    clearInterval(collectorTimer);
    collectorTimer = null;
  }
}

export function getPmtaConfiguredDomains(): string[] {
  return loadConfig()?.domains ?? [];
}
