import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  MAINTENANCE_INTERVAL_MS,
  MAINTENANCE_STARTUP_GRACE_MS,
  hasDueMaintenanceRule,
  effectiveMaintenanceLastRunAt,
  isMaintenanceRunDue,
  isMaintenanceStartupGrace,
} from "../server/lib/maintenance-schedule";

const workersSrc = readFileSync(resolve(__dirname, "../server/workers.ts"), "utf8");
const systemRepoSrc = readFileSync(resolve(__dirname, "../server/repositories/system-repository.ts"), "utf8");

describe("durable maintenance cadence", () => {
  const now = Date.parse("2026-08-01T12:00:00.000Z");

  it("runs a rule with no persisted cursor", () => {
    expect(isMaintenanceRunDue(null, now)).toBe(true);
  });

  it("does not rerun a recent rule just because the process restarted", () => {
    expect(isMaintenanceRunDue(new Date(now - MAINTENANCE_INTERVAL_MS + 1), now)).toBe(false);
  });

  it("catches up a rule whose persisted cursor is six hours old", () => {
    expect(isMaintenanceRunDue(new Date(now - MAINTENANCE_INTERVAL_MS), now)).toBe(true);
  });

  it("treats malformed persisted timestamps as due rather than disabling retention", () => {
    expect(isMaintenanceRunDue("not-a-timestamp", now)).toBe(true);
  });

  it("uses the latest log as a read-only cursor fallback for legacy NULL rules", () => {
    const latestLog = new Date(now - 1_000);
    expect(effectiveMaintenanceLastRunAt(null, latestLog)).toBe(latestLog);
    expect(effectiveMaintenanceLastRunAt(new Date(now - MAINTENANCE_INTERVAL_MS), latestLog))
      .toEqual(new Date(now - MAINTENANCE_INTERVAL_MS));
  });

  it("gives startup a grace period before automatic cleanup", () => {
    expect(isMaintenanceStartupGrace(now, now + MAINTENANCE_STARTUP_GRACE_MS - 1)).toBe(true);
    expect(isMaintenanceStartupGrace(now, now + MAINTENANCE_STARTUP_GRACE_MS)).toBe(false);
  });

  it("ignores dedicated daily tables when deciding generic maintenance due-ness", () => {
    const recent = new Date(now - 1_000);
    expect(hasDueMaintenanceRule([
      { enabled: true, tableName: "tracking_tokens", lastRunAt: null },
      { enabled: true, tableName: "import_staging", lastRunAt: null },
      { enabled: true, tableName: "campaign_sends", lastRunAt: recent },
    ], now)).toBe(false);
  });

  it("detects an overdue generic rule after a restart", () => {
    expect(hasDueMaintenanceRule([
      { enabled: true, tableName: "campaign_sends", lastRunAt: new Date(now - MAINTENANCE_INTERVAL_MS) },
    ], now)).toBe(true);
  });
});

describe("maintenance persistence wiring", () => {
  it("uses a watchdog plus the durable cursor instead of a process-local six-hour timer", () => {
    expect(workersSrc).toContain("MAINTENANCE_WATCHDOG_INTERVAL_MS");
    expect(workersSrc).toContain("hasDueMaintenanceRule");
    expect(workersSrc).toContain("getMaintenanceRulesForScheduling");
    expect(workersSrc).toContain("isMaintenanceStartupGrace");
    expect(workersSrc).not.toContain("await storage.seedDefaultMaintenanceRules");
    expect(workersSrc).not.toContain("setInterval(async () => {\n    try {\n      await runMaintenanceNow(\"auto\")");
  });

  it("queries latest maintenance logs only as a legacy cursor fallback", () => {
    expect(systemRepoSrc).toContain("getMaintenanceRulesForScheduling");
    expect(systemRepoSrc).toContain("MAX(executed_at)");
    expect(systemRepoSrc).toContain("rule.lastRunAt == null");
  });

  it("records logs and advances last_run_at in one repository transaction", () => {
    expect(systemRepoSrc).toContain("export async function recordMaintenanceRun");
    expect(systemRepoSrc).toContain("return db.transaction(async (tx)");
    expect(systemRepoSrc).toContain("lastRunAt: new Date()");
    expect(systemRepoSrc).toContain("lastRowsDeleted: data.rowsDeleted");
    expect(systemRepoSrc).toContain("return recordMaintenanceRun(data)");
    expect(workersSrc).not.toContain("updateMaintenanceRule(rule.id, {})");
    expect(workersSrc).not.toContain("storage.createMaintenanceLog");
    expect(workersSrc).toContain("storage.recordMaintenanceRun");
  });

  it("uses only short transaction-scoped batch coordination", () => {
    expect(workersSrc).toContain("pg_try_advisory_xact_lock");
    expect(workersSrc).toContain("LOCK_KEYS.MAINTENANCE");
    expect(workersSrc).toContain("SET LOCAL statement_timeout");
    expect(workersSrc).toContain("runMaintenanceBatch");
    expect(workersSrc).not.toContain("lockTransactionOpen");
    const runStart = workersSrc.indexOf("export async function runMaintenanceNow");
    const runEnd = workersSrc.indexOf("\nasync function _runMaintenance", runStart);
    expect(workersSrc.slice(runStart, runEnd)).not.toContain("pool.connect");
  });
});