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
