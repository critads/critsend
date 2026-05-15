import { logger } from "../logger";

const lastTickByName = new Map<string, number>();

type ErrorCb = (name: string, err: unknown) => void;
let onTickError: ErrorCb | null = null;

export function setSafeIntervalErrorListener(cb: ErrorCb | null): void {
  onTickError = cb;
}

export function getLastTickAt(name: string): number | null {
  return lastTickByName.get(name) ?? null;
}

export function getLastTickAgeMs(name: string): number | null {
  const t = lastTickByName.get(name);
  if (t == null) return null;
  return Date.now() - t;
}

export function recordTick(name: string): void {
  lastTickByName.set(name, Date.now());
}

/**
 * Wraps setInterval so that:
 *  - exceptions in the callback are caught + logged (never crash the
 *    Node event loop with an unhandled rejection / uncaughtException);
 *  - overlapping ticks are skipped (re-entrancy guard);
 *  - last-successful-tick timestamp is recorded per `name` so a
 *    health endpoint can answer "is this loop still alive?".
 *
 * Task #160: previously the pressure-drain `setInterval(pollDeferredQueue, ...)`
 * had no top-level try/catch — a single unhandled DB error inside the
 * tick would silently kill the loop until the next process restart, and
 * the only signal was the absence of the `[PRESSURE_GUARD_WORKER] tick:`
 * log line (impossible to alert on).
 */
export function safeInterval(
  name: string,
  fn: () => unknown | Promise<unknown>,
  intervalMs: number,
): NodeJS.Timeout {
  let isRunning = false;
  const wrapped = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      await fn();
    } catch (err: any) {
      logger.error(`[safeInterval] ${name} tick failed: ${err?.message || err}`, {
        stack: err?.stack,
      });
      try {
        onTickError?.(name, err);
      } catch {
        /* listener errors are non-fatal */
      }
    } finally {
      isRunning = false;
      recordTick(name);
    }
  };
  return setInterval(wrapped, intervalMs);
}
