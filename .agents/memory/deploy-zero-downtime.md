---
name: Critsend deploy zero-downtime & health gating
description: Why critsend-web must run PM2 cluster mode for zero-downtime reloads, and which signal is the authoritative web-readiness gate in deploy.sh.
---

# Reload downtime root cause
`critsend-web` historically ran PM2 **fork/single-instance**, so `pm2 reload` = kill+restart = ~60-90s dark per deploy while the one new process warms the link cache + ~50k token cache and runs bootstrap DDL on a busy DB.

# Fix (the durable decision)
Run `critsend-web` in **cluster mode, 2 instances, `wait_ready: true`**, and emit `process.send('ready')` from `server/index.ts` at `startupComplete=true` (routes + static mounted, BEFORE the ~90s bootstrap DDL). PM2 then keeps the old instance alive until the new one is ready → true rolling, zero-downtime reload.
**Why safe with NO Redis in prod:** sessions live in Postgres; the HTTP listener uses `reusePort`; all singleton background jobs use a DB leader-lease / advisory-lock / DB gate (not per-process state); `PROCESS_TYPE='web'` disables in-process workers. SSE progress is process-local without Redis, but each SSE conn is one long-lived request pinned to one backend and worker→web events already don't fan without Redis, so 2 instances are SSE-neutral.
**Cluster re-budget:** 2 instances would open 2×default(30)=60 main-pool conns; pin per-instance `WEB_PG_POOL_MAX` (set to 20 → ~40 aggregate) so the steady budget stays near the prior single-instance value while each instance can still absorb all traffic alone during the brief single-instance reload window.

# ONE-TIME activation gotcha
A plain `pm2 reload` will NOT convert an existing fork process into cluster mode. The first time only, on the VM:
`pm2 delete critsend-web && pm2 start deploy/ecosystem.config.cjs --only critsend-web --env production`
(brief downtime once). All subsequent deploys then get zero-downtime reloads.

# Authoritative readiness gate
`/api/health/startup` ALWAYS returns HTTP 200 — readiness is in the JSON body (`{"status":"ready"}` vs `{"status":"starting"}`). deploy.sh Step 8 must grep the body for `"status":"ready"`, not just the status code.
The Step 7b boot-line grep ("serving on port" in web-out.log) is **unreliable** (delayed past its 45s window by cache warming/bootstrap; logrotate can move the file) — it must be a non-fatal warning for `critsend-web`. Worker/drainer boot-line checks stay fatal (they have no HTTP endpoint).
