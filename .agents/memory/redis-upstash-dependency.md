---
name: Redis (Upstash) dependency and what breaks without it
description: Prod Redis is a hosted Upstash instance; what the app actually uses it for, how an outage shows up, and the idle BullMQ worker trap.
---

**Since 2026-10-07 ~06:48 CEST prod `REDIS_URL` is a local `redis-server` on the app host (`redis://127.0.0.1:6379`, apt package, no auth, loopback only).** Before that it pointed at a hosted Upstash database (CRITADS / mature-antelope, Fixed 1GB plan) tied to a credit card. On 2026-10-07 (06:02 CEST) the Upstash account was suspended for a failed payment: every write answered `ERR Your database has been temporarily rate-limited` while PING kept working, so `/api/health` showed `redis: ok` **and** `workers.source = remote-worker-missing` at the same time. Paying the invoice did NOT lift the block within 45 min (fresh connections still rejected; console showed the DB green with 0 commands) — the owner switched to local Redis instead. The Upstash DB may still exist/bill until deleted.

**What Redis is used for (USE_BULLMQ is NOT enabled in prod — campaign/import jobs go through PostgreSQL):**
- worker heartbeat key read by the web health endpoint;
- shared segment-count cache (miss → full COUNT on subscribers in PG);
- `job-progress` pub/sub bridge between processes (live UI progress);
- (until 2026-10-07) 4 BullMQ Workers (campaigns/imports/flushes/automations) that started whenever Redis was configured, even with USE_BULLMQ off — they polled empty queues and generated most of the Redis traffic and all of the error spam. Now gated by `isBullMQEnabled` (Redis + USE_BULLMQ=true): no Queue/Worker/dedicated connection otherwise. The Replit dev env still sets USE_BULLMQ=true with the old Upstash URL in `.replit` [env].

**How to read the symptom:** `remote-worker-missing` means "no heartbeat in Redis", not "worker dead" — confirm with `pm2 ls` / worker logs before restarting anything. Losing the shared count cache right before someone opens the dashboard is a plausible way to saturate the 6-connection web pool (503 load_shed → `checkout_timeout`) for a few minutes without the DB being down.

**How to apply:** when health flips to worker-missing, grep the worker log for `upstash`/`rate-limited` first and check the Upstash billing page. Both durable fixes are done (local redis-server on the app host; BullMQ gated on USE_BULLMQ) — a future Redis outage should only cost the heartbeat/cache/pub-sub, with far less log noise.
