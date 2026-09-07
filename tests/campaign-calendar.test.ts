import { describe, expect, it } from "vitest";
import {
  campaignCalendarColumnId,
  campaignScheduledForParisDay,
  campaignTimelinePlacement,
  layoutCampaignTimeline,
  UNIDENTIFIED_MTA_COLUMN_ID,
  type CalendarCampaignRecord,
} from "../client/src/lib/campaign-calendar";

function campaign(overrides: Partial<CalendarCampaignRecord> = {}): CalendarCampaignRecord {
  return {
    id: "campaign-1",
    name: "Campaign",
    mtaId: "mta-1",
    mtaName: "MTA 1",
    status: "scheduled",
    scheduledAt: "2026-09-04T08:00:00.000Z",
    ...overrides,
  };
}

describe("daily scheduled campaign calendar", () => {
  const parisDay = new Date(Date.UTC(2026, 8, 4, 12));

  it("includes scheduled_at at midnight and excludes the next midnight", () => {
    expect(campaignScheduledForParisDay(
      campaign({ scheduledAt: "2026-09-03T22:00:00.000Z" }),
      parisDay,
    )).toBe(true);
    expect(campaignScheduledForParisDay(
      campaign({ scheduledAt: "2026-09-04T22:00:00.000Z" }),
      parisDay,
    )).toBe(false);
  });

  it("never includes drafts or campaigns without scheduled_at", () => {
    expect(campaignScheduledForParisDay(
      campaign({ status: "draft" }),
      parisDay,
    )).toBe(false);
    expect(campaignScheduledForParisDay(
      campaign({ scheduledAt: null }),
      parisDay,
    )).toBe(false);
  });

  it.each([
    "scheduled",
    "sending",
    "paused",
    "completed",
    "failed",
    "cancelled",
  ])(
    "includes an in-day %s campaign based only on scheduled_at",
    (status) => {
      expect(campaignScheduledForParisDay(
        campaign({ status, scheduledAt: "2026-09-04T08:00:00.000Z" }),
        parisDay,
      )).toBe(true);
    },
  );

  it("never exposes synthetic automation tracking campaigns", () => {
    expect(campaignScheduledForParisDay(
      campaign({ status: "automation_internal" }),
      parisDay,
    )).toBe(false);
  });

  it.each(["sending", "paused", "completed", "failed", "cancelled"])(
    "excludes an out-of-day %s campaign regardless of status",
    (status) => {
      expect(campaignScheduledForParisDay(
        campaign({ status, scheduledAt: "2026-09-03T21:59:59.999Z" }),
        parisDay,
      )).toBe(false);
    },
  );

  it("places each campaign at its scheduled Paris wall-clock time", () => {
    expect(campaignTimelinePlacement(campaign(), parisDay)).toEqual({
      top: 480,
      height: 36,
    });
  });

  it("places simultaneous scheduled campaigns in separate visible lanes", () => {
    const first = campaign({ id: "first" });
    const second = campaign({ id: "second" });
    expect(
      layoutCampaignTimeline([first, second], parisDay)
        .map(({ lane, laneCount }) => ({ lane, laneCount })),
    ).toEqual([
      { lane: 0, laneCount: 2 },
      { lane: 1, laneCount: 2 },
    ]);
  });

  it("groups missing and unknown MTA references in the explicit fallback column", () => {
    const knownMtaIds = new Set(["mta-1"]);
    expect(campaignCalendarColumnId(campaign(), knownMtaIds)).toBe("mta-1");
    expect(campaignCalendarColumnId(
      campaign({ mtaId: null }),
      knownMtaIds,
    )).toBe(UNIDENTIFIED_MTA_COLUMN_ID);
    expect(campaignCalendarColumnId(
      campaign({ mtaId: "deleted-mta" }),
      knownMtaIds,
    )).toBe(UNIDENTIFIED_MTA_COLUMN_ID);
  });
});