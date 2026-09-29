import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../server/storage", () => ({ storage: {} }));
const loggerWarn = vi.fn();
vi.mock("../server/logger", () => ({
  logger: { warn: (...args: unknown[]) => loggerWarn(...args), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  BRAND_UNSUB_LIMIT,
  BRAND_UNSUB_WARN_THRESHOLD,
  BRAND_UNSUB_WINDOW_DAYS,
  brandUnsubscribeNotice,
  classifyBrandUnsubscribeCount,
  evaluateBrandUnsubscribeGuard,
  shouldEvaluateBrandGuardForPatch,
} from "../server/services/brand-unsubscribe-guard";

const findCampaignBrandAnchor = vi.fn();
const countBrandUnsubscribes = vi.fn();
const store = { findCampaignBrandAnchor, countBrandUnsubscribes };

beforeEach(() => {
  vi.clearAllMocks();
  findCampaignBrandAnchor.mockResolvedValue(null);
  countBrandUnsubscribes.mockResolvedValue(0);
});

describe("brand unsubscribe guard", () => {
  it("defaults to a 5-day Europe/Paris calendar window with unchanged thresholds", () => {
    expect(BRAND_UNSUB_WINDOW_DAYS).toBe(5);
    expect(BRAND_UNSUB_LIMIT).toBe(2_500);
    expect(BRAND_UNSUB_WARN_THRESHOLD).toBe(1_500);
  });

  it.each([
    [1_500, "ok"],
    [1_501, "warn"],
    [2_000, "warn"],
    [2_001, "warn"],
    [2_500, "warn"],
    [2_501, "exceeded"],
    [10_000, "exceeded"],
  ] as const)("classifies %s unsubscribers as %s (alert only, never blocked)", (count, expected) => {
    const status: string = classifyBrandUnsubscribeCount(count);
    expect(status).toBe(expected);
    expect(status).not.toBe("blocked");
  });

  it("uses the canonical historical brand resolved from the campaign name", async () => {
    findCampaignBrandAnchor.mockResolvedValue("#3086 Air France - old-code - mta");
    countBrandUnsubscribes.mockResolvedValue(2_634);

    const result = await evaluateBrandUnsubscribeGuard(
      "#4000 Air France Holiday Push - fresh-code - mta",
      store,
    );

    expect(findCampaignBrandAnchor).toHaveBeenCalledWith([
      "air\u001ffrance\u001fholiday\u001fpush",
      "air\u001ffrance\u001fholiday",
      "air\u001ffrance",
      "air",
    ]);
    expect(countBrandUnsubscribes).toHaveBeenCalledWith("air\u001ffrance", 5);
    expect(result).toEqual(expect.objectContaining({
      brand: "Air France",
      brandKey: "air\u001ffrance",
      count: 2_634,
      status: "exceeded",
      limit: 2_500,
      windowDays: 5,
    }));
  });

  it("returns an explicit no-brand decision without querying history", async () => {
    const result = await evaluateBrandUnsubscribeGuard("#123 Promo Aout - code - mta", store);

    expect(result).toEqual(expect.objectContaining({
      brand: null,
      brandKey: null,
      count: 0,
      status: "ok",
    }));
    expect(findCampaignBrandAnchor).not.toHaveBeenCalled();
    expect(countBrandUnsubscribes).not.toHaveBeenCalled();
  });

  it("still surfaces an unavailable check to the explicit check endpoint", async () => {
    findCampaignBrandAnchor.mockRejectedValue(new Error("database unavailable"));

    await expect(
      evaluateBrandUnsubscribeGuard("#4000 Air France - code - mta", store),
    ).rejects.toThrow("database unavailable");
    expect(countBrandUnsubscribes).not.toHaveBeenCalled();
  });

  describe("activation notice (alert only)", () => {
    it("returns the decision above the alert threshold and logs it, without any error code", async () => {
      findCampaignBrandAnchor.mockResolvedValue("#3086 Air France - old-code - mta");
      countBrandUnsubscribes.mockResolvedValue(2_501);

      const notice = await brandUnsubscribeNotice(
        "#4000 Air France - code - mta",
        { action: "resume", campaignId: "c-1" },
        store,
      );

      expect(notice).toEqual(expect.objectContaining({ status: "exceeded", count: 2_501, brand: "Air France" }));
      expect(notice).not.toHaveProperty("code");
      expect(notice).not.toHaveProperty("error");
      expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining("resume allowed while brand exceeds"));
    });

    it("returns the warning decision without logging an alert", async () => {
      countBrandUnsubscribes.mockResolvedValue(1_600);

      const notice = await brandUnsubscribeNotice("#4000 Air France - code - mta", { action: "send" }, store);

      expect(notice).toEqual(expect.objectContaining({ status: "warn", count: 1_600 }));
      expect(loggerWarn).not.toHaveBeenCalled();
    });

    it("returns null when the brand is fine or has no brand", async () => {
      countBrandUnsubscribes.mockResolvedValue(10);
      await expect(brandUnsubscribeNotice("#4000 Air France - code - mta", { action: "send" }, store)).resolves.toBeNull();
      await expect(brandUnsubscribeNotice("#123 Promo Aout - code - mta", { action: "send" }, store)).resolves.toBeNull();
    });

    it("never fails the action when the check is unavailable", async () => {
      findCampaignBrandAnchor.mockRejectedValue(new Error("database unavailable"));

      await expect(
        brandUnsubscribeNotice("#4000 Air France - code - mta", { action: "requeue", campaignId: "c-2" }, store),
      ).resolves.toBeNull();
      expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining("check unavailable during requeue"), expect.any(Error));
    });
  });

  it("rechecks a name change while a campaign is active or scheduled", () => {
    expect(shouldEvaluateBrandGuardForPatch(
      "sending",
      "sending",
      "#1 Allowed Brand - code - mta",
      "#1 Blocked Brand - code - mta",
    )).toBe(true);
    expect(shouldEvaluateBrandGuardForPatch(
      "scheduled",
      "scheduled",
      "#1 Allowed Brand - code - mta",
      "#1 Blocked Brand - code - mta",
    )).toBe(true);
    expect(shouldEvaluateBrandGuardForPatch(
      "draft",
      "draft",
      "#1 Allowed Brand - code - mta",
      "#1 Blocked Brand - code - mta",
    )).toBe(false);
    expect(shouldEvaluateBrandGuardForPatch(
      "sending",
      "paused",
      "#1 Allowed Brand - code - mta",
      "#1 Blocked Brand - code - mta",
    )).toBe(false);
  });
});