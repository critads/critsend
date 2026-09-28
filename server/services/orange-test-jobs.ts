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
import { logger } from "../logger";
import { storage } from "../storage";
import type { Mta } from "@shared/schema";
import {
  mapSpamLevelToVerdict,
  ORANGE_TEST_REFERENCE_PREFIX,
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
  /** waiting rows past their deadline → not_received. */
  expireOverdue(now: Date): Promise<number>;
  /** Atomically takes the waiting rows whose poll is due and schedules their next poll. */
  claimDue(now: Date, limit: number, intervals: ClaimIntervals): Promise<OrangeTestRecord[]>;
  /** waiting → done (only if still `waiting`). */
  recordHit(id: string, hit: HitInput): Promise<boolean>;
  recordCheckOutcome(ids: string[], at: Date, error: string | null): Promise<void>;
}

// ---------------------------------------------------------------------------
// PostgreSQL store
// ---------------------------------------------------------------------------

const COLUMNS = `
  id, mta_id, reference, message_id, status, verdict, spam_level_raw, found_in, found_folder,
  matched_by, raw_headers, mailbox, from_email, requested_by, send_error, send_note,
  last_check_error, last_check_at, poll_count, created_at, sent_at, next_poll_at, deadline_at,
  received_at, finished_at, updated_at`;

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
       WHERE status = 'waiting' AND deadline_at IS NOT NULL AND deadline_at <= $1`,
      [now],
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

export interface OrangeTestServiceDeps {
  store: OrangeTestStore;
  getMta: (id: string) => Promise<Mta | undefined | null>;
  sendPlainTest: PlainTestSender;
  lookupMailbox: MailboxLookup;
  getConfig: () => OrangeTestConfig;
  now: () => Date;
  createImapClient?: ImapClientFactory;
}

export interface StartOrangeTestResult {
  test: OrangeTestView;
  reused: boolean;
  /** Settles when the SMTP hand-off finished (tests await it; routes ignore it). */
  completion: Promise<void>;
}

export interface CheckerTickStats {
  released: number;
  expired: number;
  claimed: number;
  found: number;
  error: string | null;
  skipped: boolean;
}

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

  /** One checker pass (bounded by the caller); safe to run on several instances. */
  async function runCheckerTick(): Promise<CheckerTickStats> {
    const config = deps.getConfig();
    const now = deps.now();
    const stats: CheckerTickStats = { released: 0, expired: 0, claimed: 0, found: 0, error: null, skipped: false };

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

    if (!config.enabled) {
      stats.skipped = true;
      return stats;
    }

    const due = await store.claimDue(now, config.checkerBatchSize, config);
    stats.claimed = due.length;
    if (due.length === 0) return stats;

    const requests: MailboxLookupRequest[] = due.map((t) => ({
      reference: t.reference,
      messageId: t.messageId,
      fromEmail: t.fromEmail,
      sentAt: t.sentAt ?? t.createdAt,
    }));
    let result: MailboxLookupResult;
    try {
      result = await deps.lookupMailbox(requests, config, deps.createImapClient);
    } catch (error: any) {
      const message: string = error?.message || String(error);
      stats.error = message;
      logger.warn(`[ORANGE_TEST] Mailbox check failed for ${due.length} test(s): ${message}`);
      await store.recordCheckOutcome(due.map((t) => t.id), deps.now(), message);
      return stats;
    }
    for (const warning of result.warnings) logger.warn(`[ORANGE_TEST] Mailbox warning: ${warning}`);

    const checkedAt = deps.now();
    const missed: string[] = [];
    for (const test of due) {
      const hit = result.hits.get(test.reference);
      if (!hit) {
        missed.push(test.id);
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
    await store.recordCheckOutcome(missed, checkedAt, null);
    return stats;
  }

  return { startOrangeTest, getOrangeTest, listOrangeTests, getControlValues, runCheckerTick };
}

export type OrangeTestService = ReturnType<typeof createOrangeTestService>;

// ---------------------------------------------------------------------------
// Default wiring + singleton background checker
// ---------------------------------------------------------------------------

let defaultService: OrangeTestService | null = null;

export function getOrangeTestService(): OrangeTestService {
  if (!defaultService) {
    defaultService = createOrangeTestService({
      store: new PgOrangeTestStore(),
      getMta: (id) => storage.getMta(id),
      sendPlainTest: (mta, to, headers, options) => sendPlainTestEmail(mta, to, headers, options),
      lookupMailbox: lookupOrangeTests,
      getConfig: getOrangeTestConfig,
      now: () => new Date(),
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
