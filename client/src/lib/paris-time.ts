export const PARIS_TIME_ZONE = "Europe/Paris";

export interface ParisDateParts {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
}

const parisPartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: PARIS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function toParisDate(date: Date): ParisDateParts {
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
  };
}

export function fromParisTime(
  year: number,
  month: number,
  day: number,
  hours = 0,
  minutes = 0,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hours, minutes);

  // Europe/Paris is UTC+1 in winter and UTC+2 in summer. Verifying the
  // resulting civil parts makes the conversion independent of browser TZ.
  for (const offsetMinutes of [60, 120]) {
    const candidate = new Date(utcGuess - offsetMinutes * 60_000);
    const check = toParisDate(candidate);
    if (
      check.year === year &&
      check.month === month &&
      check.day === day &&
      check.hours === hours &&
      check.minutes === minutes
    ) {
      return candidate;
    }
  }

  // A non-existent wall-clock time can occur during the spring DST jump.
  // Preserve the existing picker behavior by moving through it with CET.
  return new Date(utcGuess - 60 * 60_000);
}

export function formatParisDateTime(
  value: Date | string | number | null | undefined,
): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  const paris = toParisDate(date);
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${pad(paris.day)}/${pad(paris.month)}/${paris.year} ${pad(paris.hours)}:${pad(paris.minutes)}`;
}

function shiftCivilDate(
  parts: Pick<ParisDateParts, "year" | "month" | "day">,
  days: number,
): Pick<ParisDateParts, "year" | "month" | "day"> {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function parisMidnight(
  parts: Pick<ParisDateParts, "year" | "month" | "day">,
): Date {
  return fromParisTime(parts.year, parts.month, parts.day);
}

export function getParisDayBounds(
  instant: Date,
  dayOffset = 0,
): { from: string; to: string } {
  const paris = toParisDate(instant);
  const day = shiftCivilDate(paris, dayOffset);
  const nextDay = shiftCivilDate(day, 1);
  return {
    from: parisMidnight(day).toISOString(),
    to: parisMidnight(nextDay).toISOString(),
  };
}

export function getParisCalendarRangeBounds(
  from: Date,
  to: Date,
): { from: string; to: string } {
  // react-day-picker represents a selected calendar date as local civil
  // fields. Read those fields as labels, then resolve them in Europe/Paris.
  const fromDay = {
    year: from.getFullYear(),
    month: from.getMonth() + 1,
    day: from.getDate(),
  };
  const inclusiveToDay = {
    year: to.getFullYear(),
    month: to.getMonth() + 1,
    day: to.getDate(),
  };
  const exclusiveToDay = shiftCivilDate(inclusiveToDay, 1);

  return {
    from: parisMidnight(fromDay).toISOString(),
    to: parisMidnight(exclusiveToDay).toISOString(),
  };
}