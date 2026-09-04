import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../server/storage", () => ({ storage: {} }));

import {
  brandUnsubscribeBlockPayload,
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
  it.each([
    [1_500, "ok"],
    [1_501, "warn"],
    [2_000, "warn"],
    [2_001, "blocked"],
  ] as const)("classifies %s unsubscribers as %s", (count, expected) => {
    expect(classifyBrandUnsubscribeCount(count, 1_500, 2_000)).toBe(expected);
  });

  it("uses the canonical historical brand resolved from the campaign name", async () => {
    findCampaignBrandAnchor.mockResolvedValue("#3086 Air France - old-code - mta");
    countBrandUnsubscribes.mockResolvedValue(2_134);

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
    expect(countBrandUnsubscribes).toHaveBeenCalledWith("air\u001ffrance", 10);
    expect(result).toEqual(expect.objectContaining({
      brand: "Air France",
      brandKey: "air\u001ffrance",
      count: 2_134,
      status: "blocked",
      limit: 2_000,
      windowDays: 10,
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

  it("propagates an unavailable check so callers fail closed", async () => {
    findCampaignBrandAnchor.mockRejectedValue(new Error("database unavailable"));

    await expect(
      evaluateBrandUnsubscribeGuard("#4000 Air France - code - mta", store),
    ).rejects.toThrow("database unavailable");
    expect(countBrandUnsubscribes).not.toHaveBeenCalled();
  });

  it("returns a structured blocking response for route clients", () => {
    const payload = brandUnsubscribeBlockPayload({
      brand: "Air France",
      brandKey: "air\u001ffrance",
      count: 2_001,
      warnThreshold: 1_500,
      limit: 2_000,
      windowDays: 10,
      status: "blocked",
    });

    expect(payload).toEqual(expect.objectContaining({
      code: "BRAND_UNSUB_LIMIT_EXCEEDED",
      brandGuard: expect.objectContaining({ status: "blocked", count: 2_001 }),
    }));
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