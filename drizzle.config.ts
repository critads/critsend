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
  // Excluding the whole family keeps it out of push's reach on both sides of the
  // diff. The table still has a Drizzle definition in shared/schema.ts purely for
  // TypeScript types.
  tablesFilter: ["!tracking_tokens", "!tracking_tokens_*"],
});
