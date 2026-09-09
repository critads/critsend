import pg from "pg";

const { Client } = pg;
const connectionString =
  process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("NEON_DATABASE_URL or DATABASE_URL must be set");
}

const INDEX_NAME = "campaign_stats_ow_campaign_subscriber_idx";
const client = new Client({ connectionString });

interface IndexState {
  valid: boolean;
  ready: boolean;
  building: boolean;
}

async function readIndexState(): Promise<IndexState | null> {
  const result = await client.query<IndexState>(
    `SELECT i.indisvalid AS valid,
            i.indisready AS ready,
            EXISTS (
              SELECT 1
                FROM pg_stat_progress_create_index p
               WHERE p.index_relid = i.indexrelid
            ) AS building
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = $1`,
    [INDEX_NAME],
  );
  return result.rows[0] ?? null;
}

async function main(): Promise<void> {
  await client.connect();
  const table = await client.query<{ exists: boolean }>(
    "SELECT to_regclass('public.campaign_stats') IS NOT NULL AS exists",
  );
  if (!table.rows[0]?.exists) {
    console.log("[ow-index] campaign_stats does not exist yet; schema push will create it");
    return;
  }

  let state = await readIndexState();
  for (let attempt = 0; state?.building && attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    state = await readIndexState();
  }
  if (state?.building) {
    throw new Error(`${INDEX_NAME} is still building after 10 minutes`);
  }
  if (state?.valid && state.ready) {
    console.log(`[ow-index] ${INDEX_NAME} is already valid`);
    return;
  }
  if (state) {
    await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_NAME}`);
  }
  await client.query(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
       ON campaign_stats (campaign_id, subscriber_id)
       WHERE ip_address = '195.154.17.225'
         AND type IN ('open', 'complaint')`,
  );
  state = await readIndexState();
  if (!state?.valid || !state.ready) {
    throw new Error(`${INDEX_NAME} was created but is not valid and ready`);
  }
  console.log(`[ow-index] ${INDEX_NAME} created concurrently and verified`);
}

main()
  .finally(async () => {
    await client.end().catch(() => {});
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });