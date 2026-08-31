import { describe, expect, it, vi } from "vitest";

const { dbExecuteMock } = vi.hoisted(() => ({
  dbExecuteMock: vi.fn(),
}));

vi.mock("../server/db", () => ({
  db: { execute: (...args: unknown[]) => dbExecuteMock(...args) },
  pool: { query: vi.fn() },
}));
vi.mock("../server/queues", () => ({ campaignQueue: {} }));
vi.mock("../server/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  buildCampaignSendStateTotals,
  finalizeSend,
  forceFailPendingSend,
  getCampaignSendStateTotals,
} from "../server/repositories/campaign-repository";

describe("campaign live send-state totals", () => {
  it("reports a sent-only campaign as fully finalized", () => {
    expect(buildCampaignSendStateTotals({ sent: "12", failed: 0, pending: 0, deferred: 0 })).toEqual({
      processed: 12,
      finalized: 12,
      sent: 12,
      failed: 0,
      pending: 0,
      deferred: 0,
    });
  });

  it("keeps deferred-only contacts inside pending without double-counting", () => {
    expect(buildCampaignSendStateTotals({ sent: 0, failed: 0, pending: "8", deferred: "8" })).toEqual({
      processed: 8,
      finalized: 0,
      sent: 0,
      failed: 0,
      pending: 8,
      deferred: 8,
    });
  });

  it("partitions mixed finalized and pending results", () => {
    expect(buildCampaignSendStateTotals({ sent: 7, failed: 2, pending: 5, deferred: 3 })).toEqual({
      processed: 14,
      finalized: 9,
      sent: 7,
      failed: 2,
      pending: 5,
      deferred: 3,
    });
  });

  it("clamps a stale deferred count to the live pending total", () => {
    expect(buildCampaignSendStateTotals({ pending: 2, deferred: 9 }).deferred).toBe(2);
  });

  it("reads one campaign-scoped live aggregate from campaign_sends", async () => {
    dbExecuteMock.mockResolvedValueOnce({
      rows: [{ sent: "4", failed: "1", pending: "3", deferred: "2" }],
    });

    await expect(getCampaignSendStateTotals("campaign-123")).resolves.toEqual({
      processed: 8,
      finalized: 5,
      sent: 4,
      failed: 1,
      pending: 3,
      deferred: 2,
    });

    expect(dbExecuteMock).toHaveBeenCalledOnce();
    const query = dbExecuteMock.mock.calls[0][0] as {
      queryChunks?: Array<{ value?: string[] }>;
    };
    const sqlText = (query.queryChunks ?? [])
      .flatMap((chunk) => chunk.value ?? [])
      .join(" ");
    expect(sqlText).toContain("FROM campaign_sends");
    expect(sqlText).toContain("WHERE campaign_id");
    expect(sqlText).toContain("eligible_at IS NOT NULL");
  });

  it("finalizes both pending and attempting rows with the real repository SQL", async () => {
    dbExecuteMock.mockResolvedValueOnce({ rows: [{ updated_count: "1" }] });

    await expect(
      finalizeSend("campaign-123", "subscriber-123", true),
    ).resolves.toBeUndefined();

    const query = dbExecuteMock.mock.calls.at(-1)?.[0] as {
      queryChunks?: Array<{ value?: string[] }>;
    };
    const sqlText = (query.queryChunks ?? [])
      .flatMap((chunk) => chunk.value ?? [])
      .join(" ");
    expect(sqlText).toContain("status IN ('pending', 'attempting')");
  });

  it("force-fails an attempting row and reports whether it changed state", async () => {
    dbExecuteMock.mockResolvedValueOnce({ rows: [{ updated_count: "1" }] });

    await expect(
      forceFailPendingSend("campaign-123", "subscriber-123"),
    ).resolves.toBe(true);

    const query = dbExecuteMock.mock.calls.at(-1)?.[0] as {
      queryChunks?: Array<{ value?: string[] }>;
    };
    const sqlText = (query.queryChunks ?? [])
      .flatMap((chunk) => chunk.value ?? [])
      .join(" ");
    expect(sqlText).toContain("status IN ('pending', 'attempting')");
  });
});