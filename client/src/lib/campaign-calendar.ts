import { fromParisTime, toParisDate } from "./paris-time";

export interface CalendarCampaignRecord {
  id: string;
  name: string;
  mtaId: string | null;
  mtaName: string | null;
  status: string;
  scheduledAt: string | null;
}

export const CALENDAR_DAY_MS = 86_400_000;
export const TIMELINE_PIXELS_PER_MINUTE = 0.8;
export const UNIDENTIFIED_MTA_COLUMN_ID = "__unidentified__";
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

export function campaignCalendarColumnId(
  campaign: Pick<CalendarCampaignRecord, "mtaId">,
  knownMtaIds: ReadonlySet<string>,
): string {
  return campaign.mtaId && knownMtaIds.has(campaign.mtaId)
    ? campaign.mtaId
    : UNIDENTIFIED_MTA_COLUMN_ID;
}

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function campaignScheduledForParisDay(
  campaign: CalendarCampaignRecord,
  day: Date,
): boolean {
  const scheduledMs = timestamp(campaign.scheduledAt);
  if (
    scheduledMs === null
    || campaign.status === "draft"
    || campaign.status === "automation_internal"
  ) {
    return false;
  }
  const dayStartMs = startOfParisCalendarDay(day).getTime();
  const dayEndMs = startOfParisCalendarDay(addCalendarDays(day, 1)).getTime();
  return scheduledMs >= dayStartMs && scheduledMs < dayEndMs;
}

export function campaignTimelinePlacement(
  campaign: CalendarCampaignRecord,
  day: Date,
): { top: number; height: number } | null {
  if (!campaignScheduledForParisDay(campaign, day)) return null;
  const scheduledMs = timestamp(campaign.scheduledAt);
  if (scheduledMs === null) return null;
  const parts = toParisDate(new Date(scheduledMs));
  const startMinute = parts.hours * 60 + parts.minutes;
  const durationMinutes = Math.min(DEFAULT_EVENT_MINUTES, 24 * 60 - startMinute);

  return {
    top: startMinute * TIMELINE_PIXELS_PER_MINUTE,
    height: Math.max(34, durationMinutes * TIMELINE_PIXELS_PER_MINUTE),
  };
}

export function layoutCampaignTimeline(
  campaigns: CalendarCampaignRecord[],
  day: Date,
): Array<{
  campaign: CalendarCampaignRecord;
  top: number;
  height: number;
  lane: number;
  laneCount: number;
}> {
  const positioned = campaigns
    .map((campaign) => {
      const placement = campaignTimelinePlacement(campaign, day);
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