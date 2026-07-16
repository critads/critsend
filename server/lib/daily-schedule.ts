/**
 * Milliseconds until the next occurrence of `hour`:00:00 in the given IANA
 * timezone. DST-safe: the offset is derived from an Intl.DateTimeFormat
 * round-trip at "now", so a timer armed with this value fires at the wall
 * clock hour even across the Europe/Paris summer/winter switches (worst
 * case the first post-switch fire drifts by the DST delta once, then the
 * chain re-arms on the correct wall clock).
 *
 * Shared by the daily 01:00 Paris maintenance job (server/workers.ts) and
 * the bot-opener DEL marker (server/services/bot-opener-marker.ts).
 */
export function msUntilNextHourInTz(hour: number, tz: string): number {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).filter(p => p.type !== "literal").map(p => [p.type, p.value])
  );
  const tzYear = +parts.year, tzMonth = +parts.month, tzDay = +parts.day;
  const tzHour = +parts.hour, tzMinute = +parts.minute, tzSecond = +parts.second;
  // Convert "now in tz" treated as UTC to derive tz offset vs real UTC.
  const tzNowAsUtcMs = Date.UTC(tzYear, tzMonth - 1, tzDay, tzHour, tzMinute, tzSecond);
  const offsetMs = tzNowAsUtcMs - (now.getTime() - (now.getTime() % 1000));
  // Target day: today if before target hour, else tomorrow
  let targetY = tzYear, targetM = tzMonth, targetD = tzDay;
  if (tzHour >= hour) {
    const tomorrow = new Date(Date.UTC(tzYear, tzMonth - 1, tzDay + 1));
    targetY = tomorrow.getUTCFullYear();
    targetM = tomorrow.getUTCMonth() + 1;
    targetD = tomorrow.getUTCDate();
  }
  const targetTzAsUtcMs = Date.UTC(targetY, targetM - 1, targetD, hour, 0, 0);
  const targetMs = targetTzAsUtcMs - offsetMs;
  return Math.max(targetMs - now.getTime(), 1000);
}
