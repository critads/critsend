import crypto from "node:crypto";
import { isIP } from "node:net";
import { safeTrackingQuery } from "./tracking-pool";

/**
 * The continue link is an impression-level affordance, not a property of an
 * unsubscribe token.  Keep only a SHA-256 digest of the canonical client IP
 * in the claim table so the table never becomes a plaintext IP store.
 */
// This is a presentation deadline for the whole operation, including pool
// checkout. safeTrackingQuery has its own longer connection/query safety net
// underneath, so a late result is still observed and cleaned up there.
const CONTINUE_CLAIM_DEADLINE_MS = 500;
const CONTINUE_CLAIM_QUERY_TIMEOUT_MS = 1_000;

function parseIpv4Groups(value: string): number[] | null {
  if (isIP(value) !== 4) return null;
  const groups = value.split(".").map(Number);
  return groups.length === 4 && groups.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? groups
    : null;
}

function parseIpv6Part(value: string): number[] | null {
  if (!value) return [];
  if (value.includes(".")) {
    const ipv4 = parseIpv4Groups(value);
    return ipv4 ? [(ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]] : null;
  }
  if (!/^[0-9a-f]{1,4}$/i.test(value)) return null;
  return [parseInt(value, 16)];
}

/**
 * Return one stable representation for equivalent IPv4 and IPv6 spellings.
 * IPv6 is deliberately expanded to eight lowercase groups; this is a
 * canonical representation for hashing, even when it is not the shortest
 * human-readable spelling.
 */
export function normalizeTrackingIp(rawIp: string | null | undefined): string | null {
  if (typeof rawIp !== "string") return null;
  const value = rawIp.trim();
  const family = isIP(value);
  if (family === 4) {
    const groups = parseIpv4Groups(value);
    return groups ? groups.join(".") : null;
  }
  if (family !== 6) return null;

  const compressed = value.indexOf("::");
  let groups: number[];
  if (compressed >= 0) {
    // More than one compression marker is never a valid IPv6 address.
    if (value.indexOf("::", compressed + 2) >= 0) return null;
    const left = value.slice(0, compressed);
    const right = value.slice(compressed + 2);
    const parsedLeft = left ? left.split(":").map(parseIpv6Part).flat() : [];
    const parsedRight = right ? right.split(":").map(parseIpv6Part).flat() : [];
    if (parsedLeft.some((part) => part === null) || parsedRight.some((part) => part === null)) return null;
    const missingGroups = 8 - parsedLeft.length - parsedRight.length;
    if (missingGroups < 1) return null;
    groups = [...(parsedLeft as number[]), ...Array(missingGroups).fill(0), ...(parsedRight as number[])];
    if (groups.length !== 8) return null;
  } else {
    const parsed = value.split(":").map(parseIpv6Part);
    if (parsed.some((part) => part === null)) return null;
    groups = parsed.flat() as number[];
    if (groups.length !== 8) return null;
  }

  // Express may expose an IPv4 client as an IPv4-mapped IPv6 address.  Treat
  // it as the same client as the corresponding plain IPv4 spelling.
  if (
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 &&
    groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff
  ) {
    return [
      groups[6] >> 8,
      groups[6] & 0xff,
      groups[7] >> 8,
      groups[7] & 0xff,
    ].join(".");
  }

  return groups.map((part) => part.toString(16).padStart(4, "0")).join(":");
}

export function hashTrackingIp(rawIp: string | null | undefined): string | null {
  const normalized = normalizeTrackingIp(rawIp);
  if (!normalized) return null;
  return crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * Atomically claim the button for this IP.  An empty RETURNING result means
 * another request (possibly on another web process) won the race.
 *
 * Errors intentionally propagate: the HTML route catches them and hides only
 * the presentation button while continuing unsubscribe event processing.
 */
export async function claimUnsubscribeContinueForIp(rawIp: string | null | undefined): Promise<boolean> {
  const ipHash = hashTrackingIp(rawIp);
  if (!ipHash) return false;

  const queryPromise = safeTrackingQuery<{ ip_hash: string }>(
    `INSERT INTO unsubscribe_continue_claims (ip_hash)
       VALUES ($1)
       ON CONFLICT (ip_hash) DO NOTHING
       RETURNING ip_hash`,
    [ipHash],
    CONTINUE_CLAIM_QUERY_TIMEOUT_MS,
  );

  // Promise.race attaches rejection handlers to queryPromise immediately.
  // Thus a late checkout/query failure remains observed (and
  // safeTrackingQuery still owns connection destruction/release), while the
  // route never waits beyond this presentation deadline.
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), CONTINUE_CLAIM_DEADLINE_MS);
  });
  try {
    const result = await Promise.race([queryPromise, deadline]);
    return result !== null && result.rows.length > 0;
  } finally {
    if (timer) clearTimeout(timer);
  }
}