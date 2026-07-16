/**
 * Unsubscribe cooling-off window (in days).
 *
 * When a contact unsubscribes, `subscribers.suppressed_until` is set to
 * NOW() + UNSUBSCRIBE_COOLING_OFF_DAYS. Every audience-selection query
 * (segment compiler + subscriber repository) excludes contacts whose
 * suppressed_until is still in the future, so they receive no campaigns during
 * this window. Once it expires, the contact becomes eligible again.
 *
 * NOTE: the duration is baked in at WRITE time (not evaluated at read time),
 * so changing this constant only affects unsubscribes recorded AFTER the
 * change ships. To apply a new window to already-suppressed contacts, update
 * their `suppressed_until` directly in the database.
 */
export const UNSUBSCRIBE_COOLING_OFF_DAYS = 21;

/**
 * Unsubscribe-source IP blocklist.
 *
 * Some automated systems (security scanners, corporate gateways) mass-fire
 * the unsubscribe link from a single IP, generating thousands of unsubscribes
 * with no human intent (observed in prod: 185.187.30.19 → 3 397 subscribers).
 * Any unsubscribe event whose source IP is in this set permanently excludes
 * the subscriber from every segment/audience: the tracking-buffer side-effect
 * adds the `BCK` tag (hard exclusion used by all segment/audience queries)
 * plus a marker tag `unsub-ip-<ip>` so those subscribers stay identifiable
 * and the action stays reversible.
 *
 * NOTE: bounce-webhook/FBL unsubscribes carry no source IP, so this check
 * only applies to link/one-click unsubscribes flowing through the tracking
 * buffer. The underlying GET-mutates flaw in /u/:token remains (deferred).
 *
 * CAUTION: the blocklist applies to BOTH GET and the RFC 8058 POST one-click
 * path. Never add Google/Apple/Microsoft mail-provider IP ranges here —
 * legitimate Gmail/Apple one-click unsubscribes POST from provider servers
 * and would be permanently BCK-tagged. Only list IPs whose unsubscribes are
 * proven spurious (like 185.187.30.19).
 *
 * Extend without a code change via the env var `UNSUBSCRIBE_IP_BLOCKLIST`
 * (comma-separated IPs), merged with the defaults below.
 */
const DEFAULT_BLOCKED_UNSUBSCRIBE_IPS = ["185.187.30.19"];

export const BLOCKED_UNSUBSCRIBE_IPS: ReadonlySet<string> = new Set([
  ...DEFAULT_BLOCKED_UNSUBSCRIBE_IPS,
  ...(process.env.UNSUBSCRIBE_IP_BLOCKLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
]);

/** Marker tag recording which blocked IP triggered the exclusion. */
export function blockedUnsubMarkerTag(ip: string): string {
  return `unsub-ip-${ip}`;
}

// ─── Bot-opener DEL marking (Task #216) ─────────────────────────────────────
//
// A robot IP (195.154.17.225, Scaleway range) generates tens of thousands of
// artificial opens. Subscribers whose engagement is essentially fabricated by
// that IP are auto-tagged with the `DEL` ref so the operator can exclude or
// segment them. Criterion over a rolling window (default 30 days): received
// at least BOT_OPENER_MIN_RECEIVED emails (campaign_sends status='sent') AND
// opened at least BOT_OPENER_OPEN_RATIO (default 70%) of them via one of the
// BOT_OPENER_IPS (campaign_stats type='open', distinct campaigns).
//
// All thresholds are env-overridable (same pattern as UNSUBSCRIBE_IP_BLOCKLIST):
//   BOT_OPENER_IP_LIST      comma-separated extra IPs, merged with defaults
//   BOT_OPENER_MIN_RECEIVED minimum emails received in the window (default 4)
//   BOT_OPENER_OPEN_RATIO   open ratio threshold, 0 < r <= 1 (default 0.7)
//   BOT_OPENER_WINDOW_DAYS  rolling window in days (default 30)
// Invalid env values fall back to the defaults (never crash the boot path).

const DEFAULT_BOT_OPENER_IPS = ["195.154.17.225"];

export const BOT_OPENER_IPS: readonly string[] = [
  ...new Set([
    ...DEFAULT_BOT_OPENER_IPS,
    ...(process.env.BOT_OPENER_IP_LIST || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ]),
];

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function envRatio(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) return fallback;
  return n;
}

/** Minimum emails received (status='sent') in the window to be evaluated. */
export const BOT_OPENER_MIN_RECEIVED = envInt("BOT_OPENER_MIN_RECEIVED", 4, 1, 1000);

/** Fraction of received emails that must have been opened via a bot IP. */
export const BOT_OPENER_OPEN_RATIO = envRatio("BOT_OPENER_OPEN_RATIO", 0.7);

/** Rolling analysis window, in days. */
export const BOT_OPENER_WINDOW_DAYS = envInt("BOT_OPENER_WINDOW_DAYS", 30, 1, 365);

/** Ref appended to matching subscribers. Never duplicated, never overwrites. */
export const BOT_OPENER_REF = "DEL";
