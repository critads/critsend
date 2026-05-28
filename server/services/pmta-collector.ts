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
import { insertPmtaSnapshot } from "../repositories/pmta-repository";

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
let collectorRunning = false;

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

async function collectOnce(cfg: CollectorConfig): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  // Open one SSH connection per domain — keeps each failure isolated and
  // avoids long-lived sessions on the PMTA host.
  for (const domain of cfg.domains) {
    try {
      const safeDomain = shellQuoteDomain(domain);
      const command = `pmta show queue ${safeDomain}`;
      const { stdout, stderr, code } = await runSshCommand(cfg, command);
      if (code !== 0 && !stdout) {
        await insertPmtaSnapshot({
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
    CREATE TABLE IF NOT EXISTS pmta_queue_snapshots (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
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
  await pool.query(`CREATE INDEX IF NOT EXISTS pmta_snapshots_domain_captured_idx ON pmta_queue_snapshots(domain, captured_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS pmta_snapshots_captured_at_idx ON pmta_queue_snapshots(captured_at)`);
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
 * Operator-facing refresh trigger. NEVER opens SSH on the caller's stack —
 * schedules the tick on `setImmediate` so the HTTP request returns
 * instantly. Leader election still applies inside `runPmtaCollectorOnce`,
 * so even if every PM2 process receives a refresh request only the leader
 * will actually contact PMTA.
 */
export function requestPmtaRefresh(): { scheduled: boolean; reason?: string } {
  if (!isPmtaConfigured()) return { scheduled: false, reason: "not_configured" };
  if (collectorRunning) return { scheduled: false, reason: "already_running" };
  setImmediate(() => {
    runPmtaCollectorOnce().catch((err) =>
      logger.error("[PMTA_COLLECTOR] background refresh failed:", err),
    );
  });
  return { scheduled: true };
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
}

export function stopPmtaCollector(): void {
  if (collectorTimer) {
    clearInterval(collectorTimer);
    collectorTimer = null;
  }
}

export function getPmtaConfiguredDomains(): string[] {
  return loadConfig()?.domains ?? [];
}
