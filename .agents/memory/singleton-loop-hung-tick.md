---
name: Singleton background loops have no recovery from a hung tick
description: Why an in-process re-entrancy guard + self-refreshing leader lease can freeze a background loop forever, and what defenses are required.
---

# Singleton background-loop hung-tick freeze

A singleton background loop that combines (a) an in-process re-entrancy guard
(e.g. `isPolling`) with (b) a leader lease kept alive by a background
refresh timer has **no recovery path from a tick that hangs on a
never-settling `await`** (dead SMTP socket, lost concurrency-limiter permit,
unbounded I/O). The guard blocks every new tick, and the refresh keeps the
lease in the future so no other process can take over. Result: indefinite
freeze with a healthy-looking lease.

**Why:** Observed in prod on the pressure-guard drainer — one tick hung ~22h
while the leader lease kept refreshing (`expires_at` always in the future)
but the productive `last_tick_at` stayed frozen; ~1.65M due-now sends piled
up. Diagnostic signature: **lease refreshed + last-productive-tick stale**,
and `pg_stat_activity` clean (no stuck DB query → the hang is in app code, not
Postgres). `safeInterval`/try-catch wrappers do NOT help: they catch
rejections, not hangs.

**How to apply:** Any singleton loop behind a leader lease (drain, pressure
maintenance, pmta-collector, etc.) needs BOTH:
1. A **per-unit-of-work timeout** (`Promise.race`) so a single op can never
   hang the tick. Keep it well above the underlying lib timeouts (e.g. >
   nodemailer's 10s socketTimeout) so it only fires on true hangs.
2. A **heartbeat watchdog**: bump a timestamp at tick start + after each unit
   of progress; a watchdog interval force-exits the process (PM2 restarts,
   lease self-releases after TTL) when in-flight with no progress for a
   window. Invariant: watchdog window ≫ per-unit timeout (≥2×) or a
   slow-but-progressing tick false-trips. Only self-exit in a dedicated
   process; in embedded mode log loudly instead of killing web/worker.

**Immediate manual recovery** when a freeze is already live and you can't SSH
fast: restart the owning process (`pm2 restart <proc>`); the lease frees on
TTL and a fresh process resumes. Stranded `attempting` rows are swept failed
(bookkeeping-only, no duplicate) by the orphaned-sends reconciler.

**Residual risk:** a per-send timeout that fires after the MTA already
accepted (send resolves late) can duplicate on retry — same accepted risk as
the existing catch→failed→auto-requeue path. Proper fix = transport-level
cancellation (AbortSignal), not yet implemented.

## Variant: in-memory active-job registry (campaign sender)

A second hung-tick shape, distinct from the leader-lease singleton above: a
worker tracks in-flight campaign jobs in a process-local registry that is
cleared ONLY by a fire-and-forget promise's `finally{}`. If
`processCampaignInternal`'s promise never settles, `finally` never runs, the
campaign stays "active" forever, and the duplicate-job guard rejects every
re-enqueued successor → permanent wedge, only a PM2 restart clears it.

**Why the DB guardian can't save you:** the wedge lives in ANOTHER process's
memory. The DB stale-heartbeat guardian can fail+re-enqueue the row, but the
successor still hits the in-memory dup guard. No SQL reaches process-local
state — recovery MUST be in-process.

**How to apply (defenses that actually un-wedge):**
1. Track `lastProgressAt` per active entry, refreshed by the sender's
   heartbeat callback (`onProgress` hook). Liveness, not mere presence, is the
   wedge signal.
2. Self-healing dup guard + a per-process watchdog interval that aborts and
   **force-deletes** entries stalled past a threshold (≫ heartbeat interval),
   freeing the concurrency slot so a successor can take over. Per-process,
   in-memory only — no leader election needed (unlike DB singletons).
3. Make the fire-and-forget `finally` **ownership-aware** (delete only if the
   entry's jobId still equals this job's id) so a late-settling zombie can't
   evict the successor that already took its slot.
4. Bound the external await itself: nodemailer `socketTimeout` only bounds an
   ALREADY-ASSIGNED socket — a pooled `sendMail` with no free connection waits
   forever. Wrap `sendMail` in `Promise.race` vs a timeout that rejects
   `code='ETIMEDOUT'` (classified retryable) so the loop keeps progressing.

**Why wire-level double-send is bounded here:** the send loop reserves each
recipient via an atomic CAS (`pressureGuardReserveSendSlots`); two concurrent
loops (zombie + successor) can't both win the same subscriber, so DB-level
single-send holds even during the eviction overlap window.
