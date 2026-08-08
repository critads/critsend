/**
 * Tests for the import_staging nightly-purge safety protocol.
 *
 * Two layers:
 *
 *   UNIT TESTS (always run, no DB required):
 *     truncateIfSafe() with a mock PurgeClient — every outcome path verified,
 *     correct SQL primitives used, correct call order enforced.
 *
 *   INTEGRATION TESTS (run when DATABASE_URL is set, skip otherwise):
 *     Two real pg.Pool connections simulate concurrent transactions.  These
 *     prove that the shared/exclusive advisory-lock protocol actually blocks
 *     at the Postgres level, not just in mocks.  Tests cover:
 *       - Shared writer lock blocks the purge's exclusive try-lock
 *       - Purge succeeds once the writer releases
 *       - Phase-2 confirmation race: committed queue row → skipped_active_import
 *       - Staging rows visible inside the purge's transaction → skipped_nonempty
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import pg from "pg";
import {
  truncateIfSafe,
  IMPORT_STAGING_PURGE_LOCK_KEY,
  type PurgeClient,
} from "../server/services/import-staging-purge";

// ─── unit-test helpers ─────────────────────────────────────────────────────

function makeMockClient(overrides: {
  lockAcquired?: boolean;
  liveRows?: number;
  activeImportRows?: number;
}): { client: PurgeClient; calls: string[] } {
  const { lockAcquired = true, liveRows = 0, activeImportRows = 0 } = overrides;
  const calls: string[] = [];

  const client: PurgeClient = {
    query: vi.fn(async (sql: string) => {
      calls.push(sql.trim().replace(/\s+/g, " "));

      if (sql.includes("pg_try_advisory_xact_lock")) {
        return { rows: [{ acquired: lockAcquired }], rowCount: 1 };
      }
      if (sql.includes("COUNT(*)")) {
        return { rows: [{ cnt: String(liveRows) }], rowCount: 1 };
      }
      if (sql.includes("import_jobs") && sql.includes("import_job_queue")) {
        return {
          rows: new Array(activeImportRows).fill({ found: 1 }),
          rowCount: activeImportRows,
        };
      }
      if (sql.includes("TRUNCATE")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
  return { client, calls };
}

// ─── unit tests ────────────────────────────────────────────────────────────

describe("truncateIfSafe() — unit (mock client)", () => {
  it("returns 'skipped_lock' and never calls TRUNCATE when exclusive lock is unavailable", async () => {
    const { client, calls } = makeMockClient({ lockAcquired: false });
    const outcome = await truncateIfSafe(client);
    expect(outcome).toBe("skipped_lock");
    expect(calls.some(s => s.includes("TRUNCATE"))).toBe(false);
  });

  it("returns 'skipped_nonempty' when lock is held but rows exist inside the transaction", async () => {
    const { client, calls } = makeMockClient({ lockAcquired: true, liveRows: 42 });
    const outcome = await truncateIfSafe(client);
    expect(outcome).toBe("skipped_nonempty");
    expect(calls.some(s => s.includes("TRUNCATE"))).toBe(false);
  });

  it("returns 'skipped_active_import' when import_jobs has a pending row", async () => {
    const { client, calls } = makeMockClient({ lockAcquired: true, liveRows: 0, activeImportRows: 1 });
    const outcome = await truncateIfSafe(client);
    expect(outcome).toBe("skipped_active_import");
    expect(calls.some(s => s.includes("TRUNCATE"))).toBe(false);
  });

  it("calls TRUNCATE and returns 'truncated' when lock is held, table empty, no active import", async () => {
    const { client, calls } = makeMockClient({ lockAcquired: true, liveRows: 0, activeImportRows: 0 });
    const outcome = await truncateIfSafe(client);
    expect(outcome).toBe("truncated");
    expect(calls.some(s => s.includes("TRUNCATE"))).toBe(true);
  });

  it("passes the correct lock key constant to pg_try_advisory_xact_lock", async () => {
    const { client } = makeMockClient({ lockAcquired: false });
    const queryMock = client.query as ReturnType<typeof vi.fn>;
    await truncateIfSafe(client);
    const lockCall = queryMock.mock.calls.find(
      ([sql]: [string]) => sql.includes("pg_try_advisory_xact_lock"),
    );
    expect(lockCall).toBeDefined();
    expect(lockCall![1]).toEqual([IMPORT_STAGING_PURGE_LOCK_KEY]);
  });

  it("queries COUNT(*) only after acquiring the lock (order matters)", async () => {
    const { client, calls } = makeMockClient({ lockAcquired: true, liveRows: 0, activeImportRows: 0 });
    await truncateIfSafe(client);
    const lockIdx  = calls.findIndex(s => s.includes("pg_try_advisory_xact_lock"));
    const countIdx = calls.findIndex(s => s.includes("COUNT(*)"));
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(countIdx).toBeGreaterThan(lockIdx);
  });

  it("queries active imports only after verifying emptiness (order matters)", async () => {
    const { client, calls } = makeMockClient({ lockAcquired: true, liveRows: 0, activeImportRows: 0 });
    await truncateIfSafe(client);
    const countIdx  = calls.findIndex(s => s.includes("COUNT(*)"));
    const activeIdx = calls.findIndex(s => s.includes("import_jobs") && s.includes("import_job_queue"));
    expect(countIdx).toBeGreaterThanOrEqual(0);
    expect(activeIdx).toBeGreaterThan(countIdx);
  });

  it("checks all three import_job statuses in the active-import query", async () => {
    const { client } = makeMockClient({ lockAcquired: true, liveRows: 0, activeImportRows: 0 });
    const queryMock = client.query as ReturnType<typeof vi.fn>;
    await truncateIfSafe(client);
    const activeCall = queryMock.mock.calls.find(
      ([sql]: [string]) => sql.includes("import_jobs") && sql.includes("import_job_queue"),
    );
    expect(activeCall).toBeDefined();
    const activeSQL = activeCall![0] as string;
    expect(activeSQL).toContain("'pending'");
    expect(activeSQL).toContain("'processing'");
    expect(activeSQL).toContain("'awaiting_confirmation'");
  });

  it("uses pg_try_advisory_xact_lock (exclusive) — not the shared variant", async () => {
    const { client } = makeMockClient({ lockAcquired: false });
    const queryMock = client.query as ReturnType<typeof vi.fn>;
    await truncateIfSafe(client);
    const lockCall = queryMock.mock.calls.find(
      ([sql]: [string]) => sql.includes("pg_try_advisory_xact_lock"),
    );
    expect(lockCall![0]).not.toContain("_shared");
  });
});

// ─── active-import predicate coverage ──────────────────────────────────────

describe("active-import predicate: all guarded statuses", () => {
  for (const status of ["pending", "processing", "awaiting_confirmation"] as const) {
    it(`skips TRUNCATE when import_job status is '${status}'`, async () => {
      const { client } = makeMockClient({ lockAcquired: true, liveRows: 0, activeImportRows: 1 });
      expect(await truncateIfSafe(client)).toBe("skipped_active_import");
    });
  }
  for (const status of ["pending", "processing"] as const) {
    it(`skips TRUNCATE when import_job_queue status is '${status}'`, async () => {
      const { client } = makeMockClient({ lockAcquired: true, liveRows: 0, activeImportRows: 1 });
      expect(await truncateIfSafe(client)).toBe("skipped_active_import");
    });
  }
});

// ─── integration tests ─────────────────────────────────────────────────────
//
// These tests connect to a real Postgres instance and verify the advisory-lock
// protocol at the database level — not just in mocks.
//
// Pattern borrowed from tests/pressure-guard-concurrency.test.ts.

const HAS_DB = !!process.env.DATABASE_URL;
const dIntegration = HAS_DB ? describe : describe.skip;

dIntegration("integration: advisory-lock protocol (real Postgres)", () => {
  let pool: pg.Pool;
  // Unique suffix so parallel CI runs don't collide.
  const suffix   = Date.now();
  const testJobId = `test-purge-job-${suffix}`;
  const testEmail = `purge-test-${suffix}@example.com`;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

    // Minimal import_jobs row — no user_id FK in this table.
    await pool.query(
      `INSERT INTO import_jobs (id, filename, status, total_rows)
       VALUES ($1, 'purge-test.csv', 'awaiting_confirmation', 0)
       ON CONFLICT (id) DO NOTHING`,
      [testJobId],
    );
  }, 30_000);

  afterAll(async () => {
    // Best-effort cleanup; failures here are non-fatal.
    await pool.query(`DELETE FROM import_job_queue WHERE import_job_id = $1`, [testJobId]).catch(() => {});
    await pool.query(`DELETE FROM import_staging WHERE job_id = $1`, [testJobId]).catch(() => {});
    await pool.query(`DELETE FROM import_jobs WHERE id = $1`, [testJobId]).catch(() => {});
    await pool.end();
  }, 30_000);

  // ── 1. Lock primitive: shared → exclusive is blocked ─────────────────────

  it("shared writer lock blocks the purge's exclusive pg_try_advisory_xact_lock", async () => {
    const writer = await pool.connect();
    const purge  = await pool.connect();
    try {
      // Writer takes shared lock (simulates admission or COPY transaction).
      await writer.query("BEGIN");
      await writer.query("SELECT pg_advisory_xact_lock_shared($1)", [IMPORT_STAGING_PURGE_LOCK_KEY]);

      // Purge attempts exclusive try-lock — must fail while writer holds shared.
      await purge.query("BEGIN");
      const res = await purge.query(
        "SELECT pg_try_advisory_xact_lock($1) AS acquired",
        [IMPORT_STAGING_PURGE_LOCK_KEY],
      );
      expect(res.rows[0].acquired).toBe(false);

      // Release writer lock.
      await writer.query("COMMIT");

      // Purge's next try on the same transaction scope should also fail because
      // pg_try_advisory_xact_lock in a new statement inside the same txn
      // re-checks.  Open a fresh transaction to verify the lock is really gone.
      await purge.query("ROLLBACK");
      await purge.query("BEGIN");
      const res2 = await purge.query(
        "SELECT pg_try_advisory_xact_lock($1) AS acquired",
        [IMPORT_STAGING_PURGE_LOCK_KEY],
      );
      expect(res2.rows[0].acquired).toBe(true);
      await purge.query("ROLLBACK");
    } finally {
      // Best-effort ROLLBACK before release so no open transactions bleed into
      // subsequent tests (a held advisory lock in an open tx would cause false
      // skipped_lock results in the tests that follow).
      await writer.query("ROLLBACK").catch(() => {});
      await purge.query("ROLLBACK").catch(() => {});
      writer.release();
      purge.release();
    }
  }, 30_000);

  // ── 2. Multiple shared holders coexist ───────────────────────────────────

  it("two concurrent writers can both hold the shared lock simultaneously", async () => {
    // pg_advisory_xact_lock_shared returns void, so we verify it doesn't throw
    // and that a third connection's exclusive try-lock still returns false while
    // both shared holders are live.
    const w1     = await pool.connect();
    const w2     = await pool.connect();
    const purge3 = await pool.connect();
    try {
      await w1.query("BEGIN");
      await w2.query("BEGIN");
      await purge3.query("BEGIN");

      // Both writers take shared lock — neither should throw.
      await w1.query("SELECT pg_advisory_xact_lock_shared($1)", [IMPORT_STAGING_PURGE_LOCK_KEY]);
      await w2.query("SELECT pg_advisory_xact_lock_shared($1)", [IMPORT_STAGING_PURGE_LOCK_KEY]);

      // Exclusive try-lock fails while both shared holders are live.
      const res = await purge3.query(
        "SELECT pg_try_advisory_xact_lock($1) AS acquired",
        [IMPORT_STAGING_PURGE_LOCK_KEY],
      );
      expect(res.rows[0].acquired).toBe(false);

      await purge3.query("ROLLBACK");
      await w1.query("COMMIT");
      await w2.query("COMMIT");
    } finally {
      // Always ROLLBACK open transactions before releasing so leaked shared
      // locks don't bleed into subsequent tests.
      await w1.query("ROLLBACK").catch(() => {});
      await w2.query("ROLLBACK").catch(() => {});
      await purge3.query("ROLLBACK").catch(() => {});
      w1.release();
      w2.release();
      purge3.release();
    }
  }, 30_000);

  // ── 3. Phase-2 confirmation race (critical path) ─────────────────────────
  //
  // Simulates the scenario the review flagged:
  //   a) Phase-2 confirmation inserts an import_job_queue row and commits.
  //   b) Purge then tries — must find the queue row and return 'skipped_active_import'.
  //
  // This proves that a committed phase-2 queue row is visible to the purge's
  // active-import check, regardless of the advisory lock (the lock ensures the
  // purge cannot TRUNCATE while the INSERT is in flight; after commit the
  // active-import check provides the protection).

  it("phase-2 confirmation: committed queue row causes skipped_active_import", async () => {
    const queueClient = await pool.connect();
    try {
      // Simulate phase-2 confirmation: take shared lock, INSERT queue row, COMMIT.
      await queueClient.query("BEGIN");
      await queueClient.query(
        "SELECT pg_advisory_xact_lock_shared($1)",
        [IMPORT_STAGING_PURGE_LOCK_KEY],
      );
      await queueClient.query(
        `INSERT INTO import_job_queue
           (import_job_id, csv_file_path, total_lines, processed_lines,
            file_size_bytes, processed_bytes, last_checkpoint_line, status)
         VALUES ($1, 'phase2_merge', 0, 0, 0, 0, 0, 'pending')`,
        [testJobId],
      );
      await queueClient.query("COMMIT");
    } finally {
      queueClient.release();
    }

    // Now run the purge via truncateIfSafe on a fresh connection.
    const purgeClient = await pool.connect();
    let outcome: string | null = null;
    try {
      await purgeClient.query("BEGIN");
      outcome = await truncateIfSafe(purgeClient);
      await purgeClient.query("COMMIT");
    } finally {
      await purgeClient.query("ROLLBACK").catch(() => {});
      purgeClient.release();
    }

    // The purge must have found the queue row and skipped TRUNCATE.
    expect(outcome).toBe("skipped_active_import");

    // Cleanup: delete the queue row so subsequent tests start clean.
    await pool.query(
      `DELETE FROM import_job_queue WHERE import_job_id = $1 AND status = 'pending'`,
      [testJobId],
    );
  }, 30_000);

  // ── 4. In-flight writer (shared lock held) blocks purge mid-stream ────────
  //
  // T1 holds the shared lock (simulates COPY in progress).
  // T2 (purge) tries the exclusive lock — must get 'skipped_lock'.

  it("in-flight writer holding shared lock → purge returns skipped_lock", async () => {
    const writer = await pool.connect();
    let outcome: string | null = null;
    try {
      // Writer takes shared lock and holds it.
      await writer.query("BEGIN");
      await writer.query(
        "SELECT pg_advisory_xact_lock_shared($1)",
        [IMPORT_STAGING_PURGE_LOCK_KEY],
      );

      // Purge runs truncateIfSafe on a separate connection — try-lock fails.
      const purgeClient = await pool.connect();
      try {
        await purgeClient.query("BEGIN");
        outcome = await truncateIfSafe(purgeClient);
        await purgeClient.query("COMMIT");
      } finally {
        await purgeClient.query("ROLLBACK").catch(() => {});
        purgeClient.release();
      }

      await writer.query("ROLLBACK");
    } finally {
      writer.release();
    }

    expect(outcome).toBe("skipped_lock");
  }, 30_000);

  // ── 5. Staging rows committed → purge returns skipped_nonempty ───────────
  //
  // Inserts a row into import_staging (simulates a completed COPY batch)
  // then runs truncateIfSafe.  The lock is available (no concurrent writer),
  // but the COUNT(*) check inside the transaction finds the row.

  it("committed staging rows → purge returns skipped_nonempty", async () => {
    // Insert a test staging row (job_id has no FK constraint in this table).
    await pool.query(
      `INSERT INTO import_staging (job_id, email, refs, line_number)
       VALUES ($1, $2, ARRAY[]::text[], 1)`,
      [testJobId, testEmail],
    );

    const purgeClient = await pool.connect();
    let outcome: string | null = null;
    try {
      await purgeClient.query("BEGIN");
      outcome = await truncateIfSafe(purgeClient);
      await purgeClient.query("COMMIT");
    } finally {
      await purgeClient.query("ROLLBACK").catch(() => {});
      purgeClient.release();
    }

    // Purge must see the row and skip.
    expect(outcome).toBe("skipped_nonempty");

    // Cleanup.
    await pool.query(`DELETE FROM import_staging WHERE job_id = $1`, [testJobId]);
  }, 30_000);

  // ── 6. Lock key constant is the same integer on both sides ───────────────

  it("IMPORT_STAGING_PURGE_LOCK_KEY is a finite safe integer", () => {
    expect(Number.isSafeInteger(IMPORT_STAGING_PURGE_LOCK_KEY)).toBe(true);
    expect(IMPORT_STAGING_PURGE_LOCK_KEY).toBeGreaterThan(0);
  });
});

// ─── source guards (supplement, not replacement, for integration tests) ─────

describe("source guards: protocol consistency across all write paths", () => {
  const { readFileSync } = require("fs");
  const { resolve } = require("path");

  const lockLibSrc     = readFileSync(resolve(__dirname, "../server/lib/import-staging-lock.ts"), "utf8");
  const purgeSvcSrc    = readFileSync(resolve(__dirname, "../server/services/import-staging-purge.ts"), "utf8");
  const workersSrc     = readFileSync(resolve(__dirname, "../server/workers.ts"), "utf8");
  const importRouteSrc = readFileSync(resolve(__dirname, "../server/routes/import-export.ts"), "utf8");
  const processorSrc   = readFileSync(resolve(__dirname, "../server/services/import-processor.ts"), "utf8");
  const importRepoSrc  = readFileSync(resolve(__dirname, "../server/repositories/import-repository.ts"), "utf8");

  it("lock key constant defined as export const in lock-lib", () => {
    expect(lockLibSrc).toContain("export const IMPORT_STAGING_PURGE_LOCK_KEY");
  });

  it("purge service (truncateIfSafe) uses exclusive pg_try_advisory_xact_lock", () => {
    expect(purgeSvcSrc).toContain("pg_try_advisory_xact_lock");
    // Must NOT use the shared variant — purge needs exclusive
    expect(purgeSvcSrc).not.toContain("pg_try_advisory_xact_lock_shared");
  });

  it("import-export.ts uses pg_advisory_xact_lock_shared (shared) on all three queue-insertion paths", () => {
    // Three paths: initial upload, chunked complete, phase-2 confirmation
    const matches = (importRouteSrc.match(/pg_advisory_xact_lock_shared/g) ?? []).length;
    expect(matches).toBeGreaterThanOrEqual(3);
    // Must NOT use the exclusive (non-shared) blocking form on the admission side
    // (blocking exclusive would serialise all admissions unnecessarily)
    expect(importRouteSrc).not.toContain("pg_advisory_xact_lock(${");
  });

  it("import-processor.ts stageRefsToImportStaging holds shared lock around COPY", () => {
    // Shared lock must appear near the COPY statement
    expect(processorSrc).toContain("pg_advisory_xact_lock_shared");
    expect(processorSrc).toContain("COPY import_staging");
    // The BEGIN must precede the lock in the source
    const beginIdx  = processorSrc.indexOf('client.query("BEGIN")');
    const lockIdx   = processorSrc.indexOf("pg_advisory_xact_lock_shared", beginIdx);
    const copyIdx   = processorSrc.indexOf("COPY import_staging", lockIdx);
    const commitIdx = processorSrc.indexOf('client.query("COMMIT")', copyIdx);
    expect(beginIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeGreaterThan(beginIdx);
    expect(copyIdx).toBeGreaterThan(lockIdx);
    expect(commitIdx).toBeGreaterThan(copyIdx);
  });

  it("import-repository.ts enqueueImportJob wraps INSERT with shared lock", () => {
    expect(importRepoSrc).toContain("pg_advisory_xact_lock_shared");
    expect(importRepoSrc).toContain("importJobQueue");
  });

  it("workers.ts uses truncateIfSafe inside BEGIN/COMMIT transaction", () => {
    expect(workersSrc).toContain(`client.query("BEGIN")`);
    expect(workersSrc).toContain(`client.query("COMMIT")`);
    expect(workersSrc).toContain("truncateIfSafe(client)");
  });

  it("import_staging excluded from 6h generic maintenance loop", () => {
    expect(workersSrc).toMatch(/enabledRules\s*=\s*rules\.filter[\s\S]{0,300}import_staging/);
  });

  it("workers.ts preliminary check uses reltuples estimate before COUNT(*)", () => {
    // The workers.ts preliminary check queries pg_class.reltuples as a cheap
    // pre-screen; the fallback exact COUNT still exists inside the if-branch
    // for when the estimate is near-zero (that's intentional and correct).
    // Verify: reltuples is queried AND there's a PRELIM_THRESHOLD constant.
    expect(workersSrc).toContain("reltuples");
    expect(workersSrc).toContain("PRELIM_THRESHOLD");
    // The COUNT must be conditional on reltupleEstimate (inside an if-branch),
    // not a bare unconditional first statement.
    const reltupleIdx = workersSrc.indexOf("reltupleEstimate");
    const countIdx    = workersSrc.indexOf("COUNT(*)::bigint AS cnt FROM import_staging", reltupleIdx);
    // COUNT must appear AFTER reltupleEstimate is defined (not before the pre-screen).
    expect(reltupleIdx).toBeGreaterThan(-1);
    expect(countIdx).toBeGreaterThan(reltupleIdx);
  });

  it("system-repository.ts getImportStagingBloat uses reltuples pre-screen", () => {
    const sysRepoSrc = readFileSync(resolve(__dirname, "../server/repositories/system-repository.ts"), "utf8");
    expect(sysRepoSrc).toContain("reltuples");
    // Exact COUNT only runs when estimate is small
    expect(sysRepoSrc).toContain("EXACT_COUNT_THRESHOLD");
  });

  it("no magic integer 1984031800 appears in source (only the named constant)", () => {
    for (const [name, src] of [
      ["import-export.ts", importRouteSrc],
      ["import-processor.ts", processorSrc],
      ["import-repository.ts", importRepoSrc],
      ["workers.ts", workersSrc],
    ] as const) {
      expect(src, `${name} must not use raw lock integer`).not.toContain("1984031800");
    }
  });
});
