import { pool } from "./db";
import { logger } from "./logger";

let bootstrapPromise: Promise<void> | null = null;

async function runBrandsBootstrap(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('brands_directory_bootstrap'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS brands (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        name varchar(255) NOT NULL,
        ref varchar(255) NOT NULL,
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS brands_name_ref_unique
      ON brands (name, ref)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS brands_created_at_idx
      ON brands (created_at)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS brands_name_lower_idx
      ON brands (lower(name))
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS brands_ref_lower_idx
      ON brands (lower(ref))
    `);
    await client.query("COMMIT");
    logger.info("[BRANDS] Schema ready");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The migration is the durable deployment artifact.  This bootstrap remains
 * intentionally idempotent because older deployments have missed migration
 * runs and must be able to recover on the next process start.
 */
export function ensureBrandsSchema(): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = runBrandsBootstrap().catch((error) => {
      bootstrapPromise = null;
      throw error;
    });
  }
  return bootstrapPromise;
}