import { defineConfig } from "drizzle-kit";

const url = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;

if (!url) {
  throw new Error("NEON_DATABASE_URL or DATABASE_URL must be set. Did you forget to provision a database?");
}

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: { url },
  // `tracking_tokens` is a RANGE-partitioned table (daily partitions on
  // created_at) managed entirely by raw SQL — the bootstrap DDL in
  // server/repositories/campaign-repository.ts plus the one-time migration in
  // scripts/migrate-tracking-tokens-partitioning.ts. drizzle-kit cannot express
  // partitioning, and `deploy/deploy.sh` runs `drizzle-kit push --force` on every
  // deploy: without this exclusion, push would see the partitioned parent + its
  // child partitions (tracking_tokens_pYYYYMMDD) + the transient
  // tracking_tokens_legacy as drift and DROP/rewrite them, destroying the table.
  // IMPORTANT: tablesFilter only shields the DB-introspection side of push's
  // diff — it does NOT hide schema-side pgTable definitions. That is why
  // shared/schema.ts deliberately has NO pgTable for tracking_tokens (only a
  // plain TS interface): a pgTable there would make every push try
  // `CREATE TABLE tracking_tokens` and abort with 42P07. Keep BOTH guards.
  tablesFilter: ["!tracking_tokens", "!tracking_tokens_*"],
});
