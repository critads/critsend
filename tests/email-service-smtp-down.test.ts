/**
 * Lot F — email-service behavior when the SMTP server is down (mocked).
 *
 * Contract under test (`sendEmail`):
 *   - connection-refused (pre-data, transient) → retried up to MAX_RETRIES,
 *     then returns { success:false, retryable:true } — the campaign layer
 *     can safely re-enqueue, no duplicate is possible;
 *   - with the Zero-Duplicate guard ON, a post-DATA failure is AMBIGUOUS:
 *     no retry at all (a retry could double-deliver), returns
 *     outcomeClass:'ambiguous' and retryable:false;
 *   - permanent SMTP rejections (5xx) are not retried.
 *
 * nodemailer and the default-headers repository are mocked; no network,
 * no database.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

process.env.TRACKING_SECRET = process.env.TRACKING_SECRET || "test-tracking-secret";

const sendMail = vi.fn();

vi.mock("nodemailer", () => {
  const createTransport = vi.fn(() => ({
    sendMail: (...args: any[]) => sendMail(...args),
    close: vi.fn(),
  }));
  return { default: { createTransport }, createTransport };
});

vi.mock("../server/repositories/mta-repository", () => ({
  getDefaultHeaders: vi.fn(async () => []),
}));

function makeMta(id: string) {
  return {
    id,
    name: "test-mta",
    hostname: "smtp.down.example",
    port: 587,
    username: null,
    password: null,
  } as any;
}

const SUBSCRIBER = {
  id: "22222222-2222-2222-2222-222222222222",
  email: "down@example.com",
  tags: [],
} as any;

const CAMPAIGN = {
  id: "11111111-1111-1111-1111-111111111111",
  htmlContent: "<html><body><p>Hi</p></body></html>",
  subject: "Test",
  preheader: null,
  fromName: "Sender",
  fromEmail: "sender@example.com",
  replyEmail: null,
  unsubscribeText: "Unsubscribe",
  companyAddress: "1 Test St",
  createdAt: new Date("2026-01-15T00:00:00Z"),
} as any;

const TRACKING_OPTS = {
  trackOpens: false,
  trackClicks: false,
  trackingDomain: "https://track.example.test",
  openTrackingDomain: null,
} as any;

let mtaSeq = 0;
function freshMta() {
  // createTransporter caches per mta.id — a fresh id per test guarantees a
  // fresh (mocked) transporter.
  return makeMta(`mta-down-${++mtaSeq}`);
}

beforeEach(() => {
  sendMail.mockReset();
});

afterEach(() => {
  delete process.env.ZERO_DUP_SEND_GUARD;
});

async function getSendEmail() {
  const { sendEmail } = await import("../server/email-service");
  return sendEmail;
}

describe("sendEmail — SMTP server down", () => {
  it("retries a connection-refused error up to MAX_RETRIES then fails retryable", async () => {
    const err: any = new Error("connect ECONNREFUSED 127.0.0.1:587");
    err.code = "ECONNREFUSED";
    sendMail.mockRejectedValue(err);

    const sendEmail = await getSendEmail();
    const result = await sendEmail(freshMta(), SUBSCRIBER, CAMPAIGN, TRACKING_OPTS);

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(3); // MAX_RETRIES
  }, 30000);

  it("recovers when the server comes back before the retry budget is spent", async () => {
    const err: any = new Error("connect ECONNREFUSED");
    err.code = "ECONNREFUSED";
    sendMail
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ messageId: "<ok@id>" });

    const sendEmail = await getSendEmail();
    const result = await sendEmail(freshMta(), SUBSCRIBER, CAMPAIGN, TRACKING_OPTS);

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("<ok@id>");
    expect(sendMail).toHaveBeenCalledTimes(2);
  }, 30000);

  it("guard ON: pre-data refusal is retried and classified pre_data_retryable", async () => {
    process.env.ZERO_DUP_SEND_GUARD = "true";
    const err: any = new Error("connect ECONNREFUSED");
    err.code = "ECONNREFUSED";
    sendMail.mockRejectedValue(err);

    const sendEmail = await getSendEmail();
    const result = await sendEmail(freshMta(), SUBSCRIBER, CAMPAIGN, TRACKING_OPTS);

    expect(result.success).toBe(false);
    expect(result.outcomeClass).toBe("pre_data_retryable");
    expect(result.retryable).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(3);
  }, 30000);

  it("guard ON: post-DATA failure is ambiguous — NO retry (duplicate prevention)", async () => {
    process.env.ZERO_DUP_SEND_GUARD = "true";
    const err: any = new Error("timeout after DATA");
    err.command = "DATA";
    sendMail.mockRejectedValue(err);

    const sendEmail = await getSendEmail();
    const result = await sendEmail(freshMta(), SUBSCRIBER, CAMPAIGN, TRACKING_OPTS);

    expect(result.success).toBe(false);
    expect(result.outcomeClass).toBe("ambiguous");
    expect(result.retryable).toBe(false);
    expect(sendMail).toHaveBeenCalledTimes(1);
  }, 30000);

  it("does not retry a permanent 5xx rejection", async () => {
    const err: any = new Error("550 mailbox unavailable");
    err.responseCode = 550;
    sendMail.mockRejectedValue(err);

    const sendEmail = await getSendEmail();
    const result = await sendEmail(freshMta(), SUBSCRIBER, CAMPAIGN, TRACKING_OPTS);

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(sendMail).toHaveBeenCalledTimes(1);
  }, 30000);
});
