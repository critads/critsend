import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../server/db", () => ({ db: {}, pool: { query: vi.fn() } }));
vi.mock("../server/storage", () => ({ storage: { getMta: vi.fn() } }));
vi.mock("../server/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../server/services/plain-test-sender", () => ({
  PLAIN_TEST_SUBJECT: "Hello moon",
  PLAIN_TEST_BODY: "I'm the sun",
  sendPlainTestEmail: vi.fn(),
  classifySmtpError: vi.fn(),
}));
vi.mock("../server/services/orange-mailbox-reader", () => ({ lookupOrangeTests: vi.fn() }));

import {
  buildOrangeTestMessageId,
  createOrangeTestService,
  EXPIRY_GRACE_MS,
  generateOrangeTestReference,
  OrangeTestError,
  STALE_SENDING_NOTE,
  type ClaimIntervals,
  type HitInput,
  type MarkSentInput,
  type NewOrangeTest,
  type OrangeTestRecord,
  type OrangeTestServiceDeps,
  type OrangeTestStore,
} from "../server/services/orange-test-jobs";
import { nextPollDelayMs, type OrangeTestConfig } from "../server/config/orange-test";
import type { MailboxLookupHit, MailboxLookupResult } from "../server/services/orange-mailbox-reader";
import type { OrangeTestControlValue, OrangeTestSendFailure } from "../shared/orange-test";
import { toOrangeTestView } from "../server/services/orange-test-jobs";

// ---------------------------------------------------------------------------
// In-memory store mirroring the SQL semantics (status guards, ordering by send time)
// ---------------------------------------------------------------------------

class MemoryStore implements OrangeTestStore {
  rows: OrangeTestRecord[] = [];
  private seq = 0;
  constructor(private readonly clock: () => Date) {}

  private sentOrCreated(r: OrangeTestRecord) { return (r.sentAt ?? r.createdAt).getTime(); }
  private bySendDesc = (a: OrangeTestRecord, b: OrangeTestRecord) =>
    this.sentOrCreated(b) - this.sentOrCreated(a) || b.createdAt.getTime() - a.createdAt.getTime();

  async insertPending(input: NewOrangeTest): Promise<OrangeTestRecord | null> {
    if (this.rows.some((r) => r.mtaId === input.mtaId && (r.status === "sending" || r.status === "waiting"))) return null;
    const now = this.clock();
    const row: OrangeTestRecord = {
      id: `t${++this.seq}`, mtaId: input.mtaId, reference: input.reference, messageId: input.messageId,
      status: "sending", verdict: null, spamLevelRaw: null, foundIn: null, foundFolder: null, matchedBy: null,
      rawHeaders: null, mailbox: input.mailbox, fromEmail: input.fromEmail, requestedBy: input.requestedBy,
      sendError: null, sendNote: null, lastCheckError: null, lastCheckAt: null, pollCount: 0,
      createdAt: now, sentAt: null, nextPollAt: null, deadlineAt: null, receivedAt: null, finishedAt: null, updatedAt: now,
    };
    this.rows.push(row);
    return { ...row };
  }
  async findPendingForMta(mtaId: string) {
    const pending = this.rows.filter((r) => r.mtaId === mtaId && (r.status === "sending" || r.status === "waiting"));
    pending.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return pending[0] ? { ...pending[0] } : null;
  }
  async getById(id: string) { const r = this.rows.find((x) => x.id === id); return r ? { ...r } : null; }
  async listForMta(mtaId: string, limit: number) {
    return this.rows.filter((r) => r.mtaId === mtaId).sort(this.bySendDesc).slice(0, limit).map((r) => ({ ...r }));
  }
  async controlValues(mtaIds: string[]) {
    const out = new Map<string, OrangeTestControlValue>();
    for (const id of mtaIds) {
      const rows = this.rows.filter((r) => r.mtaId === id).sort(this.bySendDesc);
      if (rows.length === 0) continue;
      const latestVerdict = rows.find((r) => r.verdict !== null) ?? null;
      out.set(id, { latest: toOrangeTestView(rows[0]), latestVerdict: latestVerdict ? toOrangeTestView(latestVerdict) : null });
    }
    return out;
  }
  async markSent(id: string, input: MarkSentInput) {
    const r = this.rows.find((x) => x.id === id && x.status === "sending");
    if (!r) return false;
    Object.assign(r, { status: "waiting", sentAt: input.sentAt, nextPollAt: input.nextPollAt, deadlineAt: input.deadlineAt });
    return true;
  }
  async markSendFailed(id: string, sendError: OrangeTestSendFailure, finishedAt: Date) {
    const r = this.rows.find((x) => x.id === id && x.status === "sending");
    if (!r) return false;
    Object.assign(r, { status: "failed", sendError, finishedAt });
    return true;
  }
  async releaseStaleSending(staleBefore: Date, note: string, now: Date, maxWaitMs: number, firstPollMs: number) {
    let n = 0;
    for (const r of this.rows) {
      if (r.status !== "sending" || r.createdAt >= staleBefore) continue;
      Object.assign(r, {
        status: "waiting", sendNote: note, sentAt: r.createdAt,
        nextPollAt: new Date(now.getTime() + firstPollMs), deadlineAt: new Date(r.createdAt.getTime() + maxWaitMs),
      });
      n++;
    }
    return n;
  }
  async expireOverdue(now: Date, graceMs: number) {
    let n = 0;
    for (const r of this.rows) {
      if (r.status !== "waiting" || !r.deadlineAt || r.deadlineAt > now) continue;
      const checkedClean = Boolean(r.lastCheckAt && r.lastCheckAt >= r.deadlineAt && !r.lastCheckError);
      const pastGrace = r.deadlineAt.getTime() <= now.getTime() - graceMs;
      if (!checkedClean && !pastGrace) continue;
      Object.assign(r, { status: "not_received", verdict: "NOT_RECEIVED", finishedAt: now, nextPollAt: null });
      n++;
    }
    return n;
  }
  async claimDue(now: Date, limit: number, intervals: ClaimIntervals) {
    const due = this.rows
      .filter((r) => r.status === "waiting" && r.nextPollAt && r.nextPollAt <= now)
      .sort((a, b) => a.nextPollAt!.getTime() - b.nextPollAt!.getTime())
      .slice(0, limit);
    for (const r of due) {
      const age = now.getTime() - (r.sentAt ?? r.createdAt).getTime();
      r.nextPollAt = new Date(now.getTime() + nextPollDelayMs(age, intervals));
      r.pollCount += 1;
    }
    return due.map((r) => ({ ...r }));
  }
  async recordHit(id: string, hit: HitInput) {
    const r = this.rows.find((x) => x.id === id && x.status === "waiting");
    if (!r) return false;
    Object.assign(r, {
      status: "done", verdict: hit.verdict, spamLevelRaw: hit.spamLevelRaw, foundIn: hit.foundIn, foundFolder: hit.foundFolder,
      matchedBy: hit.matchedBy, rawHeaders: hit.rawHeaders, receivedAt: hit.receivedAt, finishedAt: hit.finishedAt,
      lastCheckAt: hit.finishedAt, lastCheckError: null, nextPollAt: null,
    });
    return true;
  }
  async recordCheckOutcome(ids: string[], at: Date, error: string | null) {
    for (const r of this.rows) {
      if (ids.includes(r.id) && r.status === "waiting") Object.assign(r, { lastCheckAt: at, lastCheckError: error });
    }
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const FAST_POLL = 30_000;
const FAST_PHASE = 5 * 60_000;
const SLOW_POLL = 5 * 60_000;
const MAX_WAIT = 48 * 3600_000;

function config(overrides: Partial<OrangeTestConfig> = {}): OrangeTestConfig {
  return {
    mailbox: "ianisbaulle@orange.fr", imapHost: "imap.orange.fr", imapPort: 993, imapSecure: true,
    imapUser: "ianisbaulle@orange.fr", imapPassword: "pw", enabled: true,
    maxWaitMs: MAX_WAIT, maxWaitHours: 48, fastPollMs: FAST_POLL, fastPhaseMs: FAST_PHASE, slowPollMs: SLOW_POLL,
    fastPollSeconds: 30, fastPhaseMinutes: 5, slowPollMinutes: 5,
    imapTimeoutMs: 30_000, sessionTimeoutMs: 120_000, checkerIntervalMs: 15_000, checkerBatchSize: 50, staleSendingMs: 600_000, staleVerdictDays: 7,
    ...overrides,
  };
}

const MTA: any = { id: "mta-1", name: "MTA One", fromEmail: "news@mail.example.com", mode: "smtp", hostname: "h", port: 25 };

function hitFor(reference: string, spamLevelRaw: string | null, folder: "inbox" | "junk" = "inbox", receivedAt = new Date()): MailboxLookupHit {
  return {
    reference, folder, folderPath: folder === "inbox" ? "INBOX" : "Junk", matchedBy: "message-id",
    messageId: `<${reference}@mail.example.com>`, spamLevelRaw, headers: { "x-me-spamlevel": spamLevelRaw ?? "" }, receivedAt,
  };
}

function harness(opts: { start?: Date; configOverrides?: Partial<OrangeTestConfig>; acquireCheckerLease?: OrangeTestServiceDeps["acquireCheckerLease"] } = {}) {
  let now = opts.start ?? new Date("2026-09-28T10:00:00Z");
  const clock = () => new Date(now);
  const store = new MemoryStore(clock);
  const sendPlainTest = vi.fn(async () => ({ success: true, connectionTimeMs: 12, messageId: "<x>" }));
  const lookupMailbox = vi.fn(async (): Promise<MailboxLookupResult> => ({ hits: new Map(), foldersSearched: ["INBOX", "Junk"], warnings: [] }));
  const cfg = config(opts.configOverrides);
  const getMta = vi.fn(async (id: string) => (id === MTA.id ? MTA : undefined));
  const service = createOrangeTestService({
    store, getMta, sendPlainTest: sendPlainTest as any, lookupMailbox: lookupMailbox as any, getConfig: () => cfg, now: clock,
    acquireCheckerLease: opts.acquireCheckerLease,
  });
  return {
    store, service, sendPlainTest, lookupMailbox, cfg,
    advance(ms: number) { now = new Date(now.getTime() + ms); },
    now: clock,
  };
}

describe("Orange test references", () => {
  it("builds a dated, unique, uppercase reference and a Message-ID on the sender domain", () => {
    const ref = generateOrangeTestReference(new Date("2026-09-28T23:59:00Z"));
    expect(ref).toMatch(/^OT-20260928-[0-9A-F]{8}$/);
    expect(generateOrangeTestReference()).not.toBe(generateOrangeTestReference());
    expect(buildOrangeTestMessageId(ref, "News <news@Mail.Example.com>".replace(/.*<|>.*/g, ""))).toBe(`<${ref}@mail.example.com>`);
    expect(buildOrangeTestMessageId(ref, "broken")).toBe(`<${ref}@orange-test.invalid>`);
  });
});

describe("startOrangeTest", () => {
  it("refuses when not configured, when the MTA is missing, nullsink or has no From", async () => {
    const off = harness({ configOverrides: { enabled: false, imapPassword: "" } });
    await expect(off.service.startOrangeTest("mta-1", "u1")).rejects.toMatchObject({ code: "NOT_CONFIGURED", httpStatus: 503 });

    const h = harness();
    await expect(h.service.startOrangeTest("nope", "u1")).rejects.toMatchObject({ code: "MTA_NOT_FOUND", httpStatus: 404 });
    h.store.rows.length = 0;
    (h as any).service = createOrangeTestService({
      store: h.store, getMta: async () => ({ ...MTA, mode: "nullsink" }), sendPlainTest: h.sendPlainTest as any,
      lookupMailbox: h.lookupMailbox as any, getConfig: () => h.cfg, now: h.now,
    });
    await expect(h.service.startOrangeTest("mta-1", "u1")).rejects.toBeInstanceOf(OrangeTestError);
    const noFrom = createOrangeTestService({
      store: h.store, getMta: async () => ({ ...MTA, fromEmail: "" }), sendPlainTest: h.sendPlainTest as any,
      lookupMailbox: h.lookupMailbox as any, getConfig: () => h.cfg, now: h.now,
    });
    await expect(noFrom.startOrangeTest("mta-1", "u1")).rejects.toMatchObject({ code: "MTA_NOT_ELIGIBLE", httpStatus: 400 });
    expect(h.sendPlainTest).not.toHaveBeenCalled();
  });

  it("sends the raw Plain Test with a pre-set Message-ID and a Ref line, then waits", async () => {
    const h = harness();
    const { test, reused, completion } = await h.service.startOrangeTest("mta-1", "user-7");
    expect(reused).toBe(false);
    expect(test.status).toBe("sending");
    await completion;
    expect(h.sendPlainTest).toHaveBeenCalledTimes(1);
    const [mta, to, headers, options] = h.sendPlainTest.mock.calls[0] as unknown as [any, string, unknown, { messageId: string; bodySuffix: string }];
    expect(mta.id).toBe("mta-1");
    expect(to).toBe("ianisbaulle@orange.fr");
    expect(headers).toBeUndefined();
    expect(options.messageId).toBe(`<${test.reference}@mail.example.com>`);
    expect(options.bodySuffix).toBe(`Ref: ${test.reference}`);
    const after = (await h.service.getOrangeTest(test.id))!;
    expect(after.status).toBe("waiting");
    expect(after.sentAt).toBe(h.now().toISOString());
    expect(new Date(after.nextPollAt!).getTime() - new Date(after.sentAt!).getTime()).toBe(FAST_POLL);
    expect(new Date(after.deadlineAt!).getTime() - new Date(after.sentAt!).getTime()).toBe(MAX_WAIT);
    expect(after.requestedBy).toBe("user-7");
  });

  it("keeps the full SMTP error detail when the MTA refuses the message", async () => {
    const h = harness();
    h.sendPlainTest.mockResolvedValueOnce({
      success: false, connectionTimeMs: 40, stage: "Authentication", errorCode: "EAUTH", errorMessage: "535 5.7.8 Bad credentials",
      smtpCode: 535, suggestions: ["Check the username"],
    } as any);
    const { test, completion } = await h.service.startOrangeTest("mta-1", null);
    await completion;
    const after = (await h.service.getOrangeTest(test.id))!;
    expect(after.status).toBe("failed");
    expect(after.verdict).toBeNull();
    expect(after.sendError).toMatchObject({ stage: "Authentication", smtpCode: 535, errorCode: "EAUTH", suggestions: ["Check the username"] });
    // A failed send is terminal: a new test can be started right away.
    const again = await h.service.startOrangeTest("mta-1", null);
    expect(again.reused).toBe(false);
    expect(again.test.id).not.toBe(test.id);
  });

  it("is idempotent while a test is pending (one pending test per MTA)", async () => {
    const h = harness();
    const first = await h.service.startOrangeTest("mta-1", null);
    await first.completion;
    const second = await h.service.startOrangeTest("mta-1", null);
    expect(second.reused).toBe(true);
    expect(second.test.id).toBe(first.test.id);
    expect(h.sendPlainTest).toHaveBeenCalledTimes(1);
    expect(h.store.rows).toHaveLength(1);
  });
});

describe("checker tick", () => {
  it("does nothing before the first poll is due, then finds the message and records the verdict", async () => {
    const h = harness();
    const { test, completion } = await h.service.startOrangeTest("mta-1", null);
    await completion;

    let stats = await h.service.runCheckerTick();
    expect(stats.claimed).toBe(0);
    expect(h.lookupMailbox).not.toHaveBeenCalled();

    h.advance(FAST_POLL);
    stats = await h.service.runCheckerTick();
    expect(stats.claimed).toBe(1);
    expect(stats.found).toBe(0);
    let row = (await h.service.getOrangeTest(test.id))!;
    expect(row.status).toBe("waiting");
    expect(row.pollCount).toBe(1);
    expect(row.lastCheckAt).toBe(h.now().toISOString());
    expect(row.lastCheckError).toBeNull();
    expect(new Date(row.nextPollAt!).getTime() - h.now().getTime()).toBe(FAST_POLL);

    const receivedAt = new Date(h.now().getTime() + 5_000);
    h.advance(FAST_POLL);
    h.lookupMailbox.mockResolvedValueOnce({ hits: new Map([[test.reference, hitFor(test.reference, "low", "junk", receivedAt)]]), foldersSearched: ["INBOX", "Junk"], warnings: [] });
    stats = await h.service.runCheckerTick();
    expect(stats.found).toBe(1);
    row = (await h.service.getOrangeTest(test.id))!;
    expect(row.status).toBe("done");
    expect(row.verdict).toBe("SPAM");
    expect(row.spamLevelRaw).toBe("low");
    expect(row.foundIn).toBe("junk");
    expect(row.foundFolder).toBe("Junk");
    expect(row.deliveryDelayMs).toBe(receivedAt.getTime() - new Date(row.sentAt!).getTime());
    expect(row.nextPollAt).toBeNull();

    // Terminal: later ticks never touch it again.
    h.advance(SLOW_POLL);
    stats = await h.service.runCheckerTick();
    expect(stats.claimed).toBe(0);
  });

  it("maps the header to verdicts: not-spam GOOD, med BLOCKED, missing UNKNOWN", async () => {
    const cases: Array<[string | null, string]> = [["not-spam", "GOOD"], ["med", "BLOCKED"], [null, "UNKNOWN"], ["high", "BLOCKED"]];
    for (const [raw, expected] of cases) {
      const h = harness();
      const { test, completion } = await h.service.startOrangeTest("mta-1", null);
      await completion;
      h.advance(FAST_POLL);
      h.lookupMailbox.mockResolvedValueOnce({ hits: new Map([[test.reference, hitFor(test.reference, raw)]]), foldersSearched: [], warnings: [] });
      await h.service.runCheckerTick();
      const row = (await h.service.getOrangeTest(test.id))!;
      expect(row.verdict).toBe(expected);
      expect(row.spamLevelRaw).toBe(raw);
    }
  });

  it("slows down after the fast phase and closes the test as NOT RECEIVED at the deadline", async () => {
    const h = harness();
    const { test, completion } = await h.service.startOrangeTest("mta-1", null);
    await completion;
    h.advance(FAST_PHASE + 1_000);
    await h.service.runCheckerTick();
    let row = (await h.service.getOrangeTest(test.id))!;
    expect(new Date(row.nextPollAt!).getTime() - h.now().getTime()).toBe(SLOW_POLL);

    // Deadline reached: the row is NOT closed on the clock alone — it is
    // polled one last time (a message can land in the final minutes)…
    h.advance(MAX_WAIT);
    let stats = await h.service.runCheckerTick();
    expect(stats.expired).toBe(0);
    expect(stats.claimed).toBe(1);
    row = (await h.service.getOrangeTest(test.id))!;
    expect(row.status).toBe("waiting");
    expect(row.lastCheckAt).toBe(h.now().toISOString());

    // …and only a clean look that started after the deadline closes it.
    h.advance(15_000);
    stats = await h.service.runCheckerTick();
    expect(stats.expired).toBe(1);
    row = (await h.service.getOrangeTest(test.id))!;
    expect(row.status).toBe("not_received");
    expect(row.verdict).toBe("NOT_RECEIVED");
    expect(row.finishedAt).toBe(h.now().toISOString());
  });

  it("a message found by the final post-deadline check still wins (no NOT RECEIVED race)", async () => {
    const h = harness();
    const { test, completion } = await h.service.startOrangeTest("mta-1", null);
    await completion;
    h.advance(MAX_WAIT + 60_000);
    h.lookupMailbox.mockResolvedValueOnce({
      hits: new Map([[test.reference, hitFor(test.reference, "low", "junk", new Date(h.now().getTime() - 30_000))]]),
      foldersSearched: ["INBOX", "Junk"], warnings: [],
    });
    const stats = await h.service.runCheckerTick();
    expect(stats.expired).toBe(0);
    expect(stats.found).toBe(1);
    const row = (await h.service.getOrangeTest(test.id))!;
    expect(row.status).toBe("done");
    expect(row.verdict).toBe("SPAM");
  });

  it("a look that STARTED before the deadline never counts as the final check", async () => {
    const h = harness();
    const { test, completion } = await h.service.startOrangeTest("mta-1", null);
    await completion;
    h.advance(FAST_PHASE + 1_000);
    await h.service.runCheckerTick(); // enters the slow phase
    // Move to 10 s before the deadline and make the poll due: the check starts before the deadline.
    const row = h.store.rows.find((r) => r.id === test.id)!;
    h.advance(MAX_WAIT - (FAST_PHASE + 1_000) - 10_000);
    row.nextPollAt = h.now();
    h.lookupMailbox.mockImplementationOnce(async () => {
      h.advance(40_000); // the IMAP session straddles the deadline
      return { hits: new Map(), foldersSearched: ["INBOX", "Junk"], warnings: [] };
    });
    let stats = await h.service.runCheckerTick();
    expect(stats.claimed).toBe(1);
    // Next tick: deadline passed, but the last look started 10 s BEFORE it → not closed yet.
    h.advance(15_000);
    stats = await h.service.runCheckerTick();
    expect(stats.expired).toBe(0);
    expect((await h.service.getOrangeTest(test.id))!.status).toBe("waiting");
  });

  it("closes overdue tests after the grace period even when the mailbox keeps failing", async () => {
    const h = harness();
    const { test, completion } = await h.service.startOrangeTest("mta-1", null);
    await completion;
    h.lookupMailbox.mockRejectedValue(new Error("IMAP authentication refused"));
    h.advance(MAX_WAIT + 1_000);
    let stats = await h.service.runCheckerTick();
    expect(stats.error).toMatch(/authentication/);
    expect(stats.expired).toBe(0);
    h.advance(EXPIRY_GRACE_MS);
    stats = await h.service.runCheckerTick();
    expect(stats.expired).toBe(1);
    const row = (await h.service.getOrangeTest(test.id))!;
    expect(row.status).toBe("not_received");
    expect(row.lastCheckError).toMatch(/authentication/);
  });

  it("leaves the due rows alone when another instance holds the checker lease, and releases the lease after the session", async () => {
    let held = true;
    const release = vi.fn(async () => { held = false; });
    const acquire = vi.fn(async () => (held ? null : { release }));
    const h = harness({ acquireCheckerLease: acquire });
    const { test, completion } = await h.service.startOrangeTest("mta-1", null);
    await completion;
    h.advance(FAST_POLL);
    let stats = await h.service.runCheckerTick();
    expect(stats.skipped).toBe(true);
    expect(stats.leaseHeldElsewhere).toBe(true);
    expect(stats.claimed).toBe(0);
    expect(h.lookupMailbox).not.toHaveBeenCalled();
    let row = (await h.service.getOrangeTest(test.id))!;
    expect(row.pollCount).toBe(0); // still due for the lease holder

    held = false;
    h.lookupMailbox.mockRejectedValueOnce(new Error("boom"));
    stats = await h.service.runCheckerTick();
    expect(stats.claimed).toBe(1);
    expect(release).toHaveBeenCalledTimes(1); // released even when the session throws
    row = (await h.service.getOrangeTest(test.id))!;
    expect(row.pollCount).toBe(1);
  });

  it("keeps listening after a mailbox failure and shows the error on the test", async () => {
    const h = harness();
    const { test, completion } = await h.service.startOrangeTest("mta-1", null);
    await completion;
    h.advance(FAST_POLL);
    h.lookupMailbox.mockRejectedValueOnce(new Error("IMAP authentication refused by imap.orange.fr"));
    const stats = await h.service.runCheckerTick();
    expect(stats.error).toMatch(/authentication refused/);
    const row = (await h.service.getOrangeTest(test.id))!;
    expect(row.status).toBe("waiting");
    expect(row.lastCheckError).toMatch(/authentication refused/);
    expect(row.nextPollAt).not.toBeNull();
  });

  it("resumes a test left in 'sending' by a crash instead of failing it", async () => {
    const h = harness();
    // The send never completes (process died mid-hand-off): the row stays 'sending'.
    h.sendPlainTest.mockImplementationOnce(() => new Promise(() => { /* never settles */ }));
    const { test } = await h.service.startOrangeTest("mta-1", null);
    h.advance(5 * 60_000);
    let stats = await h.service.runCheckerTick();
    expect(stats.released).toBe(0); // not stale yet
    h.advance(6 * 60_000);
    stats = await h.service.runCheckerTick();
    expect(stats.released).toBe(1);
    const row = (await h.service.getOrangeTest(test.id))!;
    expect(row.status).toBe("waiting");
    expect(row.sendNote).toBe(STALE_SENDING_NOTE);
    expect(row.sentAt).toBe(row.createdAt);
    expect(new Date(row.deadlineAt!).getTime() - new Date(row.createdAt).getTime()).toBe(MAX_WAIT);
  });

  it("skips the mailbox when the feature is disabled and still closes overdue tests once the grace period is over", async () => {
    const h = harness();
    const { test, completion } = await h.service.startOrangeTest("mta-1", null);
    await completion;
    (h.cfg as any).enabled = false;
    h.advance(MAX_WAIT + 1);
    let stats = await h.service.runCheckerTick();
    expect(stats.skipped).toBe(true);
    expect(stats.expired).toBe(0); // no check possible → wait for the grace period
    expect(h.lookupMailbox).not.toHaveBeenCalled();
    h.advance(EXPIRY_GRACE_MS);
    stats = await h.service.runCheckerTick();
    expect(stats.expired).toBe(1);
    expect((await h.service.getOrangeTest(test.id))!.status).toBe("not_received");
  });
});

describe("control values (MTA card)", () => {
  it("shows the most recently SENT test; a late verdict of an older test never overrides a newer one", async () => {
    const h = harness({ start: new Date("2026-09-28T08:00:00Z") });
    // Test A (28 Sept) sent, never found for a long time.
    const a = await h.service.startOrangeTest("mta-1", null);
    await a.completion;
    // Force A out of pending without a verdict so a second test can start (simulate an operator waiting 20 h)…
    h.advance(20 * 3600_000);
    await h.service.runCheckerTick(); // still waiting (not found)

    // …then close A's pending state artificially: replace by a terminal-less flow is impossible (one pending per MTA),
    // so mimic the realistic path: A expires (window shortened) and B (29 Sept) is sent.
    const rowA = h.store.rows.find((r) => r.id === a.test.id)!;
    rowA.deadlineAt = h.now();
    rowA.nextPollAt = h.now();
    await h.service.runCheckerTick(); // final clean look after the deadline
    h.advance(15_000);
    await h.service.runCheckerTick(); // A → NOT_RECEIVED
    h.advance(5 * 3600_000); // 29 Sept 09:00
    const b = await h.service.startOrangeTest("mta-1", null);
    await b.completion;

    let values = await h.service.getControlValues(["mta-1", "mta-other"]);
    expect(values["mta-1"].latest?.id).toBe(b.test.id);
    expect(values["mta-1"].latest?.status).toBe("waiting");
    expect(values["mta-1"].latestVerdict?.id).toBe(a.test.id);
    expect(values["mta-1"].latestVerdict?.verdict).toBe("NOT_RECEIVED");
    expect(values["mta-other"]).toEqual({ latest: null, latestVerdict: null });

    // Now the OLD message of A finally shows up in the mailbox (Orange delivered it after 25 h).
    // A is terminal (not_received) so the hit is ignored by the status guard; B stays the control value.
    h.advance(FAST_POLL);
    h.lookupMailbox.mockResolvedValueOnce({
      hits: new Map([[a.test.reference, hitFor(a.test.reference, "not-spam")], [b.test.reference, hitFor(b.test.reference, "med")]]),
      foldersSearched: [], warnings: [],
    });
    await h.service.runCheckerTick();
    values = await h.service.getControlValues(["mta-1"]);
    expect(values["mta-1"].latest?.id).toBe(b.test.id);
    expect(values["mta-1"].latest?.verdict).toBe("BLOCKED");
    expect(values["mta-1"].latestVerdict?.id).toBe(b.test.id);
    expect((await h.service.getOrangeTest(a.test.id))!.verdict).toBe("NOT_RECEIVED");
  });

  it("orders by send time even when an older test gets its verdict after a newer one", async () => {
    const h = harness({ start: new Date("2026-09-28T08:00:00Z") });
    const store = h.store;
    // Two done tests inserted directly: older sent 28/09 with verdict recorded 30/09, newer sent 29/09 verdict 29/09.
    const older = (await store.insertPending({ mtaId: "mta-1", reference: "OT-20260928-AAAAAAAA", messageId: "<a@x>", mailbox: "m", fromEmail: "f@x", requestedBy: null }))!;
    await store.markSent(older.id, { sentAt: new Date("2026-09-28T08:00:00Z"), nextPollAt: new Date(), deadlineAt: new Date("2026-09-30T08:00:00Z") });
    // Its verdict is recorded on 30/09, i.e. AFTER the newer test's verdict below.
    await store.recordHit(older.id, { verdict: "BLOCKED", spamLevelRaw: "med", foundIn: "junk", foundFolder: "Junk", matchedBy: "text", rawHeaders: {}, receivedAt: new Date("2026-09-30T07:00:00Z"), finishedAt: new Date("2026-09-30T07:00:30Z") });
    const newer = (await store.insertPending({ mtaId: "mta-1", reference: "OT-20260929-BBBBBBBB", messageId: "<b@x>", mailbox: "m", fromEmail: "f@x", requestedBy: null }))!;
    await store.markSent(newer.id, { sentAt: new Date("2026-09-29T08:00:00Z"), nextPollAt: new Date(), deadlineAt: new Date("2026-10-01T08:00:00Z") });
    await store.recordHit(newer.id, { verdict: "GOOD", spamLevelRaw: "not-spam", foundIn: "inbox", foundFolder: "INBOX", matchedBy: "message-id", rawHeaders: {}, receivedAt: new Date("2026-09-29T08:01:00Z"), finishedAt: new Date("2026-09-29T08:01:30Z") });

    const values = await h.service.getControlValues(["mta-1"]);
    expect(values["mta-1"].latest?.reference).toBe("OT-20260929-BBBBBBBB");
    expect(values["mta-1"].latestVerdict?.verdict).toBe("GOOD");
    const history = await h.service.listOrangeTests("mta-1", 10);
    expect(history.map((t) => t.reference)).toEqual(["OT-20260929-BBBBBBBB", "OT-20260928-AAAAAAAA"]);
  });
});

describe("views", () => {
  beforeEach(() => vi.clearAllMocks());
  it("never exposes the mailbox password and computes the delivery delay", async () => {
    const h = harness();
    const { test, completion } = await h.service.startOrangeTest("mta-1", null);
    await completion;
    h.advance(FAST_POLL);
    const receivedAt = new Date(h.now().getTime() - 10_000);
    h.lookupMailbox.mockResolvedValueOnce({ hits: new Map([[test.reference, hitFor(test.reference, "not-spam", "inbox", receivedAt)]]), foldersSearched: [], warnings: [] });
    await h.service.runCheckerTick();
    const view = (await h.service.getOrangeTest(test.id))!;
    expect(JSON.stringify(view)).not.toContain('"pw"');
    expect(view.deliveryDelayMs).toBe(FAST_POLL - 10_000);
    expect(view.rawHeaders).toEqual({ "x-me-spamlevel": "not-spam" });
  });
});
