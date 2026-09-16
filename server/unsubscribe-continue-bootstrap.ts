import { pool } from "./db";
import { logger } from "./logger";
import type { PoolClient } from "pg";

let bootstrapPromise: Promise<void> | null = null;
const BOOTSTRAP_CONNECT_TIMEOUT_MS = 1_500;
const BOOTSTRAP_QUERY_TIMEOUT_MS = 1_500;

type BootstrapClient = PoolClient;

/**
 * Startup must not be held hostage by a saturated or unreachable database.
 * If a late checkout does eventually succeed, destroy that client because the
 * bootstrap invocation has already returned.
 */
async function connectWithTimeout(): Promise<BootstrapClient | null> {
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const connecting: Promise<BootstrapClient | null> = pool.connect().then((client): BootstrapClient | null => {
    if (timedOut) {
      client.release(true);
      return null;
    }
    return client;
  });
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(null);
    }, BOOTSTRAP_CONNECT_TIMEOUT_MS);
  });

  try {
    return await Promise.race<BootstrapClient | null>([connecting, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runUnsubscribeContinueBootstrap(): Promise<void> {
  let client: BootstrapClient | null;
  try {
    client = await connectWithTimeout();
  } catch (error) {
    logger.warn(
      `[UNSUBSCRIBE_CONTINUE] Schema bootstrap skipped because database checkout failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }
  if (!client) {
    logger.warn(
      `[UNSUBSCRIBE_CONTINUE] Schema bootstrap skipped after ${BOOTSTRAP_CONNECT_TIMEOUT_MS}ms checkout timeout`,
    );
    return;
  }

  let queryTimedOut = false;
  const query = <T = unknown>(text: string): Promise<T> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      queryTimedOut = true;
      reject(new Error(`unsubscribe-continue bootstrap query timed out after ${BOOTSTRAP_QUERY_TIMEOUT_MS}ms`));
    }, BOOTSTRAP_QUERY_TIMEOUT_MS);
    client.query(text)
      .then((result) => {
        clearTimeout(timer);
        resolve(result as T);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });

  try {
    await query("BEGIN");
    await query("SET LOCAL lock_timeout = '500ms'");
    await query(`SET LOCAL statement_timeout = '${BOOTSTRAP_QUERY_TIMEOUT_MS}ms'`);
    await query("SELECT pg_advisory_xact_lock(hashtext('unsubscribe_continue_claims_bootstrap'))");
    await query(`
      CREATE TABLE IF NOT EXISTS unsubscribe_continue_claims (
        ip_hash varchar(64) PRIMARY KEY,
        claimed_at timestamp NOT NULL DEFAULT now(),
        CONSTRAINT unsubscribe_continue_claims_ip_hash_format_check
          CHECK (ip_hash ~ '^[0-9a-f]{64}$')
      )
    `);
    await query("COMMIT");
    logger.info("[UNSUBSCRIBE_CONTINUE] Schema ready");
  } catch (error) {
    if (!queryTimedOut) {
      await query("ROLLBACK").catch(() => {});
    }
    logger.warn(
      `[UNSUBSCRIBE_CONTINUE] Schema bootstrap deferred; continue button remains hidden until schema is ready: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    client.release(queryTimedOut);
  }
}

/**
 * The migration is the durable deployment artifact. This idempotent bootstrap
 * also repairs deployments where migrations were not run before startup.
 */
export function ensureUnsubscribeContinueSchema(): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = runUnsubscribeContinueBootstrap().catch((error) => {
      logger.warn(
        `[UNSUBSCRIBE_CONTINUE] Optional schema bootstrap failed; routes remain available with the button hidden: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }
  return bootstrapPromise;
}