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
});
