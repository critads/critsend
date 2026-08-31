import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  completeJob,
  updateCampaignStatusAtomic,
  enqueueCampaignJobWithRetry,
} = vi.hoisted(() => ({
  completeJob: vi.fn(),
  updateCampaignStatusAtomic: vi.fn(),
  enqueueCampaignJobWithRetry: vi.fn(),
}));

vi.mock("../server/storage", () => ({
  storage: {
    completeJob,
    updateCampaignStatusAtomic,
    enqueueCampaignJobWithRetry,
  },
}));

vi.mock("../server/logger", () => ({
  logger: {
    error: vi.fn(),
  },
}));

import {
  prioritizeFinalizationDurabilityError,
  stopAutomaticReplayForFinalizationFailure,
} from "../server/services/campaign-job-error-policy";

const job = {
  id: "job-1",
  campaignId: "campaign-1",
  status: "processing",
} as any;

beforeEach(() => {
  completeJob.mockReset().mockResolvedValue(undefined);
  updateCampaignStatusAtomic.mockReset().mockResolvedValue(true);
  enqueueCampaignJobWithRetry.mockReset().mockResolvedValue(undefined);
});

describe("campaign worker finalization error policy", () => {
  it("closes a durability-failed job without scheduling a replay", async () => {
    const error = Object.assign(new Error("two rows unresolved"), {
      senderFinalizationIncomplete: true,
    });

    await expect(
      stopAutomaticReplayForFinalizationFailure(job, error),
    ).resolves.toBe(true);

    expect(completeJob).toHaveBeenCalledWith(
      job.id,
      "failed",
      expect.stringContaining("two rows unresolved"),
    );
    expect(updateCampaignStatusAtomic).toHaveBeenCalledWith(
      job.campaignId,
      "failed",
      "sending",
    );
    expect(enqueueCampaignJobWithRetry).not.toHaveBeenCalled();
  });

  it("does not intercept ordinary failures", async () => {
    await expect(
      stopAutomaticReplayForFinalizationFailure(job, new Error("ordinary")),
    ).resolves.toBe(false);

    expect(completeJob).not.toHaveBeenCalled();
    expect(updateCampaignStatusAtomic).not.toHaveBeenCalled();
    expect(enqueueCampaignJobWithRetry).not.toHaveBeenCalled();
  });

  it("still blocks replay when terminal bookkeeping itself fails", async () => {
    completeJob.mockRejectedValue(new Error("jobs table unavailable"));
    updateCampaignStatusAtomic.mockRejectedValue(new Error("campaign update unavailable"));

    await expect(
      stopAutomaticReplayForFinalizationFailure(
        job,
        Object.assign(new Error("unresolved"), {
          senderFinalizationIncomplete: true,
        }),
      ),
    ).resolves.toBe(true);

    expect(enqueueCampaignJobWithRetry).not.toHaveBeenCalled();
  });

  it("prioritizes an emergency durability failure over a transient primary error", async () => {
    const transientPrimary = Object.assign(new Error("connection timeout"), {
      code: "ETIMEDOUT",
    });
    const emergencyDurabilityFailure = Object.assign(
      new Error("buffer rows unresolved"),
      { senderFinalizationIncomplete: true },
    );

    const propagated = prioritizeFinalizationDurabilityError(
      transientPrimary,
      emergencyDurabilityFailure,
    );
    await expect(
      stopAutomaticReplayForFinalizationFailure(job, propagated),
    ).resolves.toBe(true);

    expect(completeJob).toHaveBeenCalledWith(
      job.id,
      "failed",
      expect.stringContaining("buffer rows unresolved"),
    );
    expect(enqueueCampaignJobWithRetry).not.toHaveBeenCalled();
  });
});