// Data Consolidation — the reconciliation pass against a real PostgreSQL
// (the development database), on a private throwaway schema.
//
// Covers the three business rules end to end through the SQL itself:
//   rule 3  complaint-IP open + O<ref> present → U<ref> (campaign-tag fallback,
//           untagged campaigns and subscribers without the O tag are skipped and counted)
//   rule 1  U<ref> → ref removed
//   rule 2  C<ref> without U<ref> → ref added, never duplicated
// plus: strict ref shapes (US1CT / free tags untouched), idempotence, the
// incremental cursor (overlap honoured, older events ignored, refs rediscovered
// from every tag on every run), bounded batching (batch sizes of 2), the
// single-run guard (lease + stale-heartbeat reaping) and operator cancel.
//
// Isolation: every table the service touches (subscribers, campaigns,
// campaign_stats, brands and its own run/state/lease tables) is created in a
// private schema and the service's SQL is rewritten onto it. Session-level
// search_path is not an option: NEON_DATABASE_URL is a PgBouncer
// transaction-pooling endpoint.
//
// Skipped when neither NEON_DATABASE_URL nor DATABASE_URL is set.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsolidationExecutor, ConsolidationQueryable, DataConsolidationService } from "../server/services/data-consolidation";

vi.mock("../server/db", () => ({ pool: { query: vi.fn(), connect: vi.fn() }, db: {} }));
vi.mock("../server/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../server/metrics", () => ({
  dataConsolidationChangesTotal: { inc: vi.fn() },
  dataConsolidationLastRunTimestamp: { set: vi.fn() },
}));

const DB_URL = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

type ServiceModule = typeof import("../server/services/data-consolidation");

const SCHEMA_PREFIX = "dataconso_it_";
const STALE_SCHEMA_AFTER_MS = 2 * 60 * 60_000;
const COMPLAINT_IP = "195.154.17.225";
const OTHER_IP = "10.0.0.7";
const TABLES = [
  "subscribers",
  "campaigns",
  "campaign_stats",
  "brands",
  "data_consolidation_runs",
  "data_consolidation_state",
  "data_consolidation_leader",
];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describeWithDb("Data consolidation — PostgreSQL behavior", () => {
  const runId = `${Math.floor(Date.now() / 1000)}_${randomBytes(3).toString("hex")}`;
  const schema = `${SCHEMA_PREFIX}${runId}`;
  const S = `"${schema}"`;

  let pool: pg.Pool;
  let mod: ServiceModule;
  let service: DataConsolidationService;
  let hooks: { onBatch?: (phase: string) => Promise<void> | void } = {};

  // ── Isolation ──────────────────────────────────────────────────────────

  function qualify(sql: string): string {
    let out = sql;
    for (const t of TABLES) {
      out = out.replace(new RegExp(`(?<![.\\w"])${t}(?![\\w"])`, "g"), `${S}.${t}`);
    }
    for (const t of TABLES) {
      if (new RegExp(`(?<![.\\w"])${t}(?![\\w"])`).test(out)) {
        throw new Error(`Refusing SQL with an unqualified ${t} reference (it would reach public):\n${sql}`);
      }
    }
    return out;
  }

  function executor(): ConsolidationExecutor {
    const q = (client: { query: (t: string, v?: any[]) => Promise<any> }): ConsolidationQueryable => ({
      query: (text, values) => client.query(qualify(text), values as any[]),
    });
    return {
      query: (text, values) => pool.query(qualify(text), values as any[]),
      async transaction(fn) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const r = await fn(q(client));
          await client.query("COMMIT");
          return r;
        } catch (err) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw err;
        } finally {
          client.release();
        }
      },
    };
  }

  async function dropStaleSchemas(): Promise<void> {
    const res = await pool.query<{ nspname: string }>(`SELECT nspname FROM pg_namespace WHERE nspname ~ $1`, [
      `^${SCHEMA_PREFIX}\\d+_[0-9a-f]+$`,
    ]);
    const cutoff = Math.floor((Date.now() - STALE_SCHEMA_AFTER_MS) / 1000);
    for (const { nspname } of res.rows) {
      const epoch = Number(nspname.slice(SCHEMA_PREFIX.length).split("_")[0]);
      if (!Number.isFinite(epoch) || epoch > cutoff) continue;
      await pool.query(`DROP SCHEMA IF EXISTS "${nspname}" CASCADE`).catch(() => undefined);
    }
  }

  // ── Fixtures ───────────────────────────────────────────────────────────

  async function addSubscriber(id: string, tags: string[], refs: string[], importDateSql = "NOW()"): Promise<void> {
    await pool.query(
      `INSERT INTO ${S}.subscribers (id, email, tags, refs, import_date)
       VALUES ($1, $2, $3::text[], $4::text[], ${importDateSql})`,
      [id, `${id.toLowerCase()}@example.test`, tags, refs],
    );
  }

  async function addCampaign(id: string, tags: { open?: string | null; click?: string | null; unsub?: string | null }): Promise<void> {
    await pool.query(
      `INSERT INTO ${S}.campaigns (id, name, open_tag, click_tag, unsubscribe_tag) VALUES ($1, $2, $3, $4, $5)`,
      [id, id, tags.open ?? null, tags.click ?? null, tags.unsub ?? null],
    );
  }

  /** `atSql` is a SQL expression for the naive UTC timestamp, e.g. `NOW() - INTERVAL '3 hours'`. */
  async function addEvent(subscriberId: string, campaignId: string, opts: { type?: string; ip?: string; atSql?: string } = {}): Promise<void> {
    await pool.query(
      `INSERT INTO ${S}.campaign_stats (campaign_id, subscriber_id, type, ip_address, "timestamp")
       VALUES ($1, $2, $3, $4, ${opts.atSql ?? "NOW()"})`,
      [campaignId, subscriberId, opts.type ?? "open", opts.ip ?? COMPLAINT_IP],
    );
  }

  async function snapshot(): Promise<Record<string, { tags: string[]; refs: string[] }>> {
    const res = await pool.query<{ id: string; tags: string[]; refs: string[] }>(
      `SELECT id, tags, refs FROM ${S}.subscribers ORDER BY id`,
    );
    const out: Record<string, { tags: string[]; refs: string[] }> = {};
    for (const r of res.rows) out[r.id] = { tags: [...r.tags].sort(), refs: [...r.refs].sort() };
    return out;
  }

  async function resetData(): Promise<void> {
    await pool.query(`
      TRUNCATE ${S}.campaign_stats, ${S}.subscribers, ${S}.campaigns, ${S}.brands,
               ${S}.data_consolidation_runs, ${S}.data_consolidation_leader;
      UPDATE ${S}.data_consolidation_state SET cursor_at = NULL, known_refs = ARRAY[]::text[], last_full_run_at = NULL;
    `);
  }

  async function waitForRun(id: string, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const run = await service.getRun(id);
      if (run && run.status !== "running") return run;
      if (Date.now() > deadline) throw new Error(`run ${id} still running after ${timeoutMs} ms`);
      await sleep(200);
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DB_URL, max: 4 });
    pool.on("error", (error) => console.warn(`[dataconso-it] pool error: ${error.message}`));
    await dropStaleSchemas();
    await pool.query(`
      BEGIN;
      CREATE SCHEMA ${S};
      SET LOCAL search_path TO ${S};
      CREATE TABLE subscribers (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        email text NOT NULL,
        tags text[] NOT NULL DEFAULT ARRAY[]::text[],
        refs text[] NOT NULL DEFAULT ARRAY[]::text[],
        import_date timestamp NOT NULL DEFAULT NOW()
      );
      CREATE TABLE campaigns (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        open_tag text, click_tag text, unsubscribe_tag text
      );
      CREATE TABLE campaign_stats (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        campaign_id varchar NOT NULL,
        subscriber_id varchar NOT NULL,
        type text NOT NULL,
        ip_address text,
        "timestamp" timestamp NOT NULL DEFAULT NOW()
      );
      CREATE TABLE brands (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), ref text NOT NULL);
      COMMIT;
    `);
    mod = await import("../server/services/data-consolidation");
    service = new mod.DataConsolidationService({
      executor: executor(),
      complaintIps: [COMPLAINT_IP],
      batchSize: 2,
      eventBatchSize: 2,
      batchPauseMs: 0,
      overlapMinutes: 60,
      heartbeatIntervalMs: 1_000,
      staleHeartbeatMs: 30_000,
      holderId: `test:${runId}`,
      onBatch: (phase) => hooks.onBatch?.(phase),
    });
    await service.ensureSchema();
  }, 90_000);

  beforeEach(async () => {
    hooks = {};
    await resetData();
  }, 30_000);

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`).catch((error) => {
        console.warn(`[dataconso-it] could not drop ${schema}: ${error.message} — the next run sweeps it`);
      });
      await pool.end().catch(() => undefined);
    }
  }, 60_000);

  // ── Tests ──────────────────────────────────────────────────────────────

  it("first run (full history) applies rules 3 → 1 → 2 with guarded writes and reports skips", async () => {
    await addCampaign("K1", { open: "O1CT", click: "C1CT", unsub: "U1CT" });
    await addCampaign("K2", {}); // untagged campaign
    await addCampaign("K3", { click: "C2AB" }); // no open tag → brand from click tag
    await pool.query(`INSERT INTO ${S}.brands (ref) VALUES ('xyz')`);

    // Rule 1 — three rows so the batch of 2 paginates.
    await addSubscriber("S01", ["U1CT"], ["1CT", "2AB"]);
    await addSubscriber("S02", ["U1CT", "C1CT"], ["1CT"]);
    await addSubscriber("S03", ["U1CT"], ["1CT"]);
    // Rule 2
    await addSubscriber("S04", ["C1CT"], []);
    await addSubscriber("S05", ["C1CT"], ["2AB"]);
    await addSubscriber("S06", ["C1CT"], ["1CT"]); // already consistent → untouched, no duplicate
    await addSubscriber("S07", ["C1CT", "U1CT"], []); // U wins over C
    // Rule 3
    await addSubscriber("S08", ["O1CT"], ["1CT"]); // complaint open + O tag → U1CT, then rule 1 drops 1CT
    await addSubscriber("S09", [], ["1CT"]); // complaint open, no O tag → untouched
    await addSubscriber("S10", ["O1CT"], ["1CT"]); // event on untagged campaign → untouched
    await addSubscriber("S11", ["O2AB"], ["2AB"]); // campaign K3 has only a click tag → fallback ref 2AB
    await addSubscriber("S12", ["O1CT"], ["1CT"]); // open from another IP → untouched
    await addSubscriber("S13", ["O1CT", "U1CT"], []); // already tagged → counted, no duplicate
    await addSubscriber("S14", ["O1CT"], ["1CT"]); // 'complaint'-typed event counts like an open
    // Out of scope shapes
    await addSubscriber("S15", ["US1CT"], ["1CT"]); // US variant never maps to ref 1CT
    await addSubscriber("S16", ["STOP-U2CU", "UNSUB_2BT", "u1ct"], ["2BT", "2CU"]); // free / lowercase tags

    await addEvent("S08", "K1", { atSql: "NOW() - INTERVAL '3 days'" });
    await addEvent("S08", "K1", { atSql: "NOW() - INTERVAL '2 days'" }); // duplicate event → still one tag
    await addEvent("S09", "K1", { atSql: "NOW() - INTERVAL '2 days'" });
    await addEvent("S10", "K2", { atSql: "NOW() - INTERVAL '2 days'" });
    await addEvent("S11", "K3", { atSql: "NOW() - INTERVAL '1 day'" });
    await addEvent("S12", "K1", { ip: OTHER_IP, atSql: "NOW() - INTERVAL '1 day'" });
    await addEvent("S13", "K1", { atSql: "NOW() - INTERVAL '1 day'" });
    await addEvent("S14", "K1", { type: "complaint", atSql: "NOW() - INTERVAL '12 hours'" });

    const run = await service.runOnce({ mode: "incremental", triggeredBy: "test" });
    expect(run.status).toBe("completed");
    expect(run.error).toBeNull();
    expect(run.cursorFrom).toBeNull(); // first run → full history
    expect(run.cursorTo).not.toBeNull();

    const after = await snapshot();
    expect(after.S01).toEqual({ tags: ["U1CT"], refs: ["2AB"] });
    expect(after.S02).toEqual({ tags: ["C1CT", "U1CT"], refs: [] });
    expect(after.S03).toEqual({ tags: ["U1CT"], refs: [] });
    expect(after.S04).toEqual({ tags: ["C1CT"], refs: ["1CT"] });
    expect(after.S05).toEqual({ tags: ["C1CT"], refs: ["1CT", "2AB"] });
    expect(after.S06).toEqual({ tags: ["C1CT"], refs: ["1CT"] });
    expect(after.S07).toEqual({ tags: ["C1CT", "U1CT"], refs: [] });
    expect(after.S08).toEqual({ tags: ["O1CT", "U1CT"], refs: [] });
    expect(after.S09).toEqual({ tags: [], refs: ["1CT"] });
    expect(after.S10).toEqual({ tags: ["O1CT"], refs: ["1CT"] });
    expect(after.S11).toEqual({ tags: ["O2AB", "U2AB"], refs: [] });
    expect(after.S12).toEqual({ tags: ["O1CT"], refs: ["1CT"] });
    expect(after.S13).toEqual({ tags: ["O1CT", "U1CT"], refs: [] });
    expect(after.S14).toEqual({ tags: ["O1CT", "U1CT"], refs: [] });
    expect(after.S15).toEqual({ tags: ["US1CT"], refs: ["1CT"] });
    expect(after.S16).toEqual({ tags: ["STOP-U2CU", "UNSUB_2BT", "u1ct"], refs: ["2BT", "2CU"] });

    const c = run.counters;
    expect(c.rule3EventsTotal).toBe(7); // all complaint-IP open/complaint events (S12's other-IP open excluded)
    expect(c.rule3EventsScanned).toBe(7);
    expect(c.rule3SkippedNoCampaignTag).toBe(1); // S10 on K2
    expect(c.rule3TagsAdded).toBe(3); // S08, S11, S14
    expect(c.rule3SkippedNoOpenTag).toBe(1); // S09
    expect(c.rule3AlreadyTagged).toBe(1); // S13
    expect(c.rule1RefsRemoved).toBe(6); // S01 S02 S03 + S08 S14 (1CT) + S11 (2AB), the last three after rule 3
    expect(c.rule2RefsAdded).toBe(2); // S04 S05
    // Universe: subscriber tags (1CT, 2AB) + brands (XYZ); US1CT/free tags contribute nothing.
    expect(c.refsUniverseSize).toBe(3);

    const state = await service.getState();
    expect(state.cursorAt).toBe(run.cursorTo);
    expect(state.knownRefsCount).toBe(3);
    expect(state.lastFullRunAt).toBe(run.cursorTo);
    const known = await pool.query<{ known_refs: string[] }>(`SELECT known_refs FROM ${S}.data_consolidation_state`);
    expect(known.rows[0].known_refs).toEqual(["1CT", "2AB", "XYZ"]);
  }, 120_000);

  it("is idempotent: an immediate re-run changes no row and advances the cursor", async () => {
    await addCampaign("K1", { open: "O1CT" });
    await addSubscriber("S01", ["U1CT"], ["1CT"]);
    await addSubscriber("S02", ["C1CT"], []);
    await addSubscriber("S03", ["O1CT"], ["1CT"]);
    await addEvent("S03", "K1", { atSql: "NOW() - INTERVAL '1 day'" });

    const first = await service.runOnce({ mode: "full" });
    expect(first.status).toBe("completed");
    const afterFirst = await snapshot();
    expect(afterFirst.S03).toEqual({ tags: ["O1CT", "U1CT"], refs: [] });

    const second = await service.runOnce({ mode: "incremental" });
    expect(second.status).toBe("completed");
    expect(await snapshot()).toEqual(afterFirst);
    expect(second.counters.rule3TagsAdded).toBe(0);
    expect(second.counters.rule1RefsRemoved).toBe(0);
    expect(second.counters.rule2RefsAdded).toBe(0);
    // Incremental window starts at the previous cursor minus the 60-minute overlap: the day-old event is out of range.
    expect(second.counters.rule3EventsTotal).toBe(0);
    expect(second.cursorFrom).not.toBeNull();
    expect(new Date(first.cursorTo!).getTime() - new Date(second.cursorFrom!).getTime()).toBe(60 * 60_000);
    expect((await service.getState()).cursorAt).toBe(second.cursorTo);
  }, 120_000);

  it("incremental run reads only events after the cursor (with overlap) and rediscovers refs from every tag, including tags merged onto old rows", async () => {
    await addCampaign("K1", { open: "O1CT" });
    await addSubscriber("S00", ["C1CT"], []);
    // Old rows (import_date well before the first run) that will receive new brand tags LATER through the
    // tag-import upsert, which merges tags on conflict WITHOUT touching import_date.
    await addSubscriber("S05", [], [], `NOW() - INTERVAL '2 days'`);
    await addSubscriber("S06", [], ["7XX"], `NOW() - INTERVAL '2 days'`);
    await service.runOnce({ mode: "full" });
    const { cursorAt } = await service.getState();
    expect(cursorAt).not.toBeNull();

    // Events relative to the cursor: before the overlap window (ignored), inside it, and after the cursor.
    await addSubscriber("S01", ["O1CT"], ["1CT"]);
    await addSubscriber("S02", ["O1CT"], ["1CT"]);
    await addSubscriber("S03", ["O1CT"], ["1CT"]);
    await addEvent("S01", "K1", { atSql: `('${cursorAt}'::timestamptz AT TIME ZONE 'UTC') - INTERVAL '2 hours'` });
    await addEvent("S02", "K1", { atSql: `('${cursorAt}'::timestamptz AT TIME ZONE 'UTC') - INTERVAL '30 minutes'` });
    await addEvent("S03", "K1", { atSql: `('${cursorAt}'::timestamptz AT TIME ZONE 'UTC') + INTERVAL '1 second'` });
    // A new import carrying a brand never seen before (new row).
    await addSubscriber("S04", ["C9ZZ"], []);
    // The same import merging brand tags onto the OLD rows — exact conflict expression of
    // server/services/import-processor.ts (tags merged, import_date untouched).
    const mergeTag = (id: string, tag: string) =>
      pool.query(
        `UPDATE ${S}.subscribers
            SET tags = COALESCE((SELECT array_agg(DISTINCT t) FROM unnest(tags || ARRAY[$2]::text[]) AS t WHERE t IS NOT NULL), ARRAY[]::text[])
          WHERE id = $1`,
        [id, tag],
      );
    await mergeTag("S05", "C8YY"); // brand 8YY: unknown to campaigns, brands and previous runs
    await mergeTag("S06", "U7XX"); // brand 7XX: idem, and the row still carries the ref
    const dates = await pool.query<{ id: string; old: boolean }>(
      `SELECT id, import_date < ($1::timestamptz AT TIME ZONE 'UTC') AS old FROM ${S}.subscribers WHERE id IN ('S05', 'S06') ORDER BY id`,
      [cursorAt],
    );
    expect(dates.rows.map((r) => r.old)).toEqual([true, true]); // the merge left import_date before the cursor

    const run = await service.runOnce({ mode: "incremental" });
    expect(run.status).toBe("completed");
    const after = await snapshot();
    expect(after.S01).toEqual({ tags: ["O1CT"], refs: ["1CT"] }); // before the window → untouched
    expect(after.S02).toEqual({ tags: ["O1CT", "U1CT"], refs: [] }); // inside the overlap
    expect(after.S03).toEqual({ tags: ["O1CT", "U1CT"], refs: [] }); // after the cursor
    expect(after.S04).toEqual({ tags: ["C9ZZ"], refs: ["9ZZ"] }); // new row, new brand
    expect(after.S05).toEqual({ tags: ["C8YY"], refs: ["8YY"] }); // old row, tag merged after the first run → rule 2
    expect(after.S06).toEqual({ tags: ["U7XX"], refs: [] }); // old row, U tag merged after the first run → rule 1
    expect(run.counters.rule3EventsTotal).toBe(2);
    expect(run.counters.refsUniverseSize).toBe(4); // 1CT + 9ZZ + 8YY + 7XX
    expect(run.counters.rule1RefsRemoved).toBe(3); // S02, S03, S06
    expect(run.counters.rule2RefsAdded).toBe(2); // S04, S05

    // A full recompute replays the whole complaint-IP history; rules 1–2 are already satisfied.
    const full = await service.runOnce({ mode: "full" });
    expect(full.status).toBe("completed");
    expect(full.counters.refsUniverseSize).toBe(4);
    expect(full.cursorFrom).toBeNull();
    expect(full.counters.rule3EventsTotal).toBe(3); // whole history again, all idempotent
    expect(full.counters.rule3TagsAdded).toBe(1); // S01 (before the window last time) is finally tagged
    expect(full.counters.rule1RefsRemoved).toBe(1); // S01's ref
    expect(full.counters.rule2RefsAdded).toBe(0);
    expect((await snapshot()).S01).toEqual({ tags: ["O1CT", "U1CT"], refs: [] });
  }, 180_000);

  it("refuses a second run while one is active, and reaps a stale one", async () => {
    await pool.query(
      `INSERT INTO ${S}.data_consolidation_runs (id, mode, status, holder, heartbeat_at) VALUES ('ghost', 'incremental', 'running', 'other:1', NOW())`,
    );
    const refused = await service.startRun({ mode: "incremental" });
    expect(refused.started).toBe(false);
    if (!refused.started) {
      expect(refused.reason).toBe("already_running");
      expect(refused.run?.id).toBe("ghost");
    }
    await expect(service.runOnce({ mode: "incremental" })).rejects.toThrow(/already active/);

    // Heartbeat older than the stale threshold → interrupted, and a new run can start.
    await pool.query(`UPDATE ${S}.data_consolidation_runs SET heartbeat_at = NOW() - INTERVAL '10 minutes' WHERE id = 'ghost'`);
    const started = await service.startRun({ mode: "incremental", triggeredBy: "op" });
    expect(started.started).toBe(true);
    if (!started.started) return;
    expect(started.run.status).toBe("running");
    expect(started.run.triggeredBy).toBe("op");
    const ghost = await service.getRun("ghost");
    expect(ghost?.status).toBe("interrupted");
    expect(ghost?.error).toMatch(/heartbeat stale/);

    const done = await waitForRun(started.run.id);
    expect(done.status).toBe("completed");
    const status = await service.getStatus();
    expect(status.current).toBeNull();
    expect(status.last?.id).toBe(started.run.id);
    const lease = await pool.query(`SELECT holder FROM ${S}.data_consolidation_leader`);
    expect(lease.rowCount).toBe(0); // released after the run
  }, 120_000);

  it("a cancelled run stops at the next batch boundary and leaves the cursor untouched", async () => {
    await addCampaign("K1", { open: "O1CT" });
    for (let i = 0; i < 6; i++) {
      await addSubscriber(`S0${i}`, ["O1CT"], ["1CT"]);
      await addEvent(`S0${i}`, "K1", { atSql: `NOW() - INTERVAL '${i + 1} hours'` });
    }
    let fired = false;
    hooks.onBatch = async (phase) => {
      if (phase === "rule3_complaint_u_tags" && !fired) {
        fired = true;
        await service.requestCancel();
      }
    };
    const run = await service.runOnce({ mode: "full" });
    expect(run.status).toBe("cancelled");
    expect(run.error).toMatch(/cancelled/i);
    expect(run.counters.rule1RefsRemoved).toBe(0); // never reached rule 1
    expect(run.counters.rule3EventsScanned).toBeLessThan(6);
    expect((await service.getState()).cursorAt).toBeNull();
    const lease = await pool.query(`SELECT holder FROM ${S}.data_consolidation_leader`);
    expect(lease.rowCount).toBe(0);

    // Relaunch finishes the job.
    const again = await service.runOnce({ mode: "full" });
    expect(again.status).toBe("completed");
    for (const row of Object.values(await snapshot())) expect(row).toEqual({ tags: ["O1CT", "U1CT"], refs: [] });
  }, 120_000);
});
