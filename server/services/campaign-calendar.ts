export const CAMPAIGN_CALENDAR_MAX_RANGE_MS = 32 * 24 * 60 * 60 * 1000;

const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export type CampaignCalendarRangeResult =
  | { ok: true; from: Date; to: Date }
  | { ok: false; error: string };

export function parseCampaignCalendarRange(
  fromValue: unknown,
  toValue: unknown,
): CampaignCalendarRangeResult {
  if (
    typeof fromValue !== "string"
    || typeof toValue !== "string"
    || !ISO_INSTANT_PATTERN.test(fromValue)
    || !ISO_INSTANT_PATTERN.test(toValue)
  ) {
    return { ok: false, error: "Valid from/to ISO date bounds are required" };
  }
  const from = new Date(fromValue);
  const to = new Date(toValue);
  if (
    !Number.isFinite(from.getTime())
    || !Number.isFinite(to.getTime())
    || from >= to
  ) {
    return { ok: false, error: "Valid from/to ISO date bounds are required" };
  }
  if (to.getTime() - from.getTime() > CAMPAIGN_CALENDAR_MAX_RANGE_MS) {
    return { ok: false, error: "Calendar range cannot exceed 32 days" };
  }
  return { ok: true, from, to };
}