import { describe, expect, it } from "vitest";
import {
  campaignCalendarStart,
  campaignOverlapsParisDay,
  campaignTimelinePlacement,
  layoutCampaignTimeline,
  type CalendarCampaignRecord,
} from "../client/src/lib/campaign-calendar";

function campaign(overrides: Partial<CalendarCampaignRecord> = {}): CalendarCampaignRecord {
  return {
    id: "campaign-1",
    name: "Campaign",
    mtaId: "mta-1",
    mtaName: "MTA 1",
    status: "completed",
    scheduledAt: null,
    firstSendAt: null,
    lastSendAt: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe("campaign calendar time placement", () => {
  it("uses the scheduled time for a scheduled campaign", () => {
    const item = campaign({
      status: "scheduled",
      scheduledAt: "2026-09-04T08:00:00.000Z",
      firstSendAt: "2026-09-04T07:00:00.000Z",
    });
    expect(campaignCalendarStart(item)).toBe("2026-09-04T08:00:00.000Z");
  });

  it("shows a campaign on both Paris days when it crosses midnight", () => {
    const item = campaign({
      firstSendAt: "2026-09-04T21:30:00.000Z",
      lastSendAt: "2026-09-04T22:30:00.000Z",
    });
    const friday = new Date(Date.UTC(2026, 8, 4, 12));
    const saturday = new Date(Date.UTC(2026, 8, 5, 12));
    expect(campaignOverlapsParisDay(item, friday)).toBe(true);
    expect(campaignOverlapsParisDay(item, saturday)).toBe(true);
  });

  it("positions spring-DST events by Paris wall-clock time", () => {
    const item = campaign({
      firstSendAt: "2026-03-28T23:30:00.000Z",
      lastSendAt: "2026-03-29T01:30:00.000Z",
    });
    const dstDay = new Date(Date.UTC(2026, 2, 29, 12));
    expect(campaignTimelinePlacement(item, dstDay)).toEqual({
      top: 24,
      height: 144,
    });
  });

  it("gives point-in-time scheduled events a visible minimum duration", () => {
    const item = campaign({
      status: "scheduled",
      scheduledAt: "2026-09-04T08:00:00.000Z",
    });
    const day = new Date(Date.UTC(2026, 8, 4, 12));
    expect(campaignTimelinePlacement(item, day)).toEqual({
      top: 480,
      height: 36,
    });
  });

  it("places overlapping campaigns in separate visible lanes", () => {
    const day = new Date(Date.UTC(2026, 8, 4, 12));
    const first = campaign({
      id: "first",
      firstSendAt: "2026-09-04T08:00:00.000Z",
      lastSendAt: "2026-09-04T09:00:00.000Z",
    });
    const second = campaign({
      id: "second",
      firstSendAt: "2026-09-04T08:30:00.000Z",
      lastSendAt: "2026-09-04T09:30:00.000Z",
    });
    const layout = layoutCampaignTimeline([first, second], day);
    expect(layout.map(({ lane, laneCount }) => ({ lane, laneCount }))).toEqual([
      { lane: 0, laneCount: 2 },
      { lane: 1, laneCount: 2 },
    ]);
  });

  it("keeps an ongoing campaign visible when it started before the viewed day", () => {
    const ongoing = campaign({
      status: "sending",
      firstSendAt: "2026-09-03T08:00:00.000Z",
      lastSendAt: "2026-09-03T09:00:00.000Z",
    });
    const day = new Date(Date.UTC(2026, 8, 4, 12));
    const asOf = new Date("2026-09-04T12:00:00.000Z").getTime();
    expect(campaignOverlapsParisDay(ongoing, day, asOf)).toBe(true);
    expect(campaignTimelinePlacement(ongoing, day, asOf)).toEqual({
      top: 0,
      height: 672,
    });
  });

  it("does not carry a paused campaign past its actual last send", () => {
    const paused = campaign({
      status: "paused",
      firstSendAt: "2026-09-03T08:00:00.000Z",
      lastSendAt: "2026-09-03T09:00:00.000Z",
    });
    const nextDay = new Date(Date.UTC(2026, 8, 4, 12));
    const asOf = new Date("2026-09-04T12:00:00.000Z").getTime();
    expect(campaignOverlapsParisDay(paused, nextDay, asOf)).toBe(false);
  });
});