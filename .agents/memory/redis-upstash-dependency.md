---
name: Redis (Upstash) dependency and what breaks without it
description: Prod Redis is a hosted Upstash instance; what the app actually uses it for, how an outage shows up, and the idle BullMQ worker trap.
---

Prod `REDIS_URL` points at a hosted Upstash database tied to a credit card. On 2026-10-07 (06:02 CEST) the Upstash account was suspended for a failed payment: every write answered `ERR Your database has been temporarily rate-limited` while PING kept working, so `/api/health` showed `redis: ok` **and** `workers.source = remote-worker-missing` at the same time.

**What Redis is used for (USE_BULLMQ is NOT enabled in prod — campaign/import jobs go through PostgreSQL):**
- worker heartbeat key read by the web health endpoint;
- shared segment-count cache (miss → full COUNT on subscribers in PG);
- `job-progress` pub/sub bridge between processes (live UI progress);
- 4 BullMQ Workers (campaigns/imports/flushes/automations) that still start whenever Redis is configured, even with USE_BULLMQ off — they poll empty queues and generate most of the Redis traffic and all of the error spam.

**How to read the symptom:** `remote-worker-missing` means "no heartbeat in Redis", not "worker dead" — confirm with `pm2 ls` / worker logs before restarting anything. Losing the shared count cache right before someone opens the dashboard is a plausible way to saturate the 6-connection web pool (503 load_shed → `checkout_timeout`) for a few minutes without the DB being down.

**How to apply:** when health flips to worker-missing, grep the worker log for `upstash`/`rate-limited` first and check the Upstash billing page. Durable fixes discussed: gate `startBullMQWorkers()` on USE_BULLMQ, or move to a local redis-server on the app host (Redis only coordinates processes on that one machine).
