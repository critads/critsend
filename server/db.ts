import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";
import { logger } from "./logger";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL,
  max: 20,
  min: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  statement_timeout: 120000,
  allowExitOnIdle: false,
});

pool.on('error', (err) => {
  logger.error('Unexpected DB pool error on idle client', { error: err.message });
});

pool.on('connect', () => {
});

export const db = drizzle(pool, { schema });
