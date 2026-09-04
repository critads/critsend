import { describe, expect, it } from "vitest";
import { parseCampaignCalendarRange } from "../server/services/campaign-calendar";

describe("campaign calendar API range", () => {
  it("accepts ISO instants with an explicit timezone", () => {
    const result = parseCampaignCalendarRange(
      "2026-09-01T00:00:00.000+02:00",
      "2026-09-08T00:00:00.000+02:00",
    );
    expect(result.ok).toBe(true);
  });

  it.each([
    ["September 1 2026", "2026-09-08T00:00:00.000Z"],
    ["2026-09-01", "2026-09-08T00:00:00.000Z"],
    ["2026-09-08T00:00:00.000Z", "2026-09-01T00:00:00.000Z"],
  ])("rejects invalid or unordered bounds", (from, to) => {
    expect(parseCampaignCalendarRange(from, to)).toEqual({
      ok: false,
      error: "Valid from/to ISO date bounds are required",
    });
  });

  it("rejects ranges longer than 32 days", () => {
    expect(parseCampaignCalendarRange(
      "2026-09-01T00:00:00.000Z",
      "2026-10-04T00:00:00.001Z",
    )).toEqual({
      ok: false,
      error: "Calendar range cannot exceed 32 days",
    });
  });
});