/**
 * One-shot reclamation for the tracking_tokens table.
 *
 * Background: the new tracking_tokens retention rule (server/workers.ts) drains
 * old rows in batches but only marks them dead — Postgres does not return the
 * ~65 GB to the filesystem until the table is rewritten. This script performs
 * that rewrite once the steady-state has been reached.
 *
 * Usage (from the project root):
 *   tsx scripts/reclaim-tracking-tokens.ts --check
 *   tsx scripts/reclaim-tracking-tokens.ts --method=cluster --confirm
 *   tsx scripts/reclaim-tracking-tokens.ts --method=vacuum-full --confirm
 *   tsx scripts/reclaim-tracking-tokens.ts --method=pg-repack
 *
 * --check          Print before-size only and exit. Safe at any time.
 * --method=cluster Run CLUSTER tracking_tokens USING tracking_tokens_created_at_idx.
 *                  Holds an ACCESS EXCLUSIVE lock for the duration — schedule a
 *                  maintenance window. Rewrites + reindexes in one pass.
 * --method=vacuum-full
 *                  Run VACUUM FULL tracking_tokens. Same locking profile as
 *                  CLUSTER, slightly slower but no index ordering.
 * --method=pg-repack
 *                  Print the pg_repack command to run from a shell. pg_repack
 *                  rewrites the table online (no long lock) but must be run as
 *                  a separate OS-level binary against the cluster — this script
 *                  cannot invoke it for you.
 * --confirm        Required for cluster / vacuum-full because they take a long
 *                  exclusive lock.
 *
 * In all cases the script prints pg_total_relation_size('tracking_tokens')
 * before and after so the reclamation can be verified.
 */

import { pool } from "../server/db";

type Method = "cluster" | "vacuum-full" | "pg-repack";

function parseArgs(): { check: boolean; method?: Method; confirm: boolean } {
  const args = process.argv.slice(2);
  const out: { check: boolean; method?: Method; confirm: boolean } = {
    check: false,
    confirm: false,
  };
  for (const a of args) {
    if (a === "--check") out.check = true;
    else if (a === "--confirm") out.confirm = true;
    else if (a.startsWith("--method=")) {
      const v = a.slice("--method=".length);
      if (v !== "cluster" && v !== "vacuum-full" && v !== "pg-repack") {
        throw new Error(`Unknown --method=${v}`);
      }
      out.method = v;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return out;
}

async function getSize(label: string): Promise<void> {
  const res = await pool.query(`
    SELECT
      pg_size_pretty(pg_total_relation_size('tracking_tokens'))     AS total_pretty,
      pg_total_relation_size('tracking_tokens')                     AS total_bytes,
      pg_size_pretty(pg_relation_size('tracking_tokens'))           AS heap_pretty,
      pg_relation_size('tracking_tokens')                           AS heap_bytes,
      (SELECT n_live_tup FROM pg_stat_user_tables
        WHERE relname = 'tracking_tokens')                          AS live_rows,
      (SELECT n_dead_tup FROM pg_stat_user_tables
        WHERE relname = 'tracking_tokens')                          AS dead_rows
  `);
  const r = res.rows[0];
  console.log(`[${label}] tracking_tokens`);
  console.log(`  total size : ${r.total_pretty} (${r.total_bytes} bytes)`);
  console.log(`  heap size  : ${r.heap_pretty} (${r.heap_bytes} bytes)`);
  console.log(`  live rows  : ${r.live_rows}`);
  console.log(`  dead rows  : ${r.dead_rows}`);
}

async function runCluster(): Promise<void> {
  console.log(
    "[reclaim] Running CLUSTER tracking_tokens USING tracking_tokens_created_at_idx ...",
  );
  console.log(
    "[reclaim] This holds ACCESS EXCLUSIVE on tracking_tokens until it finishes.",
  );
  const client = await pool.connect();
  try {
    // Allow the rewrite to take as long as it needs and to wait on the lock.
    // The pool's default statement_timeout (120s) and lock_timeout (30s) are
    // far too aggressive for a multi-GB rewrite.
    await client.query("SET statement_timeout = 0");
    await client.query("SET lock_timeout = 0");
    const start = Date.now();
    await client.query("CLUSTER tracking_tokens USING tracking_tokens_created_at_idx");
    await client.query("ANALYZE tracking_tokens");
    console.log(`[reclaim] CLUSTER finished in ${Math.round((Date.now() - start) / 1000)}s`);
  } finally {
    client.release();
  }
}

async function runVacuumFull(): Promise<void> {
  console.log("[reclaim] Running VACUUM FULL tracking_tokens ...");
  console.log(
    "[reclaim] This holds ACCESS EXCLUSIVE on tracking_tokens until it finishes.",
  );
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = 0");
    await client.query("SET lock_timeout = 0");
    const start = Date.now();
    await client.query("VACUUM (FULL, ANALYZE) tracking_tokens");
    console.log(`[reclaim] VACUUM FULL finished in ${Math.round((Date.now() - start) / 1000)}s`);
  } finally {
    client.release();
  }
}

function printPgRepackInstructions(): void {
  const url = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL || "<DATABASE_URL>";
  console.log("[reclaim] pg_repack must be invoked from the OS shell, not from this script.");
  console.log("[reclaim] Recommended command (run on a host that can reach the database):");
  console.log("");
  console.log(`  pg_repack --no-superuser-check --table=public.tracking_tokens \\`);
  console.log(`    --jobs=2 --dbname='${url}'`);
  console.log("");
  console.log("[reclaim] pg_repack rewrites the table online and only takes a brief");
  console.log("[reclaim] exclusive lock at the very start and end. It requires the");
  console.log("[reclaim] pg_repack extension to be installed in the target database:");
  console.log("[reclaim]   CREATE EXTENSION pg_repack;");
  console.log("[reclaim] Re-run this script with --check afterwards to verify the size drop.");
}

async function main(): Promise<void> {
  const args = parseArgs();

  await getSize("before");

  if (args.check) {
    process.exit(0);
  }

  if (!args.method) {
    console.error(
      "Refusing to run: pass --method=cluster | --method=vacuum-full | --method=pg-repack, or --check.",
    );
    process.exit(2);
  }

  if (args.method === "pg-repack") {
    printPgRepackInstructions();
    process.exit(0);
  }

  if (!args.confirm) {
    console.error(
      `Refusing to run --method=${args.method} without --confirm. This will hold an ACCESS EXCLUSIVE lock on tracking_tokens.`,
    );
    process.exit(2);
  }

  if (args.method === "cluster") {
    await runCluster();
  } else if (args.method === "vacuum-full") {
    await runVacuumFull();
  }

  await getSize("after");
  process.exit(0);
}

main().catch((err) => {
  console.error("[reclaim] Failed:", err?.message || err);
  process.exit(1);
});
