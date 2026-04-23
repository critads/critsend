#!/usr/bin/env tsx
/**
 * One-shot full-table counter reconciliation.
 *
 * Walks every campaign (no time-window filter) and rewrites:
 *   - campaigns.sent_count             from campaign_sends.status='sent'
 *   - campaign_sends.first_open_at     from MIN(timestamp) campaign_stats opens
 *   - campaign_sends.first_click_at    from MIN(timestamp) campaign_stats clicks
 *
 * Idempotent. Only touches rows that disagree with the source-of-truth.
 *
 * Usage on the OVH host:
 *   cd /home/ubuntu/critsend
 *   tsx scripts/reconcile-counters.ts
 *
 * Or via PM2 one-off:
 *   pm2 exec critsend-web -- tsx scripts/reconcile-counters.ts
 *
 * Run this once after deploying the atomic side-effect fix to recover any
 * campaigns that were already affected by the dropped-side-effect bug.
 * After that, the in-process worker (startCounterReconciler) keeps things
 * in sync automatically every 15 minutes.
 */

import { reconcileCounters } from "../server/workers/counter-reconciler";
import { trackingPool } from "../server/tracking-pool";
import { pool } from "../server/db";

async function main() {
  console.log("[reconcile-counters] starting full-table pass…");
  const t0 = Date.now();
  const result = await reconcileCounters({ scope: "all" });
  const elapsed = Date.now() - t0;

  console.log("[reconcile-counters] done:");
  console.log(`  sent_count fixed:      ${result.sentCountFixed}`);
  console.log(`  first_open_at fixed:   ${result.firstOpenFixed}`);
  console.log(`  first_click_at fixed:  ${result.firstClickFixed}`);
  console.log(`  total elapsed:         ${elapsed}ms`);
}

main()
  .then(async () => {
    await trackingPool.end().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[reconcile-counters] FAILED:", err);
    await trackingPool.end().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(1);
  });
