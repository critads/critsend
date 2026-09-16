/**
 * Durable cadence helpers for retention maintenance.
 *
 * The old worker used a process-local six-hour setInterval.  A PM2 restart
 * resets that timer, so repeated restarts could indefinitely postpone the next
 * cleanup.  These helpers deliberately make the database's last_run_at value
 * (or a read-only latest-log fallback for legacy NULL rows) the source of
 * truth instead.
 */

export const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const MAINTENANCE_STARTUP_GRACE_MS = 5 * 60 * 1000;

// The scheduler is a watchdog, not the cadence.  It is intentionally much
// shorter than the six-hour retention interval so a restart cannot create a
// new six-hour grace period.
export const MAINTENANCE_WATCHDOG_INTERVAL_MS = 60 * 1000;

export interface MaintenanceScheduleRule {
  enabled: boolean;
  tableName: string;
  lastRunAt: Date | string | null;
}

export function effectiveMaintenanceLastRunAt(
  lastRunAt: Date | string | null | undefined,
  latestLogAt: Date | string | null | undefined,
): Date | string | null {
  return lastRunAt ?? latestLogAt ?? null;
}

export function isMaintenanceStartupGrace(
  startedAtMs: number,
  nowMs: number = Date.now(),
  graceMs: number = MAINTENANCE_STARTUP_GRACE_MS,
): boolean {
  return nowMs - startedAtMs < graceMs;
}

export function isMaintenanceRunDue(
  lastRunAt: Date | string | null | undefined,
  nowMs: number = Date.now(),
  intervalMs: number = MAINTENANCE_INTERVAL_MS,
): boolean {
  if (lastRunAt == null) return true;
  const lastRunMs = new Date(lastRunAt).getTime();
  // A malformed/null timestamp must not disable retention indefinitely.
  if (!Number.isFinite(lastRunMs)) return true;
  return nowMs - lastRunMs >= intervalMs;
}

export function hasDueMaintenanceRule(
  rules: readonly MaintenanceScheduleRule[],
  nowMs: number = Date.now(),
): boolean {
  return rules.some((rule) =>
    rule.enabled &&
    rule.tableName !== "tracking_tokens" &&
    rule.tableName !== "import_staging" &&
    isMaintenanceRunDue(rule.lastRunAt, nowMs),
  );
}