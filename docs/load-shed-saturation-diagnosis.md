# DB Pool Saturation / Load-Shed 503 Diagnosis

Incident date: 2026-05-11. Daily count of `503 service_busy` responses
attributed to the load-shedding middleware:

| Route bucket     | Count | Reason     |
|------------------|------:|------------|
| `/api/other`     |    48 | saturation |
| `/api/campaigns` |    37 | saturation |
| `non-api`        |     4 | saturation |
| `/api/segments`  |     4 | saturation |
| **Total**        | **93**|            |

## What load-shed actually means

`server/middleware/pool-safety.ts::loadShedMiddleware` rejects non-critical
requests with `503 service_busy` + `Retry-After: 1` whenever **either**
condition holds for the main `pg.Pool`:

- `pool.waitingCount > 0` continuously for ≥ `POOL_WAITING_PERSISTENCE_MS`
  (500 ms by default), or
- `getPoolSaturation() ≥ POOL_LOAD_SHED_THRESHOLD` (0.9 by default).

This is **working as designed**: it converts pool starvation into a fast,
client-retryable response instead of a 10-second hang or a `pg` checkout
timeout 500. The metric we care about is the *frequency* of shedding, not
its existence — every 503 here is one user request that didn't get
served, even if it was rejected gracefully.

## Suspected workload causes (from code review)

1. **`/api/other` was a black hole.** The original `routeBucket` only
   labelled the seven biggest `/api/*` prefixes (`campaigns`,
   `subscribers`, `imports`, `segments`, `automations`, `analytics`,
   `mtas`); ~20 other prefixes (`/api/dashboard`, `/api/system-metrics`,
   `/api/database-health`, `/api/jobs`, `/api/error-logs`,
   `/api/export`, `/api/admin`, `/api/bug-reports`, `/api/warmup`,
   `/api/nullsink`, `/api/debug`, `/api/headers`, `/api/auth`,
   `/api/csrf-token`, `/api/webhooks`, `/api/unsubscribe`, `/api/track`,
   `/api/health`, `/api/metrics`, `/api/import`, `/api/import-jobs`,
   `/api/automation`, `/api/campaign-assets`, `/api/tag-queue`) all
   collapsed into a single `/api/other` label. 48/93 of yesterday's
   sheds landed there, hiding the real offender.

2. **`GET /api/campaigns?originalsOnly=true` had no covering index.**
   This is the default page load on the Campaigns screen. The query
   filters `parent_campaign_id IS NULL` and orders by `created_at DESC`,
   but the only existing campaigns indexes were on
   `(parent_campaign_id)` (unique, NOT NULL only), follow-up scheduling,
   and trigram GIN indexes for search. Postgres had to seq-scan +
   sort on every page load. Under modest concurrent traffic this holds
   pool clients long enough to push saturation past 90% and trip the
   shed.

3. **`GET /api/segments/counts` fanned out past the per-request lease.**
   The handler used `mapWithConcurrency(targetIds, 5, …)`, but the
   per-request connection lease (`MAX_CONNECTIONS_PER_REQUEST`,
   default 2) caps a single request to 2 concurrent pool checkouts.
   Cache misses beyond that cap throw `RequestLeaseExceededError` and
   get translated to 503 by `poolErrorHandler`. The unfiltered branch
   also enumerated **every** segment in the workspace before fanning
   out, so a workspace with thousands of segments could turn one
   request into thousands of cache-miss queries.

## Fixes shipped in this task

| # | Change | File | Reason |
|---|--------|------|--------|
| 1 | De-bucketed `/api/other` into ~20 named prefixes | `server/middleware/route-bucket.ts` | Make the next saturation incident attributable instead of a black hole. The `/api/other` bucket should now be near-empty in steady state. |
| 2 | Added partial covering index `campaigns_originals_created_at_idx ON campaigns (created_at DESC) WHERE parent_campaign_id IS NULL` | `server/repositories/campaign-repository.ts`, wired in `server/index.ts` | Index-only scan for the hottest `/api/campaigns` query path. Created with `CREATE INDEX CONCURRENTLY` under the existing advisory-lock bootstrap pattern (new key `CAMPAIGN_ORIGINALS_LIST = 900011`). |
| 3 | Lowered `mapWithConcurrency` from 5 → 2 in `/api/segments/counts` | `server/routes/segments.ts` | Match `MAX_CONNECTIONS_PER_REQUEST` so cache-miss fan-out no longer self-inflicts 503s. |
| 4 | Capped unfiltered fan-out at 100 segments | `server/routes/segments.ts` | Same 100-item ceiling the explicit-`ids` branch already enforced. Prevents a single call from issuing thousands of count queries on workspaces with many segments. |

## What was deliberately *not* changed

- `loadShedMiddleware`, `MAX_CONNECTIONS_PER_REQUEST`, `CRITICAL_PREFIXES`,
  `LOAD_SHED_THRESHOLD`, and the 503 contract are untouched. Those are
  the safety net, not the bug.
- `MAIN_POOL_MAX` is unchanged. The Neon direct-endpoint cap (50) and
  the existing connection budget remain the source of truth.
- The tracking, import, webhook-buffer, and bounce-buffer paths are
  untouched — they already bypass the main pool.

## How to verify (post-deploy)

1. Wait 24 h on prod, then re-pull `critsend_db_pool_load_shed_total` by
   `{reason, route}`. Expect:
   - Total daily count to drop ≥80% (target < 10).
   - `/api/other` bucket to be near-empty; remaining sheds attributed to
     a named bucket so the next round of optimization is targeted.
2. Inspect `critsend_http_request_duration_seconds{route="/api/campaigns"}`
   p99 — expect a measurable drop once the partial index is in use
   (`SELECT * FROM pg_stat_user_indexes WHERE indexrelname = 'campaigns_originals_created_at_idx'`
   should show `idx_scan > 0` within minutes of receiving traffic).
3. Inspect `critsend_db_pool_request_lease_exceeded_total{route="/api/segments/counts"}`
   — expect this to fall to ~0 since the handler no longer requests
   more concurrent checkouts than the cap allows.

If load-shed counts are still elevated after the next 24 h window, the
now-de-bucketed `/api/other` labels will name the next offender to
attack — repeat the same diagnose-then-fix loop on whatever bucket leads
the table.
