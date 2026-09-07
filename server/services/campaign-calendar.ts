const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;
const PARIS_TIME_ZONE = "Europe/Paris";
const parisPartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: PARIS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function parisCivilParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
} {
  const parts = parisPartsFormatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number.parseInt(parts.find((part) => part.type === type)?.value ?? "0", 10);
  const hours = get("hour");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hours: hours === 24 ? 0 : hours,
    minutes: get("minute"),
    seconds: get("second"),
  };
}

export function parseStrictIsoInstant(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (!match) return null;

  const [
    ,
    yearValue,
    monthValue,
    dayValue,
    hourValue,
    minuteValue,
    secondValue = "0",
    millisecondValue = "0",
    zone,
    offsetSign,
    offsetHourValue = "0",
    offsetMinuteValue = "0",
  ] = match;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;

  const offsetHours = Number.parseInt(offsetHourValue, 10);
  const offsetMinutesPart = Number.parseInt(offsetMinuteValue, 10);
  if (offsetHours > 23 || offsetMinutesPart > 59) return null;
  const offsetMinutes = zone === "Z"
    ? 0
    : (offsetSign === "-" ? -1 : 1) * (
      offsetHours * 60 + offsetMinutesPart
    );
  const suppliedLocal = new Date(parsed.getTime() + offsetMinutes * 60_000);
  const expectedMilliseconds = Number.parseInt(
    millisecondValue.padEnd(3, "0"),
    10,
  );

  if (
    suppliedLocal.getUTCFullYear() !== Number.parseInt(yearValue, 10)
    || suppliedLocal.getUTCMonth() + 1 !== Number.parseInt(monthValue, 10)
    || suppliedLocal.getUTCDate() !== Number.parseInt(dayValue, 10)
    || suppliedLocal.getUTCHours() !== Number.parseInt(hourValue, 10)
    || suppliedLocal.getUTCMinutes() !== Number.parseInt(minuteValue, 10)
    || suppliedLocal.getUTCSeconds() !== Number.parseInt(secondValue, 10)
    || suppliedLocal.getUTCMilliseconds() !== expectedMilliseconds
  ) {
    return null;
  }

  return parsed;
}

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
  ) {
    return { ok: false, error: "Valid from/to ISO date bounds are required" };
  }
  const from = parseStrictIsoInstant(fromValue);
  const to = parseStrictIsoInstant(toValue);
  if (
    !from
    || !to
    || from >= to
  ) {
    return { ok: false, error: "Valid from/to ISO date bounds are required" };
  }
  const fromParis = parisCivilParts(from);
  const toParis = parisCivilParts(to);
  const startsAtMidnight =
    fromParis.hours === 0
    && fromParis.minutes === 0
    && fromParis.seconds === 0
    && from.getUTCMilliseconds() === 0;
  const endsAtMidnight =
    toParis.hours === 0
    && toParis.minutes === 0
    && toParis.seconds === 0
    && to.getUTCMilliseconds() === 0;
  const fromCivilDay = Date.UTC(fromParis.year, fromParis.month - 1, fromParis.day);
  const toCivilDay = Date.UTC(toParis.year, toParis.month - 1, toParis.day);
  if (
    !startsAtMidnight
    || !endsAtMidnight
    || toCivilDay - fromCivilDay !== 24 * 60 * 60 * 1000
  ) {
    return {
      ok: false,
      error: "Calendar range must be exactly one Paris civil day",
    };
  }
  return { ok: true, from, to };
}