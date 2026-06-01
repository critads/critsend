import { pool } from "../server/db";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const c0 = await pool.query(`SELECT count(*)::bigint AS c FROM tracking_tokens`);
  const t0 = Date.now();
  console.log(`count start: ${c0.rows[0].c}`);

  let sawActive = 0;
  for (let i = 0; i < 12; i++) {
    const r = await pool.query(
      `SELECT pid, state, now() - query_start AS run
       FROM pg_stat_activity
       WHERE application_name = 'tracking-migration-copy' AND state = 'active'`,
    );
    if (r.rows.length) {
      sawActive++;
      console.log(`  [${i}] ACTIVE pid=${r.rows[0].pid} run=${JSON.stringify(r.rows[0].run)}`);
    }
    await sleep(2500);
  }

  const c1 = await pool.query(`SELECT count(*)::bigint AS c FROM tracking_tokens`);
  const dt = (Date.now() - t0) / 1000;
  const delta = Number(c1.rows[0].c) - Number(c0.rows[0].c);
  console.log(`count end: ${c1.rows[0].c} (+${delta} in ${dt.toFixed(0)}s = ${(delta / dt).toFixed(0)}/s); active-samples ${sawActive}/12`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
