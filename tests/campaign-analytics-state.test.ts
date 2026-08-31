import { describe, expect, it } from "vitest";
import { getCampaignAnalyticsNotice } from "../client/src/lib/campaign-analytics-state";

describe("campaign analytics availability", () => {
  it("distinguishes pending-only work from zero engagement", () => {
    expect(getCampaignAnalyticsNotice({
      processed: 10,
      finalized: 0,
      sent: 0,
      failed: 0,
      pending: 10,
      deferred: 6,
    }, 0, 0)).toBe("awaiting-finalization");
  });

  it("shows zero engagement when sends have finalized", () => {
    expect(getCampaignAnalyticsNotice({
      processed: 10,
      finalized: 10,
      sent: 9,
      failed: 1,
      pending: 0,
      deferred: 0,
    }, 0, 0)).toBe("zero-engagement");
  });

  it("does not show an empty-state notice once engagement exists", () => {
    expect(getCampaignAnalyticsNotice({
      processed: 10,
      finalized: 10,
      sent: 10,
      failed: 0,
      pending: 0,
      deferred: 0,
    }, 1, 0)).toBeNull();
  });
});