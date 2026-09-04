import { beforeEach, describe, expect, it, vi } from "vitest";

const original = {
  id: "campaign-original",
  name: "#100 Brand - code - mta",
  segmentId: "segment-a",
  status: "completed",
  sendingSpeed: "medium",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  startedAt: new Date("2026-01-01T01:00:00.000Z"),
  completedAt: new Date("2026-01-01T02:00:00.000Z"),
  firstSendAt: new Date("2026-01-01T01:00:00.000Z"),
  lastSendAt: new Date("2026-01-01T02:00:00.000Z"),
  sentCount: 100,
  pendingCount: 0,
  failedCount: 0,
  autoRetryCount: 0,
  totalOpensCount: 10,
  uniqueOpensCount: 8,
  totalClicksCount: 4,
  uniqueClicksCount: 3,
  unsubscribesCount: 0,
  complaintsCount: 0,
  parentCampaignId: null,
  followUpCampaignId: null,
  followUpScheduledAt: null,
  urgentMode: true,
  scheduledAt: new Date("2026-01-01T01:00:00.000Z"),
};

const copied = {
  ...original,
  id: "campaign-copy",
  status: "draft",
};

const campaignValues = vi.fn();
const relationValues = vi.fn();
const txInsert = vi.fn();
const transaction = vi.fn();
const select = vi.fn();

vi.mock("../server/db", () => ({
  db: {
    select: (...args: unknown[]) => select(...args),
    transaction: (...args: unknown[]) => transaction(...args),
  },
  pool: { query: vi.fn() },
}));

vi.mock("../server/queues", () => ({ campaignQueue: {} }));
vi.mock("../server/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../server/repositories/campaigns-list-cache", () => ({
  publishCampaignsListInvalidation: vi.fn(),
}));

import { copyCampaign } from "../server/repositories/campaign-repository";

beforeEach(() => {
  vi.clearAllMocks();
  select
    .mockReturnValueOnce({
      from: () => ({ where: async () => [original] }),
    })
    .mockReturnValueOnce({
      from: () => ({
        where: () => ({
          orderBy: async () => [
            { campaignId: original.id, segmentId: "segment-a", position: 0 },
            { campaignId: original.id, segmentId: "segment-b", position: 1 },
            { campaignId: original.id, segmentId: "segment-c", position: 2 },
          ],
        }),
      }),
    });
  campaignValues.mockReturnValue({ returning: async () => [copied] });
  relationValues.mockResolvedValue(undefined);
  txInsert
    .mockReturnValueOnce({ values: campaignValues })
    .mockReturnValueOnce({ values: relationValues });
  transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback({ insert: txInsert }));
});

describe("copyCampaign", () => {
  it("atomically copies every canonical segment in its original order", async () => {
    const result = await copyCampaign(original.id);

    expect(result?.id).toBe(copied.id);
    expect(transaction).toHaveBeenCalledTimes(1);
    const insertedCampaign = campaignValues.mock.calls[0][0];
    expect(insertedCampaign).toEqual(expect.objectContaining({
      segmentId: "segment-a",
      status: "draft",
    }));
    expect(insertedCampaign).not.toHaveProperty("urgentMode");
    expect(relationValues).toHaveBeenCalledWith([
      { campaignId: copied.id, segmentId: "segment-a", position: 0 },
      { campaignId: copied.id, segmentId: "segment-b", position: 1 },
      { campaignId: copied.id, segmentId: "segment-c", position: 2 },
    ]);
  });
});