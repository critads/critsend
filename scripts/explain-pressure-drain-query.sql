-- ─────────────────────────────────────────────────────────────────────────
-- Pressure-guard drain — eligibility query EXPLAIN harness
-- ─────────────────────────────────────────────────────────────────────────
--
-- Purpose
--   Task #173 swapped the pressure-guard drain's "which campaigns to work on
--   next" query from a cheap SELECT DISTINCT to a per-campaign COUNT(*)
--   aggregation (volume-priority + fairness ordering). On a 200k+ deferred-row
--   backlog the new query does more work than the old one. This script
--   captures EXPLAIN (ANALYZE, BUFFERS) so we can confirm:
--     1. The planner picks `campaign_sends_pressure_deferred_idx`.
--     2. Total execution time stays well under 1 second.
--     3. The plan never escalates to a full sequential scan of campaign_sends.
--
-- How to run (production)
--   Connect to the production database as a read-only role and execute:
--     psql "$PROD_READONLY_URL" -f scripts/explain-pressure-drain-query.sql
--   Run during a real backlog window (deferred_total >= 50k) for a meaningful
--   plan; the planner's choices flip as the deferred fraction of the table
--   changes. Re-run a few times to capture cold vs warm cache behavior.
--
-- Parameters
--   $1 = MAX_CAMPAIGNS_PER_TICK * 3 = 15 (PRESSURE_GUARD_MAX_CAMPAIGNS=5, the
--        current production default; raise if the env var differs)
--   $2 = PRESSURE_MAX_DEFER_HOURS  = 72 (default; override if the env var
--        differs in production)
--
-- Pass/fail criteria
--   PASS:
--     - "Index Scan using campaign_sends_pressure_deferred_idx" appears in plan
--     - Execution Time < 1000 ms (target), < 5000 ms (hard ceiling)
--     - Buffers: shared read/hit count grows ~ linearly with deferred row count
--   FAIL — investigate / consider a covering index:
--     - Plan shows "Seq Scan on campaign_sends" instead of the partial index
--     - Execution Time > 1000 ms, OR > 25000 ms (statement_timeout)
--
-- Why a Seq Scan can sneak in
--   When the partial-index predicate (status='pending' AND eligible_at IS NOT
--   NULL) matches a large fraction of the table (verified empirically: >~50%),
--   PostgreSQL switches to a Parallel Seq Scan because the index loses
--   selectivity. In production the deferred backlog is typically <10% of the
--   table, so the partial index is highly selective — but during a stuck-
--   campaign incident this ratio can spike. If a Seq Scan appears, the fix is
--   not to remove the index; it is to investigate why drainable rows aren't
--   draining (pressure-drain worker stalled, dedicated drain process crashed,
--   etc.) before the table accumulates a backlog that defeats the planner.
--
-- ─────────────────────────────────────────────────────────────────────────

\timing on

-- Context: snapshot the backlog so the plan is interpretable.
SELECT
  (SELECT COUNT(*)::bigint FROM campaign_sends)                                              AS table_rows,
  (SELECT COUNT(*)::bigint FROM campaign_sends
     WHERE status='pending' AND eligible_at IS NOT NULL)                                     AS deferred_rows,
  (SELECT COUNT(*)::bigint FROM campaign_sends
     WHERE status='pending' AND eligible_at IS NOT NULL AND eligible_at <= NOW())            AS drainable_now,
  (SELECT COUNT(DISTINCT campaign_id)::bigint FROM campaign_sends
     WHERE status='pending' AND eligible_at IS NOT NULL)                                     AS distinct_campaigns,
  pg_size_pretty(pg_relation_size('campaign_sends'))                                          AS table_size,
  pg_size_pretty(pg_relation_size('campaign_sends_pressure_deferred_idx'))                    AS partial_index_size;

-- The exact eligibility query from
-- server/workers/pressure-guard-worker.ts (~line 574-597). Parameters mirror
-- the worker's defaults; adjust if PRESSURE_GUARD_MAX_CAMPAIGNS or
-- PRESSURE_MAX_DEFER_HOURS differs in your production environment.
EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
WITH per_campaign AS (
   SELECT cs.campaign_id, COUNT(*)::bigint AS drainable_count
   FROM campaign_sends cs
   WHERE cs.status = 'pending'
     AND cs.eligible_at IS NOT NULL
     AND (
       cs.eligible_at <= NOW()
       OR (
         cs.first_deferred_at IS NOT NULL
         AND cs.first_deferred_at <= NOW() - (72::numeric || ' hours')::interval
       )
     )
   GROUP BY cs.campaign_id
 )
 SELECT pc.campaign_id,
        c.created_at,
        pc.drainable_count,
        c.pending_count,
        c.sent_count
 FROM per_campaign pc
 JOIN campaigns c ON c.id = pc.campaign_id
 WHERE c.status IN ('sending', 'paused')
 ORDER BY pc.drainable_count DESC, c.created_at ASC NULLS FIRST
 LIMIT 15;
