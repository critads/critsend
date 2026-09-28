// Orange Test — PgOrangeTestStore and acquirePgCheckerLease against a real
// PostgreSQL (the development database). tests/orange-test-jobs.test.ts
// covers the checker logic through an in-memory mirror of the SQL semantics;
// this suite pins the SQL itself so the two cannot drift silently (e.g.
// expireOverdue closing a test without the post-deadline look, or
// controlValues picking the latest verdict instead of the latest SENT test).
//
// Isolation: each run creates a private schema (orange_it_<epoch>_<rand>)
// holding a scratch `mtas` table plus `mta_orange_tests` built verbatim from
// migrations/0009, and drops it afterwards — even when a test fails. The
// store is handed a query adapter that schema-qualifies `mta_orange_tests`
// in the SQL it receives, and refuses any SQL it could not qualify. The
// sweep queries (releaseStaleSending / expireOverdue / closeUnchecked /
// claimDue) are table-wide and the dev checker runs against
// public.mta_orange_tests every 15 s, so the rows under test must live where
// neither can see the other.
// (A session-level `SET search_path` would not be a safe alternative:
// NEON_DATABASE_URL is a PgBouncer transaction-pooling endpoint, where
// session state is not guaranteed to follow the client between statements.)
//
// The lease tests use the application pool and the shared advisory key,
// exactly as production does.
//
// Skipped when neither NEON_DATABASE_URL nor DATABASE_URL is set.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  CheckerLease,
  HitInput,
  NewOrangeTest,
  OrangeTestRecord,
  PgOrangeTestStore,
} from "../server/services/orange-test-jobs";
import type { OrangeTestSendFailure } from "../shared/orange-test";

vi.mock("../server/storage", () => ({ storage: { getMta: vi.fn() } }));
vi.mock("../server/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../server/services/plain-test-sender", () => ({
  PLAIN_TEST_SUBJECT: "Hello moon",
  PLAIN_TEST_BODY: "I'm the sun",
  sendPlainTestEmail: vi.fn(),
  classifySmtpError: vi.fn(),
}));
vi.mock("../server/services/orange-mailbox-reader", () => ({ lookupOrangeTests: vi.fn() }));

const DB_URL = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

type JobsModule = typeof import("../server/services/orange-test-jobs");
type LoggerModule = typeof import("../server/logger");

const MIGRATION_PATH = fileURLToPath(new URL("../migrations/0009_mta_orange_tests.sql", import.meta.url));
const SCHEMA_PREFIX = "orange_it_";
/** Schemas left behind by a killed run are swept on the next run once this old. */
const STALE_SCHEMA_AFTER_MS = 2 * 60 * 60_000;

const SECOND = 1_000;
const MIN = 60 * SECOND;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const FAST_POLL = 30 * SECOND;
const FAST_PHASE = 5 * MIN;
const SLOW_POLL = 5 * MIN;
const MAX_WAIT = 48 * HOUR;
const GRACE = HOUR;
const INTERVALS = { fastPollMs: FAST_POLL, fastPhaseMs: FAST_PHASE, slowPollMs: SLOW_POLL };

const SEND_FAILURE: OrangeTestSendFailure = {
  stage: "Authentication",
  errorCode: "EAUTH",
  errorMessage: "535 5.7.8 Bad credentials",
  smtpCode: 535,
  suggestions: ["Check the username"],
  connectionTimeMs: 40,
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describeWithDb("Orange test store — PostgreSQL behavior", () => {
  const runId = `${Math.floor(Date.now() / 1000)}_${randomBytes(3).toString("hex")}`;
  const schema = `${SCHEMA_PREFIX}${runId}`;
  const schemaIdent = `"${schema}"`;
  const T = `${schemaIdent}.mta_orange_tests`;
  const M = `${schemaIdent}.mtas`;
  /** Every timestamp the tests write is relative to this instant (whole second, so it round-trips exactly). */
  const T0 = new Date(Math.floor(Date.now() / 1000) * 1000);
  const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

  let pool: pg.Pool;
  let appPool: pg.Pool;
  let jobs: JobsModule;
  let logger: LoggerModule["logger"];
  let checkerLockKey: number;
  let store: PgOrangeTestStore;
  let refSeq = 0;
  /** Undo actions for resources a failing test could leave behind (run in reverse before the schema is dropped). */
  const finalizers: Array<() => Promise<unknown>> = [];

  // -------------------------------------------------------------------------
  // Isolation
  // -------------------------------------------------------------------------

  /** Rewrites the store's SQL onto the private schema; throws rather than let a reference reach public. */
  function qualify(sql: string): string {
    const qualified = sql.replace(/\bmta_orange_tests\b/g, `${schemaIdent}.mta_orange_tests`);
    if (/(?<!\.)\bmta_orange_tests\b/.test(qualified)) {
      throw new Error(`Refusing SQL with an unqualified mta_orange_tests reference (it would reach public):\n${sql}`);
    }
    return qualified;
  }

  async function dropStaleSchemas(): Promise<void> {
    const res = await pool.query<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace WHERE nspname ~ $1`,
      [`^${SCHEMA_PREFIX}\\d+_[0-9a-f]+$`],
    );
    const cutoff = Math.floor((Date.now() - STALE_SCHEMA_AFTER_MS) / 1000);
    for (const { nspname } of res.rows) {
      const epoch = Number(nspname.slice(SCHEMA_PREFIX.length).split("_")[0]);
      if (!Number.isFinite(epoch) || epoch > cutoff) continue;
      await pool.query(`DROP SCHEMA IF EXISTS "${nspname}" CASCADE`).catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Fixtures (through the store wherever the store has a path for it)
  // -------------------------------------------------------------------------

  async function newMtas(count: number, label: string): Promise<string[]> {
    const names = Array.from({ length: count }, (_, i) => `orange-it ${label} ${i + 1}`);
    const res = await pool.query<{ id: string }>(`INSERT INTO ${M} (name) SELECT unnest($1::text[]) RETURNING id`, [names]);
    return res.rows.map((r) => r.id);
  }

  function newTestInput(mtaId: string): NewOrangeTest {
    const reference = `OT-IT-${runId}-${String(++refSeq).padStart(3, "0")}`;
    return {
      mtaId,
      reference,
      messageId: `<${reference}@orange-it.invalid>`,
      mailbox: "orange-it@example.test",
      fromEmail: "news@orange-it.invalid",
      requestedBy: "integration-test",
    };
  }

  async function pending(mtaId: string): Promise<OrangeTestRecord> {
    const inserted = await store.insertPending(newTestInput(mtaId));
    if (!inserted) throw new Error(`expected a fresh pending test for MTA ${mtaId}`);
    return inserted;
  }

  async function waiting(mtaId: string, opts: { sentAt: Date; nextPollAt?: Date; deadlineAt?: Date }): Promise<OrangeTestRecord> {
    const inserted = await pending(mtaId);
    const ok = await store.markSent(inserted.id, {
      sentAt: opts.sentAt,
      nextPollAt: opts.nextPollAt ?? new Date(opts.sentAt.getTime() + FAST_POLL),
      deadlineAt: opts.deadlineAt ?? new Date(opts.sentAt.getTime() + MAX_WAIT),
    });
    if (!ok) throw new Error("markSent refused a freshly inserted sending row");
    return row(inserted.id);
  }

  async function row(id: string): Promise<OrangeTestRecord> {
    const found = await store.getById(id);
    if (!found) throw new Error(`test row ${id} disappeared`);
    return found;
  }

  async function setCreatedAt(id: string, createdAt: Date): Promise<void> {
    await pool.query(`UPDATE ${T} SET created_at = $2 WHERE id = $1`, [id, createdAt]);
  }

  function hit(overrides: Partial<HitInput> = {}): HitInput {
    return {
      verdict: "SPAM",
      spamLevelRaw: "low",
      foundIn: "junk",
      foundFolder: "Junk",
      matchedBy: "message-id",
      rawHeaders: { "x-me-spamlevel": "low", "authentication-results": "orange.fr; dkim=pass" },
      receivedAt: at(-5 * MIN),
      finishedAt: T0,
      ...overrides,
    };
  }

  /** Captures the pool clients acquirePgCheckerLease checks out, so a test can look inside the lease transaction. */
  function captureLeaseClients(): { clients: pg.PoolClient[]; restore: () => void } {
    const clients: pg.PoolClient[] = [];
    const originalConnect = appPool.connect.bind(appPool);
    const spy = vi.spyOn(appPool, "connect").mockImplementation((async () => {
      const client = await originalConnect();
      clients.push(client);
      return client;
    }) as typeof appPool.connect);
    return { clients, restore: () => spy.mockRestore() };
  }

  /**
   * The advisory key is shared with a dev server running in the same
   * workspace, whose checker holds the lease for a few milliseconds every
   * tick: retry briefly instead of failing on that coincidence.
   */
  async function acquireLeaseOrWait(budgetMs: number): Promise<CheckerLease> {
    const deadline = Date.now() + 5 * SECOND;
    for (;;) {
      const lease = await jobs.acquirePgCheckerLease(budgetMs);
      if (lease) return lease;
      if (Date.now() > deadline) {
        throw new Error("checker lease held by another process for more than 5 s (a dev server running a mailbox session?) — retry later");
      }
      await sleep(250);
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DB_URL, max: 4 });
    pool.on("error", (error) => console.warn(`[orange-it] pool error: ${error.message}`));
    await dropStaleSchemas();
    // One round trip, one transaction: the scratch schema, a minimal mtas
    // table for the foreign key, and the migration DDL verbatim (search_path
    // is transaction-local here, so IF NOT EXISTS resolves inside the schema).
    const migration = readFileSync(MIGRATION_PATH, "utf8");
    await pool.query(`
      BEGIN;
      CREATE SCHEMA ${schemaIdent};
      SET LOCAL search_path TO ${schemaIdent};
      CREATE TABLE mtas (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL);
      ${migration}
      COMMIT;
    `);

    ({ pool: appPool } = await import("../server/db"));
    ({ ADVISORY_LOCK_KEY_ORANGE_TEST_CHECKER: checkerLockKey } = await import("../server/bootstrap-lock"));
    ({ logger } = await import("../server/logger"));
    jobs = await import("../server/services/orange-test-jobs");
    store = new jobs.PgOrangeTestStore({
      query: (text, params) => pool.query(qualify(text), params as unknown[] | undefined),
    });
  }, 60_000);

  afterAll(async () => {
    for (const finalize of finalizers.splice(0).reverse()) await finalize().catch(() => undefined);
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaIdent} CASCADE`).catch((error) => {
        console.warn(`[orange-it] could not drop ${schema}: ${error.message} — the next run sweeps it`);
      });
      await pool.end().catch(() => undefined);
    }
    await appPool?.end().catch(() => undefined);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Tests
  // -------------------------------------------------------------------------

  it("works on a private copy of the table built from migrations/0009, never on public.mta_orange_tests", async () => {
    expect(qualify("UPDATE mta_orange_tests t SET poll_count = 0 WHERE t.id IN (SELECT id FROM mta_orange_tests)")).toBe(
      `UPDATE ${T} t SET poll_count = 0 WHERE t.id IN (SELECT id FROM ${T})`,
    );
    expect(qualify("SELECT hashtext('mta_orange_tests_bootstrap')")).toBe("SELECT hashtext('mta_orange_tests_bootstrap')");

    const shape = await pool.query<{ table_name: string | null; fk_target: string | null; indexes: string[] | null }>(
      `SELECT to_regclass($1)::text AS table_name,
              (SELECT confrelid::regclass::text FROM pg_constraint WHERE conrelid = to_regclass($1) AND contype = 'f') AS fk_target,
              (SELECT array_agg(indexname::text ORDER BY indexname) FROM pg_indexes WHERE schemaname = $2 AND tablename = 'mta_orange_tests') AS indexes`,
      [`${schema}.mta_orange_tests`, schema],
    );
    expect(shape.rows[0].table_name).toBe(`${schema}.mta_orange_tests`);
    expect(shape.rows[0].fk_target).toBe(`${schema}.mtas`);
    expect(shape.rows[0].indexes).toEqual([
      "mta_orange_tests_due_idx",
      "mta_orange_tests_mta_created_idx",
      "mta_orange_tests_pending_mta_idx",
      "mta_orange_tests_pkey",
      "mta_orange_tests_reference_idx",
    ]);
    expect(await store.listForMta("nobody", 5)).toEqual([]);
  });

  it("keeps one pending test per MTA: the partial unique index turns the second insert into null, other errors propagate", async () => {
    const [mta] = await newMtas(1, "pending");
    const first = await store.insertPending(newTestInput(mta));
    expect(first).toMatchObject({
      mtaId: mta, status: "sending", verdict: null, pollCount: 0, requestedBy: "integration-test",
      sentAt: null, nextPollAt: null, deadlineAt: null, finishedAt: null, sendError: null, lastCheckAt: null,
    });
    expect(first!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first!.createdAt).toBeInstanceOf(Date);
    expect(first!.updatedAt).toBeInstanceOf(Date);

    expect(await store.insertPending(newTestInput(mta))).toBeNull(); // 23505 while 'sending'
    expect((await store.findPendingForMta(mta))?.id).toBe(first!.id);
    expect(await store.markSent(first!.id, { sentAt: T0, nextPollAt: at(FAST_POLL), deadlineAt: at(MAX_WAIT) })).toBe(true);
    expect(await store.insertPending(newTestInput(mta))).toBeNull(); // still 23505 while 'waiting'
    expect((await store.findPendingForMta(mta))?.id).toBe(first!.id);

    // Only the unique violation is swallowed: a missing MTA surfaces as the FK error.
    await expect(store.insertPending(newTestInput("no-such-mta"))).rejects.toMatchObject({ code: "23503" });

    // A terminal test frees the slot.
    expect(await store.recordHit(first!.id, hit())).toBe(true);
    expect(await store.findPendingForMta(mta)).toBeNull();
    const second = await store.insertPending(newTestInput(mta));
    expect(second?.id).toBeDefined();
    expect(second!.id).not.toBe(first!.id);
    expect((await store.findPendingForMta(mta))?.id).toBe(second!.id);
    expect(await store.getById("no-such-test")).toBeNull();
  });

  it("markSent / markSendFailed / recordHit / recordCheckOutcome only move a row out of the state they expect", async () => {
    const [mtaA, mtaB] = await newMtas(2, "guards");

    // sending → waiting; afterwards nothing can rewrite the send outcome.
    const a = await pending(mtaA);
    const sentAt = at(-MIN);
    expect(await store.markSent(a.id, { sentAt, nextPollAt: at(-MIN + FAST_POLL), deadlineAt: at(-MIN + MAX_WAIT) })).toBe(true);
    let cur = await row(a.id);
    expect(cur.status).toBe("waiting");
    expect(cur.sentAt?.getTime()).toBe(sentAt.getTime());
    expect(cur.nextPollAt?.getTime()).toBe(sentAt.getTime() + FAST_POLL);
    expect(cur.deadlineAt?.getTime()).toBe(sentAt.getTime() + MAX_WAIT);
    expect(cur.updatedAt.getTime()).toBeGreaterThanOrEqual(a.updatedAt.getTime());
    expect(await store.markSent(a.id, { sentAt: T0, nextPollAt: at(FAST_POLL), deadlineAt: at(MAX_WAIT) })).toBe(false);
    expect(await store.markSendFailed(a.id, SEND_FAILURE, T0)).toBe(false);
    cur = await row(a.id);
    expect(cur.status).toBe("waiting");
    expect(cur.sentAt?.getTime()).toBe(sentAt.getTime());
    expect(cur.sendError).toBeNull();
    expect(cur.finishedAt).toBeNull();

    // Check outcomes stamp the look (time + error), and a later clean look clears the error.
    await store.recordCheckOutcome([a.id], at(-30 * SECOND), "IMAP authentication refused");
    cur = await row(a.id);
    expect(cur.lastCheckAt?.getTime()).toBe(at(-30 * SECOND).getTime());
    expect(cur.lastCheckError).toBe("IMAP authentication refused");
    await store.recordCheckOutcome([a.id], at(-10 * SECOND), null);
    cur = await row(a.id);
    expect(cur.lastCheckAt?.getTime()).toBe(at(-10 * SECOND).getTime());
    expect(cur.lastCheckError).toBeNull();
    await store.recordCheckOutcome([], at(-SECOND), "ignored"); // empty batch is a no-op
    expect((await row(a.id)).lastCheckAt?.getTime()).toBe(at(-10 * SECOND).getTime());

    // waiting → done with every field of the hit; then terminal for hits and check outcomes alike.
    const found = hit({ verdict: "GOOD", spamLevelRaw: "not-spam", foundIn: "inbox", foundFolder: "INBOX", receivedAt: at(-20 * SECOND), finishedAt: T0 });
    expect(await store.recordHit(a.id, found)).toBe(true);
    cur = await row(a.id);
    expect(cur).toMatchObject({
      status: "done", verdict: "GOOD", spamLevelRaw: "not-spam", foundIn: "inbox", foundFolder: "INBOX", matchedBy: "message-id",
      rawHeaders: found.rawHeaders, lastCheckError: null, nextPollAt: null,
    });
    expect(cur.receivedAt?.getTime()).toBe(found.receivedAt!.getTime());
    expect(cur.finishedAt?.getTime()).toBe(T0.getTime());
    expect(cur.lastCheckAt?.getTime()).toBe(T0.getTime());
    expect(await store.recordHit(a.id, hit({ verdict: "BLOCKED" }))).toBe(false);
    await store.recordCheckOutcome([a.id], at(MIN), "late error");
    cur = await row(a.id);
    expect(cur.verdict).toBe("GOOD");
    expect(cur.lastCheckError).toBeNull();
    expect(cur.lastCheckAt?.getTime()).toBe(T0.getTime());

    // sending → failed keeps the SMTP detail; a hit can never land on a row that was never sent.
    const b = await pending(mtaB);
    expect(await store.recordHit(b.id, hit())).toBe(false);
    expect(await store.markSendFailed(b.id, SEND_FAILURE, T0)).toBe(true);
    cur = await row(b.id);
    expect(cur).toMatchObject({ status: "failed", verdict: null, sendError: SEND_FAILURE, sentAt: null, nextPollAt: null, deadlineAt: null });
    expect(cur.finishedAt?.getTime()).toBe(T0.getTime());
    expect(await store.markSent(b.id, { sentAt: T0, nextPollAt: at(FAST_POLL), deadlineAt: at(MAX_WAIT) })).toBe(false);
    expect(await store.markSendFailed(b.id, { stage: "Connection" }, at(MIN))).toBe(false);
    cur = await row(b.id);
    expect(cur.status).toBe("failed");
    expect(cur.sendError).toEqual(SEND_FAILURE);
    expect(cur.finishedAt?.getTime()).toBe(T0.getTime());
  });

  it("claimDue takes due waiting rows in poll order, skips rows another session holds, and reschedules fast/slow", async () => {
    const [m1, m2, m3, m4, m5, m6, m7] = await newMtas(7, "claim");
    const [fast, slow, boundary, notDue, locked] = await Promise.all([
      waiting(m1, { sentAt: at(-MIN), nextPollAt: at(-20 * SECOND) }), // fast phase, due
      waiting(m2, { sentAt: at(-10 * MIN), nextPollAt: at(-30 * SECOND) }), // slow phase, due before `fast`
      waiting(m3, { sentAt: at(-FAST_PHASE), nextPollAt: T0 }), // age == fast phase → slow; due at exactly `now`
      waiting(m4, { sentAt: at(-MIN), nextPollAt: at(SECOND) }), // not due yet
      waiting(m5, { sentAt: at(-MIN), nextPollAt: at(-40 * SECOND) }), // due first of all, but locked below
    ]);
    const stillSending = await pending(m6);
    const done = await waiting(m7, { sentAt: at(-MIN), nextPollAt: at(-MIN) });
    expect(await store.recordHit(done.id, hit())).toBe(true);
    await pool.query(`UPDATE ${T} SET next_poll_at = $2 WHERE id = $1`, [done.id, at(-MIN)]); // due-looking but terminal

    // Another session holds `locked` (as a concurrent checker instance would mid-claim).
    const locker = await pool.connect();
    let lockerDone = false;
    const releaseLocker = async () => {
      if (lockerDone) return;
      lockerDone = true;
      await locker.query("ROLLBACK").catch(() => undefined);
      locker.release();
    };
    finalizers.push(releaseLocker);
    await locker.query("BEGIN");
    await locker.query(`SELECT id FROM ${T} WHERE id = $1 FOR UPDATE`, [locked.id]);
    try {
      const first = await store.claimDue(T0, 1, INTERVALS);
      expect(first.map((r) => r.id)).toEqual([slow.id]); // LIMIT applies after the locked row is skipped
      expect(first[0].pollCount).toBe(1);
      expect(first[0].status).toBe("waiting");
      expect(first[0].nextPollAt?.getTime()).toBe(T0.getTime() + SLOW_POLL);

      // ORDER BY next_poll_at decides WHICH rows fit under the limit; the order UPDATE … RETURNING
      // hands them back in is not guaranteed (and the checker does not depend on it).
      const rest = await store.claimDue(T0, 10, INTERVALS);
      expect(rest.map((r) => r.id).sort()).toEqual([fast.id, boundary.id].sort());
      const byId = new Map(rest.map((r) => [r.id, r]));
      expect(byId.get(fast.id)?.nextPollAt?.getTime()).toBe(T0.getTime() + FAST_POLL);
      expect(byId.get(boundary.id)?.nextPollAt?.getTime()).toBe(T0.getTime() + SLOW_POLL);
      expect(rest.map((r) => r.pollCount)).toEqual([1, 1]);

      expect(await store.claimDue(T0, 10, INTERVALS)).toEqual([]);
    } finally {
      await releaseLocker();
    }

    const afterUnlock = await store.claimDue(T0, 10, INTERVALS);
    expect(afterUnlock.map((r) => r.id)).toEqual([locked.id]);
    expect(afterUnlock[0].pollCount).toBe(1);
    expect(afterUnlock[0].nextPollAt?.getTime()).toBe(T0.getTime() + FAST_POLL);

    // The claim is persisted, not only returned; a second claim in the same instant finds nothing.
    expect((await row(slow.id)).nextPollAt?.getTime()).toBe(T0.getTime() + SLOW_POLL);
    expect((await row(slow.id)).pollCount).toBe(1);
    expect(await store.claimDue(T0, 10, INTERVALS)).toEqual([]);
    expect((await store.claimDue(at(SECOND), 10, INTERVALS)).map((r) => r.id)).toEqual([notDue.id]);

    // Rows that were never candidates are untouched.
    for (const [id, status] of [[stillSending.id, "sending"], [done.id, "done"]] as const) {
      const cur = await row(id);
      expect(cur.status).toBe(status);
      expect(cur.pollCount).toBe(0);
    }
    expect((await row(done.id)).verdict).toBe("SPAM");
  });

  it("expireOverdue closes a waiting test as NOT RECEIVED only after a clean look that started past its deadline; closeUnchecked closes the rest as NOT CHECKED once the grace period is over", async () => {
    const mtas = await newMtas(9, "expire");
    const deadline = at(-10 * MIN);
    const [clean, early, errored, unchecked, graceUnchecked, graceErrored, future] = await Promise.all([
      waiting(mtas[0], { sentAt: at(-DAY), deadlineAt: deadline }),
      waiting(mtas[1], { sentAt: at(-DAY), deadlineAt: deadline }),
      waiting(mtas[2], { sentAt: at(-DAY), deadlineAt: deadline }),
      waiting(mtas[3], { sentAt: at(-DAY), deadlineAt: deadline }),
      waiting(mtas[4], { sentAt: at(-DAY), deadlineAt: at(-GRACE - MIN) }),
      waiting(mtas[5], { sentAt: at(-DAY), deadlineAt: at(-GRACE - MIN) }),
      waiting(mtas[6], { sentAt: at(-DAY), deadlineAt: at(MIN) }),
    ]);
    const terminal = await waiting(mtas[7], { sentAt: at(-DAY), deadlineAt: at(-DAY) });
    expect(await store.recordHit(terminal.id, hit())).toBe(true);
    const noDeadline = await waiting(mtas[8], { sentAt: at(-DAY), deadlineAt: deadline });
    await pool.query(`UPDATE ${T} SET deadline_at = NULL WHERE id = $1`, [noDeadline.id]);
    await Promise.all([
      store.recordCheckOutcome([clean.id], at(-5 * MIN), null), // look started after the deadline, clean
      store.recordCheckOutcome([early.id], at(-11 * MIN), null), // look started BEFORE the deadline (session straddled it)
      store.recordCheckOutcome([errored.id], at(-5 * MIN), "IMAP down"),
      store.recordCheckOutcome([graceErrored.id], at(-MIN), "IMAP down"),
      store.recordCheckOutcome([future.id], T0, null),
    ]);

    // Only the clean post-deadline look yields a verdict …
    expect(await store.expireOverdue(T0)).toBe(1);
    const closedClean = await row(clean.id);
    expect(closedClean).toMatchObject({ status: "not_received", verdict: "NOT_RECEIVED", nextPollAt: null });
    expect(closedClean.finishedAt?.getTime()).toBe(T0.getTime());
    // … the two past the grace period close WITHOUT one: nothing was ever seen after their window.
    expect(await store.closeUnchecked(T0, GRACE)).toBe(2);
    for (const r of [graceUnchecked, graceErrored]) {
      const cur = await row(r.id);
      expect(cur).toMatchObject({ status: "not_checked", verdict: null, nextPollAt: null });
      expect(cur.finishedAt?.getTime()).toBe(T0.getTime());
    }
    for (const r of [early, errored, unchecked, future, noDeadline]) {
      const cur = await row(r.id);
      expect(cur.status).toBe("waiting");
      expect(cur.verdict).toBeNull();
      expect(cur.finishedAt).toBeNull();
      expect(cur.nextPollAt).not.toBeNull();
    }
    expect((await row(terminal.id)).status).toBe("done");
    expect(await store.expireOverdue(T0)).toBe(0);
    expect(await store.closeUnchecked(T0, GRACE)).toBe(0);

    // A clean look past the deadline now closes the straddled and the previously failing tests as NOT RECEIVED …
    await store.recordCheckOutcome([early.id, errored.id], T0, null);
    expect(await store.expireOverdue(at(SECOND))).toBe(2);
    expect((await row(early.id))).toMatchObject({ status: "not_received", verdict: "NOT_RECEIVED" });
    expect((await row(errored.id))).toMatchObject({ status: "not_received", verdict: "NOT_RECEIVED" });
    // … while a never-checked test only closes — as NOT CHECKED — when the grace period is over (deadline + 1 h, inclusive).
    expect(await store.expireOverdue(at(GRACE - 10 * MIN))).toBe(0);
    expect(await store.closeUnchecked(at(GRACE - 10 * MIN - SECOND), GRACE)).toBe(0);
    expect(await store.closeUnchecked(at(GRACE - 10 * MIN), GRACE)).toBe(1);
    expect((await row(unchecked.id))).toMatchObject({ status: "not_checked", verdict: null });
    expect((await row(unchecked.id)).finishedAt?.getTime()).toBe(at(GRACE - 10 * MIN).getTime());
    // `future` is overdue by then, but its only look started before its deadline and its grace is not over.
    expect((await row(future.id)).status).toBe("waiting");
    expect((await row(noDeadline.id)).status).toBe("waiting");
  });

  it("releaseStaleSending resumes rows stuck in 'sending' as waiting rows anchored on their creation time", async () => {
    const [m1, m2, m3] = await newMtas(3, "stale");
    const stale = await pending(m1);
    await setCreatedAt(stale.id, at(-20 * MIN));
    const fresh = await pending(m2);
    const alreadyWaiting = await waiting(m3, { sentAt: at(-20 * MIN) });

    expect(await store.releaseStaleSending(at(-10 * MIN), "resumed after a restart", T0, MAX_WAIT, FAST_POLL)).toBe(1);
    const cur = await row(stale.id);
    expect(cur.status).toBe("waiting");
    expect(cur.sendNote).toBe("resumed after a restart");
    expect(cur.createdAt.getTime()).toBe(at(-20 * MIN).getTime());
    expect(cur.sentAt?.getTime()).toBe(at(-20 * MIN).getTime());
    expect(cur.nextPollAt?.getTime()).toBe(T0.getTime() + FAST_POLL);
    expect(cur.deadlineAt?.getTime()).toBe(at(-20 * MIN).getTime() + MAX_WAIT);
    expect(await store.insertPending(newTestInput(m1))).toBeNull(); // still the MTA's pending test

    const untouched = await row(fresh.id);
    expect(untouched.status).toBe("sending");
    expect(untouched.sendNote).toBeNull();
    const still = await row(alreadyWaiting.id);
    expect(still.sendNote).toBeNull();
    expect(still.nextPollAt?.getTime()).toBe(at(-20 * MIN).getTime() + FAST_POLL);
    expect(await store.releaseStaleSending(at(-10 * MIN), "again", T0, MAX_WAIT, FAST_POLL)).toBe(0);
  });

  it("controlValues and listForMta order by send time (COALESCE(sent_at, created_at)), never by when the verdict arrived", async () => {
    const [x, z, y] = await newMtas(3, "control");
    // A: sent two days ago, verdict recorded one hour ago (a late delivery). B: sent yesterday, verdict right away.
    const a = await waiting(x, { sentAt: at(-2 * DAY) });
    expect(await store.recordHit(a.id, hit({ verdict: "BLOCKED", spamLevelRaw: "med", receivedAt: at(-2 * HOUR), finishedAt: at(-HOUR) }))).toBe(true);
    const b = await waiting(x, { sentAt: at(-DAY) });
    expect(
      await store.recordHit(b.id, hit({ verdict: "GOOD", spamLevelRaw: "not-spam", foundIn: "inbox", foundFolder: "INBOX", receivedAt: at(-DAY + MIN), finishedAt: at(-DAY + 2 * MIN) })),
    ).toBe(true);
    const zWaiting = await waiting(z, { sentAt: at(-30 * MIN) });

    let values = await store.controlValues([x, z, y]);
    expect(values.get(x)?.latest?.id).toBe(b.id);
    expect(values.get(x)?.latestVerdict?.id).toBe(b.id);
    expect(values.get(x)?.latestVerdict?.verdict).toBe("GOOD");
    expect(values.get(z)?.latest?.id).toBe(zWaiting.id);
    expect(values.get(z)?.latest?.status).toBe("waiting");
    expect(values.get(z)?.latestVerdict).toBeNull();
    expect(values.has(y)).toBe(false);
    expect((await store.controlValues([])).size).toBe(0);

    // C: a refused hand-off half a day ago (never sent → ordered by created_at) is the latest test; the verdict stays B's.
    const c = await pending(x);
    await setCreatedAt(c.id, at(-12 * HOUR));
    expect(await store.markSendFailed(c.id, SEND_FAILURE, at(-12 * HOUR + 5 * SECOND))).toBe(true);
    values = await store.controlValues([x]);
    expect(values.get(x)?.latest?.id).toBe(c.id);
    expect(values.get(x)?.latest?.status).toBe("failed");
    expect(values.get(x)?.latest?.verdict).toBeNull();
    expect(values.get(x)?.latest?.sendError).toEqual(SEND_FAILURE);
    expect(values.get(x)?.latestVerdict?.id).toBe(b.id);
    // Views are the wire shape: ISO strings and the computed delivery delay.
    expect(values.get(x)?.latestVerdict?.sentAt).toBe(at(-DAY).toISOString());
    expect(values.get(x)?.latestVerdict?.deliveryDelayMs).toBe(MIN);
    expect(values.get(x)?.latest?.createdAt).toBe(at(-12 * HOUR).toISOString());

    // History follows the same order and honours the limit.
    expect((await store.listForMta(x, 10)).map((r) => r.id)).toEqual([c.id, b.id, a.id]);
    expect((await store.listForMta(x, 2)).map((r) => r.id)).toEqual([c.id, b.id]);
    expect(await store.listForMta(y, 10)).toEqual([]);
  });

  it("acquirePgCheckerLease is exclusive across connections, transaction-scoped, and released by release()", async () => {
    const baseline = (await appPool.query("SHOW idle_in_transaction_session_timeout")).rows[0].idle_in_transaction_session_timeout as string;
    expect(baseline).not.toBe("45s");
    const { clients, restore } = captureLeaseClients();
    finalizers.push(async () => restore());
    const lease = await acquireLeaseOrWait(45 * SECOND);
    finalizers.push(() => lease.release());
    try {
      const leaseClient = clients.at(-1)!;
      // The budget is applied to the lease transaction (SHOW inside it) …
      expect((await leaseClient.query("SHOW idle_in_transaction_session_timeout")).rows[0].idle_in_transaction_session_timeout).toBe("45s");
      expect((await leaseClient.query("SELECT setting FROM pg_settings WHERE name = 'idle_in_transaction_session_timeout'")).rows[0].setting).toBe("45000");
      // … on a backend that sits idle in transaction while holding the checker's advisory lock.
      const pid = Number((await leaseClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      const holder = await pool.query(
        `SELECT a.state, l.granted
         FROM pg_stat_activity a
         JOIN pg_locks l ON l.pid = a.pid
         WHERE a.pid = $1 AND l.locktype = 'advisory' AND l.classid = 0 AND l.objid = $2 AND l.objsubid = 1`,
        [pid, checkerLockKey],
      );
      expect(holder.rows).toEqual([{ state: "idle in transaction", granted: true }]);

      // A second acquisition, from another connection, loses immediately (no waiting on the lock).
      const started = Date.now();
      expect(await jobs.acquirePgCheckerLease(45 * SECOND)).toBeNull();
      expect(Date.now() - started).toBeLessThan(5 * SECOND);
      const idleInTx = await pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid
         WHERE l.locktype = 'advisory' AND l.classid = 0 AND l.objid = $1 AND l.objsubid = 1`,
        [checkerLockKey],
      );
      expect(idleInTx.rows[0].n).toBe(1); // the loser did not queue on the lock
    } finally {
      await lease.release();
      restore();
    }

    // release() committed: the lock is free again …
    const again = await acquireLeaseOrWait(45 * SECOND);
    await again.release();
    await again.release(); // idempotent
    // … and the timeout was transaction-local: sessions are back to their default.
    expect((await appPool.query("SHOW idle_in_transaction_session_timeout")).rows[0].idle_in_transaction_session_timeout).toBe(baseline);
  });

  it("a holder that hangs loses the lease when idle_in_transaction_session_timeout fires, and release() survives it", async () => {
    const { clients, restore } = captureLeaseClients();
    finalizers.push(async () => restore());
    // 1 s is the clamped minimum budget: PostgreSQL drops the idle backend (and its lock) after one second.
    const hung = await acquireLeaseOrWait(SECOND);
    finalizers.push(() => hung.release());
    const hungClient = clients.at(-1)!;
    try {
      let winner: CheckerLease | null = null;
      const deadline = Date.now() + 10 * SECOND;
      while (!winner && Date.now() < deadline) {
        await sleep(250);
        winner = await jobs.acquirePgCheckerLease(45 * SECOND);
      }
      expect(winner).not.toBeNull();
      await winner!.release();
    } finally {
      restore();
    }
    // The dropped backend reaches the process as 'error' events on the checked-out client (the FATAL,
    // then the socket end): the lease must own a listener or they become uncaught exceptions.
    expect(hungClient.listenerCount("error")).toBeGreaterThan(0);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(expect.stringMatching(/Checker lease connection dropped by PostgreSQL/));
    await expect(hung.release()).resolves.toBeUndefined();
    await expect(hung.release()).resolves.toBeUndefined(); // idempotent after a loss too
    // The pool is healthy afterwards: the dead client was discarded, not recycled.
    const fresh = await acquireLeaseOrWait(45 * SECOND);
    await fresh.release();
  });
});
