import { fromParisTime, toParisDate } from "./paris-time";

export interface CalendarCampaignRecord {
  id: string;
  name: string;
  mtaId: string | null;
  mtaName: string | null;
  status: string;
  scheduledAt: string | null;
  firstSendAt: string | null;
  lastSendAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export const CALENDAR_DAY_MS = 86_400_000;
export const TIMELINE_PIXELS_PER_MINUTE = 0.8;
const DEFAULT_EVENT_MINUTES = 45;

export function addCalendarDays(date: Date, amount: number): Date {
  return new Date(date.getTime() + amount * CALENDAR_DAY_MS);
}

export function parisCivilDate(date: Date): Date {
  const parts = toParisDate(date);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12));
}

export function calendarDayKey(date: Date): string {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export function startOfParisCalendarDay(date: Date): Date {
  return fromParisTime(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
  );
}

export function campaignCalendarStart(campaign: CalendarCampaignRecord): string | null {
  if (campaign.status === "scheduled") return campaign.scheduledAt;
  return campaign.firstSendAt ?? campaign.startedAt ?? campaign.scheduledAt;
}

export function campaignCalendarEnd(campaign: CalendarCampaignRecord): string | null {
  return campaign.lastSendAt
    ?? campaign.completedAt
    ?? campaignCalendarStart(campaign);
}

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function campaignCalendarInterval(
  campaign: CalendarCampaignRecord,
  openEndMs = Date.now(),
): { startMs: number; endMs: number } | null {
  const startMs = timestamp(campaignCalendarStart(campaign));
  if (startMs === null) return null;
  if (campaign.status === "sending") {
    return {
      startMs,
      endMs: Math.max(startMs + 1, openEndMs),
    };
  }
  const rawEndMs = timestamp(campaignCalendarEnd(campaign)) ?? startMs;
  return {
    startMs,
    endMs: rawEndMs > startMs
      ? rawEndMs
      : startMs + DEFAULT_EVENT_MINUTES * 60_000,
  };
}

export function campaignOverlapsParisDay(
  campaign: CalendarCampaignRecord,
  day: Date,
  openEndMs?: number,
): boolean {
  const interval = campaignCalendarInterval(campaign, openEndMs);
  if (!interval) return false;
  const dayStartMs = startOfParisCalendarDay(day).getTime();
  const dayEndMs = startOfParisCalendarDay(addCalendarDays(day, 1)).getTime();
  return interval.startMs < dayEndMs && interval.endMs > dayStartMs;
}

export function campaignTimelinePlacement(
  campaign: CalendarCampaignRecord,
  day: Date,
  openEndMs?: number,
): { top: number; height: number } | null {
  const interval = campaignCalendarInterval(campaign, openEndMs);
  if (!interval) return null;
  const dayStartMs = startOfParisCalendarDay(day).getTime();
  const dayEndMs = startOfParisCalendarDay(addCalendarDays(day, 1)).getTime();
  const clippedStartMs = Math.max(interval.startMs, dayStartMs);
  const clippedEndMs = Math.min(interval.endMs, dayEndMs);
  if (clippedStartMs >= clippedEndMs) return null;

  const startParts = toParisDate(new Date(clippedStartMs));
  const endParts = toParisDate(new Date(clippedEndMs));
  const startMinute = clippedStartMs === dayStartMs
    ? 0
    : startParts.hours * 60 + startParts.minutes;
  const civilEndMinute = clippedEndMs === dayEndMs
    ? 24 * 60
    : endParts.hours * 60 + endParts.minutes;
  const elapsedMinutes = (clippedEndMs - clippedStartMs) / 60_000;
  const durationMinutes = Math.min(
    24 * 60 - startMinute,
    Math.max(DEFAULT_EVENT_MINUTES, civilEndMinute - startMinute, elapsedMinutes),
  );

  return {
    top: startMinute * TIMELINE_PIXELS_PER_MINUTE,
    height: Math.max(34, durationMinutes * TIMELINE_PIXELS_PER_MINUTE),
  };
}

export function layoutCampaignTimeline(
  campaigns: CalendarCampaignRecord[],
  day: Date,
  openEndMs?: number,
): Array<{
  campaign: CalendarCampaignRecord;
  top: number;
  height: number;
  lane: number;
  laneCount: number;
}> {
  const positioned = campaigns
    .map((campaign) => {
      const placement = campaignTimelinePlacement(campaign, day, openEndMs);
      return placement ? { campaign, ...placement } : null;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => a.top - b.top || b.height - a.height);
  const laneEnds: number[] = [];
  const withLanes = positioned.map((item) => {
    let lane = laneEnds.findIndex((end) => end <= item.top);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = item.top + item.height;
    return { ...item, lane };
  });
  const laneCount = Math.max(1, laneEnds.length);
  return withLanes.map((item) => ({ ...item, laneCount }));
}