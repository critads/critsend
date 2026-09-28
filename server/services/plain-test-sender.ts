// Raw SMTP test email shared by the manual « Plain Test » (server/routes/mtas.ts)
// and the automated « Orange Test » (server/services/orange-test-jobs.ts).
// Extracted verbatim from the MTA routes so both callers send exactly the same
// message; the Orange variant only adds a pre-set Message-ID and a `Ref:` line.
import nodemailer from "nodemailer";
import type { Mta } from "@shared/schema";
import { resolveSmtpSecurity } from "../email-service";

export function classifySmtpError(error: any): { stage: string; suggestions: string[] } {
  const msg = (error.message || "").toLowerCase();
  const code = (error.code || "").toUpperCase();
  const responseCode = error.responseCode;

  if (code === "ENOTFOUND" || msg.includes("getaddrinfo") || msg.includes("dns")) {
    return {
      stage: "DNS Resolution",
      suggestions: [
        "Verify the hostname is spelled correctly",
        "Confirm the hostname resolves in DNS (try: ping " + (error.hostname || "hostname") + ")",
        "Try using the server's IP address instead of the hostname",
      ],
    };
  }
  if (code === "ECONNREFUSED") {
    return {
      stage: "TCP Connection",
      suggestions: [
        "The server actively refused the connection — check the port number",
        "Common ports: 25 (unauthenticated), 465 (SSL), 587 (STARTTLS)",
        "Verify no firewall or security group is blocking outbound SMTP",
      ],
    };
  }
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || msg.includes("timeout")) {
    return {
      stage: "Connection Timeout",
      suggestions: [
        "The server did not respond within the timeout window",
        "A firewall may be silently dropping the connection (no RST packet)",
        "Try a different port — some ISPs block port 25",
        "Check whether the server is online and accepting connections",
      ],
    };
  }
  if (
    code === "ESOCKET" ||
    code === "CERT_HAS_EXPIRED" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    msg.includes("tls") ||
    msg.includes("ssl") ||
    msg.includes("certificate") ||
    msg.includes("handshake")
  ) {
    return {
      stage: "TLS/SSL Handshake",
      suggestions: [
        "The server's TLS certificate may be self-signed or expired",
        "Port 465 requires SSL from the start; port 587 uses STARTTLS after greeting",
        "Temporarily set SMTP_SKIP_TLS_VERIFY=true to bypass cert validation (dev only)",
        "If your provider uses STARTTLS, ensure you are NOT using secure:true (port 465 mode)",
      ],
    };
  }
  if (
    code === "EAUTH" ||
    (responseCode && responseCode === 535) ||
    msg.includes("authentication") ||
    msg.includes("credentials") ||
    msg.includes("535") ||
    msg.includes("username") ||
    msg.includes("invalid login")
  ) {
    return {
      stage: "Authentication",
      suggestions: [
        "Double-check the SMTP username and password",
        "Some providers require an app-specific password when 2FA is enabled",
        "Ensure SMTP authentication is enabled for this account",
        "Gmail / Outlook may require OAuth2 instead of password auth",
      ],
    };
  }
  if (msg.includes("greeting") || msg.includes("banner") || msg.includes("ehlo") || msg.includes("helo")) {
    return {
      stage: "SMTP Greeting",
      suggestions: [
        "The server responded but rejected the EHLO/HELO greeting",
        "Your server IP may be on a blocklist or rate-limited",
        "Contact the SMTP provider for more detail on the rejection reason",
      ],
    };
  }
  if (code === "ECONNRESET" || msg.includes("connection reset") || msg.includes("socket hang up")) {
    return {
      stage: "Connection Reset",
      suggestions: [
        "The server closed the connection unexpectedly",
        "Your IP may be blocked or rate-limited by the server",
        "Try again in a few minutes",
      ],
    };
  }
  return {
    stage: "SMTP Protocol",
    suggestions: [
      "An unexpected error occurred during the SMTP handshake",
      "Check the raw error message below for more detail",
      "Review your SMTP server's logs for the matching request",
    ],
  };
}

export interface PlainTestResult {
  success: boolean;
  connectionTimeMs: number;
  messageId?: string;
  accepted?: string[];
  rejected?: string[];
  from?: string;
  to?: string;
  stage?: string;
  errorCode?: string;
  errorMessage?: string;
  smtpCode?: number;
  suggestions?: string[];
}

export const PLAIN_TEST_SUBJECT = "Hello moon";
export const PLAIN_TEST_BODY = "I'm the sun";

export interface PlainTestSendOptions {
  /**
   * Message-ID to stamp on the email (angle brackets included). The Orange
   * Test sets it in advance so the mailbox reader can look up this exact
   * message; the manual Plain Test leaves it to nodemailer.
   */
  messageId?: string;
  /**
   * Extra plain-text lines appended after the body (the Orange Test adds a
   * `Ref: OT-…` line so the message can be reconciled even if a relay
   * rewrites the Message-ID). The manual Plain Test never sets it.
   */
  bodySuffix?: string;
}

/**
 * Sends a deliberately *raw* test email through the MTA, bypassing the entire
 * `prepareTrackedHtml` pipeline. NONE of our machinery is applied: no custom
 * email headers, no List-Unsubscribe / unsubscribe footer, no open-tracking
 * pixel, no click/link rewriting, no image rewriting, no preheader. Just the
 * MTA's own From, the recipient, subject "Hello moon" and a plain-text body
 * "I'm the sun". Useful for isolating raw deliverability of an MTA from any
 * tracking/header that content scanners might react to.
 *
 * A one-off, non-pooled transport is used on purpose so this manual test never
 * touches the production sending pool (`createTransporter`).
 */
export async function sendPlainTestEmail(
  mta: Mta,
  to: string,
  headers?: Array<{ key: string; value: string }>,
  options: PlainTestSendOptions = {},
): Promise<PlainTestResult> {
  const start = Date.now();

  if ((mta as any).mode === "nullsink") {
    return {
      success: false,
      connectionTimeMs: 0,
      stage: "Not supported",
      errorMessage: "Plain Test sends a real email and is not available for a nullsink (test mode) MTA.",
      suggestions: ["Use a real SMTP MTA to send a plain test email."],
    };
  }

  const fromEmail = (mta.fromEmail || "").trim();
  if (!fromEmail) {
    return {
      success: false,
      connectionTimeMs: 0,
      stage: "Configuration",
      errorMessage: "This MTA has no From email configured, so a plain test cannot set a sender.",
      suggestions: ["Edit the MTA and set a From email (and optionally a From name)."],
    };
  }

  const port = mta.port || 587;
  const protocol = (mta as any).protocol || "STARTTLS";
  const { secure, ignoreTLS } = resolveSmtpSecurity(protocol);

  const transporter = nodemailer.createTransport({
    host: mta.hostname || "localhost",
    port,
    secure,
    ignoreTLS,
    auth: mta.username && mta.password
      ? { user: mta.username, pass: mta.password }
      : undefined,
    pool: false,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    tls: {
      rejectUnauthorized: process.env.SMTP_SKIP_TLS_VERIFY !== "true",
    },
  });

  const fromName = (mta.fromName || "").trim();
  const from = fromName ? { name: fromName, address: fromEmail } : fromEmail;

  try {
    // Raw on purpose: only From / To / Subject / plain-text body, plus any custom
    // headers the operator added explicitly. No unsubscribe, no tracking, no
    // footer — bypasses prepareTrackedHtml.
    const info = await transporter.sendMail({
      from,
      to,
      subject: PLAIN_TEST_SUBJECT,
      text: options.bodySuffix ? `${PLAIN_TEST_BODY}\n\n${options.bodySuffix}` : PLAIN_TEST_BODY,
      ...(options.messageId ? { messageId: options.messageId } : {}),
      ...(headers && headers.length > 0 ? { headers } : {}),
    });
    const connectionTimeMs = Date.now() - start;
    const normalizeAddrs = (arr: any[] | undefined): string[] =>
      (arr || []).map((a) => (typeof a === "string" ? a : a?.address)).filter(Boolean);
    return {
      success: true,
      connectionTimeMs,
      messageId: info.messageId,
      accepted: normalizeAddrs(info.accepted as any[]),
      rejected: normalizeAddrs(info.rejected as any[]),
      from: typeof from === "string" ? from : `${from.name} <${from.address}>`,
      to,
    };
  } catch (error: any) {
    const connectionTimeMs = Date.now() - start;
    const { stage, suggestions } = classifySmtpError(error);
    return {
      success: false,
      connectionTimeMs,
      stage,
      errorCode: error.code || undefined,
      errorMessage: error.message || "Unknown error",
      smtpCode: error.responseCode || undefined,
      suggestions,
    };
  } finally {
    transporter.close();
  }
}
