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
