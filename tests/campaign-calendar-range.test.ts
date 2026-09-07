import { describe, expect, it } from "vitest";
import { parseCampaignCalendarRange } from "../server/services/campaign-calendar";

describe("daily campaign calendar API range", () => {
  it("accepts one normal Paris civil day", () => {
    expect(parseCampaignCalendarRange(
      "2026-09-03T22:00:00.000Z",
      "2026-09-04T22:00:00.000Z",
    )).toEqual({
      ok: true,
      from: new Date("2026-09-03T22:00:00.000Z"),
      to: new Date("2026-09-04T22:00:00.000Z"),
    });
  });

  it.each([
    ["spring DST day", "2026-03-28T23:00:00.000Z", "2026-03-29T22:00:00.000Z", 23],
    ["autumn DST day", "2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z", 25],
  ])("accepts the %s as a %d-hour UTC interval", (_label, from, to, hours) => {
    const result = parseCampaignCalendarRange(from, to);
    expect(result.ok).toBe(true);
    expect(Date.parse(to) - Date.parse(from)).toBe(hours * 60 * 60 * 1000);
  });

  it.each([
    ["September 1 2026", "2026-09-01T22:00:00.000Z"],
    ["2026-09-01", "2026-09-01T22:00:00.000Z"],
    ["2026-09-04T22:00:00.000Z", "2026-09-03T22:00:00.000Z"],
    ["2026-02-30T23:00:00.000Z", "2026-03-03T23:00:00.000Z"],
  ])("rejects invalid or unordered bounds", (from, to) => {
    expect(parseCampaignCalendarRange(from, to)).toEqual({
      ok: false,
      error: "Valid from/to ISO date bounds are required",
    });
  });

  it.each([
    ["2026-09-01T22:00:00.000Z", "2026-09-03T22:00:00.000Z"],
    ["2026-09-01T22:30:00.000Z", "2026-09-02T22:30:00.000Z"],
    ["2026-09-01T22:00:00.001Z", "2026-09-02T22:00:00.001Z"],
  ])("rejects a range that is not exactly one Paris civil day", (from, to) => {
    expect(parseCampaignCalendarRange(from, to)).toEqual({
      ok: false,
      error: "Calendar range must be exactly one Paris civil day",
    });
  });
});