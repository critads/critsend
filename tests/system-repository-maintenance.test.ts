import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const insertedLog = {
    id: "log-1",
    ruleId: "rule-1",
    tableName: "campaign_sends",
    rowsDeleted: 12,
    durationMs: 25,
    status: "success",
    errorMessage: null,
    triggeredBy: "auto",
    executedAt: new Date("2026-08-01T12:00:00.000Z"),
  };
  const returningInsert = vi.fn(async () => [insertedLog]);
  const returningUpdate = vi.fn(async () => [{ id: "rule-1" }]);
  const setUpdate = vi.fn(() => ({ where: vi.fn(() => ({ returning: returningUpdate })) }));
  const tx = {
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: returningInsert })) })),
    update: vi.fn(() => ({ set: setUpdate })),
  };
  const db = {
    transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
    select: vi.fn(),
  };
  const pool = { query: vi.fn() };
  return { db, pool, tx, insertedLog, returningUpdate, setUpdate };
});

vi.mock("../server/db", () => ({
  db: mocks.db,
  pool: mocks.pool,
}));

import {
  getMaintenanceRulesForScheduling,
  recordMaintenanceRun,
} from "../server/repositories/system-repository";

describe("system maintenance repository", () => {
  it("inserts the audit row and advances the cursor in one transaction", async () => {
    const result = await recordMaintenanceRun({
      ruleId: "rule-1",
      tableName: "campaign_sends",
      rowsDeleted: 12,
      durationMs: 25,
      status: "success",
      errorMessage: null,
      triggeredBy: "auto",
    });

    expect(result).toBe(mocks.insertedLog);
    expect(mocks.db.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.tx.insert).toHaveBeenCalledTimes(1);
    expect(mocks.tx.update).toHaveBeenCalledTimes(1);
    expect(mocks.setUpdate).toHaveBeenCalledWith({
      lastRunAt: expect.any(Date),
      lastRowsDeleted: 12,
    });
    expect(mocks.returningUpdate).toHaveBeenCalledTimes(1);
  });

  it("uses the latest log timestamp when a legacy rule cursor is NULL", async () => {
    const latestLogAt = new Date("2026-08-01T11:55:00.000Z");
    const rules = [
      {
        id: "legacy-rule",
        tableName: "campaign_sends",
        displayName: "Campaign Sends",
        description: null,
        retentionDays: 180,
        enabled: true,
        lastRunAt: null,
        lastRowsDeleted: 0,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ];
    const orderBy = vi.fn(async () => rules);
    mocks.db.select.mockReturnValue({ from: vi.fn(() => ({ orderBy })) });
    mocks.pool.query.mockResolvedValue({
      rows: [{ rule_id: "legacy-rule", latest_executed_at: latestLogAt }],
    });

    const scheduledRules = await getMaintenanceRulesForScheduling();

    expect(scheduledRules[0].lastRunAt).toEqual(latestLogAt);
    expect(mocks.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("MAX(executed_at)"),
      [["legacy-rule"]],
    );
  });
});