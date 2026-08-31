import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  formatParisDateTime,
  fromParisTime,
  getParisCalendarRangeBounds,
  getParisDayBounds,
  toParisDate,
} from "../client/src/lib/paris-time";

describe("campaign Paris timezone helpers", () => {
  it("formats winter timestamps in CET", () => {
    expect(formatParisDateTime("2026-01-15T12:30:00.000Z")).toBe("15/01/2026 13:30");
  });

  it("formats summer timestamps in CEST", () => {
    expect(formatParisDateTime("2026-07-15T12:30:00.000Z")).toBe("15/07/2026 14:30");
  });

  it("returns a stable placeholder for missing or invalid timestamps", () => {
    expect(formatParisDateTime(null)).toBe("—");
    expect(formatParisDateTime("not-a-date")).toBe("—");
  });

  it("round-trips Paris civil time independently of the host timezone", () => {
    const instant = fromParisTime(2026, 8, 31, 13, 46);
    expect(instant.toISOString()).toBe("2026-08-31T11:46:00.000Z");
    expect(toParisDate(instant)).toEqual({
      year: 2026,
      month: 8,
      day: 31,
      hours: 13,
      minutes: 46,
    });
  });

  it("uses the Paris calendar date when the current instant crosses Paris midnight", () => {
    expect(getParisDayBounds(new Date("2026-08-31T22:30:00.000Z"))).toEqual({
      from: "2026-08-31T22:00:00.000Z",
      to: "2026-09-01T22:00:00.000Z",
    });
  });

  it("returns the previous Paris civil day for yesterday", () => {
    expect(getParisDayBounds(new Date("2026-01-15T12:00:00.000Z"), -1)).toEqual({
      from: "2026-01-13T23:00:00.000Z",
      to: "2026-01-14T23:00:00.000Z",
    });
  });

  it("uses a 23-hour range on the spring DST transition day", () => {
    const bounds = getParisCalendarRangeBounds(
      new Date(2026, 2, 29, 12),
      new Date(2026, 2, 29, 12),
    );
    expect(bounds).toEqual({
      from: "2026-03-28T23:00:00.000Z",
      to: "2026-03-29T22:00:00.000Z",
    });
    expect(Date.parse(bounds.to) - Date.parse(bounds.from)).toBe(23 * 60 * 60 * 1000);
  });

  it("uses a 25-hour range on the autumn DST transition day", () => {
    const bounds = getParisCalendarRangeBounds(
      new Date(2026, 9, 25, 12),
      new Date(2026, 9, 25, 12),
    );
    expect(bounds).toEqual({
      from: "2026-10-24T22:00:00.000Z",
      to: "2026-10-25T23:00:00.000Z",
    });
    expect(Date.parse(bounds.to) - Date.parse(bounds.from)).toBe(25 * 60 * 60 * 1000);
  });

  it("keeps custom date ranges inclusive through Paris end-day", () => {
    expect(
      getParisCalendarRangeBounds(
        new Date(2026, 7, 30, 12),
        new Date(2026, 7, 31, 12),
      ),
    ).toEqual({
      from: "2026-08-29T22:00:00.000Z",
      to: "2026-08-31T22:00:00.000Z",
    });
  });

  it("uses the shared Paris formatter on campaign list and detail surfaces", () => {
    const campaignList = readFileSync("client/src/pages/campaigns.tsx", "utf8");
    const campaignDetail = readFileSync("client/src/pages/campaign-detail.tsx", "utf8");

    expect(campaignList).toContain("formatParisDateTime(campaign.scheduledAt)");
    expect(campaignList).toContain("formatParisDateTime(campaign.createdAt)");
    expect(campaignList).toContain("formatParisDateTime(child.scheduledAt)");
    expect(campaignDetail).toContain("formatParisDateTime(campaign.scheduledAt)");
    expect(campaignDetail).toContain("formatParisDateTime(linked.scheduledAt)");
    expect(campaignList).not.toMatch(/scheduledAt\)\.toLocaleString/);
    expect(campaignDetail).not.toMatch(/scheduledAt\)\.toLocaleString/);
  });
});