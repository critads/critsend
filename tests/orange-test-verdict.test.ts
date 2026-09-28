import { afterEach, describe, expect, it } from "vitest";
import { isOrangeTestPending, mapSpamLevelToVerdict } from "../shared/orange-test";
import { getOrangeTestConfig, nextPollDelayMs, toPublicOrangeTestConfig } from "../server/config/orange-test";

describe("mapSpamLevelToVerdict", () => {
  it("maps the agreed Orange values", () => {
    expect(mapSpamLevelToVerdict("not-spam").verdict).toBe("GOOD");
    expect(mapSpamLevelToVerdict("low").verdict).toBe("SPAM");
    expect(mapSpamLevelToVerdict("med").verdict).toBe("BLOCKED");
  });

  it("treats anything more severe than med as BLOCKED", () => {
    expect(mapSpamLevelToVerdict("high").verdict).toBe("BLOCKED");
    expect(mapSpamLevelToVerdict("very-high").verdict).toBe("BLOCKED");
  });

  it("is case/whitespace/quote insensitive and keeps the normalized value", () => {
    expect(mapSpamLevelToVerdict('  "Not-Spam" ')).toEqual({ verdict: "GOOD", normalized: "not-spam" });
    expect(mapSpamLevelToVerdict("LOW")).toEqual({ verdict: "SPAM", normalized: "low" });
  });

  it("returns UNKNOWN for a missing header or an unseen value", () => {
    expect(mapSpamLevelToVerdict(null)).toEqual({ verdict: "UNKNOWN", normalized: null });
    expect(mapSpamLevelToVerdict(undefined).verdict).toBe("UNKNOWN");
    expect(mapSpamLevelToVerdict("   ").verdict).toBe("UNKNOWN");
    expect(mapSpamLevelToVerdict("weird-value")).toEqual({ verdict: "UNKNOWN", normalized: "weird-value" });
  });
});

describe("isOrangeTestPending", () => {
  it("only sending and waiting are pending", () => {
    expect(isOrangeTestPending("sending")).toBe(true);
    expect(isOrangeTestPending("waiting")).toBe(true);
    expect(isOrangeTestPending("done")).toBe(false);
    expect(isOrangeTestPending("failed")).toBe(false);
    expect(isOrangeTestPending("not_received")).toBe(false);
  });
});

describe("orange test config", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("ORANGE_TEST_")) delete process.env[key];
    }
    for (const [key, value] of Object.entries(saved)) {
      if (key.startsWith("ORANGE_TEST_")) process.env[key] = value;
    }
  });

  it("is disabled without the IMAP password and says why, without leaking anything", () => {
    delete process.env.ORANGE_TEST_IMAP_PASSWORD;
    const config = getOrangeTestConfig();
    expect(config.enabled).toBe(false);
    expect(config.mailbox).toBe("ianisbaulle@orange.fr");
    expect(config.imapHost).toBe("imap.orange.fr");
    expect(config.imapPort).toBe(993);
    expect(config.maxWaitHours).toBe(48);
    const pub = toPublicOrangeTestConfig(config);
    expect(pub.enabled).toBe(false);
    expect(pub.disabledReason).toMatch(/ORANGE_TEST_IMAP_PASSWORD/);
    expect(pub).not.toHaveProperty("imapPassword");
    expect(pub).not.toHaveProperty("imapUser");
  });

  it("is enabled with the password and never exposes it publicly", () => {
    process.env.ORANGE_TEST_IMAP_PASSWORD = "s3cret-value";
    process.env.ORANGE_TEST_MAX_WAIT_HOURS = "12";
    const config = getOrangeTestConfig();
    expect(config.enabled).toBe(true);
    expect(config.maxWaitMs).toBe(12 * 3600 * 1000);
    const pub = toPublicOrangeTestConfig(config);
    expect(pub.enabled).toBe(true);
    expect(pub.disabledReason).toBeNull();
    expect(pub.maxWaitHours).toBe(12);
    expect(JSON.stringify(pub)).not.toContain("s3cret-value");
  });

  it("exposes the campaign-wizard stale window (default 7 days, bounded 1–365)", () => {
    delete process.env.ORANGE_TEST_STALE_VERDICT_DAYS;
    expect(getOrangeTestConfig().staleVerdictDays).toBe(7);
    expect(toPublicOrangeTestConfig(getOrangeTestConfig()).staleVerdictDays).toBe(7);
    process.env.ORANGE_TEST_STALE_VERDICT_DAYS = "3";
    expect(toPublicOrangeTestConfig(getOrangeTestConfig()).staleVerdictDays).toBe(3);
    process.env.ORANGE_TEST_STALE_VERDICT_DAYS = "0";
    expect(getOrangeTestConfig().staleVerdictDays).toBe(1);
    process.env.ORANGE_TEST_STALE_VERDICT_DAYS = "9999";
    expect(getOrangeTestConfig().staleVerdictDays).toBe(365);
    process.env.ORANGE_TEST_STALE_VERDICT_DAYS = "abc";
    expect(getOrangeTestConfig().staleVerdictDays).toBe(7);
  });

  it("polls every 30 s for 5 min, then every 5 min", () => {
    const config = { fastPollMs: 30_000, fastPhaseMs: 5 * 60_000, slowPollMs: 5 * 60_000 };
    expect(nextPollDelayMs(0, config)).toBe(30_000);
    expect(nextPollDelayMs(4 * 60_000, config)).toBe(30_000);
    expect(nextPollDelayMs(5 * 60_000, config)).toBe(5 * 60_000);
    expect(nextPollDelayMs(3 * 3600_000, config)).toBe(5 * 60_000);
  });
});
