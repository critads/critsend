import { describe, expect, it } from "vitest";
import { getCampaignListSegmentIds } from "../client/src/lib/campaign-list-segments";

describe("campaign list segment associations", () => {
  it("returns every canonical segment in order", () => {
    expect(getCampaignListSegmentIds({
      segmentIds: ["segment-a", "segment-b", "segment-c"],
      segmentId: "segment-a",
    })).toEqual(["segment-a", "segment-b", "segment-c"]);
  });

  it("falls back to the legacy segment for older payloads", () => {
    expect(getCampaignListSegmentIds({
      segmentId: "legacy-segment",
    })).toEqual(["legacy-segment"]);
  });

  it("deduplicates malformed association payloads", () => {
    expect(getCampaignListSegmentIds({
      segmentIds: ["segment-a", "segment-a", "segment-b"],
      segmentId: "segment-a",
    })).toEqual(["segment-a", "segment-b"]);
  });

  it("returns no segment for all-subscriber campaigns", () => {
    expect(getCampaignListSegmentIds({
      segmentIds: [],
      segmentId: null,
    })).toEqual([]);
  });
});