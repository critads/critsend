/**
 * Bounded retry of database connection acquisition for the import path.
 *
 * Why this exists: the CSV import opens up to IMPORT_POOL_MAX connections in a
 * burst at the start of each batch wave (each in-flight COPY/INSERT batch grabs
 * its own connection) against Neon's PgBouncer pooled endpoint. Under pooler
 * load or a compute cold start, a fresh connection accept can exceed the pool's
 * connectionTimeoutMillis, so node-postgres throws "timeout exceeded when trying
 * to connect". Without a retry, a single such blip:
 *   - on a COPY/INSERT batch → sets batchError → fails the ENTIRE import, or
 *   - on a per-row fallback (singleUpsert) → permanently marks rows failed.
 *
 * Both were observed in production (whole-import "timeout exceeded when trying to
 * connect" failures AND a "completed" import with thousands of failed rows).
 *
 * Retrying transient connection-class errors with exponential backoff + jitter
 * turns a momentary pooler/compute hiccup into a brief pause instead of a lost
 * import or false row failures. Retried operations on this path are idempotent
 * (counts, ON CONFLICT upserts, LIMIT-loop deletes/updates), so a retry after a
 * mid-flight reset is safe.
 *
 * Kept dependency-light (logger only) so the retry core is unit-testable in
 * isolation without loading the whole import processor.
 */
import { logger } from "../logger";

export const IMPORT_CONNECT_MAX_RETRIES = Number(process.env.IMPORT_CONNECT_MAX_RETRIES) || 4;
export const IMPORT_CONNECT_RETRY_BASE_MS = Number(process.env.IMPORT_CONNECT_RETRY_BASE_MS) || 500;
export const IMPORT_CONNECT_RETRY_MAX_MS = Number(process.env.IMPORT_CONNECT_RETRY_MAX_MS) || 8000;

/**
 * True for transient connection-acquisition / network failures worth retrying.
 * The most important is node-postgres's "timeout exceeded when trying to
 * connect" (Pool could not acquire/establish a connection within
 * connectionTimeoutMillis), plus dropped/reset sockets and Postgres
 * connection-class SQLSTATEs (08xxx, 57P01 admin shutdown). Deliberately does
 * NOT match SQL/data-integrity errors, so genuine data errors fail fast.
 */
export function isTransientConnError(err: any): boolean {
  const msg = String(err?.message || err || "").toLowerCase();
  const code = err?.code;
  return (
    msg.includes("timeout exceeded when trying to connect") ||
    msg.includes("connection terminated") ||
    msg.includes("server closed the connection") ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ECONNREFUSED" ||
    code === "EPIPE" ||
    code === "57P01" ||
    code === "08000" ||
    code === "08001" ||
    code === "08003" ||
    code === "08004" ||
    code === "08006"
  );
}

export interface ConnRetryOptions {
  maxRetries?: number;
  baseMs?: number;
  maxMs?: number;
  label?: string;
}

/**
 * Run `op` (a connection acquire or a pool query) with bounded exponential
 * backoff + jitter, retrying ONLY transient connection-class failures. Non-
 * transient errors (and exhausted retries) are re-thrown unchanged.
 *
 * Delay knobs are injectable via `options` so tests can run with zero delay.
 */
export async function withConnRetry<T>(op: () => Promise<T>, options: ConnRetryOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? IMPORT_CONNECT_MAX_RETRIES;
  const baseMs = options.baseMs ?? IMPORT_CONNECT_RETRY_BASE_MS;
  const maxMs = options.maxMs ?? IMPORT_CONNECT_RETRY_MAX_MS;
  const label = options.label ?? "connection";

  let attempt = 0;
  while (true) {
    try {
      return await op();
    } catch (err: any) {
      attempt++;
      if (attempt > maxRetries || !isTransientConnError(err)) {
        throw err;
      }
      const backoff = Math.min(baseMs * 2 ** (attempt - 1), maxMs);
      const jitter = backoff > 0 ? Math.floor(Math.random() * 250) : 0;
      const delay = backoff + jitter;
      logger.warn(
        `[IMPORT] transient ${label} failure (attempt ${attempt}/${maxRetries}): ${err?.message || err}; retrying in ${delay}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
