/**
 * Zero-Duplicate Send Guard — feature flag + SMTP outcome classifier.
 *
 * GOAL: never deliver the same (campaign_id, subscriber_id) twice. The operator
 * has accepted the tradeoff that we would rather UNDER-deliver (drop a send we
 * are unsure about) than risk a duplicate, because duplicates drive anti-spam
 * complaints.
 *
 * The whole feature is gated behind the ZERO_DUP_SEND_GUARD env flag. While the
 * flag is OFF (the default) every code path behaves byte-identically to before
 * this guard existed, so the deploy is inert and trivially reversible.
 *
 * This module is intentionally dependency-free (no nodemailer / DB imports) so
 * it can be imported by the repositories, the workers, and the email service
 * alike, and unit-tested in isolation.
 */

/**
 * Outcome of a single wire-level send attempt.
 *   'delivered'          — sendMail resolved; the MTA accepted the message.
 *   'pre_data_retryable' — the attempt failed provably BEFORE the message data
 *                          was accepted (DNS/connect/auth refusals, 4xx/5xx
 *                          command rejections). The recipient never got it, so
 *                          resending cannot create a duplicate.
 *   'ambiguous'          — we cannot prove the message was NOT delivered
 *                          (timeouts, mid/post-DATA socket drops, unexpected
 *                          throws). Treated as terminal and NEVER resent.
 */
export type SmtpOutcomeClass = "delivered" | "pre_data_retryable" | "ambiguous";

/**
 * Master switch. Mirrors the established flag style in this codebase
 * (cf. prettyTrackingUrlsEnabled). Defaults to OFF — must be explicitly set to
 * the string "true" to engage the guard.
 */
export function zeroDupSendGuardEnabled(): boolean {
  return process.env.ZERO_DUP_SEND_GUARD === "true";
}

// SMTP commands that run strictly BEFORE the message body is transmitted. A
// failure tagged with one of these proves the recipient never received data.
const PRE_DATA_COMMANDS = new Set([
  "CONN",
  "EHLO",
  "HELO",
  "STARTTLS",
  "AUTH",
  "MAIL",
  "MAIL FROM",
  "RCPT",
  "RCPT TO",
]);

// Commands covering the data body and the end-of-data terminator. A failure
// here means the body was (at least partly) transmitted — the server may have
// accepted/queued it, so the outcome is ambiguous and must not be resent.
const POST_DATA_COMMANDS = new Set(["DATA", "BDAT", "."]);

// Transport error codes that prove no session/message ever made it out:
// connection refused, DNS resolution failures, TLS/auth refusals.
const PRE_DATA_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EDNS",
  "EAUTH",
  "ECONNECTION",
  "ESTARTTLS",
]);

// Transport error codes where a message could have been in flight when the
// socket failed — the send may or may not have completed on the wire.
const AMBIGUOUS_CODES = new Set([
  "ETIMEDOUT",
  "ETIME",
  "ECONNRESET",
  "EPIPE",
  "ESOCKET",
]);

/**
 * Classify a FAILED send attempt as retryable (provably not delivered) or
 * ambiguous (possibly delivered → never resend). Only ever called on failures,
 * so it never returns 'delivered'.
 *
 * Conservative by construction: any signal we cannot positively tie to a
 * pre-data failure collapses to 'ambiguous'. Order matters — the SMTP command
 * stage is the most reliable signal and is checked first.
 */
export function classifySmtpFailure(
  error: any,
): "pre_data_retryable" | "ambiguous" {
  if (!error) return "ambiguous";

  // 1) Most reliable signal: which SMTP command nodemailer was executing.
  const command =
    typeof error.command === "string" ? error.command.toUpperCase() : undefined;
  if (command) {
    if (POST_DATA_COMMANDS.has(command)) return "ambiguous";
    if (PRE_DATA_COMMANDS.has(command)) return "pre_data_retryable";
  }

  // 2) An explicit SMTP response code means the server answered and did NOT
  //    accept the message (a 2xx accept is not surfaced as an error). A 4xx/5xx
  //    delivered after end-of-data carries command='.'/'DATA' and was already
  //    caught as ambiguous in step 1, so a bare response code here is a
  //    pre-acceptance rejection → safe to resend (no duplicate possible).
  const responseCode =
    typeof error.responseCode === "number" ? error.responseCode : undefined;
  if (responseCode && responseCode >= 400) {
    return "pre_data_retryable";
  }

  // 3) Transport-level error code with no command/response context.
  const code = typeof error.code === "string" ? error.code.toUpperCase() : undefined;
  if (code) {
    if (PRE_DATA_CODES.has(code)) return "pre_data_retryable";
    if (AMBIGUOUS_CODES.has(code)) return "ambiguous";
  }

  // 4) Default (incl. our own sendMailBounded timeout, whose message contains
  //    "timed out"): anything we cannot prove was pre-data is ambiguous.
  return "ambiguous";
}
