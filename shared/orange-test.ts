// Orange Test — shared contract between the server (job runner, IMAP reader,
// routes) and the /mtas page. A test sends the raw Plain Test to the Orange
// mailbox, then the server reads that mailbox back and turns the
// `X-me-spamlevel` header Orange stamps on every delivered message into a
// deliverability verdict for the MTA.

export const ORANGE_TEST_VERDICTS = ["GOOD", "SPAM", "BLOCKED", "UNKNOWN", "NOT_RECEIVED"] as const;
export type OrangeTestVerdict = (typeof ORANGE_TEST_VERDICTS)[number];

/**
 * Lifecycle of one test row:
 *   sending      → the Plain Test is being handed to the MTA
 *   waiting      → the MTA accepted it; the mailbox is polled until the
 *                  message shows up or the listening window closes
 *   done         → found in the mailbox, verdict derived from the header
 *   failed       → the MTA refused the message (SMTP error, see sendError)
 *   not_received → listening window closed without the message (verdict NOT_RECEIVED)
 */
export const ORANGE_TEST_STATUSES = ["sending", "waiting", "done", "failed", "not_received"] as const;
export type OrangeTestStatus = (typeof ORANGE_TEST_STATUSES)[number];

export const ORANGE_TEST_PENDING_STATUSES: readonly OrangeTestStatus[] = ["sending", "waiting"];

export function isOrangeTestPending(status: OrangeTestStatus): boolean {
  return ORANGE_TEST_PENDING_STATUSES.includes(status);
}

/** Header Orange writes on delivered mail; case-insensitive on the wire. */
export const ORANGE_SPAM_LEVEL_HEADER = "x-me-spamlevel";

/** Reference prefix used in the Message-ID and the `Ref:` body line. */
export const ORANGE_TEST_REFERENCE_PREFIX = "OT-";

/**
 * Header value → verdict. Values agreed with the operator: `not-spam` is
 * GOOD, `low` is SPAM (deliverability problem), `med` is BLOCKED. Anything
 * more severe than `med` (Orange also emits `high` / `very-high`) is treated
 * as BLOCKED too; an absent header or a value never seen before is UNKNOWN
 * and the raw value is kept for the operator.
 */
export function mapSpamLevelToVerdict(raw: string | null | undefined): {
  verdict: OrangeTestVerdict;
  normalized: string | null;
} {
  if (raw === null || raw === undefined) return { verdict: "UNKNOWN", normalized: null };
  const normalized = raw.trim().replace(/^["']|["']$/g, "").toLowerCase();
  if (normalized === "") return { verdict: "UNKNOWN", normalized: null };
  switch (normalized) {
    case "not-spam":
    case "not_spam":
    case "notspam":
      return { verdict: "GOOD", normalized };
    case "low":
      return { verdict: "SPAM", normalized };
    case "med":
    case "medium":
    case "high":
    case "very-high":
    case "very_high":
    case "veryhigh":
      return { verdict: "BLOCKED", normalized };
    default:
      return { verdict: "UNKNOWN", normalized };
  }
}

export interface OrangeTestSendFailure {
  stage?: string;
  errorCode?: string;
  errorMessage?: string;
  smtpCode?: number;
  suggestions?: string[];
  connectionTimeMs?: number;
}

/** One test as exposed by the API (dates are ISO strings). */
export interface OrangeTestView {
  id: string;
  mtaId: string;
  reference: string;
  messageId: string;
  status: OrangeTestStatus;
  verdict: OrangeTestVerdict | null;
  /** Raw `X-me-spamlevel` value as found in the message (null when absent). */
  spamLevelRaw: string | null;
  foundIn: "inbox" | "junk" | null;
  foundFolder: string | null;
  matchedBy: "message-id" | "text" | "fallback" | null;
  /** Diagnostic headers kept verbatim (X-me-*, Authentication-Results, …). */
  rawHeaders: Record<string, string> | null;
  mailbox: string;
  fromEmail: string;
  requestedBy: string | null;
  sendError: OrangeTestSendFailure | null;
  sendNote: string | null;
  lastCheckError: string | null;
  lastCheckAt: string | null;
  pollCount: number;
  createdAt: string;
  sentAt: string | null;
  nextPollAt: string | null;
  deadlineAt: string | null;
  receivedAt: string | null;
  finishedAt: string | null;
  /** receivedAt − sentAt, when both are known. */
  deliveryDelayMs: number | null;
}

/**
 * What the MTA card shows. `latest` is the most recently SENT test whatever
 * its state; `latestVerdict` is the most recently sent test that already
 * carries a verdict. Both are ordered by send time, never by the time the
 * verdict was obtained: a slow test from the 28th that lands after a test
 * from the 29th never overrides the 29th.
 */
export interface OrangeTestControlValue {
  latest: OrangeTestView | null;
  latestVerdict: OrangeTestView | null;
}

export interface OrangeTestPublicConfig {
  enabled: boolean;
  /** Human-readable reason when disabled (never contains credentials). */
  disabledReason: string | null;
  mailbox: string;
  maxWaitHours: number;
  fastPollSeconds: number;
  fastPhaseMinutes: number;
  slowPollMinutes: number;
}
