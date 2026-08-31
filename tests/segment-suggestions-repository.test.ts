import { beforeEach, describe, expect, it, vi } from "vitest";

const poolQueryMock = vi.fn();

vi.mock("../server/db", () => ({
  db: {},
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));

vi.mock("../server/queues", () => ({
  campaignQueue: {},
}));

vi.mock("../server/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getSegmentPerformanceHistoryCandidates } from "../server/repositories/campaign-repository";

beforeEach(() => {
  poolQueryMock.mockReset();
});

describe("segment suggestion repository history lookup", () => {
  it("resolves the exact brand before limiting history, so 5,000 newer related-brand rows cannot crowd it out", async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "air-france-anchor" }] })
      .mockResolvedValueOnce({
        rows: [{
          campaign_id: "air-france-history",
          name: "#4900 Air France - code - mta",
          segment_id: "segment-fr",
          segment_name: "France audience",
          total_clicks_count: 125,
          sent_count: 10_000,
          first_send_at: "2026-08-01T10:00:00.000Z",
        }],
      });

    const rows = await getSegmentPerformanceHistoryCandidates([
      "air\u001ffrance\u001fholiday\u001fpush",
      "air\u001ffrance\u001fholiday",
      "air\u001ffrance",
      "air",
    ]);

    expect(poolQueryMock).toHaveBeenCalledTimes(4);
    expect(poolQueryMock.mock.calls[2][1][0]).toBe("%air%france%");
    expect(poolQueryMock.mock.calls[2][1][1]).toBe("air\u001ffrance");

    const finalSql = String(poolQueryMock.mock.calls[3][0]);
    const exactFilterAt = finalSql.indexOf("= $2");
    const historyLimitAt = finalSql.indexOf("LIMIT 250");
    expect(exactFilterAt).toBeGreaterThan(-1);
    expect(historyLimitAt).toBeGreaterThan(exactFilterAt);
    expect(finalSql).not.toContain("LIMIT 5000");
    expect(poolQueryMock.mock.calls[3][1][0]).toBe("%air%france%");
    expect(poolQueryMock.mock.calls[3][1][1]).toBe("air\u001ffrance");
    expect(rows).toEqual([{
      campaignId: "air-france-history",
      name: "#4900 Air France - code - mta",
      segmentId: "segment-fr",
      segmentName: "France audience",
      totalClicks: 125,
      deliveredCount: 10_000,
      firstSentAt: new Date("2026-08-01T10:00:00.000Z"),
    }]);
  });

  it("falls back from a descriptive one-token request to its exact historical anchor", async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "kiabi-anchor" }] })
      .mockResolvedValueOnce({ rows: [] });

    await getSegmentPerformanceHistoryCandidates([
      "kiabi\u001fsummer",
      "kiabi",
    ]);

    expect(poolQueryMock).toHaveBeenCalledTimes(3);
    expect(poolQueryMock.mock.calls[1][1][0]).toBe("%kiabi%");
    expect(poolQueryMock.mock.calls[1][1][1]).toBe("kiabi");
    expect(poolQueryMock.mock.calls[2][1][0]).toBe("%kiabi%");
  });

  it("uses equality only after resolving a generic one-token brand", async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [{ id: "air-anchor" }] })
      .mockResolvedValueOnce({ rows: [] });

    await getSegmentPerformanceHistoryCandidates(["air"]);

    const finalSql = String(poolQueryMock.mock.calls[1][0]);
    expect(finalSql).toContain("= $2");
    expect(finalSql).not.toContain("LIKE $2 || chr(31)");
  });
});