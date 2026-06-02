---
name: Import hard-fail vs statement_timeout
description: Why CSV imports hard-fail on "canceling statement due to statement timeout" and where the uncaught heavy statements live.
---

# Import hard-fail vs statement_timeout (PG 57014)

**Rule:** A `statement_timeout` (PG code `57014`) is NOT a connection-class error, so the
import conn-retry layer (`withConnRetry` / `isTransientConnError`, connection-class only)
does NOT catch it — it propagates uncaught.

**Why this matters:** The normal `processImport` path and remove-mode degrade gracefully
(batch upsert -> chunk -> per-row `singleUpsert` -> mark that row `failed`), so a statement
timeout there yields **"completed with N failed rows"**, never a hard "failed". A hard
`failed: canceling statement due to statement timeout` therefore can ONLY come from an
**uncaught** heavy statement that touches the ~89M-row `subscribers` table. Those live only
on the **refs import path**: `mergeRefsFromStaging`, `cleanExistingRefsInDb`,
`deleteSubscribersByRefsInDb`, and (historically) `detectImportRefs` running on the MAIN
pool's 2-min `statement_timeout` instead of the import pool's 5-min.

**How to apply:**
- Any NEW heavy bulk statement on the import path that hits `subscribers` must either go
  through the graceful per-row fallback OR run via `runHeavyImportQuery` (import pool,
  `SET LOCAL statement_timeout = IMPORT_HEAVY_STATEMENT_TIMEOUT_MS`, default 30 min) so one
  slow statement can't hard-fail the whole job.
- Derive inserted/updated from `INSERT ... ON CONFLICT ... RETURNING (xmax = 0) AS inserted`
  (inserted = count of xmax=0 rows; updated = rowCount - inserted). Do NOT add a separate
  `COUNT(DISTINCT ... JOIN subscribers)` pre-count — it's a redundant 89M-row read and is
  seq-scan-prone on unanalyzed temp/staging tables.
- `SET LOCAL statement_timeout` must be inside an explicit `BEGIN/COMMIT` to be safe on
  Neon PgBouncer transaction pooling (transaction-scoped, won't leak to reused backends).

**Agent-env limitation:** the live production Neon DB and the VM's PM2 logs are NOT reachable
from the Replit agent env (Replit "production" replica is a different/stale DB; the workspace
dev DB has ~100 rows; `fetch_deployment_logs` is empty for this self-hosted app; no SSH).
Import root-causing here is code-grounded only.
