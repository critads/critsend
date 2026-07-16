/**
 * Task #216 — bot-opener DEL marker.
 *
 * Covers, without any real DB:
 *   1. Config parsing (defaults + env overrides + invalid-value fallback).
 *   2. The eligibility predicate boundaries: exactly minOpened opened,
 *      exactly the 70% bot-open ratio, below-threshold cases.
 *   3. The marking pass contract against a mocked pool:
 *      - candidate SQL counts ALL opens in the denominator but restricts
 *        the numerator to the configured bot IPs (FILTER clause);
 *      - only qualifying subscribers reach the UPDATE;
 *      - the UPDATE is idempotent (guarded array_append, never overwrites)
 *        and atomically inserts the bot_opener_marks audit row;
 *      - updates are batched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const queryMock = vi.fn();
const clientQueryMock = vi.fn();
const releaseMock = vi.fn();

vi.mock("../server/db", () => ({
  pool: {
    query: (...args: any[]) => queryMock(...args),
    connect: async () => ({
      query: (...args: any[]) => clientQueryMock(...args),
      release: releaseMock,
    }),
  },
  db: {},
}));

vi.mock("../server/metrics", () => ({
  botOpenerMarkedTotal: { inc: vi.fn() },
  botOpenerLastRunTimestamp: { set: vi.fn() },
}));

vi.mock("../server/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const ENV_KEYS = [
  "BOT_OPENER_IP_LIST",
  "BOT_OPENER_MIN_OPENED",
  "BOT_OPENER_OPEN_RATIO",
  "BOT_OPENER_WINDOW_DAYS",
  "BOT_OPENER_UPDATE_BATCH",
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  queryMock.mockReset();
  clientQueryMock.mockReset();
  releaseMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.resetModules();
});

async function loadConfig() {
  return import("../server/config/suppression");
}

async function loadMarker() {
  return import("../server/services/bot-opener-marker");
}

// ─── 1. Config parsing ──────────────────────────────────────────────────────

describe("suppression config — bot-opener constants", () => {
  it("exposes the documented defaults", async () => {
    const cfg = await loadConfig();
    expect(cfg.BOT_OPENER_IPS).toContain("195.154.17.225");
    expect(cfg.BOT_OPENER_MIN_OPENED).toBe(5);
    expect(cfg.BOT_OPENER_OPEN_RATIO).toBe(0.7);
    expect(cfg.BOT_OPENER_WINDOW_DAYS).toBe(30);
    expect(cfg.BOT_OPENER_REF).toBe("DEL");
  });

  it("merges BOT_OPENER_IP_LIST with the default IPs (deduplicated)", async () => {
    process.env.BOT_OPENER_IP_LIST = " 1.2.3.4 ,195.154.17.225, 5.6.7.8 ";
    const cfg = await loadConfig();
    expect(cfg.BOT_OPENER_IPS).toEqual(
      expect.arrayContaining(["195.154.17.225", "1.2.3.4", "5.6.7.8"]),
    );
    expect(cfg.BOT_OPENER_IPS.filter((ip) => ip === "195.154.17.225")).toHaveLength(1);
  });

  it("honours numeric env overrides", async () => {
    process.env.BOT_OPENER_MIN_OPENED = "8";
    process.env.BOT_OPENER_OPEN_RATIO = "0.5";
    process.env.BOT_OPENER_WINDOW_DAYS = "15";
    const cfg = await loadConfig();
    expect(cfg.BOT_OPENER_MIN_OPENED).toBe(8);
    expect(cfg.BOT_OPENER_OPEN_RATIO).toBe(0.5);
    expect(cfg.BOT_OPENER_WINDOW_DAYS).toBe(15);
  });

  it("falls back to defaults on invalid env values", async () => {
    process.env.BOT_OPENER_MIN_OPENED = "zero";
    process.env.BOT_OPENER_OPEN_RATIO = "1.5";
    process.env.BOT_OPENER_WINDOW_DAYS = "-3";
    const cfg = await loadConfig();
    expect(cfg.BOT_OPENER_MIN_OPENED).toBe(5);
    expect(cfg.BOT_OPENER_OPEN_RATIO).toBe(0.7);
    expect(cfg.BOT_OPENER_WINDOW_DAYS).toBe(30);
  });
});

// ─── 2. Eligibility predicate boundaries ────────────────────────────────────
// Semantics: totalOpened = distinct campaigns OPENED (any IP) in the window,
// botOpened = distinct campaigns opened via a bot IP. Qualify when
// totalOpened >= 5 AND botOpened/totalOpened >= 0.7.

describe("qualifiesAsBotOpener", () => {
  it("accepts exactly minOpened=5 opened when the ratio is met", async () => {
    const { qualifiesAsBotOpener } = await loadMarker();
    // 4/5 = 80% >= 70%
    expect(qualifiesAsBotOpener(5, 4)).toBe(true);
    // 5/5 = 100%
    expect(qualifiesAsBotOpener(5, 5)).toBe(true);
  });

  it("rejects below minOpened even at a 100% bot ratio", async () => {
    const { qualifiesAsBotOpener } = await loadMarker();
    expect(qualifiesAsBotOpener(4, 4)).toBe(false);
    expect(qualifiesAsBotOpener(1, 1)).toBe(false);
  });

  it("accepts exactly 70% (7 of 10 opens via bot IP)", async () => {
    const { qualifiesAsBotOpener } = await loadMarker();
    expect(qualifiesAsBotOpener(10, 7)).toBe(true);
  });

  it("rejects just under 70% (6 of 10, and 69 of 100)", async () => {
    const { qualifiesAsBotOpener } = await loadMarker();
    expect(qualifiesAsBotOpener(10, 6)).toBe(false);
    expect(qualifiesAsBotOpener(100, 69)).toBe(false);
  });

  it("accepts exactly 70% on awkward float cases (70 of 100, 14 of 20)", async () => {
    const { qualifiesAsBotOpener } = await loadMarker();
    expect(qualifiesAsBotOpener(100, 70)).toBe(true);
    expect(qualifiesAsBotOpener(20, 14)).toBe(true);
  });

  it("rejects zero bot opens regardless of opened count", async () => {
    const { qualifiesAsBotOpener } = await loadMarker();
    expect(qualifiesAsBotOpener(50, 0)).toBe(false);
  });

  it("honours option overrides (custom min/ratio)", async () => {
    const { qualifiesAsBotOpener } = await loadMarker();
    expect(qualifiesAsBotOpener(2, 1, { minOpened: 2, openRatio: 0.5 })).toBe(true);
    expect(qualifiesAsBotOpener(2, 1, { minOpened: 3, openRatio: 0.5 })).toBe(false);
  });
});

// ─── 3. Marking pass contract (mocked pool) ─────────────────────────────────

function installPassPoolMock(
  candidateRows: Array<{ id: string; total_opened: number; bot_opened: number }>,
) {
  const updateCalls: Array<{ ids: string[]; ref: string; sql: string }> = [];
  let candidateSql = "";
  let candidateParams: any[] = [];

  queryMock.mockImplementation(async (text: string, params?: any[]) => {
    if (/INSERT INTO bot_opener_leader/i.test(text)) {
      return { rowCount: 1, rows: [{ holder: params?.[1] }] };
    }
    if (/FROM bot_opener_runs/i.test(text) && /SELECT/i.test(text)) {
      return { rowCount: 0, rows: [] }; // no previous run → due
    }
    if (/INSERT INTO bot_opener_runs/i.test(text)) {
      return { rowCount: 1, rows: [{ id: "run-1" }] };
    }
    if (/UPDATE bot_opener_runs/i.test(text)) {
      return { rowCount: 1, rows: [] };
    }
    if (/UPDATE subscribers/i.test(text)) {
      const ids: string[] = params?.[0] ?? [];
      updateCalls.push({ ids, ref: params?.[1], sql: text });
      // The service reads rows[0].marked (CTE count), NOT rowCount.
      return { rowCount: 1, rows: [{ marked: ids.length }] };
    }
    if (/CREATE TABLE|CREATE INDEX/i.test(text)) {
      return { rowCount: 0, rows: [] };
    }
    throw new Error(`unexpected pool.query: ${text.slice(0, 80)}`);
  });

  clientQueryMock.mockImplementation(async (text: string, params?: any[]) => {
    if (/^BEGIN$/i.test(text.trim()) || /^COMMIT$/i.test(text.trim()) || /^ROLLBACK$/i.test(text.trim())) {
      return { rowCount: 0, rows: [] };
    }
    if (/SET LOCAL statement_timeout/i.test(text)) {
      return { rowCount: 0, rows: [] };
    }
    if (/bot_subs/i.test(text)) {
      candidateSql = text;
      candidateParams = params ?? [];
      return { rowCount: candidateRows.length, rows: candidateRows };
    }
    throw new Error(`unexpected client.query: ${text.slice(0, 80)}`);
  });

  return {
    updateCalls,
    getCandidateSql: () => candidateSql,
    getCandidateParams: () => candidateParams,
  };
}

describe("runBotOpenerMarkPassOnce (mocked pool)", () => {
  it("only marks qualifying subscribers; numerator is IP-filtered; UPDATE is a guarded append + audit insert", async () => {
    const mockCtl = installPassPoolMock([
      { id: "s-qualify-exact", total_opened: 10, bot_opened: 7 }, // exactly 70% → yes
      { id: "s-qualify-min", total_opened: 5, bot_opened: 4 },    // exactly 5 opened, 80% → yes
      { id: "s-under-ratio", total_opened: 10, bot_opened: 6 },   // 60% → no
      { id: "s-under-opened", total_opened: 4, bot_opened: 4 },   // < 5 opened → no
    ]);
    const marker = await loadMarker();
    const result = await marker.runBotOpenerMarkPassOnce();

    expect(result.ran).toBe(true);
    expect(result.matched).toBe(2);
    expect(result.marked).toBe(2);

    const allUpdatedIds = mockCtl.updateCalls.flatMap((c) => c.ids);
    expect(allUpdatedIds.sort()).toEqual(["s-qualify-exact", "s-qualify-min"]);
    expect(allUpdatedIds).not.toContain("s-under-ratio");
    expect(allUpdatedIds).not.toContain("s-under-opened");

    // Denominator = ALL opens; numerator restricted to the bot IP list via a
    // FILTER clause, with the IPs passed as a parameter.
    expect(mockCtl.getCandidateSql()).toMatch(
      /FILTER \(WHERE cs\.ip_address = ANY\(\$1::text\[\]\)\)/i,
    );
    expect(mockCtl.getCandidateSql()).toMatch(/ip_address\s*=\s*ANY\(\$1::text\[\]\)/i);
    expect(mockCtl.getCandidateParams()[0]).toContain("195.154.17.225");
    // Only 'open' events count — received emails are irrelevant now.
    expect(mockCtl.getCandidateSql()).toMatch(/type\s*=\s*'open'/i);
    expect(mockCtl.getCandidateSql()).not.toMatch(/campaign_sends/i);

    // Idempotence: the UPDATE appends only when the ref is absent, never
    // replaces the refs array wholesale, and atomically records the
    // timestamped audit row for the analytics series.
    for (const call of mockCtl.updateCalls) {
      expect(call.ref).toBe("DEL");
      expect(call.sql).toMatch(/array_append\(COALESCE\(refs, ARRAY\[\]::text\[\]\), \$2\)/i);
      expect(call.sql).toMatch(/NOT \(\$2 = ANY\(COALESCE\(refs, ARRAY\[\]::text\[\]\)\)\)/i);
      expect(call.sql).not.toMatch(/SET refs = \$/i);
      expect(call.sql).toMatch(/INSERT INTO bot_opener_marks/i);
      expect(call.sql).toMatch(/ON CONFLICT \(subscriber_id\) DO NOTHING/i);
    }
  });

  it("batches UPDATEs (2500 qualifying ids @ batch 1000 → 3 calls)", async () => {
    process.env.BOT_OPENER_UPDATE_BATCH = "1000";
    const rows = Array.from({ length: 2500 }, (_, i) => ({
      id: `s-${i}`,
      total_opened: 10,
      bot_opened: 9,
    }));
    const mockCtl = installPassPoolMock(rows);
    const marker = await loadMarker();
    const result = await marker.runBotOpenerMarkPassOnce();

    expect(result.matched).toBe(2500);
    expect(result.marked).toBe(2500);
    expect(mockCtl.updateCalls).toHaveLength(3);
    expect(mockCtl.updateCalls[0].ids).toHaveLength(1000);
    expect(mockCtl.updateCalls[1].ids).toHaveLength(1000);
    expect(mockCtl.updateCalls[2].ids).toHaveLength(500);
  });

  it("skips when another process holds the lease", async () => {
    queryMock.mockImplementation(async (text: string) => {
      if (/INSERT INTO bot_opener_leader/i.test(text)) {
        return { rowCount: 0, rows: [] }; // lost the lease
      }
      if (/FROM bot_opener_runs/i.test(text)) {
        return { rowCount: 0, rows: [] }; // due
      }
      return { rowCount: 0, rows: [] };
    });
    const marker = await loadMarker();
    const result = await marker.runBotOpenerMarkPassOnce();
    expect(result.ran).toBe(false);
    expect(result.skipped).toBe("not_leader");
    expect(clientQueryMock).not.toHaveBeenCalled();
  });

  it("skips when a pass completed recently (not due)", async () => {
    queryMock.mockImplementation(async (text: string) => {
      if (/FROM bot_opener_runs/i.test(text)) {
        return { rowCount: 1, rows: [{ completed_at: new Date() }] };
      }
      return { rowCount: 1, rows: [] };
    });
    const marker = await loadMarker();
    const result = await marker.runBotOpenerMarkPassOnce();
    expect(result.ran).toBe(false);
    expect(result.skipped).toBe("not_due");
    expect(clientQueryMock).not.toHaveBeenCalled();
  });

  it("chunkIds splits exactly", async () => {
    const { chunkIds } = await loadMarker();
    expect(chunkIds([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkIds([], 2)).toEqual([]);
    expect(chunkIds([1], 5)).toEqual([[1]]);
  });
});
