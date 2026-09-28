// Static render checks for the Orange Test presentation on /mtas: the
// mailbox-health banner and the card badge. Rendered with react-dom/server
// (no DOM needed) so the states that only appear in production incidents —
// mailbox unreadable, tests closed as NOT CHECKED — stay covered.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OrangeMailboxHealthBanner } from "../client/src/components/mtas/orange-mailbox-health";
import { OrangeTestCardBadge } from "../client/src/components/mtas/orange-test";
import type { OrangeMailboxHealthView, OrangeTestPublicConfig, OrangeTestView } from "../shared/orange-test";

const config: OrangeTestPublicConfig = {
  enabled: true, disabledReason: null, mailbox: "ianisbaulle@orange.fr", maxWaitHours: 48,
  fastPollSeconds: 30, fastPhaseMinutes: 5, slowPollMinutes: 5,
};

const healthy: OrangeMailboxHealthView = {
  mailbox: "ianisbaulle@orange.fr", state: "ok", lastSuccessAt: "2026-09-28T09:30:00.000Z", lastFailureAt: null,
  lastErrorClass: null, lastErrorMessage: null, failingSince: null, consecutiveFailures: 0,
};

const failing: OrangeMailboxHealthView = {
  mailbox: "ianisbaulle@orange.fr", state: "failing", lastSuccessAt: "2026-09-27T09:30:00.000Z",
  lastFailureAt: "2026-09-28T09:45:00.000Z", lastErrorClass: "AUTH",
  lastErrorMessage: "IMAP authentication refused by imap.orange.fr (Authentication failed.)",
  failingSince: "2026-09-28T08:00:00.000Z", consecutiveFailures: 21,
};

function view(overrides: Partial<OrangeTestView>): OrangeTestView {
  return {
    id: "t1", mtaId: "mta-1", reference: "OT-20260928-ABCD1234", messageId: "<x@example.com>", status: "done", verdict: "GOOD",
    spamLevelRaw: "not-spam", foundIn: "inbox", foundFolder: "INBOX", matchedBy: "message-id", rawHeaders: null,
    mailbox: "ianisbaulle@orange.fr", fromEmail: "news@example.com", requestedBy: null, sendError: null, sendNote: null,
    lastCheckError: null, lastCheckAt: null, pollCount: 3, createdAt: "2026-09-28T08:00:00.000Z", sentAt: "2026-09-28T08:00:01.000Z",
    nextPollAt: null, deadlineAt: "2026-09-30T08:00:01.000Z", receivedAt: null, finishedAt: "2026-09-28T08:05:00.000Z",
    deliveryDelayMs: null, ...overrides,
  };
}

const render = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(element);

describe("OrangeMailboxHealthBanner", () => {
  it("renders nothing when the feature is disabled or the summary is not loaded", () => {
    expect(render(createElement(OrangeMailboxHealthBanner, { config: { ...config, enabled: false }, health: failing }))).toBe("");
    expect(render(createElement(OrangeMailboxHealthBanner, { config, health: undefined }))).toBe("");
  });

  it("shows a compact line with the last successful read while the mailbox is healthy", () => {
    const html = render(createElement(OrangeMailboxHealthBanner, { config, health: healthy }));
    expect(html).toContain('data-testid="orange-mailbox-health-ok"');
    expect(html).toContain("last read");
    expect(html).not.toContain("role=\"alert\"");
  });

  it("raises an alert with the error class, the streak and the last success while the mailbox is failing", () => {
    const html = render(createElement(OrangeMailboxHealthBanner, { config, health: failing, now: Date.parse("2026-09-28T10:00:00.000Z") }));
    expect(html).toContain('data-testid="orange-mailbox-health-failing"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Orange tests are not being checked");
    expect(html).toContain(">AUTH<");
    expect(html).toContain("21 consecutive checks");
    expect(html).toContain("authentication refused");
    expect(html).toContain("2 h ago");
    expect(html).toContain("NOT CHECKED");
    expect(html).toContain("IMAP authentication refused by imap.orange.fr");
  });

  it("says the mailbox was never read yet when no session was recorded", () => {
    const html = render(createElement(OrangeMailboxHealthBanner, { config, health: { ...healthy, state: "unknown", lastSuccessAt: null } }));
    expect(html).toContain('data-testid="orange-mailbox-health-unknown"');
    expect(html).toContain("not read yet");
  });
});

describe("OrangeTestCardBadge", () => {
  it("shows NOT CHECKED with the last real verdict instead of a NOT RECEIVED verdict", () => {
    const latest = view({ id: "t2", status: "not_checked", verdict: null, lastCheckError: "IMAP authentication refused" });
    const previous = view({ id: "t1", status: "done", verdict: "BLOCKED" });
    const html = render(createElement(OrangeTestCardBadge, { mtaId: "mta-1", value: { latest, latestVerdict: previous } }));
    expect(html).toContain('data-testid="orange-test-card-not-checked-mta-1"');
    expect(html).toContain("NOT CHECKED");
    expect(html).not.toContain("NOT RECEIVED");
    expect(html).toContain("last checked test:");
    expect(html).toContain('data-testid="orange-test-card-previous-mta-1"');
    expect(html).toContain("BLOCKED");
  });

  it("flags a waiting test that is not actually being checked while the mailbox is failing", () => {
    const latest = view({ status: "waiting", verdict: null, finishedAt: null });
    const withFailing = render(createElement(OrangeTestCardBadge, { mtaId: "mta-1", value: { latest, latestVerdict: null }, mailbox: failing }));
    expect(withFailing).toContain('data-testid="orange-test-card-pending-mta-1"');
    expect(withFailing).toContain('data-testid="orange-test-card-unreadable-mta-1"');
    expect(withFailing).toContain("mailbox unreadable");

    const withHealthy = render(createElement(OrangeTestCardBadge, { mtaId: "mta-1", value: { latest, latestVerdict: null }, mailbox: healthy }));
    expect(withHealthy).not.toContain("mailbox unreadable");
  });

  it("still shows a plain verdict for a test closed after a clean look", () => {
    const latest = view({ status: "not_received", verdict: "NOT_RECEIVED" });
    const html = render(createElement(OrangeTestCardBadge, { mtaId: "mta-1", value: { latest, latestVerdict: latest }, mailbox: failing }));
    expect(html).toContain('data-testid="orange-test-card-verdict-mta-1"');
    expect(html).toContain("NOT RECEIVED");
    expect(html).not.toContain("NOT CHECKED");
  });
});
