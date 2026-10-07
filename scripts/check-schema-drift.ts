/**
 * scripts/check-schema-drift.ts — read-only comparison of shared/schema.ts
 * against the live database.
 *
 * Why this exists: production deploys routinely run with SKIP_SCHEMA_PUSH=1
 * (drizzle-kit push --force is too dangerous on the prod tables), so schema
 * changes are applied by hand. When a column is added to schema.ts but the
 * matching DDL is never run, the code ships anyway and fails at runtime with
 * 42703 (undefined_column) — e.g. campaign_sends.smtp_outcome_class on
 * 2026-10-07, which silently stalled 24 campaigns in their retry phase.
 *
 * What it checks (presence only, no type comparison):
 *   - every pgTable in shared/schema.ts exists in the DB
 *   - every column of those tables exists in the DB
 * Extra DB columns/tables (present in the DB, absent from schema.ts) are
 * reported as informational — the code does not depend on them.
 *
 * Exit code: 1 when anything the code depends on is missing, 0 otherwise.
 * It prints copy-pasteable `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` DDL
 * for missing columns.
 *
 * Usage (server, repo root): npx tsx scripts/check-schema-drift.ts
 *   Reads NEON_DATABASE_URL || DATABASE_URL (same precedence as
 *   drizzle.config.ts). Falls back to parsing ./.env when neither is set.
 * Flags: --warn-only  → always exit 0 (report only)
 *        --quiet      → only print problems
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../shared/schema";

const warnOnly = process.argv.includes("--warn-only");
const quiet = process.argv.includes("--quiet");

function loadDotEnvIfNeeded(): void {
  if (process.env.NEON_DATABASE_URL || process.env.DATABASE_URL) return;
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key !== "NEON_DATABASE_URL" && key !== "DATABASE_URL") continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

type DbColumn = { table: string; column: string };

async function main(): Promise<number> {
  loadDotEnvIfNeeded();
  const connectionString = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("check-schema-drift: NEON_DATABASE_URL or DATABASE_URL must be set");
    return 2;
  }

  const client = new pg.Client({ connectionString, statement_timeout: 30_000 });
  await client.connect();
  try {
    const meta = await client.query<{ host: string | null; db: string; schema: string }>(
      "SELECT inet_server_addr()::text AS host, current_database() AS db, current_schema() AS schema",
    );
    const { host, db, schema: currentSchema } = meta.rows[0];

    const dbTables = new Set<string>(
      (
        await client.query<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = $1",
          [currentSchema],
        )
      ).rows.map((r) => r.table_name),
    );
    const dbColumns = new Map<string, Set<string>>();
    for (const row of (
      await client.query<DbColumn>(
        "SELECT table_name AS table, column_name AS column FROM information_schema.columns WHERE table_schema = $1",
        [currentSchema],
      )
    ).rows) {
      if (!dbColumns.has(row.table)) dbColumns.set(row.table, new Set());
      dbColumns.get(row.table)!.add(row.column);
    }

    const tables = Object.values(schema).filter((v): v is PgTable => is(v, PgTable));
    const missingTables: string[] = [];
    const missingColumns: Array<{ table: string; column: string; ddl: string; needsBackfill: boolean }> = [];
    const extraColumns: Array<{ table: string; column: string }> = [];
    const schemaTableNames = new Set<string>();

    for (const table of tables) {
      const cfg = getTableConfig(table);
      schemaTableNames.add(cfg.name);
      if (!dbTables.has(cfg.name)) {
        missingTables.push(cfg.name);
        continue;
      }
      const present = dbColumns.get(cfg.name) ?? new Set<string>();
      const declared = new Set<string>();
      for (const col of cfg.columns) {
        declared.add(col.name);
        if (present.has(col.name)) continue;
        // Suggested DDL: nullable add is metadata-only and safe on huge tables.
        // A NOT NULL column without a default needs a backfill first.
        const needsBackfill = col.notNull && !col.hasDefault;
        const ddl = `ALTER TABLE "${cfg.name}" ADD COLUMN IF NOT EXISTS "${col.name}" ${col.getSQLType()};`;
        missingColumns.push({ table: cfg.name, column: col.name, ddl, needsBackfill });
      }
      for (const dbCol of present) {
        if (!declared.has(dbCol)) extraColumns.push({ table: cfg.name, column: dbCol });
      }
    }

    const target = `${db}@${host ?? "local"} (schema ${currentSchema})`;
    if (!quiet) {
      console.log(`[schema-drift] target: ${target}`);
      console.log(`[schema-drift] ${tables.length} tables declared in shared/schema.ts`);
    }

    if (missingTables.length > 0) {
      console.log(`\n[schema-drift] ✗ ${missingTables.length} table(s) declared in schema.ts but MISSING in the DB:`);
      for (const t of missingTables) console.log(`  - ${t}`);
    }
    if (missingColumns.length > 0) {
      console.log(`\n[schema-drift] ✗ ${missingColumns.length} column(s) declared in schema.ts but MISSING in the DB:`);
      for (const m of missingColumns) {
        console.log(`  - ${m.table}.${m.column}${m.needsBackfill ? "   (NOT NULL without default → add nullable, backfill, then SET NOT NULL)" : ""}`);
      }
      console.log(`\n[schema-drift] Suggested DDL (run with SET lock_timeout = '5s'; retry on lock timeout):`);
      for (const m of missingColumns) console.log(`  ${m.ddl}`);
    }
    if (!quiet && extraColumns.length > 0) {
      console.log(`\n[schema-drift] ℹ ${extraColumns.length} column(s) present in the DB but not in schema.ts (ignored by the code):`);
      for (const e of extraColumns) console.log(`  - ${e.table}.${e.column}`);
    }

    const broken = missingTables.length > 0 || missingColumns.length > 0;
    if (!broken) {
      console.log(`[schema-drift] ✓ no missing tables or columns — DB matches shared/schema.ts for ${target}`);
      return 0;
    }
    console.log(
      `\n[schema-drift] ${warnOnly ? "WARNING" : "FAILED"}: the code expects objects that do not exist in the DB; it will fail with 42703/42P01 at runtime.`,
    );
    return warnOnly ? 0 : 1;
  } finally {
    await client.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("check-schema-drift: error:", err instanceof Error ? err.message : err);
    process.exit(2);
  });
