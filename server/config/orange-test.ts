// Orange Test configuration (task: Orange Test — verdict de délivrabilité par MTA).
//
// Production runs self-hosted under PM2, so the mailbox credentials are plain
// environment variables (documented in .env.example / DEPLOY.md). Locally the
// password comes from a Replit secret. The feature is visible-but-disabled
// while ORANGE_TEST_IMAP_PASSWORD is absent; nothing else depends on it.
import type { OrangeTestPublicConfig } from "@shared/orange-test";

function envInt(name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export const ORANGE_TEST_DEFAULT_MAILBOX = "ianisbaulle@orange.fr";
export const ORANGE_TEST_DEFAULT_IMAP_HOST = "imap.orange.fr";
export const ORANGE_TEST_DEFAULT_IMAP_PORT = 993;

export function getOrangeTestConfig() {
  const mailbox = process.env.ORANGE_TEST_MAILBOX?.trim() || ORANGE_TEST_DEFAULT_MAILBOX;
  const password = process.env.ORANGE_TEST_IMAP_PASSWORD ?? "";
  const maxWaitHours = envInt("ORANGE_TEST_MAX_WAIT_HOURS", 48, 1, 24 * 14);
  const fastPollSeconds = envInt("ORANGE_TEST_FAST_POLL_SECONDS", 30, 10, 600);
  const fastPhaseMinutes = envInt("ORANGE_TEST_FAST_PHASE_MINUTES", 5, 0, 120);
  const slowPollMinutes = envInt("ORANGE_TEST_SLOW_POLL_MINUTES", 5, 1, 120);
  return {
    /** Recipient of every Orange Test (also the IMAP login unless overridden). */
    mailbox,
    imapHost: process.env.ORANGE_TEST_IMAP_HOST?.trim() || ORANGE_TEST_DEFAULT_IMAP_HOST,
    imapPort: envInt("ORANGE_TEST_IMAP_PORT", ORANGE_TEST_DEFAULT_IMAP_PORT, 1, 65535),
    /** Implicit TLS on 993 (the only mode Orange documents). */
    imapSecure: process.env.ORANGE_TEST_IMAP_SECURE?.trim().toLowerCase() !== "false",
    imapUser: process.env.ORANGE_TEST_IMAP_USER?.trim() || mailbox,
    /** Never exposed by the API nor logged; `enabled` is its only public trace. */
    imapPassword: password,
    enabled: password.length > 0,
    /** Listening window: after it closes the test becomes NOT RECEIVED. */
    maxWaitMs: maxWaitHours * 60 * 60 * 1000,
    maxWaitHours,
    /** Tight polling during the first minutes after the send. */
    fastPollMs: fastPollSeconds * 1000,
    fastPhaseMs: fastPhaseMinutes * 60 * 1000,
    /** Relaxed polling for the rest of the window (queued MTAs take hours). */
    slowPollMs: slowPollMinutes * 60 * 1000,
    fastPollSeconds,
    fastPhaseMinutes,
    slowPollMinutes,
    /** Per-connection IMAP timeouts (connect / greeting / socket inactivity). */
    imapTimeoutMs: envInt("ORANGE_TEST_IMAP_TIMEOUT_MS", 30_000, 5_000, 120_000),
    /** Hard bound of one whole mailbox session, whatever the number of tests checked. */
    sessionTimeoutMs: envInt("ORANGE_TEST_SESSION_TIMEOUT_MS", 120_000, 15_000, 600_000),
    /** How often the background checker looks for tests whose next poll is due. */
    checkerIntervalMs: envInt("ORANGE_TEST_CHECKER_INTERVAL_MS", 15_000, 5_000, 300_000),
    /** Tests handled per checker pass (one IMAP session). */
    checkerBatchSize: envInt("ORANGE_TEST_CHECKER_BATCH_SIZE", 50, 1, 500),
    /** A row still `sending` after this long had its process die mid-send. */
    staleSendingMs: envInt("ORANGE_TEST_STALE_SENDING_MS", 10 * 60 * 1000, 60_000, 60 * 60 * 1000),
  };
}

export type OrangeTestConfig = ReturnType<typeof getOrangeTestConfig>;

export function toPublicOrangeTestConfig(config: OrangeTestConfig = getOrangeTestConfig()): OrangeTestPublicConfig {
  return {
    enabled: config.enabled,
    disabledReason: config.enabled
      ? null
      : "Orange Test is not configured on this server: set ORANGE_TEST_IMAP_PASSWORD (and optionally ORANGE_TEST_MAILBOX / ORANGE_TEST_IMAP_HOST) to enable it.",
    mailbox: config.mailbox,
    maxWaitHours: config.maxWaitHours,
    fastPollSeconds: config.fastPollSeconds,
    fastPhaseMinutes: config.fastPhaseMinutes,
    slowPollMinutes: config.slowPollMinutes,
  };
}

/** Delay before the next mailbox poll for a test sent `ageMs` ago. */
export function nextPollDelayMs(ageMs: number, config: Pick<OrangeTestConfig, "fastPollMs" | "fastPhaseMs" | "slowPollMs">): number {
  return ageMs < config.fastPhaseMs ? config.fastPollMs : config.slowPollMs;
}
