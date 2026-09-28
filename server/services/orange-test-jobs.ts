// Orange Test — job runner: starts a test (raw Plain Test to the Orange
// mailbox with a unique reference), then a persistent background checker
// polls the mailbox over IMAP until the message is found or the listening
// window closes. Tests survive restarts (rows are resumed, never closed at
// startup) and each verdict is bound to its own reference, so a slow test from
// one day can never be mistaken for the test of the next day.
//
// Dependencies (store / sender / mailbox reader) are injectable so the
// behaviour is unit-testable without SQL string matching.
import { randomBytes } from "crypto";
import { pool } from "../db";
import { ADVISORY_LOCK_KEY_ORANGE_TEST_CHECKER } from "../bootstrap-lock";
import { logger } from "../logger";
import { storage } from "../storage";
import type { Mta } from "@shared/schema";
import {
  mapSpamLevelToVerdict,
  ORANGE_TEST_REFERENCE_PREFIX,
  toOrangeMailboxErrorClass,
  type OrangeMailboxErrorClass,
  type OrangeMailboxHealthView,
  type OrangeTestControlValue,
  type OrangeTestSendFailure,
  type OrangeTestStatus,
  type OrangeTestVerdict,
  type OrangeTestView,
} from "@shared/orange-test";
import { getOrangeTestConfig, nextPollDelayMs, type OrangeTestConfig } from "../config/orange-test";
import { sendPlainTestEmail, type PlainTestResult } from "./plain-test-sender";
import {
  lookupOrangeTests,
  type ImapClientFactory,
  type MailboxLookupHit,
  type MailboxLookupRequest,
  type MailboxLookupResult,
} from "./orange-mailbox-reader";

// ---------------------------------------------------------------------------
// Records & store contract
// ---------------------------------------------------------------------------

export interface OrangeTestRecord {
  id: string;
  mtaId: string;
  reference: string;
  messageId: string;
  status: OrangeTestStatus;
  verdict: OrangeTestVerdict | null;
  spamLevelRaw: string | null;
  foundIn: "inbox" | "junk" | null;
  foundFolder: string | null;
  matchedBy: "message-id" | "text" | "fallback" | null;
  rawHeaders: Record<string, string> | null;
  mailbox: string;
  fromEmail: string;
  requestedBy: string | null;
  sendError: OrangeTestSendFailure | null;
  sendNote: string | null;
  lastCheckError: string | null;
  lastCheckAt: Date | null;
  pollCount: number;
  createdAt: Date;
  sentAt: Date | null;
  nextPollAt: Date | null;
  deadlineAt: Date | null;
  receivedAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date;
}

export interface NewOrangeTest {
  mtaId: string;
  reference: string;
  messageId: string;
  mailbox: string;
  fromEmail: string;
  requestedBy: string | null;
}

export interface MarkSentInput {
  sentAt: Date;
  nextPollAt: Date;
  deadlineAt: Date;
}

export interface HitInput {
  verdict: OrangeTestVerdict;
  spamLevelRaw: string | null;
  foundIn: "inbox" | "junk";
  foundFolder: string;
  matchedBy: "message-id" | "text" | "fallback";
  rawHeaders: Record<string, string>;
  receivedAt: Date | null;
  finishedAt: Date;
}

export interface ClaimIntervals {
  fastPollMs: number;
  fastPhaseMs: number;
  slowPollMs: number;
}

/** One row of mta_orange_mailbox_health: how the last IMAP sessions went. */
export interface MailboxHealthRecord {
  mailbox: string;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastErrorClass: OrangeMailboxErrorClass | null;
  lastErrorMessage: string | null;
  /** Start of the current failure streak; null while healthy. */
  failingSince: Date | null;
  consecutiveFailures: number;
  lastWarnedAt: Date | null;
  updatedAt: Date;
}

export interface MailboxFailureInput {
  mailbox: string;
  at: Date;
  errorClass: OrangeMailboxErrorClass;
  message: string;
  /** Minimum delay between two "still failing" warnings (`warnDue`). */
  warnIntervalMs: number;
}

export interface MailboxFailureOutcome {
  health: MailboxHealthRecord;
  /** True when this failure should be logged as a warning (first of a streak, then at most every `warnIntervalMs`). */
  warnDue: boolean;
}

export interface MailboxSuccessOutcome {
  health: MailboxHealthRecord;
  /** Set when this session ended a failure streak. */
  recoveredFrom: { failingSince: Date; consecutiveFailures: number } | null;
}

export interface OrangeTestStore {
  /** Inserts a `sending` row; returns `null` when another test of the MTA is already pending. */
  insertPending(input: NewOrangeTest): Promise<OrangeTestRecord | null>;
  findPendingForMta(mtaId: string): Promise<OrangeTestRecord | null>;
  getById(id: string): Promise<OrangeTestRecord | null>;
  listForMta(mtaId: string, limit: number): Promise<OrangeTestRecord[]>;
  controlValues(mtaIds: string[]): Promise<Map<string, OrangeTestControlValue>>;
  /** sending → waiting (only if still `sending`). */
  markSent(id: string, input: MarkSentInput): Promise<boolean>;
  /** sending → failed (only if still `sending`). */
  markSendFailed(id: string, sendError: OrangeTestSendFailure, finishedAt: Date): Promise<boolean>;
  /** Rows stuck in `sending` since before `staleBefore` → waiting with a note. */
  releaseStaleSending(staleBefore: Date, note: string, now: Date, maxWaitMs: number, firstPollMs: number): Promise<number>;
  /**
   * waiting rows past their deadline → not_received (verdict NOT_RECEIVED),
   * but only once a mailbox check that started AFTER the deadline came back
   * clean: the last poll is always a real look, never a clock tick.
   */
  expireOverdue(now: Date): Promise<number>;
  /**
   * waiting rows more than `graceMs` past their deadline that still have no
   * clean post-deadline check → not_checked (NO verdict): the mailbox was
   * failing, the feature disabled or the checker down, so nothing is known
   * about the delivery. Bounds how long such tests linger.
   */
  closeUnchecked(now: Date, graceMs: number): Promise<number>;
  /** Atomically takes the waiting rows whose poll is due and schedules their next poll. */
  claimDue(now: Date, limit: number, intervals: ClaimIntervals): Promise<OrangeTestRecord[]>;
  /** waiting → done (only if still `waiting`). */
  recordHit(id: string, hit: HitInput): Promise<boolean>;
  recordCheckOutcome(ids: string[], at: Date, error: string | null): Promise<void>;
  getMailboxHealth(mailbox: string): Promise<MailboxHealthRecord | null>;
  /** A mailbox session completed: ends any failure streak. */
  recordMailboxSuccess(mailbox: string, at: Date): Promise<MailboxSuccessOutcome>;
  /** A mailbox session failed: extends (or starts) the failure streak and decides whether to warn. */
  recordMailboxFailure(input: MailboxFailureInput): Promise<MailboxFailureOutcome>;
}

// ---------------------------------------------------------------------------
// PostgreSQL store
// ---------------------------------------------------------------------------

const COLUMNS = `
  id, mta_id, reference, message_id, status, verdict, spam_level_raw, found_in, found_folder,
  matched_by, raw_headers, mailbox, from_email, requested_by, send_error, send_note,
  last_check_error, last_check_at, poll_count, created_at, sent_at, next_poll_at, deadline_at,
  received_at, finished_at, updated_at`;

const HEALTH_COLUMNS = `
  mailbox, last_success_at, last_failure_at, last_error_class, last_error_message,
  failing_since, consecutive_failures, last_warned_at, updated_at`;

const MAILBOX_ERROR_MESSAGE_MAX = 2000;

function toDateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

function rowToRecord(row: any): OrangeTestRecord {
  return {
    id: row.id,
    mtaId: row.mta_id,
    reference: row.reference,
    messageId: row.message_id,
    status: row.status,
    verdict: row.verdict ?? null,
    spamLevelRaw: row.spam_level_raw ?? null,
    foundIn: row.found_in ?? null,
    foundFolder: row.found_folder ?? null,
    matchedBy: row.matched_by ?? null,
    rawHeaders: row.raw_headers ?? null,
    mailbox: row.mailbox,
    fromEmail: row.from_email,
    requestedBy: row.requested_by ?? null,
    sendError: row.send_error ?? null,
    sendNote: row.send_note ?? null,
    lastCheckError: row.last_check_error ?? null,
    lastCheckAt: toDateOrNull(row.last_check_at),
    pollCount: Number(row.poll_count ?? 0),
    createdAt: toDateOrNull(row.created_at) ?? new Date(0),
    sentAt: toDateOrNull(row.sent_at),
    nextPollAt: toDateOrNull(row.next_poll_at),
    deadlineAt: toDateOrNull(row.deadline_at),
    receivedAt: toDateOrNull(row.received_at),
    finishedAt: toDateOrNull(row.finished_at),
    updatedAt: toDateOrNull(row.updated_at) ?? new Date(0),
  };
}

export class PgOrangeTestStore implements OrangeTestStore {
  constructor(private readonly db: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> } = pool) {}

  async insertPending(input: NewOrangeTest): Promise<OrangeTestRecord | null> {
    try {
      const res = await this.db.query(
        `INSERT INTO mta_orange_tests (mta_id, reference, message_id, status, mailbox, from_email, requested_by)
         VALUES ($1, $2, $3, 'sending', $4, $5, $6)
         RETURNING ${COLUMNS}`,
        [input.mtaId, input.reference, input.messageId, input.mailbox, input.fromEmail, input.requestedBy],
      );
      return rowToRecord(res.rows[0]);
    } catch (error: any) {
      // Partial unique index (one pending test per MTA) — the caller re-reads the winner.
      if (error?.code === "23505") return null;
      throw error;
    }
  }

  async findPendingForMta(mtaId: string): Promise<OrangeTestRecord | null> {
    const res = await this.db.query(
      `SELECT ${COLUMNS} FROM mta_orange_tests
       WHERE mta_id = $1 AND status IN ('sending', 'waiting')
       ORDER BY created_at DESC LIMIT 1`,
      [mtaId],
    );
    return res.rows[0] ? rowToRecord(res.rows[0]) : null;
  }

  async getById(id: string): Promise<OrangeTestRecord | null> {
    const res = await this.db.query(`SELECT ${COLUMNS} FROM mta_orange_tests WHERE id = $1`, [id]);
    return res.rows[0] ? rowToRecord(res.rows[0]) : null;
  }

  async listForMta(mtaId: string, limit: number): Promise<OrangeTestRecord[]> {
    const res = await this.db.query(
      `SELECT ${COLUMNS} FROM mta_orange_tests
       WHERE mta_id = $1
       ORDER BY COALESCE(sent_at, created_at) DESC, created_at DESC
       LIMIT $2`,
      [mtaId, limit],
    );
    return res.rows.map(rowToRecord);
  }

  async controlValues(mtaIds: string[]): Promise<Map<string, OrangeTestControlValue>> {
    const out = new Map<string, OrangeTestControlValue>();
    if (mtaIds.length === 0) return out;
    // Both picks are ordered by SEND time (never by the time the verdict came
    // in): a late verdict for an older test can never override a newer test.
    const res = await this.db.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (mta_id) ${COLUMNS}, 'latest'::text AS pick
         FROM mta_orange_tests WHERE mta_id = ANY($1::varchar[])
         ORDER BY mta_id, COALESCE(sent_at, created_at) DESC, created_at DESC
       ) latest
       UNION ALL
       SELECT * FROM (
         SELECT DISTINCT ON (mta_id) ${COLUMNS}, 'verdict'::text AS pick
         FROM mta_orange_tests WHERE mta_id = ANY($1::varchar[]) AND verdict IS NOT NULL
         ORDER BY mta_id, COALESCE(sent_at, created_at) DESC, created_at DESC
       ) with_verdict`,
      [mtaIds],
    );
    for (const row of res.rows) {
      const record = rowToRecord(row);
      const entry = out.get(record.mtaId) ?? { latest: null, latestVerdict: null };
      if (row.pick === "latest") entry.latest = toOrangeTestView(record);
      else entry.latestVerdict = toOrangeTestView(record);
      out.set(record.mtaId, entry);
    }
    return out;
  }

  async markSent(id: string, input: MarkSentInput): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE mta_orange_tests
       SET status = 'waiting', sent_at = $2, next_poll_at = $3, deadline_at = $4, updated_at = now()
       WHERE id = $1 AND status = 'sending'`,
      [id, input.sentAt, input.nextPollAt, input.deadlineAt],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async markSendFailed(id: string, sendError: OrangeTestSendFailure, finishedAt: Date): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE mta_orange_tests
       SET status = 'failed', send_error = $2::jsonb, finished_at = $3, updated_at = now()
       WHERE id = $1 AND status = 'sending'`,
      [id, JSON.stringify(sendError), finishedAt],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async releaseStaleSending(staleBefore: Date, note: string, now: Date, maxWaitMs: number, firstPollMs: number): Promise<number> {
    const res = await this.db.query(
      `UPDATE mta_orange_tests
       SET status = 'waiting', send_note = $2, sent_at = created_at,
           next_poll_at = $3, deadline_at = created_at + ($4::bigint * INTERVAL '1 millisecond'),
           updated_at = now()
       WHERE status = 'sending' AND created_at < $1`,
      [staleBefore, note, new Date(now.getTime() + firstPollMs), maxWaitMs],
    );
    return res.rowCount ?? 0;
  }

  async expireOverdue(now: Date): Promise<number> {
    const res = await this.db.query(
      `UPDATE mta_orange_tests
       SET status = 'not_received', verdict = 'NOT_RECEIVED', finished_at = $1, next_poll_at = NULL, updated_at = now()
       WHERE status = 'waiting' AND deadline_at IS NOT NULL AND deadline_at <= $1::timestamptz
         AND last_check_at IS NOT NULL AND last_check_at >= deadline_at AND last_check_error IS NULL`,
      [now],
    );
    return res.rowCount ?? 0;
  }

  async closeUnchecked(now: Date, graceMs: number): Promise<number> {
    // The clean-check exclusion is re-evaluated inside the UPDATE so a row
    // that another instance just checked clean is closed as NOT RECEIVED by
    // the next expireOverdue, never as NOT CHECKED here.
    const res = await this.db.query(
      `UPDATE mta_orange_tests
       SET status = 'not_checked', finished_at = $1, next_poll_at = NULL, updated_at = now()
       WHERE status = 'waiting' AND deadline_at IS NOT NULL
         AND deadline_at <= $1::timestamptz - ($2::bigint * INTERVAL '1 millisecond')
         AND NOT (last_check_at IS NOT NULL AND last_check_at >= deadline_at AND last_check_error IS NULL)`,
      [now, graceMs],
    );
    return res.rowCount ?? 0;
  }

  async claimDue(now: Date, limit: number, intervals: ClaimIntervals): Promise<OrangeTestRecord[]> {
    const res = await this.db.query(
      `UPDATE mta_orange_tests t
       SET next_poll_at = CASE
             WHEN $1::timestamptz - COALESCE(t.sent_at, t.created_at) < ($3::bigint * INTERVAL '1 millisecond')
               THEN $1::timestamptz + ($2::bigint * INTERVAL '1 millisecond')
             ELSE $1::timestamptz + ($4::bigint * INTERVAL '1 millisecond')
           END,
           poll_count = t.poll_count + 1,
           updated_at = now()
       WHERE t.id IN (
         SELECT id FROM mta_orange_tests
         WHERE status = 'waiting' AND next_poll_at IS NOT NULL AND next_poll_at <= $1::timestamptz
         ORDER BY next_poll_at
         LIMIT $5
         FOR UPDATE SKIP LOCKED
       )
       RETURNING ${COLUMNS}`,
      [now, intervals.fastPollMs, intervals.fastPhaseMs, intervals.slowPollMs, limit],
    );
    return res.rows.map(rowToRecord);
  }

  async recordHit(id: string, hit: HitInput): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE mta_orange_tests
       SET status = 'done', verdict = $2, spam_level_raw = $3, found_in = $4, found_folder = $5,
           matched_by = $6, raw_headers = $7::jsonb, received_at = $8, finished_at = $9,
           last_check_at = $9, last_check_error = NULL, next_poll_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'waiting'`,
      [
        id,
        hit.verdict,
        hit.spamLevelRaw,
        hit.foundIn,
        hit.foundFolder,
        hit.matchedBy,
        JSON.stringify(hit.rawHeaders),
        hit.receivedAt,
        hit.finishedAt,
      ],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async recordCheckOutcome(ids: string[], at: Date, error: string | null): Promise<void> {
    if (ids.length === 0) return;
    await this.db.query(
      `UPDATE mta_orange_tests
       SET last_check_at = $2, last_check_error = $3, updated_at = now()
       WHERE id = ANY($1::varchar[]) AND status = 'waiting'`,
      [ids, at, error],
    );
  }

  async getMailboxHealth(mailbox: string): Promise<MailboxHealthRecord | null> {
    const res = await this.db.query(
      `SELECT ${HEALTH_COLUMNS} FROM mta_orange_mailbox_health WHERE mailbox = $1`,
      [mailbox],
    );
    return res.rows[0] ? rowToHealth(res.rows[0]) : null;
  }

  async recordMailboxSuccess(mailbox: string, at: Date): Promise<MailboxSuccessOutcome> {
    // `prev` reads the row as it was before this statement, so the caller can
    // log "readable again" exactly once, when a failure streak ends.
    const res = await this.db.query(
      `WITH prev AS (
         SELECT failing_since, consecutive_failures FROM mta_orange_mailbox_health WHERE mailbox = $1
       )
       INSERT INTO mta_orange_mailbox_health (mailbox, last_success_at, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (mailbox) DO UPDATE
         SET last_success_at = EXCLUDED.last_success_at,
             failing_since = NULL, consecutive_failures = 0, last_warned_at = NULL, updated_at = now()
       RETURNING ${HEALTH_COLUMNS},
         (SELECT failing_since FROM prev) AS prev_failing_since,
         (SELECT consecutive_failures FROM prev) AS prev_consecutive_failures`,
      [mailbox, at],
    );
    const row = res.rows[0];
    const prevFailingSince = toDateOrNull(row.prev_failing_since);
    return {
      health: rowToHealth(row),
      recoveredFrom: prevFailingSince
        ? { failingSince: prevFailingSince, consecutiveFailures: Number(row.prev_consecutive_failures ?? 0) }
        : null,
    };
  }

  async recordMailboxFailure(input: MailboxFailureInput): Promise<MailboxFailureOutcome> {
    // last_warned_at is bumped in the same statement that records the
    // failure, so two instances can never both decide to warn.
    const res = await this.db.query(
      `INSERT INTO mta_orange_mailbox_health
         (mailbox, last_failure_at, last_error_class, last_error_message, failing_since, consecutive_failures, last_warned_at, updated_at)
       VALUES ($1, $2, $3, $4, $2, 1, $2, now())
       ON CONFLICT (mailbox) DO UPDATE
         SET last_failure_at = EXCLUDED.last_failure_at,
             last_error_class = EXCLUDED.last_error_class,
             last_error_message = EXCLUDED.last_error_message,
             failing_since = COALESCE(mta_orange_mailbox_health.failing_since, EXCLUDED.last_failure_at),
             consecutive_failures = mta_orange_mailbox_health.consecutive_failures + 1,
             last_warned_at = CASE
               WHEN mta_orange_mailbox_health.last_warned_at IS NULL
                 OR mta_orange_mailbox_health.last_warned_at <= EXCLUDED.last_failure_at - ($5::bigint * INTERVAL '1 millisecond')
               THEN EXCLUDED.last_failure_at
               ELSE mta_orange_mailbox_health.last_warned_at
             END,
             updated_at = now()
       RETURNING ${HEALTH_COLUMNS}, (last_warned_at = $2::timestamptz) AS warn_due`,
      [input.mailbox, input.at, input.errorClass, input.message.slice(0, MAILBOX_ERROR_MESSAGE_MAX), input.warnIntervalMs],
    );
    const row = res.rows[0];
    return { health: rowToHealth(row), warnDue: Boolean(row.warn_due) };
  }
}

function rowToHealth(row: any): MailboxHealthRecord {
  return {
    mailbox: row.mailbox,
    lastSuccessAt: toDateOrNull(row.last_success_at),
    lastFailureAt: toDateOrNull(row.last_failure_at),
    lastErrorClass: row.last_error_class ? toOrangeMailboxErrorClass(row.last_error_class) : null,
    lastErrorMessage: row.last_error_message ?? null,
    failingSince: toDateOrNull(row.failing_since),
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
    lastWarnedAt: toDateOrNull(row.last_warned_at),
    updatedAt: toDateOrNull(row.updated_at) ?? new Date(0),
  };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toOrangeTestView(record: OrangeTestRecord): OrangeTestView {
  return {
    id: record.id,
    mtaId: record.mtaId,
    reference: record.reference,
    messageId: record.messageId,
    status: record.status,
    verdict: record.verdict,
    spamLevelRaw: record.spamLevelRaw,
    foundIn: record.foundIn,
    foundFolder: record.foundFolder,
    matchedBy: record.matchedBy,
    rawHeaders: record.rawHeaders,
    mailbox: record.mailbox,
    fromEmail: record.fromEmail,
    requestedBy: record.requestedBy,
    sendError: record.sendError,
    sendNote: record.sendNote,
    lastCheckError: record.lastCheckError,
    lastCheckAt: iso(record.lastCheckAt),
    pollCount: record.pollCount,
    createdAt: record.createdAt.toISOString(),
    sentAt: iso(record.sentAt),
    nextPollAt: iso(record.nextPollAt),
    deadlineAt: iso(record.deadlineAt),
    receivedAt: iso(record.receivedAt),
    finishedAt: iso(record.finishedAt),
    deliveryDelayMs:
      record.receivedAt && record.sentAt ? Math.max(0, record.receivedAt.getTime() - record.sentAt.getTime()) : null,
  };
}

export function toMailboxHealthView(mailbox: string, record: MailboxHealthRecord | null): OrangeMailboxHealthView {
  if (!record) {
    return {
      mailbox, state: "unknown", lastSuccessAt: null, lastFailureAt: null, lastErrorClass: null,
      lastErrorMessage: null, failingSince: null, consecutiveFailures: 0,
    };
  }
  return {
    mailbox: record.mailbox,
    state: record.failingSince ? "failing" : record.lastSuccessAt ? "ok" : "unknown",
    lastSuccessAt: iso(record.lastSuccessAt),
    lastFailureAt: iso(record.lastFailureAt),
    lastErrorClass: record.lastErrorClass,
    lastErrorMessage: record.lastErrorMessage,
    failingSince: iso(record.failingSince),
    consecutiveFailures: record.consecutiveFailures,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type OrangeTestErrorCode = "NOT_CONFIGURED" | "MTA_NOT_FOUND" | "MTA_NOT_ELIGIBLE";

export class OrangeTestError extends Error {
  constructor(public readonly code: OrangeTestErrorCode, public readonly httpStatus: number, message: string) {
    super(message);
    this.name = "OrangeTestError";
  }
}

export type PlainTestSender = (
  mta: Mta,
  to: string,
  headers: undefined,
  options: { messageId: string; bodySuffix: string },
) => Promise<PlainTestResult>;

export type MailboxLookup = (
  requests: MailboxLookupRequest[],
  config: OrangeTestConfig,
  createClient?: ImapClientFactory,
) => Promise<MailboxLookupResult>;

/** Exclusive right to run the mailbox part of a checker tick (one IMAP session across all instances). */
export interface CheckerLease {
  release(): Promise<void>;
}

export interface OrangeTestServiceDeps {
  store: OrangeTestStore;
  getMta: (id: string) => Promise<Mta | undefined | null>;
  sendPlainTest: PlainTestSender;
  lookupMailbox: MailboxLookup;
  getConfig: () => OrangeTestConfig;
  now: () => Date;
  createImapClient?: ImapClientFactory;
  /** Returns null when another instance holds the lease; omitted = single instance. */
  acquireCheckerLease?: (budgetMs: number) => Promise<CheckerLease | null>;
}

export interface StartOrangeTestResult {
  test: OrangeTestView;
  reused: boolean;
  /** Settles when the SMTP hand-off finished (tests await it; routes ignore it). */
  completion: Promise<void>;
}

export interface CheckerTickStats {
  released: number;
  /** Closed as NOT RECEIVED (clean look after the deadline). */
  expired: number;
  /** Closed as NOT CHECKED (grace period over, no clean look — no verdict). */
  notChecked: number;
  claimed: number;
  found: number;
  /** Claimed tests whose lookup the server refused (recorded as failed checks, never as clean misses). */
  unsearched: number;
  error: string | null;
  /** A "mailbox unreadable" warning was logged this tick (first failure, then hourly). */
  mailboxWarned: boolean;
  /** Mailbox part not run: feature disabled, or another instance holds the lease. */
  skipped: boolean;
  leaseHeldElsewhere: boolean;
}

/**
 * Overdue tests are closed as NOT RECEIVED only after a clean mailbox check
 * that started past the deadline; when the mailbox is unreachable (or the
 * feature got disabled) this grace period bounds how long they linger — they
 * are then closed as NOT CHECKED, without a verdict.
 */
export const EXPIRY_GRACE_MS = 60 * 60 * 1000;

/** While the mailbox keeps failing, the warning is repeated at most this often (across instances). */
export const MAILBOX_WARN_INTERVAL_MS = 60 * 60 * 1000;

export const STALE_SENDING_NOTE =
  "Send outcome unknown: the server restarted while the message was being handed to the MTA. Listening anyway in case it was sent.";

const HISTORY_LIMIT_MAX = 50;

export function generateOrangeTestReference(now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `${ORANGE_TEST_REFERENCE_PREFIX}${day}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

export function buildOrangeTestMessageId(reference: string, fromEmail: string): string {
  const domain = (fromEmail.split("@")[1] || "").trim().toLowerCase().replace(/[^a-z0-9.-]/g, "") || "orange-test.invalid";
  return `<${reference}@${domain}>`;
}

function describeSendFailure(result: PlainTestResult): OrangeTestSendFailure {
  return {
    stage: result.stage,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    smtpCode: result.smtpCode,
    suggestions: result.suggestions,
    connectionTimeMs: result.connectionTimeMs,
  };
}

export function createOrangeTestService(deps: OrangeTestServiceDeps) {
  const { store } = deps;

  async function performSend(record: OrangeTestRecord, mta: Mta, config: OrangeTestConfig): Promise<void> {
    let result: PlainTestResult;
    try {
      result = await deps.sendPlainTest(mta, config.mailbox, undefined, {
        messageId: record.messageId,
        bodySuffix: `Ref: ${record.reference}`,
      });
    } catch (error: any) {
      result = {
        success: false,
        connectionTimeMs: 0,
        stage: "Unknown",
        errorMessage: error?.message || String(error),
        suggestions: ["Check server logs for more details."],
      };
    }
    const now = deps.now();
    if (result.success) {
      const sentAt = now;
      await store.markSent(record.id, {
        sentAt,
        nextPollAt: new Date(sentAt.getTime() + config.fastPollMs),
        deadlineAt: new Date(sentAt.getTime() + config.maxWaitMs),
      });
      logger.info(`[ORANGE_TEST] ${record.reference} handed to MTA ${mta.name} → listening for up to ${config.maxWaitHours} h`);
    } else {
      await store.markSendFailed(record.id, describeSendFailure(result), now);
      logger.warn(`[ORANGE_TEST] ${record.reference} refused by MTA ${mta.name}: ${result.stage || "error"} — ${result.errorMessage || "unknown"}`);
    }
  }

  async function startOrangeTest(mtaId: string, requestedBy: string | null): Promise<StartOrangeTestResult> {
    const config = deps.getConfig();
    if (!config.enabled) {
      throw new OrangeTestError("NOT_CONFIGURED", 503, "Orange Test is not configured on this server (ORANGE_TEST_IMAP_PASSWORD is missing).");
    }
    const mta = await deps.getMta(mtaId);
    if (!mta) throw new OrangeTestError("MTA_NOT_FOUND", 404, "MTA not found");
    if ((mta as any).mode === "nullsink") {
      throw new OrangeTestError("MTA_NOT_ELIGIBLE", 400, "Orange Test needs a real MTA: a nullsink MTA never delivers to Orange.");
    }
    if (!mta.fromEmail || !mta.fromEmail.includes("@")) {
      throw new OrangeTestError("MTA_NOT_ELIGIBLE", 400, "This MTA has no From email configured; the Orange Test needs one.");
    }

    const existing = await store.findPendingForMta(mtaId);
    if (existing) return { test: toOrangeTestView(existing), reused: true, completion: Promise.resolve() };

    const reference = generateOrangeTestReference(deps.now());
    const inserted = await store.insertPending({
      mtaId,
      reference,
      messageId: buildOrangeTestMessageId(reference, mta.fromEmail),
      mailbox: config.mailbox,
      fromEmail: mta.fromEmail,
      requestedBy,
    });
    if (!inserted) {
      const winner = await store.findPendingForMta(mtaId);
      if (winner) return { test: toOrangeTestView(winner), reused: true, completion: Promise.resolve() };
      throw new Error("Orange test insert conflicted but no pending test was found");
    }
    logger.info(`[ORANGE_TEST] ${reference} created for MTA ${mta.name} (@${(mta.fromEmail.split("@")[1] || "?")} → Orange mailbox)`);
    const completion = performSend(inserted, mta, config).catch((error) => {
      logger.error(`[ORANGE_TEST] ${reference} send bookkeeping failed:`, error);
    });
    return { test: toOrangeTestView(inserted), reused: false, completion };
  }

  async function getOrangeTest(id: string): Promise<OrangeTestView | null> {
    const record = await store.getById(id);
    return record ? toOrangeTestView(record) : null;
  }

  async function listOrangeTests(mtaId: string, limit = 10): Promise<OrangeTestView[]> {
    const bounded = Math.min(HISTORY_LIMIT_MAX, Math.max(1, Math.floor(limit)));
    return (await store.listForMta(mtaId, bounded)).map(toOrangeTestView);
  }

  async function getControlValues(mtaIds: string[]): Promise<Record<string, OrangeTestControlValue>> {
    const unique = [...new Set(mtaIds)].slice(0, 200);
    const map = await store.controlValues(unique);
    const out: Record<string, OrangeTestControlValue> = {};
    for (const id of unique) out[id] = map.get(id) ?? { latest: null, latestVerdict: null };
    return out;
  }

  function hitToInput(hit: MailboxLookupHit, finishedAt: Date): HitInput {
    const { verdict } = mapSpamLevelToVerdict(hit.spamLevelRaw);
    return {
      verdict,
      spamLevelRaw: hit.spamLevelRaw,
      foundIn: hit.folder,
      foundFolder: hit.folderPath,
      matchedBy: hit.matchedBy,
      rawHeaders: hit.headers,
      receivedAt: hit.receivedAt,
      finishedAt,
    };
  }

  async function getMailboxHealth(): Promise<OrangeMailboxHealthView> {
    const config = deps.getConfig();
    return toMailboxHealthView(config.mailbox, await store.getMailboxHealth(config.mailbox));
  }

  function describeMailboxState(health: MailboxHealthRecord | null, config: OrangeTestConfig): string {
    if (!config.enabled) return "Orange Test is disabled on this server";
    if (health?.failingSince) {
      return `mailbox ${config.mailbox} unreadable since ${health.failingSince.toISOString()} (${health.lastErrorClass ?? "UNKNOWN"}, ${health.consecutiveFailures} failed check(s))`;
    }
    return `no successful mailbox check after their deadline (checker down or mailbox ${config.mailbox} unreadable)`;
  }

  /** One checker pass (bounded by the caller); safe to run on several instances. */
  async function runCheckerTick(): Promise<CheckerTickStats> {
    const config = deps.getConfig();
    const now = deps.now();
    const stats: CheckerTickStats = {
      released: 0, expired: 0, notChecked: 0, claimed: 0, found: 0, unsearched: 0, error: null,
      mailboxWarned: false, skipped: false, leaseHeldElsewhere: false,
    };

    stats.released = await store.releaseStaleSending(
      new Date(now.getTime() - config.staleSendingMs),
      STALE_SENDING_NOTE,
      now,
      config.maxWaitMs,
      config.fastPollMs,
    );
    if (stats.released > 0) logger.warn(`[ORANGE_TEST] ${stats.released} test(s) stuck in 'sending' released to 'waiting'`);

    stats.expired = await store.expireOverdue(now);
    if (stats.expired > 0) logger.info(`[ORANGE_TEST] ${stats.expired} test(s) closed as NOT RECEIVED (listening window over)`);

    stats.notChecked = await store.closeUnchecked(now, EXPIRY_GRACE_MS);
    if (stats.notChecked > 0) {
      const health = await store.getMailboxHealth(config.mailbox);
      logger.warn(
        `[ORANGE_TEST] ${stats.notChecked} test(s) closed as NOT CHECKED — no verdict: ${describeMailboxState(health, config)}`,
      );
    }

    if (!config.enabled) {
      stats.skipped = true;
      return stats;
    }

    // The claim itself is atomic (SKIP LOCKED), but the mailbox session that
    // follows is not: without the lease two web instances would open two IMAP
    // sessions at once. Whoever misses the lease simply leaves the due rows
    // for the holder (their poll time is untouched).
    const lease = deps.acquireCheckerLease
      ? await deps.acquireCheckerLease(config.sessionTimeoutMs + 30_000)
      : { release: async () => undefined };
    if (!lease) {
      stats.skipped = true;
      stats.leaseHeldElsewhere = true;
      return stats;
    }

    try {
      const due = await store.claimDue(now, config.checkerBatchSize, config);
      stats.claimed = due.length;
      if (due.length === 0) return stats;

      const requests: MailboxLookupRequest[] = due.map((t) => ({
        reference: t.reference,
        messageId: t.messageId,
        fromEmail: t.fromEmail,
        sentAt: t.sentAt ?? t.createdAt,
      }));
      // Mailbox-level bookkeeping: the failure streak feeds the /mtas
      // indicator and the warning is throttled to once per hour (in the DB,
      // so both web instances share the throttle). Intermediate failures
      // stay at info.
      const noteMailboxFailure = async (failedAt: Date, errorClass: OrangeMailboxErrorClass, message: string) => {
        const { health, warnDue } = await store.recordMailboxFailure({
          mailbox: config.mailbox,
          at: failedAt,
          errorClass,
          message,
          warnIntervalMs: MAILBOX_WARN_INTERVAL_MS,
        });
        stats.mailboxWarned = warnDue;
        const streak = `${health.lastErrorClass ?? "UNKNOWN"}, ${health.consecutiveFailures} failed check(s) since ${(health.failingSince ?? failedAt).toISOString()}`;
        if (warnDue) {
          logger.warn(
            `[ORANGE_TEST] Orange mailbox ${config.mailbox} unreadable (${streak}); ${due.length} pending test(s) NOT checked: ${message}` +
              ` — tests reaching the end of their window while this lasts are closed as NOT CHECKED (no verdict).`,
          );
        } else {
          logger.info(`[ORANGE_TEST] Mailbox check failed for ${due.length} test(s) (${streak}): ${message}`);
        }
      };

      let result: MailboxLookupResult;
      try {
        result = await deps.lookupMailbox(requests, config, deps.createImapClient);
      } catch (error: any) {
        const message: string = error?.message || String(error);
        const failedAt = deps.now();
        stats.error = message;
        await store.recordCheckOutcome(due.map((t) => t.id), failedAt, message);
        await noteMailboxFailure(failedAt, toOrangeMailboxErrorClass(error?.code), message);
        return stats;
      }
      for (const warning of result.warnings) logger.warn(`[ORANGE_TEST] Mailbox warning: ${warning}`);

      const checkedAt = deps.now();
      const missed: string[] = [];
      const unsearched: Array<{ id: string; reason: string }> = [];
      for (const test of due) {
        const hit = result.hits.get(test.reference);
        if (!hit) {
          // The server refused a search that could have found this test: the
          // miss says nothing, so it must never become the final clean look.
          const reason = result.incomplete.get(test.reference);
          if (reason) unsearched.push({ id: test.id, reason });
          else missed.push(test.id);
          continue;
        }
        const input = hitToInput(hit, checkedAt);
        const applied = await store.recordHit(test.id, input);
        if (applied) {
          stats.found += 1;
          logger.info(
            `[ORANGE_TEST] ${test.reference} found in ${hit.folder} (${hit.folderPath}) — X-me-spamlevel=${hit.spamLevelRaw ?? "absent"} → ${input.verdict}`,
          );
        }
      }
      // A clean miss is stamped with the time the look STARTED (the claim):
      // expiry requires a look that started after the deadline, so a session
      // that straddles the deadline never counts as the final check.
      await store.recordCheckOutcome(missed, now, null);
      // An incomplete lookup is recorded as a failed check (last_check_error
      // set): expireOverdue ignores it and, if it lasts past the grace, the
      // test closes as NOT CHECKED — never as NOT RECEIVED.
      for (const { id, reason } of unsearched) {
        await store.recordCheckOutcome([id], checkedAt, `Mailbox search incomplete — ${reason}`);
      }
      stats.unsearched = unsearched.length;

      if (stats.found === 0 && missed.length === 0 && unsearched.length > 0) {
        // Logged in, but not a single lookup completed: for the tests' purpose
        // the mailbox is as unreadable as a refused login.
        const message = `IMAP session opened but every search was refused (${unsearched[0].reason})`;
        stats.error = message;
        await noteMailboxFailure(checkedAt, "IMAP", message);
        return stats;
      }
      const { recoveredFrom } = await store.recordMailboxSuccess(config.mailbox, checkedAt);
      if (recoveredFrom) {
        logger.info(
          `[ORANGE_TEST] Orange mailbox ${config.mailbox} readable again after ${recoveredFrom.consecutiveFailures} failed check(s) since ${recoveredFrom.failingSince.toISOString()}`,
        );
      }
      if (unsearched.length > 0) {
        logger.warn(`[ORANGE_TEST] ${unsearched.length} of ${due.length} pending test(s) could not be looked up (search refused): ${unsearched[0].reason}`);
      }
      return stats;
    } finally {
      await lease.release();
    }
  }

  return { startOrangeTest, getOrangeTest, listOrangeTests, getControlValues, getMailboxHealth, runCheckerTick };
}

export type OrangeTestService = ReturnType<typeof createOrangeTestService>;

// ---------------------------------------------------------------------------
// Default wiring + singleton background checker
// ---------------------------------------------------------------------------

let defaultService: OrangeTestService | null = null;

/**
 * Cross-instance lease = a transaction-scoped advisory lock held on a
 * dedicated connection for the duration of the mailbox session. The
 * transaction is idle while IMAP runs, so `idle_in_transaction_session_timeout`
 * makes PostgreSQL itself drop the lock (and the backend) if this process
 * ever hangs past the tick budget — no leaked lock can freeze the other
 * instance's checker.
 */
export async function acquirePgCheckerLease(budgetMs: number): Promise<CheckerLease | null> {
  const client = await pool.connect();
  let released = false;
  // A checked-out pg client has no 'error' listener of its own. When the
  // timeout above fires, PostgreSQL closes the backend and the client emits
  // 'error' (the FATAL, then the socket end): without a listener that is an
  // uncaught exception, i.e. the safety net would take the process down
  // instead of just costing us the lease. Remember the loss for release().
  let connectionLost: Error | null = null;
  const onConnectionError = (error: Error) => {
    if (connectionLost) return;
    connectionLost = error;
    logger.warn(`[ORANGE_TEST] Checker lease connection dropped by PostgreSQL (${error?.message || error}) — the lease is lost`);
  };
  client.on("error", onConnectionError);
  const release = async () => {
    if (released) return;
    released = true;
    if (connectionLost) {
      // Keep the listener: a destroyed client can still report the socket end.
      client.release(true);
      return;
    }
    try {
      await client.query("COMMIT");
      client.removeListener("error", onConnectionError);
      client.release();
    } catch (error: any) {
      logger.warn(`[ORANGE_TEST] Checker lease release failed (${error?.message || error}) — dropping the connection`);
      client.release(true);
    }
  };
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL idle_in_transaction_session_timeout = ${Math.max(1000, Math.floor(budgetMs))}`);
    const res = await client.query<{ acquired: boolean }>(`SELECT pg_try_advisory_xact_lock($1) AS acquired`, [
      ADVISORY_LOCK_KEY_ORANGE_TEST_CHECKER,
    ]);
    if (res.rows[0]?.acquired !== true) {
      await release();
      return null;
    }
    return { release };
  } catch (error) {
    await release();
    throw error;
  }
}

export function getOrangeTestService(): OrangeTestService {
  if (!defaultService) {
    defaultService = createOrangeTestService({
      store: new PgOrangeTestStore(),
      getMta: (id) => storage.getMta(id),
      sendPlainTest: (mta, to, headers, options) => sendPlainTestEmail(mta, to, headers, options),
      lookupMailbox: lookupOrangeTests,
      getConfig: getOrangeTestConfig,
      now: () => new Date(),
      acquireCheckerLease: acquirePgCheckerLease,
    });
  }
  return defaultService;
}

let checkerTimer: NodeJS.Timeout | null = null;
let kickoffTimer: NodeJS.Timeout | null = null;
let tickInFlight = false;

/**
 * Runs one tick under a hard deadline. The in-flight guard is released by the
 * deadline too, so a never-settling IMAP/DB await cannot freeze the checker
 * (every write it might still do later is status-guarded).
 */
export async function runOrangeTestCheckerOnce(service: OrangeTestService = getOrangeTestService()): Promise<CheckerTickStats | null> {
  if (tickInFlight) return null;
  tickInFlight = true;
  const config = getOrangeTestConfig();
  const budgetMs = config.sessionTimeoutMs + 30_000;
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      service.runCheckerTick(),
      new Promise<CheckerTickStats | null>((resolve) => {
        timer = setTimeout(() => {
          logger.error(`[ORANGE_TEST] Checker tick exceeded ${budgetMs} ms — releasing the tick guard`);
          resolve(null);
        }, budgetMs);
      }),
    ]);
  } catch (error) {
    logger.error("[ORANGE_TEST] Checker tick failed:", error);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    tickInFlight = false;
  }
}

/** Starts the background checker (idempotent). Pending tests resume on the first tick. */
export function startOrangeTestChecker(): void {
  if (checkerTimer) return;
  const config = getOrangeTestConfig();
  logger.info(
    `[ORANGE_TEST] Checker started (every ${Math.round(config.checkerIntervalMs / 1000)} s; ` +
      `${config.enabled ? `mailbox ${config.mailbox} via ${config.imapHost}:${config.imapPort}` : "mailbox NOT configured — tests disabled"})`,
  );
  kickoffTimer = setTimeout(() => {
    kickoffTimer = null;
    void runOrangeTestCheckerOnce();
  }, 3_000);
  kickoffTimer.unref();
  checkerTimer = setInterval(() => {
    void runOrangeTestCheckerOnce();
  }, config.checkerIntervalMs);
  checkerTimer.unref();
}

export function stopOrangeTestChecker(): void {
  if (kickoffTimer) {
    clearTimeout(kickoffTimer);
    kickoffTimer = null;
  }
  if (checkerTimer) {
    clearInterval(checkerTimer);
    checkerTimer = null;
  }
}
