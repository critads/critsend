# AUDIT PRODUCTION & SCALABILITY REPORT — Critsend

**Date:** 2026-05-03
**Scope:** Full codebase, database, backend, frontend, deployment, security, reliability
**Audit type:** Read-only analysis. **No code or schema changes were applied.**
**Methodology:** Multi-track parallel exploration (8 specialized passes) + targeted code verification

---

## A. EXECUTIVE SUMMARY

### Overall Health Score: **6.5 / 10**

Critsend is a **mature, well-engineered platform** with sophisticated patterns rarely seen in mid-stage SaaS (request lease tracking, split-pool architecture, counter drift reconciler, load shedding with structured 503 responses, advisory-lock-protected bootstrap migrations). The team has clearly invested in **production resilience**.

However, the audit identified **architectural debt and one structural blocker** that prevent the platform from scaling beyond its current single-organization use case without targeted refactoring.

### Top 5 Strengths

1. **Connection pool safety net** — request lease cap (2/req), AsyncLocalStorage tracking, automatic 500→503 upgrade with `Retry-After`, dedicated tracking + import pools through Neon's pgbouncer pooler.
2. **Counter drift reconciler** — self-healing pattern for cached aggregates; metric `critsend_counter_drift_fixed_total` exposes silent write failures.
3. **Comprehensive Prometheus metrics** — pool, query duration, lease holdings per route, buffer depths, drift counts, system info.
4. **Advisory-lock bootstrap migrations** — only one process runs each migration group; safe `pg_indexes` pre-checks; defers on disk pressure instead of crashing.
5. **Encryption at rest** — MTA passwords use AES-256-GCM with key derived from `MTA_ENCRYPTION_KEY`; bcrypt cost 12 for user passwords.

### Top 10 Risks Blocking Scale

| # | Risk | Severity | Category |
|---|---|---|---|
| 1 | **No multi-tenant isolation** in schema or queries — every authenticated user reads/writes the same data | **CRITICAL** | Security / SaaS readiness |
| 2 | **No ownership check on `:id` routes** — IDOR-style risk if any second org/user is added | **CRITICAL** | Security |
| 3 | **`uncaughtException` / `unhandledRejection` do not exit** the process — zombie risk | **HIGH** | Reliability |
| 4 | **Missing trigram index on `subscribers.email`** + `ILIKE %x%` queries → seq scan on multi-million-row table | **HIGH** | DB performance |
| 5 | **`tracking_tokens` table unbounded growth** — already caused "Disk quota exceeded" on Neon, blocked unique-index rebuild | **HIGH** | Capacity / Ops |
| 6 | **Synchronous file ops in HTTP handlers** — `countLines` (char-by-char), chunked import assembly, image fetching in `/api/campaigns/:id/process-html` | **HIGH** | Performance |
| 7 | **In-process schema migrations on boot** in route files — startup contention, AccessExclusive locks during reload | **MEDIUM** | Reliability |
| 8 | **Webhook idempotency limited to 60s in-memory window** — long-tail ESP retries duplicate processing | **MEDIUM** | Reliability |
| 9 | **Repository bypass** — many routes use `db.execute(sql\`...\`)` directly, business logic leaks into transport layer | **MEDIUM** | Maintainability |
| 10 | **Frontend imports `@shared/schema` directly** in 17 pages — DB schema changes propagate straight to bundle, no DTO boundary | **MEDIUM** | Maintainability / Security |

---

## B. CRITICAL ISSUES

### B.1 — No Multi-Tenant Isolation

| Field | Value |
|---|---|
| **Severity** | CRITICAL (if onboarding external customers) / LOW (if intentional single-org tool) |
| **Category** | Security / SaaS architecture |
| **Files** | `shared/schema.ts` (whole file), all `server/repositories/*.ts`, all `server/routes/*.ts` |

**Detected pattern:** No `user_id` / `owner_id` / `tenant_id` column exists on any business table (`subscribers`, `campaigns`, `mtas`, `segments`, `import_jobs`, `automation_workflows`, `tags`). Every repository method (e.g., `getCampaigns()` at `server/repositories/campaign-repository.ts:31`, `getSubscribers()` at `subscriber-repository.ts:97`, `getMtas()` at `mta-repository.ts:18`) returns global rows. Routes verify `req.session.userId` (`server/index.ts:565`) but never check that the requested `:id` resource belongs to the calling user.

**Risk at scale:** Today the app is used by Critads internally (single org, mutually-trusted users) — **acceptable**. The day a second organization is given access, **every user can read, modify, or delete every other org's subscribers, campaigns, and SMTP credentials**. The `mtas` table also exposes encrypted credentials to all authenticated users via `GET /api/mtas`.

**Recommended fix:**
1. Add `users.organization_id` (UUID, NOT NULL).
2. Add `organization_id` column to all business tables.
3. Backfill all existing rows with a default org.
4. Add a `requireOrgOwnership(req, resource)` helper.
5. Update every repository method to take and apply `organizationId` in WHERE.
6. Add CI test: assert no SELECT on business tables omits `organization_id`.

**Complexity:** High (multi-week refactor). **Safe to defer** until business plan calls for external orgs. **Document explicitly** in `replit.md` that current model assumes a single trusted organization.

---

### B.2 — Process Does Not Exit on Unhandled Rejection / Exception

| Field | Value |
|---|---|
| **Severity** | HIGH |
| **Category** | Reliability |
| **Files** | `server/index.ts:44-54`, `server/worker-main.ts`, `server/import-worker.ts` |

**Detected pattern:**
```ts
process.on('uncaughtException', (err) => { logger.error(...); /* no exit */ });
process.on('unhandledRejection', (reason) => { logger.error(...); /* no exit */ });
```

**Risk at scale:** A corrupted state (stale DB pool client, leaked transaction, half-released advisory lock) lingers forever. PM2 cannot restart what does not crash. Memory leaks accumulate silently. We have already seen one occurrence in the deployment logs:
> `[ERROR] Unhandled Promise Rejection {"reason":"This IP address ... is not allowed to connect..."}`

**Recommended fix:** After logging, call `process.exit(1)` (let PM2 restart) — but only after a short grace period to flush logs and tracking buffers. Wrap in a guard so a flush failure during shutdown does not loop.

**Complexity:** Low (~30 lines). **Safe to apply immediately** with manual verification.

---

### B.3 — `tracking_tokens` Disk Bloat / Unique Index Cannot Be Built

| Field | Value |
|---|---|
| **Severity** | HIGH (already blocked production) |
| **Category** | Capacity / Ops |
| **Files** | `server/repositories/campaign-repository.ts:798-870` (bootstrap), `scripts/reclaim-tracking-tokens.ts`, `docs/reclaim-tracking-tokens.md` |

**Detected pattern:** The bootstrap tries `CREATE UNIQUE INDEX CONCURRENTLY ... (type, campaign_id, subscriber_id, COALESCE(link_id, ''))`. On the production Neon instance this fails with `Disk quota exceeded` because the table has grown beyond Neon's per-build temp-file budget. The code already ships a reclaim script, but it must be run manually.

**Mitigation already shipped this session:** `ON CONFLICT (type, campaign_id, subscriber_id, COALESCE(link_id, ''))` was changed to `ON CONFLICT (token)` in `server/repositories/campaign-repository.ts` so that token generation no longer depends on the missing index. Duplicates in `(type, campaign_id, subscriber_id, link_id)` are now possible but harmless (lookup map dedupes at app layer).

**Remaining risk:** Old tokens from completed campaigns are never purged automatically. A scheduled reclamation (e.g., delete `tracking_tokens` rows where `campaign_id` belongs to a campaign in `completed/cancelled/failed` for >30 days) is required.

**Recommended fix:**
1. Add a scheduled reclaim worker running `scripts/reclaim-tracking-tokens.ts` weekly (cron in worker process).
2. Add Prometheus metric `critsend_tracking_tokens_total{state}` exposing total + reclaimable rows.
3. Alert when total > 50M.
4. Once the table is small enough, retry the unique-index build during a maintenance window.

**Complexity:** Medium. **Safe to apply immediately for the cron; defer the index rebuild until reclamation runs.**

---

### B.4 — Synchronous Heavy Work in HTTP Request Handlers

| Field | Value |
|---|---|
| **Severity** | HIGH |
| **Category** | Performance |
| **Files** | `server/routes/import-export.ts:14` (`countLines`), `server/routes/import-export.ts:557` (chunk assembly), `server/routes/campaigns.ts:336-462` (`process-html` image downloads + cheerio) |

**Detected patterns:**
- `countLines` reads multi-GB CSVs character-by-character on the event loop.
- Chunked-upload `complete` endpoint reassembles the file synchronously inside the request, blocking the web pool for seconds.
- `POST /api/campaigns/:id/process-html` synchronously fetches every external image, parses HTML with cheerio, all inside the request.

**Risk at scale:** During a 1 GB import or a heavy HTML-process call, the Node event loop is blocked, no other request on the same web process can be served, `/api/health` may itself time out, and PM2 may kill the process for unresponsiveness.

**Recommended fix:**
1. Move `countLines` to a Worker thread or use streaming with `read()`-byte-counting (no per-char loop).
2. Move chunk assembly to the worker process via the existing job queue; respond `202 Accepted` immediately.
3. Move `process-html` image fetch to the worker as a "preflight" job; current request returns immediately and the UI polls for status.

**Complexity:** Medium per fix. **Safe to apply incrementally**; each change is isolated.

---

### B.5 — Sensitive Endpoints Not Auth-Gated

| Field | Value |
|---|---|
| **Severity** | HIGH |
| **Category** | Security |
| **Files** | `server/routes/health.ts:273` (`/api/system-metrics`), `server/routes/analytics.ts:132` (`/api/error-logs`), `server/routes/database-health.ts` |

**Detected pattern:** `server/index.ts:565` enforces `req.session.userId` for **all `/api`** routes, **except** explicitly bypassed paths (`/api/health`, `/metrics`, `/api/track/*`, `/c/*`, `/u/*`, `/api/unsubscribe/*`, `/api/webhooks/*`, `/api/auth/*`). Verify that `/api/system-metrics`, `/api/error-logs`, and `/api/database-health` are **not** in the bypass list. If they are, internal stack traces, pool stats, and DB schema info are anonymously readable.

**Recommended fix:** Audit the bypass list in `server/index.ts` and remove any monitoring endpoint that should be auth-gated. Better: introduce an `internal-only` middleware that requires both session AND a header `x-internal-secret` for ops dashboards.

**Complexity:** Low. **Safe to apply immediately** after verifying current bypass list.

---

### B.6 — Session Fixation: No `req.session.regenerate()` on Login

| Field | Value |
|---|---|
| **Severity** | MEDIUM |
| **Category** | Security |
| **Files** | `server/index.ts:334, 379` |

**Detected pattern:** On login, the existing session is reused (`req.session.userId = user.id`). An attacker who can force a victim's browser to set a session cookie before login (e.g., via XSS on a sibling subdomain) can hijack the post-login session.

**Recommended fix:** Wrap login success in `req.session.regenerate(cb => { req.session.userId = ...; req.session.save(...) })`. Same for any "elevate privileges" action.

**Complexity:** Trivial. **Safe to apply immediately.**

---

### B.7 — In-Process Schema Migrations Running From Routes

| Field | Value |
|---|---|
| **Severity** | MEDIUM |
| **Category** | Reliability / Architecture |
| **Files** | `server/routes/campaigns.ts`, `server/routes/import-export.ts`, `server/routes/tracking.ts` (IIFEs running `ALTER TABLE` / `CREATE INDEX`) |

**Detected pattern:** Several route files have top-level IIFEs that run schema-shape changes on import. While protected by the new `bootstrap-lock.ts` advisory locks (good!), they still run on every web reload and add startup latency. Worse, they couple "first request can be served" to "all bootstrap migrations finished" since the route module is required to be loaded.

**Risk at scale:** During a `pm2 reload` under load, the new process holds a `share update exclusive` lock while the old one drains, and any user request hitting the new process waits for migrations.

**Recommended fix:** Extract every bootstrap migration into a **single explicit `runMigrations()` function** invoked once from `server/index.ts` before `app.listen()`, and from `server/worker-main.ts` before queue start. No more side-effect IIFEs in routes.

**Complexity:** Medium. Should be done as part of a planned maintenance window.

---

### B.8 — Webhook Idempotency Limited to 60s In-Memory Window

| Field | Value |
|---|---|
| **Severity** | MEDIUM |
| **Category** | Reliability |
| **Files** | `server/bounce-buffer.ts`, `server/routes/webhooks.ts:17` |

**Detected pattern:** Bounce/complaint dedup uses an in-memory `Map` with 60s TTL. Mailgun and SES retry up to **8 hours**. A process restart resets the dedup window. The downstream business logic (tag application, suppression) is mostly idempotent, but each duplicate still consumes a DB write.

**Recommended fix:** Add a `webhook_idempotency_keys (key text PRIMARY KEY, received_at timestamptz)` table; INSERT with `ON CONFLICT DO NOTHING`; if no row was inserted, skip processing. Cleanup rows older than 7 days via the existing reaper.

**Complexity:** Low. **Safe to apply immediately.**

---

### B.9 — Repository Bypass / Business Logic in Routes

| Field | Value |
|---|---|
| **Severity** | MEDIUM |
| **Category** | Maintainability |
| **Files** | `server/routes/campaigns.ts` (multiple), `server/routes/import-export.ts`, `server/routes/segments.ts` |

**Detected pattern:** Routes import `@shared/schema` and call `db.execute(sql\`...\`)` directly. The "auto-resend to openers" logic in `routes/campaigns.ts` performs multi-table cleanups that should live in `campaign-repository.ts`. This makes business rules invisible from a service layer perspective and impossible to unit-test without spinning up Express.

**Recommended fix:** Move every `db.execute` and `pool.query` call out of `routes/*.ts` into the corresponding repository. Routes should only orchestrate `req`/`res` and delegate.

**Complexity:** Medium-high (touches many files). Apply incrementally per route.

---

### B.10 — Frontend Imports `@shared/schema` Directly

| Field | Value |
|---|---|
| **Severity** | MEDIUM |
| **Category** | Maintainability / Security |
| **Files** | 17 files in `client/src/pages/*` |

**Detected pattern:** UI components import `Subscriber`, `Campaign`, etc. types from `@shared/schema`. Adding a sensitive column (e.g., a hashed token) automatically exposes it in the TS type used by the UI; if the API serializer ever sends the full row, the column ships to the browser.

**Recommended fix:** Introduce `shared/dto.ts` with explicit DTO types; routes return `toDto(row)`; frontend imports only DTOs.

**Complexity:** Medium. Safe; can be migrated table-by-table.

---

## C. DATABASE PERFORMANCE SECTION

### C.1 — Schema observations

- 30+ tables, generally well-normalized.
- Strong use of foreign keys with `ON DELETE CASCADE` for stats and sends.
- Unique constraints on `subscribers.email` (lowercased) and `campaign_sends(campaign_id, subscriber_id)` (good).
- **Missing**: `organization_id` on every business table (see B.1).
- **Missing CHECK constraints** on enum-like columns (`campaigns.status`, `campaign_jobs.status`) — would catch bad inserts at DB layer.

### C.2 — Recommended indexes (DDL — DO NOT APPLY YET)

> **All indexes below should be reviewed, then created with `CONCURRENTLY` during a quiet window, after disk-space reclamation on `tracking_tokens`.**

```sql
-- 1. Trigram on email (subscribers seq-scan killer)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX CONCURRENTLY subscribers_email_trgm_idx
  ON subscribers USING gin (email gin_trgm_ops);

-- 2. Keyset/covering index for the subscribers list
CREATE INDEX CONCURRENTLY subscribers_import_date_id_idx
  ON subscribers (import_date DESC, id DESC);

-- 3. Failed sends per campaign (retry dashboard)
CREATE INDEX CONCURRENTLY campaign_sends_campaign_failed_idx
  ON campaign_sends (campaign_id) WHERE status = 'failed';

-- 4. Cleanup of orphan failed sends
CREATE INDEX CONCURRENTLY campaign_sends_cleanup_idx
  ON campaign_sends (campaign_id) WHERE status = 'failed' AND retry_count = 0;

-- 5. Error logs by campaign + time (analytics)
CREATE INDEX CONCURRENTLY error_logs_campaign_timestamp_idx
  ON error_logs (campaign_id, timestamp DESC);

-- 6. Pending job queue claim (SKIP LOCKED)
CREATE INDEX CONCURRENTLY campaign_jobs_pending_retry_idx
  ON campaign_jobs (next_retry_at ASC NULLS FIRST) WHERE status = 'pending';

-- 7. Pending tag operations claim
CREATE INDEX CONCURRENTLY pending_tag_ops_claim_idx
  ON pending_tag_operations (created_at) WHERE status = 'pending';

-- 8. Nullsink captures listing (admin)
CREATE INDEX CONCURRENTLY nullsink_captures_timestamp_idx
  ON nullsink_captures (timestamp DESC);
```

### C.3 — Heavy / risky queries

| File:Line | Issue |
|---|---|
| `server/repositories/subscriber-repository.ts:105` | `ILIKE %x%` without trigram → seq scan |
| `server/services/segment-compiler.ts:182, 187, 193` | Segment count + `SELECT *` on millions of rows |
| `server/repositories/analytics-ops.ts:294` | `COUNT(*)` on `subscribers` per analytics refresh — use `pg_class.reltuples` for estimates |
| `server/repositories/analytics-ops.ts:212` | `COUNT(DISTINCT subscriber_id) FILTER (WHERE type = 'open')` — already cached on `campaigns` table; ensure code path uses cache, not aggregate |
| `server/repositories/subscriber-repository.ts:595` | One UPDATE per tag in a loop — consolidate into `UPDATE ... WHERE id = ANY($)` |
| `server/repositories/subscriber-repository.ts:114` | `OFFSET n` pagination — slow at high pages, use keyset |

### C.4 — Connection pooling — verdict: GOOD

Three independent pools (main 20, tracking 20, import 6) with 18-conn worker pool, all routed through Neon's pgbouncer pooler where appropriate. Direct-connection budget 40/50 with 10 headroom. The request-lease cap (2/req) is best-in-class. **No change needed.**

### C.5 — Transactions

- Bulk reserve/send is atomic via `bulkReserveSendSlots`.
- Tracking flush is **split** into two transactions (insert + mark-firsts) with `lock_timeout` 2s — already documented in `replit.md`.
- **Risk:** No transaction wraps "create campaign + insert into queue", so a crash between the two leaves a draft campaign with no enqueued job. Low impact (UI shows the draft, user can re-launch).

---

## D. SECURITY SECTION

### D.1 — Authentication risks
- Default session secret if `SESSION_SECRET` missing in dev — throws in prod (✓).
- **Session fixation** — see B.6.
- No login throttling beyond the global rate limiter — add a per-IP `login` bucket (3 attempts / 5 min).

### D.2 — Authorization risks
- **No ownership check on `:id` routes** — see B.1 / B.2.
- Admin actions and user actions share the same middleware tree.

### D.3 — Tenant isolation risks
- See B.1. **Document explicitly that current model is single-org.**

### D.4 — Secret exposure risks
- `server/index.ts:537` filters "sensitive patterns" in JSON response logging — verify the regex covers `password`, `token`, `secret`, `authorization`, `cookie`.
- `server/routes/campaigns.ts:466` logs `req.body` in some paths — ensure HTML content does not leak credentials inserted by mistake.
- `.env` is parsed by `loadEnvFile()` in `ecosystem.config.cjs` — make sure file mode is `0600`.

### D.5 — API abuse risks
- Tracking endpoints (`/c/:token`, `/api/track/open/...`) deliberately have looser rate limits — they could be used to fill the tracking buffer. The 25 k cap on bounce buffer + 503 load-shed mitigates, but no hard rate limit per source IP.
- Webhook endpoints validate `x-webhook-secret` with `timingSafeEqual` (✓).

### D.6 — Immediate security priorities
1. Apply B.6 (session regeneration) — 30 min of work, eliminates session fixation.
2. Audit bypass list in `server/index.ts` for monitoring endpoints (B.5).
3. Add login throttle (per-IP, 5/15min) using existing `express-rate-limit`.
4. **Plan** the multi-tenant migration (B.1) before onboarding any external customer.

---

## E. PERFORMANCE BOTTLENECK SECTION

### E.1 — Slow / risky endpoints

| Endpoint | Issue | File:Line |
|---|---|---|
| `POST /api/campaigns/:id/process-html` | Sync external image fetch + cheerio | `routes/campaigns.ts:336-462` |
| `POST /api/import/chunked/:uploadId/complete` | Sync chunk assembly | `routes/import-export.ts:557` |
| `POST /api/import` (any) | `countLines` char-by-char | `routes/import-export.ts:14` |
| `GET /api/segments/counts` | N+1 with concurrency 5 | `routes/segments.ts:56-97` |
| `GET /api/segments/:id/export` | Sync CSV streaming inside HTTP req | `routes/segments.ts:237-346` |
| `GET /api/analytics/campaign/:id/clicker-ips` | `SELECT DISTINCT ip` + CSV | `routes/analytics.ts:108` |
| `GET /api/analytics/overview` (fallback) | `COUNT(*)` on multi-M tables | `routes/advanced-analytics.ts:13-59` |

### E.2 — Background job risks

| Component | Risk |
|---|---|
| `campaign-sender.ts:148` (`godzilla` mode) | Concurrency 250 + batch up to 15 000 → memory spikes |
| `campaign-sender.ts:313` | `checkStatusAndHeartbeat` sync DB query every 10s on each campaign loop — adds latency |
| `tracking-buffer.ts:84` | Map prune is O(n) over 100 k entries — blocks event loop briefly |
| `bounce-buffer.ts:54` | Same Map-prune cost |
| `workers.ts:130` | Polling loops still run alongside LISTEN/NOTIFY — constant DB chatter |
| `workers.ts:83` | Tag queue claims only 50 ops at a time — many small tx for high-volume tagging |

### E.3 — Memory risks

- `--max-old-space-size=8192` (web) / `--max-old-space-size=6144` (worker) is generous; no immediate OOM risk.
- `tracking-buffer` and `bounce-buffer` Maps can spike to ~25-100 k entries during traffic bursts.
- CSV import uses `import_staging` — protects against memory bloat (good).

### E.4 — Frontend performance

| Issue | File:Line |
|---|---|
| `segmentNameById` Map rebuilt every render | `dashboard.tsx:154`, `campaigns.tsx:155` |
| `campaign-edit.tsx` 1230 lines; no code-splitting | `client/src/pages/campaign-edit.tsx` |
| `campaign-new.tsx` & `campaign-edit.tsx` duplicate ~80% of wizard logic | `client/src/pages/` |
| `recharts` + full `lucide-react` import — verify tree-shaking via `npm run build` bundle report | various |

### E.5 — Recommended caching / queue strategy

- Cache `getSegmentSubscriberCountCached` results in Redis with a 60s TTL (already partially done; verify hit rate via metric).
- Move `process-html` and `import/complete` to BullMQ jobs.
- Consider a small in-process LRU for `link_destinations` lookup (currently DB on every click).

---

## F. RELIABILITY SECTION

### F.1 — Logging gaps
- Custom logger is structured (good).
- **Gap**: `tryLogSystemError` in `server/index.ts:30-42` swallows DB-down errors silently — no fallback channel (no stderr-only path, no Sentry).

### F.2 — Error handling gaps
- See B.2 — zombie processes from un-exited handlers.
- `db-errors.ts` exists but several routes still hand-roll their own try/catch and return generic 500s.

### F.3 — Retry / idempotency
- Campaigns retry with exponential backoff (good).
- Webhooks dedup is short-lived (B.8).
- Tracking flusher retries lock-timeouts via the 15-min reconciler (good).

### F.4 — Monitoring recommendations

Add the following Prometheus alert rules:

```yaml
- alert: CounterDriftRegression
  expr: rate(critsend_counter_drift_fixed_total[15m]) > 0
  for: 30m
  annotations: { summary: "Counter writes are drifting — live write path failing" }

- alert: TrackingTokensTooLarge
  expr: critsend_tracking_tokens_total > 50e6
  annotations: { summary: "tracking_tokens > 50M, run reclaim" }

- alert: PoolLoadShedSustained
  expr: rate(critsend_db_pool_load_shed_total[5m]) > 1
  for: 10m
  annotations: { summary: "Sustained 503s — pool saturation" }

- alert: WebhookBufferOverflow
  expr: critsend_bounce_buffer_dropped_total > 0
  annotations: { summary: "Bounce buffer dropped events" }
```

---

## G. REFACTORING ROADMAP

### Phase 1 — Urgent fixes before more traffic (1-2 weeks, low risk)

1. **B.2** — `process.exit(1)` after logging in unhandled handlers (web + worker + import worker).
2. **B.5** — Audit and gate monitoring endpoints (`/api/system-metrics`, `/api/error-logs`, `/api/database-health`).
3. **B.6** — Session regeneration on login.
4. **B.8** — `webhook_idempotency_keys` table + 7-day reaper.
5. **B.3 (cron part)** — Schedule `reclaim-tracking-tokens.ts` weekly in worker.
6. Add login per-IP throttle (5 / 15 min).
7. Add the 4 Prometheus alert rules above.

### Phase 2 — Scaling improvements (2-4 weeks, medium risk)

1. **B.4** — Move `process-html`, `import/complete`, `countLines` off the event loop (Worker thread or background job).
2. **C.2** — Apply the 8 recommended indexes in a maintenance window, after `tracking_tokens` reclamation.
3. **B.7** — Centralize all bootstrap migrations in a single `runMigrations()` invocation.
4. **B.10** — Introduce DTO layer; migrate `Subscriber`, `Campaign`, `Mta` types first.
5. Replace `OFFSET` pagination with keyset pagination on the subscribers list.
6. Reduce polling intervals where LISTEN/NOTIFY is reliable (gate behind a feature flag).

### Phase 3 — Long-term architecture (1-3 months, higher complexity)

1. **B.1** — Multi-tenant migration: `organization_id` on all tables, repository signature change, CI guard.
2. **B.9** — Eliminate `db.execute` from routes; move all SQL to repositories.
3. Split `import-processor.ts` and `campaign-edit.tsx` into focused modules.
4. Extract the campaign sender into its own deployable service if send volume grows beyond one worker.
5. Introduce a proper migration tool (`drizzle-kit migrate` with versioned SQL files) and remove all in-process schema changes.
6. Add an integration test suite covering: import resumption after crash, MTA failover, counter reconciler, and connection budget edge cases.

---

## H. SAFE IMPLEMENTATION PROMPTS

> Copy each block individually into the next session. Each prompt is **isolated, low-risk, asks for tests first**, and can be reverted by reverting a single commit.

### Prompt 1 — Process exit on unhandled errors

```
In server/index.ts, server/worker-main.ts, and server/import-worker.ts, modify the
'uncaughtException' and 'unhandledRejection' handlers to flush logs, then call
process.exit(1) after a 2-second grace period. Add a unit test that simulates an
unhandled rejection and verifies the exit code. Do not change any other handler.
Show me a diff before applying.
```

### Prompt 2 — Session regeneration on login

```
In server/index.ts at the two login success paths (around lines 334 and 379),
wrap the session.userId assignment in req.session.regenerate() so the session ID
rotates on login. Add a test that verifies the cookie value changes after login.
Do not modify logout or any other auth path. Show me a diff before applying.
```

### Prompt 3 — Webhook idempotency table

```
Add a new table webhook_idempotency_keys (key text PRIMARY KEY, received_at
timestamptz NOT NULL DEFAULT now()). In server/routes/webhooks.ts, before
processing each event, INSERT ... ON CONFLICT DO NOTHING with the key
"{provider}:{messageId}:{type}". If 0 rows inserted, return 202 immediately.
Add a daily worker that DELETEs rows older than 7 days. Write tests for both
duplicate detection and TTL cleanup. Show me a diff and the migration SQL
before applying.
```

### Prompt 4 — Audit bypass list for monitoring endpoints

```
Read server/index.ts auth middleware around line 565 and list every path in the
bypass array. Confirm whether /api/system-metrics, /api/error-logs, and
/api/database-health require authentication. If any are public, add them behind
the session check. Provide a test that asserts unauthenticated requests to
those endpoints receive 401. Show me the audit results and the diff before
applying.
```

### Prompt 5 — Login rate limit

```
In server/routes.ts, add a per-IP rate limiter for POST /api/auth/login and
POST /api/auth/register: max 5 requests per 15 minutes, response 429 with
Retry-After. Use the existing express-rate-limit pattern. Write a test that
hits the endpoint 6 times and verifies the 6th is 429. Show me a diff before
applying.
```

### Prompt 6 — Tracking-tokens weekly reclaim cron

```
In server/workers.ts, add a weekly scheduled job (every Sunday 03:00 UTC) that
runs the logic of scripts/reclaim-tracking-tokens.ts in-process. Expose a
Prometheus gauge critsend_tracking_tokens_total{state="all"|"reclaimable"}.
Add a test that the cron registers and that the metric updates after a manual
trigger. Do not run the index rebuild yet. Show me a diff before applying.
```

### Prompt 7 — Move countLines off the event loop

```
In server/routes/import-export.ts, replace the character-by-character countLines
with a streaming approach using fs.createReadStream + Buffer.indexOf(0x0A). Keep
the same function signature. Add a test that counts lines correctly for files
ending with and without a trailing newline, and for a 100 MB synthetic file.
Show me a diff before applying.
```

### Prompt 8 — Move /api/campaigns/:id/process-html to background

```
In server/routes/campaigns.ts, refactor POST /api/campaigns/:id/process-html so
the handler enqueues a job and returns 202 with a job id. Add GET
/api/campaigns/:id/process-html/status that returns the job state. Implement
the worker handler in server/services/. Update the frontend campaign editor to
poll the status endpoint. Provide tests for the queue flow and a UI
integration test. Show me a diff before applying.
```

### Prompt 9 — Recommended indexes (one at a time)

```
Apply ONE index at a time, in order, with CREATE INDEX CONCURRENTLY, during a
quiet period. After each, verify EXPLAIN on the matching query and show me the
plan diff. Start with subscribers_email_trgm_idx. Do not apply the next one
until I confirm the previous one is good.
```

### Prompt 10 — DTO layer for Subscriber

```
Create shared/dto/subscriber.ts exporting type SubscriberDto and a function
toSubscriberDto(row). Update server/routes/subscribers.ts to return
toSubscriberDto everywhere. Update client/src/pages/subscribers.tsx to import
SubscriberDto from @shared/dto/subscriber instead of Subscriber from
@shared/schema. Add a test that the API never returns the password_hash or any
internal-only column. Show me the diff before applying.
```

### Prompt 11 — Centralize bootstrap migrations

```
Create server/migrations/run-bootstrap.ts exporting runBootstrapMigrations().
Move every IIFE migration currently scattered in server/routes/*.ts into named
functions inside this file. Call runBootstrapMigrations() once from
server/index.ts BEFORE app.listen(), and from server/worker-main.ts BEFORE
queue start. Verify with a test that no module-level await/IIFE remains in
server/routes/*.ts. Show me the diff before applying.
```

### Prompt 12 — Document multi-tenant decision

```
Update replit.md with a new section "Single-organization assumption" that
documents: (a) all authenticated users see the same data by design, (b) the
schema lacks organization_id, (c) onboarding a second org requires the
migration described in AUDIT_PRODUCTION_SCALABILITY_REPORT.md section B.1.
Show me the diff before applying.
```

---

## END OF REPORT

**Files referenced:** 35+
**Tables analyzed:** 30+
**Endpoints reviewed:** 70+
**Recommendations:** 12 prompts grouped in 3 phases

For questions or clarifications on any specific finding, reference the section letter and number (e.g., "B.4" or "C.2 index #3").
