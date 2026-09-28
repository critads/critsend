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
 *   not_received → a mailbox check made after the window closed came back
 *                  clean: the message never arrived (verdict NOT_RECEIVED)
 *   not_checked  → the window closed but the mailbox could not be read
 *                  after it (IMAP failure, feature disabled, checker down):
 *                  nothing is known about the delivery, so NO verdict
 */
export const ORANGE_TEST_STATUSES = ["sending", "waiting", "done", "failed", "not_received", "not_checked"] as const;
export type OrangeTestStatus = (typeof ORANGE_TEST_STATUSES)[number];

export const ORANGE_TEST_PENDING_STATUSES: readonly OrangeTestStatus[] = ["sending", "waiting"];

export function isOrangeTestPending(status: OrangeTestStatus): boolean {
  return ORANGE_TEST_PENDING_STATUSES.includes(status);
}

/**
 * Why a mailbox session failed, as classified by the IMAP reader. `UNKNOWN`
 * covers errors raised outside the reader (should not happen in practice).
 */
export const ORANGE_MAILBOX_ERROR_CLASSES = ["AUTH", "NETWORK", "TIMEOUT", "IMAP", "UNKNOWN"] as const;
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
 * carries a verdict (`failed` and `not_checked` tests carry none, so they
 * never hide the last real verdict). Both are ordered by send time, never by
 * the time the verdict was obtained: a slow test from the 28th that lands
 * after a test from the 29th never overrides the 29th.
 */
export interface OrangeTestControlValue {
  latest: OrangeTestView | null;
  latestVerdict: OrangeTestView | null;
}

/** GET /api/mtas/orange-test/summary */
export interface OrangeTestSummaryResponse {
  values: Record<string, OrangeTestControlValue>;
  mailbox: OrangeMailboxHealthView;
}

/**
 * Upper bound of MTA ids accepted by one `GET /api/mtas/orange-test/summary`
 * request; clients must split longer lists into several requests (the route
 * silently ignores ids past this bound).
 */
export const ORANGE_TEST_SUMMARY_MAX_IDS = 200;

export interface OrangeTestPublicConfig {
  enabled: boolean;
  /** Human-readable reason when disabled (never contains credentials). */
  disabledReason: string | null;
  mailbox: string;
  maxWaitHours: number;
  fastPollSeconds: number;
  fastPhaseMinutes: number;
  slowPollMinutes: number;
  /**
   * Age (days) beyond which a verdict no longer counts as a recent check when
   * an MTA is picked for a campaign (`ORANGE_TEST_STALE_VERDICT_DAYS`).
   */
  staleVerdictDays: number;
}

// ---------------------------------------------------------------------------
// Campaign launch check
// ---------------------------------------------------------------------------

/** Default for `ORANGE_TEST_STALE_VERDICT_DAYS` (server) and the wizard fallback. */
export const ORANGE_TEST_DEFAULT_STALE_VERDICT_DAYS = 7;

/** Verdicts that warn (never block) before a campaign is launched on the MTA. */
export const ORANGE_LAUNCH_WARNING_VERDICTS: readonly OrangeTestVerdict[] = ["SPAM", "BLOCKED", "NOT_RECEIVED"];

/**
 * What the campaign wizard shows next to an MTA, derived from its control
 * value. `recent` = a verdict within the stale window, `stale` = the last
 * verdict is older than the window, `none` = no test ever produced a verdict.
 * Only a recent SPAM / BLOCKED / NOT_RECEIVED verdict sets `warn`.
 */
export interface OrangeLaunchCheck {
  status: "recent" | "stale" | "none";
  /** Last known verdict, also kept when stale so the operator sees history. */
  verdict: OrangeTestVerdict | null;
  /** Send time of the test that produced `verdict` (age is counted from it). */
  verdictAt: string | null;
  ageMs: number | null;
  warn: boolean;
  /** A newer test is still in progress (sending / waiting) since this time. */
  pendingSince: string | null;
  /** The most recently sent test was refused by the MTA (not a verdict). */
  lastSendFailedAt: string | null;
  staleAfterDays: number;
}

/**
 * Pure: no clock access, `nowMs` is injected so the result is reproducible.
 * The verdict comes from `latestVerdict` (most recently SENT test carrying a
 * verdict) and never from a pending or failed newer test — the same rule as
 * the /mtas card. Ages are counted from the send time, not from the moment
 * the mailbox check landed, because a NOT_RECEIVED verdict is only reached
 * hours after the send while it still describes that send.
 */
export function assessOrangeControlValue(
  value: OrangeTestControlValue | null | undefined,
  opts: { nowMs: number; staleAfterDays?: number },
): OrangeLaunchCheck {
  const staleAfterDays =
    Number.isFinite(opts.staleAfterDays) && (opts.staleAfterDays as number) > 0
      ? (opts.staleAfterDays as number)
      : ORANGE_TEST_DEFAULT_STALE_VERDICT_DAYS;
  const latest = value?.latest ?? null;
  const latestVerdict = value?.latestVerdict ?? null;
  const pendingSince = latest && isOrangeTestPending(latest.status) ? latest.sentAt || latest.createdAt : null;
  const lastSendFailedAt = latest && latest.status === "failed" ? latest.createdAt : null;

  const base = { pendingSince, lastSendFailedAt, staleAfterDays };
  if (!latestVerdict || !latestVerdict.verdict) {
    return { ...base, status: "none", verdict: null, verdictAt: null, ageMs: null, warn: false };
  }
  const verdictAt = latestVerdict.sentAt || latestVerdict.createdAt;
  const sentMs = Date.parse(verdictAt);
  if (!Number.isFinite(sentMs)) {
    return { ...base, status: "none", verdict: null, verdictAt: null, ageMs: null, warn: false };
  }
  const ageMs = Math.max(0, opts.nowMs - sentMs);
  const stale = ageMs > staleAfterDays * 24 * 60 * 60 * 1000;
  const verdict = latestVerdict.verdict;
  return {
    ...base,
    status: stale ? "stale" : "recent",
    verdict,
    verdictAt,
    ageMs,
    warn: !stale && ORANGE_LAUNCH_WARNING_VERDICTS.includes(verdict),
  };
}

/**
 * Health of the Orange mailbox connection as seen by the checker. Updated
 * after every IMAP session (the checker only opens one when a test is due):
 *   unknown → no session recorded yet
 *   ok      → the last session succeeded (whether or not it found anything)
 *   failing → the last session failed; pending tests are NOT being checked
 *             and tests reaching the end of their window close as not_checked
 */
export type OrangeMailboxHealthState = "unknown" | "ok" | "failing";

export interface OrangeMailboxHealthView {
  mailbox: string;
  state: OrangeMailboxHealthState;
  /** Last IMAP session that completed (ISO). */
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastErrorClass: OrangeMailboxErrorClass | null;
  /** Scrubbed error text of the last failure (never contains credentials). */
  lastErrorMessage: string | null;
  /** Start of the current failure streak (null while healthy). */
  failingSince: string | null;
  consecutiveFailures: number;
}

export type OrangeMailboxErrorClass = (typeof ORANGE_MAILBOX_ERROR_CLASSES)[number];

export function toOrangeMailboxErrorClass(code: unknown): OrangeMailboxErrorClass {
  return typeof code === "string" && (ORANGE_MAILBOX_ERROR_CLASSES as readonly string[]).includes(code)
    ? (code as OrangeMailboxErrorClass)
    : "UNKNOWN";
}
