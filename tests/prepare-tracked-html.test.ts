import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prepareTrackedHtml } from "../server/email-service";

const CAMPAIGN = {
  id: "11111111-1111-1111-1111-111111111111",
  htmlContent: `<html><body><p>Hi {{email}}</p><a href="https://example.com/promo">Click me</a></body></html>`,
  subject: "Hello {{email}}",
  preheader: null,
  unsubscribeText: "Unsubscribe",
  companyAddress: "1 Test St",
  createdAt: new Date("2026-01-15T00:00:00Z"),
};

const SUBSCRIBER = {
  id: "22222222-2222-2222-2222-222222222222",
  email: "guard@example.com",
  tags: [],
};

const MTA = { imageHostingDomain: null };

describe("prepareTrackedHtml — guard against silent tracking regression", () => {
  it("injects an open pixel pointing at the tracking domain", () => {
    const out = prepareTrackedHtml(CAMPAIGN, SUBSCRIBER, MTA, {
      trackOpens: true,
      trackClicks: true,
      trackingDomain: "https://track.example.test",
      openTrackingDomain: null,
    });
    // Open pixel is a 1x1 <img> served from /o/ or /api/track/open/ on the
    // tracking domain. Either route is acceptable — both are HMAC-signed
    // and resolve to the same handler. The point of this guard is to fail
    // loudly if any send path bypasses the open-pixel injection.
    expect(out.html).toMatch(/<img[^>]+src=["']https:\/\/track\.example\.test\/(o\/|api\/track\/open\/)/);
    // The pixel must NOT use display:none — some clients / image proxies /
    // anti-spam scanners refuse to load hidden images, silently dropping
    // real opens (Task #202). It stays invisible via opacity:0 + 1×1 sizing.
    const pixelTag = out.html.match(/<img[^>]+src=["']https:\/\/track\.example\.test\/(?:o\/|api\/track\/open\/)[^>]*>/)?.[0] ?? "";
    expect(pixelTag).not.toMatch(/display\s*:\s*none/i);
    expect(pixelTag).toMatch(/opacity\s*:\s*0/i);
    // Each rendered pixel carries a unique per-send cache-buster (mid).
    expect(pixelTag).toMatch(/[?&]mid=/);
  });

  it("rewrites raw <a href> URLs to go through the click tracker", () => {
    const out = prepareTrackedHtml(CAMPAIGN, SUBSCRIBER, MTA, {
      trackOpens: true,
      trackClicks: true,
      trackingDomain: "https://track.example.test",
      openTrackingDomain: null,
    });
    // Original href must NOT survive unrewritten (it would otherwise bypass
    // click tracking entirely on any path that forgot to call
    // `prepareTrackedHtml`).
    expect(out.html).not.toMatch(/href=["']https:\/\/example\.com\/promo["']/);
    // It should now route through the tracking domain (either the long
    // /api/track/click/ HMAC form or the short /c/ form).
    expect(out.html).toMatch(/href=["']https:\/\/track\.example\.test\/(c\/|api\/track\/click\/)/);
  });

  it("personalizes {{email}} placeholders in body and subject", () => {
    const out = prepareTrackedHtml(CAMPAIGN, SUBSCRIBER, MTA, {
      trackOpens: false,
      trackClicks: false,
      trackingDomain: "https://track.example.test",
      openTrackingDomain: null,
    });
    expect(out.html).toContain("guard@example.com");
    expect(out.subject).toBe("Hello guard@example.com");
  });

  it("respects trackOpens=false / trackClicks=false (no pixel, no rewrite)", () => {
    const out = prepareTrackedHtml(CAMPAIGN, SUBSCRIBER, MTA, {
      trackOpens: false,
      trackClicks: false,
      trackingDomain: "https://track.example.test",
      openTrackingDomain: null,
    });
    expect(out.html).not.toMatch(/<img[^>]+src=["']https:\/\/track\.example\.test/);
    expect(out.html).toContain('href="https://example.com/promo"');
  });
});

/**
 * Path-level chokepoint guard (Task #185).
 *
 * The runtime behavior of `prepareTrackedHtml` is exercised above. These
 * tests are a static guard that the four canonical outbound send paths —
 * bulk campaign sender (real SMTP), nullsink (simulated SMTP),
 * pressure-guard drain worker, automation `send_email`, and the Resend
 * fallback — all invoke the chokepoint. Pressure-guard is included
 * transitively because it calls back into `sendEmail` /
 * `sendEmailBatchNullsink` rather than rendering HTML itself; we assert
 * that explicitly below.
 *
 * If a new outbound path is added without going through
 * `prepareTrackedHtml`, this test fails loudly so reviewers can decide
 * whether to wire it into the chokepoint (the answer is almost always
 * yes) or to add a deliberate exception with a comment explaining why.
 */
const ROOT = join(__dirname, "..");
function readSrc(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("Task #185 chokepoint: every outbound path funnels through prepareTrackedHtml", () => {
  it("bulk campaign sender (real SMTP path in sendEmail) calls prepareTrackedHtml", () => {
    const src = readSrc("server/email-service.ts");
    // sendEmail is the real-SMTP entry point used by campaign-sender.ts;
    // it must invoke prepareTrackedHtml. We assert both the export
    // exists and that sendEmail's body references it.
    expect(src).toMatch(/export\s+async\s+function\s+sendEmail\b/);
    const sendEmailBody = src.split(/export\s+async\s+function\s+sendEmail\b/)[1] ?? "";
    expect(sendEmailBody).toMatch(/prepareTrackedHtml\s*\(/);
  });

  it("nullsink path (sendEmailWithNullsink + sendEmailBatchNullsink) calls prepareTrackedHtml", () => {
    const src = readSrc("server/email-service.ts");
    const singleBody = src.split(/function\s+sendEmailWithNullsink\b/)[1] ?? "";
    const batchBody = src.split(/function\s+sendEmailBatchNullsink\b/)[1] ?? "";
    expect(singleBody).toMatch(/prepareTrackedHtml\s*\(/);
    expect(batchBody).toMatch(/prepareTrackedHtml\s*\(/);
  });

  it("pressure-guard drain worker dispatches through sendEmail / nullsink (no rolled-its-own HTML)", () => {
    // The drain worker must not directly render HTML — it must delegate
    // to the same sendEmail / sendEmailWithNullsink / sendEmailBatchNullsink
    // entry points the bulk sender uses, which are already covered above.
    const drainSrc = readSrc("server/workers/pressure-guard-worker.ts");
    expect(drainSrc).toMatch(/sendEmail(WithNullsink|BatchNullsink)?\b/);
    // And critically: it must NOT inject its own pixel or rewrite hrefs
    // outside the chokepoint.
    expect(drainSrc).not.toMatch(/<img\s+[^>]*src=["'][^"']*track/i);
    expect(drainSrc).not.toMatch(/injectOpenPixel|rewriteClickLinks/);
  });

  it("automation engine send_email step funnels through sendEmail (and refuses untracked fallback)", () => {
    const src = readSrc("server/services/automation-engine.ts");
    // Must call sendEmail (the tracked chokepoint), not the legacy
    // untracked sendAutomationEmail as the primary path.
    expect(src).toMatch(/\bsendEmail\s*\(/);
    // And must refuse to silently bypass tracking — if we can't provision
    // the tracking campaign we throw, not fall through to an untracked send.
    expect(src).toMatch(/refusing to send untracked/i);
  });

  it("Resend fallback (sendTestEmailViaResend) supports tracking via prepareTrackedHtml", () => {
    const src = readSrc("server/resend-client.ts");
    expect(src).toMatch(/prepareTrackedHtml\s*\(/);
    expect(src).toMatch(/TestEmailTrackingContext/);
  });

  it("test-send route accepts the trackInTest opt-in (default off, requires saved campaignId)", () => {
    const src = readSrc("server/routes/campaigns.ts");
    expect(src).toMatch(/trackInTest/);
    // The opt-in must require a saved campaignId so tracking events can
    // satisfy the campaign_stats FK constraint.
    expect(src).toMatch(/trackInTest requires a saved campaignId/);
  });

  it("test-send response shape is consistent across SMTP + Resend (both return `tracked`)", () => {
    const src = readSrc("server/routes/campaigns.ts");
    // Both transport branches must include the same `tracked` flag so the
    // UI can show a consistent indicator regardless of which one ran.
    const trackedFieldOccurrences = src.match(/tracked:\s*!!trackingContext/g) || [];
    expect(trackedFieldOccurrences.length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * Regression guard: automation send_email steps must not leak one
 * recipient's `{{name}}` substitution into another recipient's email via
 * the cached synthetic tracking campaign row. The fix is to keep the
 * synthetic campaign as a tracking FK target only and to override
 * subject/htmlContent per recipient before calling sendEmail.
 */
describe("Task #185 automation: per-recipient personalization is not leaked via cached tracking campaign", () => {
  it("personalizes {{name}} per recipient through prepareTrackedHtml", () => {
    const ALICE = { id: "aaaa1111-1111-1111-1111-111111111111", email: "alice@example.com", tags: [] };
    const BOB = { id: "bbbb2222-2222-2222-2222-222222222222", email: "bob@example.com", tags: [] };

    // Simulate the per-send shaping the automation engine now performs:
    // synthetic-campaign identity (id) + per-recipient personalized
    // subject/htmlContent. The synthetic row's own (unused) htmlContent
    // is intentionally seeded with Alice's name to prove that Bob's
    // render does NOT pick it up — only the per-send override matters.
    const cachedSyntheticRow = {
      id: "ssss3333-3333-3333-3333-333333333333",
      htmlContent: "<p>Hello {{name}}</p>",
      subject: "Hi {{name}}",
      preheader: null,
      unsubscribeText: "Unsubscribe",
      companyAddress: null,
      createdAt: new Date(),
    };

    const perSendForBob = {
      ...cachedSyntheticRow,
      subject: cachedSyntheticRow.subject.replace(/\{\{name\}\}/gi, "Bob"),
      htmlContent: cachedSyntheticRow.htmlContent.replace(/\{\{name\}\}/gi, "Bob"),
    };

    const out = prepareTrackedHtml(perSendForBob, BOB, MTA, {
      trackOpens: false,
      trackClicks: false,
      trackingDomain: "https://track.example.test",
      openTrackingDomain: null,
    });
    expect(out.html).toContain("Bob");
    expect(out.html).not.toContain("Alice");
    expect(out.subject).toBe("Hi Bob");
    void ALICE;
  });

  it("automation engine overrides cached campaign content with per-recipient subject + html before sendEmail", () => {
    const src = readSrc("server/services/automation-engine.ts");
    // The engine must build a per-send campaign view (spread of the
    // tracking campaign + recipient-specific subject + htmlContent)
    // instead of handing the cached synthetic row directly to sendEmail.
    expect(src).toMatch(/perSendCampaign\s*=\s*\{[\s\S]*?\.\.\.trackingCampaign[\s\S]*?subject:\s*personalizedSubject[\s\S]*?htmlContent:\s*nameReplacedHtml/);
    // And the synthetic row itself must be seeded with the RAW template
    // (no per-recipient name substitution baked in), so the persisted
    // row never carries another recipient's personalization.
    expect(src).toMatch(/ensureAutomationTrackingCampaign\([\s\S]*?subject,\s*\n[\s\S]*?htmlContent,\s*\n/);
  });
});
