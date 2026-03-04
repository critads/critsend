# Critsend System Architecture

## High-Level Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        BROWSER (React SPA)                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │
│  │Campaigns │ │Subscr.   │ │ Import   │ │Analytics │ │Settings  │ │
│  │  Wizard  │ │  Mgmt    │ │  UI      │ │Dashboard │ │ (MTA)    │ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ │
│       │             │            │             │            │       │
│  ┌────┴─────────────┴────────────┴─────────────┴────────────┴────┐ │
│  │              SSE (useJobStream) + React Query                 │ │
│  │      Singleton EventSource → Direct Query Cache Updates       │ │
│  └───────────────────────────┬───────────────────────────────────┘ │
└──────────────────────────────┼──────────────────────────────────────┘
                               │ HTTP / SSE
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     EXPRESS.JS SERVER (Node.js)                      │
│                                                                      │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌──────────────┐  │
│  │ Helmet  │ │  CORS   │ │  CSRF   │ │  Rate   │ │  Session     │  │
│  │  CSP    │ │         │ │  Token  │ │ Limiter │ │  (PG Store)  │  │
│  └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘ └──────┬───────┘  │
│       └───────────┴───────────┴───────────┴──────────────┘          │
│                               │                                      │
│  ┌────────────────────────────┴──────────────────────────────────┐   │
│  │                    ROUTE MODULES (14)                         │   │
│  │  campaigns | subscribers | import-export | segments           │   │
│  │  tracking  | webhooks    | analytics     | advanced-analytics │   │
│  │  mtas      | ab-testing  | automation    | warmup             │   │
│  │  nullsink  | database-health | health                        │   │
│  └───────────────────────────────────────────────────────────────┘   │
│                               │                                      │
│  ┌────────────────────────────┴──────────────────────────────────┐   │
│  │                   STORAGE LAYER (Drizzle ORM)                 │   │
│  │  IStorage interface → DatabaseStorage implementation          │   │
│  └───────────────────────────────────────────────────────────────┘   │
│                               │                                      │
│  ┌────────────────────────────┴──────────────────────────────────┐   │
│  │                 BACKGROUND WORKERS                            │   │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐  │   │
│  │  │Campaign Send │ │  Tag Queue   │ │ Flush Job Processor  │  │   │
│  │  │  Processor   │ │   Worker     │ │ (TRUNCATE/batched)   │  │   │
│  │  └──────────────┘ └──────────────┘ └──────────────────────┘  │   │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐  │   │
│  │  │Import Worker │ │  MTA Recov.  │ │ Maintenance Worker   │  │   │
│  │  │ (child proc) │ │  (30s poll)  │ │ (6h interval)        │  │   │
│  │  └──────────────┘ └──────────────┘ └──────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌───────────────────┐  ┌────────────────┐  ┌────────────────────┐  │
│  │   Job Events Hub  │  │  Message Queue  │  │  Metrics Collector │  │
│  │  (EventEmitter)   │  │ (LISTEN/NOTIFY) │  │  (15s interval)    │  │
│  └───────────────────┘  └────────────────┘  └────────────────────┘  │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    PostgreSQL (Neon)                                  │
│                                                                      │
│  Connection Budget: 50 total                                         │
│  ┌──────────────┐ ┌──────────────┐ ┌───────────────────────────┐    │
│  │  Main Pool   │ │ Import Pool  │ │  LISTEN/NOTIFY Connection │    │
│  │  (45 conns)  │ │  (4 conns)   │ │  (1 conn)                 │    │
│  └──────────────┘ └──────────────┘ └───────────────────────────┘    │
│                                                                      │
│  Timeouts: statement=120s (main) / 300s (import) | lock=30s (both)  │
│  Keepalive: 4min query (Neon) | 10s TCP keepalive                   │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Import Pipeline

```
User uploads CSV
       │
       ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  POST /api/import │───▶│  Object Storage  │───▶│  import_job_queue │
│  (chunked upload) │    │  (CSV file)      │    │  status: pending  │
└──────────────────┘    └──────────────────┘    └────────┬─────────┘
                                                         │
                                              LISTEN/NOTIFY 'import_jobs'
                                                         │
                                                         ▼
                                               ┌──────────────────┐
                                               │   Main Process   │
                                               │   (workers.ts)   │
                                               │  Claims job via  │
                                               │  SKIP LOCKED     │
                                               └────────┬─────────┘
                                                        │
                                                   fork()
                                                        │
                                                        ▼
┌──────────────────────────────────────────────────────────────────┐
│                  IMPORT WORKER (child process)                    │
│                                                                  │
│  ┌──────────────┐     ┌─────────────┐     ┌──────────────────┐  │
│  │  Stream CSV   │────▶│ Parse Rows  │────▶│  Batch Buffer    │  │
│  │  (readline)   │     │ Validate    │     │  (25,000 rows)   │  │
│  └──────────────┘     └─────────────┘     └───────┬──────────┘  │
│                                                    │             │
│                              ┌─────────────────────┤             │
│                              ▼                     ▼             │
│                     ┌──────────────┐     ┌──────────────────┐   │
│                     │ COPY command │     │ Direct INSERT    │   │
│                     │ (4 parallel) │     │ (fallback)       │   │
│                     └──────┬───────┘     └───────┬──────────┘   │
│                            │                     │               │
│                            └──────────┬──────────┘               │
│                                       │                          │
│                                       ▼                          │
│                            ┌────────────────────┐                │
│                            │  ON CONFLICT DO    │                │
│                            │  UPDATE (upsert)   │                │
│                            │  Merge tags/refs   │                │
│                            └────────┬───────────┘                │
│                                     │                            │
│  ┌──────────────────────────────────┤                            │
│  │           Progress IPC           │                            │
│  │  sendIpc() → parent process      │                            │
│  │  heartbeat every 10s             │                            │
│  │  flushProgress() DB + IPC        │                            │
│  └──────────────────────────────────┘                            │
│                                                                  │
│  Count Integrity:                                                │
│  - Pre/post subscriber count (fresh imports only)                │
│  - actualNew = min(post-pre, committed-failed-dupes)             │
│  - actualUpdated = committed - actualNew - failed - dupes        │
│  - Resume imports use batch-accumulated values                   │
└──────────────────────────────────────────────────────────────────┘
       │
       │ IPC messages
       ▼
┌──────────────────────────────────────────────────────────────────┐
│                    PARENT PROCESS                                 │
│                                                                  │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────────┐ │
│  │ IPC listener │────▶│ jobEvents    │────▶│ SSE stream       │ │
│  │ (process.on) │     │ .emitProgress│     │ GET /api/jobs/   │ │
│  └──────────────┘     └──────────────┘     │ stream           │ │
│                                            └──────────────────┘ │
│  Crash recovery:                                                 │
│  - 2min heartbeat timeout → retry (max 2)                        │
│  - 10min process timeout → SIGKILL                               │
│  - Parent writes final values if worker DB write failed          │
└──────────────────────────────────────────────────────────────────┘
```

---

## Campaign Sending Pipeline

```
POST /api/campaigns/:id/send
       │
       ▼
┌───────────────────┐     ┌──────────────────┐
│  Set campaign     │────▶│  campaign_jobs    │
│  status: sending  │     │  status: pending  │
└───────────────────┘     └────────┬─────────┘
                                   │
                        LISTEN/NOTIFY 'campaign_jobs'
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│              CAMPAIGN SENDER (V3 Engine)                         │
│              server/services/campaign-sender.ts                  │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  1. SETUP                                                │   │
│  │  - Verify MTA (SMTP test or nullsink check)              │   │
│  │  - Count segment subscribers                             │   │
│  │  - Recover orphaned pending sends                        │   │
│  │  - Set retry deadline (12h from now)                     │   │
│  └─────────────────────────┬────────────────────────────────┘   │
│                            │                                     │
│  ┌─────────────────────────▼────────────────────────────────┐   │
│  │  2. MAIN SEND LOOP                                       │   │
│  │                                                          │   │
│  │  while (subscribers remain):                             │   │
│  │    ┌───────────────┐   ┌──────────────────┐              │   │
│  │    │ Cursor-based  │──▶│ bulkReserveSend  │              │   │
│  │    │ batch fetch   │   │ Slots (INSERT    │              │   │
│  │    │ (10k-15k)     │   │ unique guard)    │              │   │
│  │    └───────────────┘   └───────┬──────────┘              │   │
│  │                                │                          │   │
│  │              ┌─────────────────┼─────────────────┐       │   │
│  │              ▼                 ▼                  │       │   │
│  │    ┌──────────────┐  ┌──────────────────┐        │       │   │
│  │    │  NULLSINK    │  │  REAL SMTP       │        │       │   │
│  │    │  (in-memory) │  │  (Nodemailer)    │        │       │   │
│  │    │  Batch 2500  │  │  Concurrent      │        │       │   │
│  │    │  sync render │  │  (5-250 parallel)│        │       │   │
│  │    └──────┬───────┘  └──────┬───────────┘        │       │   │
│  │           │                 │                     │       │   │
│  │           └────────┬────────┘                     │       │   │
│  │                    ▼                              │       │   │
│  │          ┌──────────────────┐                     │       │   │
│  │          │  Write-Behind   │                      │       │   │
│  │          │  Flush Buffer   │                      │       │   │
│  │          │  (2500 pending  │                      │       │   │
│  │          │   or 3-5s)      │                      │       │   │
│  │          └────────┬────────┘                      │       │   │
│  │                   │                               │       │   │
│  │                   ▼                               │       │   │
│  │          ┌──────────────────┐                     │       │   │
│  │          │ bulkFinalize    │                      │       │   │
│  │          │ Sends (atomic   │                      │       │   │
│  │          │ counter update) │                      │       │   │
│  │          └─────────────────┘                      │       │   │
│  │                                                   │       │   │
│  │  Guards:                                          │       │   │
│  │  - Status check every 10s (pause/cancel detect)   │       │   │
│  │  - Heartbeat every 30s                            │       │   │
│  │  - 10 consecutive SMTP failures → auto-pause      │       │   │
│  └───────────────────────────────────────────────────┘       │   │
│                            │                                     │
│  ┌─────────────────────────▼────────────────────────────────┐   │
│  │  3. RETRY PHASE (if failures exist, within 12h window)   │   │
│  │                                                          │   │
│  │  while (failed sends && within deadline):                │   │
│  │    - Fetch failed sends                                  │   │
│  │    - Mark for retry                                      │   │
│  │    - Re-attempt send (same nullsink/smtp path)           │   │
│  │    - Exponential backoff between passes                  │   │
│  │      (30s → 60s → ... → 15min cap)                      │   │
│  └──────────────────────────────────────────────────────────┘   │
│                            │                                     │
│  ┌─────────────────────────▼────────────────────────────────┐   │
│  │  4. RECONCILIATION                                       │   │
│  │                                                          │   │
│  │  SELECT COUNT(*) + FILTER by status FROM campaign_sends  │   │
│  │  Compare: segment_count vs campaign_sends.total          │   │
│  │  Warn if: >1% discrepancy AND >10 recipients            │   │
│  │  Warn if: any sends still in pending/reserved            │   │
│  └──────────────────────────────────────────────────────────┘   │
│                            │                                     │
│  ┌─────────────────────────▼────────────────────────────────┐   │
│  │  5. COMPLETION                                           │   │
│  │                                                          │   │
│  │  updateCampaignStatusAtomic('completed', 'sending')      │   │
│  │  Emit SSE completion event                               │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

---

## Tracking & Webhook Pipeline

```
                    Email delivered to recipient
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
     ┌──────────────┐ ┌─────────────┐ ┌────────────────┐
     │  Open pixel  │ │ Click link  │ │  Unsubscribe   │
     │  (1x1 img)   │ │ (redirect)  │ │  link click    │
     └──────┬───────┘ └──────┬──────┘ └───────┬────────┘
            │                │                 │
            ▼                ▼                 ▼
     ┌──────────────────────────────────────────────────┐
     │           TRACKING ROUTES                        │
     │  GET /api/track/open/:token                      │
     │  GET /api/track/click/:token                     │
     │  GET /api/unsubscribe/:token                     │
     │                                                  │
     │  1. Validate HMAC-SHA256 token                   │
     │  2. Record in campaign_stats                     │
     │  3. Enqueue tag operation (fire-and-forget        │
     │     with .catch() logging)                       │
     │  4. Return pixel/redirect/confirmation            │
     └─────────────────────┬────────────────────────────┘
                           │
                           ▼
     ┌──────────────────────────────────────────────────┐
     │        PENDING TAG OPERATIONS QUEUE              │
     │  pending_tag_operations table                    │
     │                                                  │
     │  Tag Queue Worker (2s poll):                     │
     │  - Bulk grouped UPDATEs for throughput           │
     │  - Retry with exponential backoff               │
     │  - In-memory campaign tag cache (60s TTL)        │
     └─────────────────────────────────────────────────┘

     ┌──────────────────────────────────────────────────┐
     │           WEBHOOK ROUTES                         │
     │  POST /api/webhooks/bounce                       │
     │  POST /api/webhooks/complaint                    │
     │                                                  │
     │  1. Authenticate webhook (provider-specific)     │
     │  2. Deduplicate (idempotency)                    │
     │  3. Hard bounce/complaint → tag subscriber BCK   │
     │  4. Bulk processing (single SELECT +             │
     │     bulk UPDATEs)                                │
     └─────────────────────────────────────────────────┘
```

---

## Flush (Delete All Subscribers) Pipeline

```
POST /api/subscribers/flush
       │
       ▼
┌──────────────────┐     ┌──────────────────┐
│  Create flush    │────▶│  flush_jobs       │
│  job record      │     │  status: pending  │
└──────────────────┘     └────────┬─────────┘
                                  │
                       LISTEN/NOTIFY 'flush_jobs'
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│                  FLUSH JOB PROCESSOR                             │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Phase 1: Clear Dependencies                             │   │
│  │  clearSubscriberDependencies()                           │   │
│  │  - campaign_sends, campaign_stats, nullsink_captures     │   │
│  │  - pending_tag_operations, automation_enrollments         │   │
│  │  - Batched DELETE with heartbeat updates                  │   │
│  └─────────────────────────┬────────────────────────────────┘   │
│                            │                                     │
│  ┌─────────────────────────▼────────────────────────────────┐   │
│  │  Phase 2: Delete Subscribers                             │   │
│  │                                                          │   │
│  │  PRIMARY: TRUNCATE subscribers CASCADE                   │   │
│  │  - Instant, no MVCC issues                               │   │
│  │  - Safe because dependencies already cleared             │   │
│  │                                                          │   │
│  │  FALLBACK (if TRUNCATE fails):                           │   │
│  │  - Batched DELETE (10,000 per batch)                     │   │
│  │  - 5 retries × 1s delay per stall                        │   │
│  │  - ctid-based DELETE on retry ≥3                         │   │
│  │  - Max 3 consecutive stalls before stopping              │   │
│  │  - Re-count between stalls (2s delay)                    │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

---

## Job Queue Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                  POSTGRESQL JOB QUEUES                            │
│                                                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │  campaign_jobs   │  │ import_job_queue │  │   flush_jobs    │ │
│  │                  │  │                  │  │                  │ │
│  │ Claim: UPDATE    │  │ Claim: UPDATE    │  │ Claim: UPDATE    │ │
│  │ SET status=      │  │ SET status=      │  │ SET status=      │ │
│  │ 'processing'     │  │ 'processing'     │  │ 'processing'     │ │
│  │ WHERE id=(SELECT │  │ WHERE id=(SELECT │  │ WHERE id=(SELECT │ │
│  │ ... FOR UPDATE   │  │ ... FOR UPDATE   │  │ ... FOR UPDATE   │ │
│  │ SKIP LOCKED)     │  │ SKIP LOCKED)     │  │ SKIP LOCKED)     │ │
│  │                  │  │                  │  │                  │ │
│  │ Retry: exp.      │  │ Retry: 2 max     │  │ Retry: on start  │ │
│  │ backoff 30s-15m  │  │ (2min heartbeat  │  │ (reset to        │ │
│  │ 12h deadline     │  │  timeout)        │  │  pending)        │ │
│  │                  │  │                  │  │                  │ │
│  │ Stale: 30min     │  │ Stale: 2min no   │  │ Stale: reset on  │ │
│  │                  │  │ heartbeat        │  │ server start     │ │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘ │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  MESSAGE QUEUE (LISTEN/NOTIFY)                           │   │
│  │                                                          │   │
│  │  Channels: campaign_jobs | import_jobs | flush_jobs |    │   │
│  │            tag_operations                                │   │
│  │                                                          │   │
│  │  Dedicated connection (1 from budget)                    │   │
│  │  Fallback polling: 1-2s intervals                        │   │
│  │  Advisory locks for coordination                         │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  DEAD LETTER HANDLING                                    │   │
│  │                                                          │   │
│  │  No separate DLQ table — status-based approach:          │   │
│  │  - Jobs exceeding retry limits → status='failed'         │   │
│  │  - Error details stored in error_message column          │   │
│  │  - error_logs table for detailed diagnostics             │   │
│  │  - Manual inspection/re-trigger via admin                │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

---

## SSE Real-Time Progress

```
┌─────────────────────────────────────────────────────────────────┐
│                  SERVER-SENT EVENTS                              │
│                                                                 │
│  GET /api/jobs/stream                                           │
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │ Import Worker │    │ Campaign     │    │ Flush Job        │  │
│  │ (IPC/direct) │    │ Sender       │    │ Processor        │  │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────────┘  │
│         │                   │                    │              │
│         └───────────────────┼────────────────────┘              │
│                             ▼                                   │
│                  ┌────────────────────┐                         │
│                  │  jobEvents Hub     │                         │
│                  │  (EventEmitter)    │                         │
│                  │  emitProgress()    │                         │
│                  └─────────┬──────────┘                         │
│                            │                                    │
│                            ▼                                    │
│                  ┌────────────────────┐                         │
│                  │  SSE Handler       │                         │
│                  │  res.write()       │                         │
│                  └────────────────────┘                         │
│                                                                 │
│  Client Safeguards:                                             │
│  - Monotonic guards (Math.max) — counters never decrease        │
│  - Terminal status guards — late events can't revert completion │
│  - structuralSharing on polling — poll can't overwrite SSE      │
│  - Singleton EventSource with ref-counting                      │
│  - Polling disabled when SSE connected (fallback on disconnect) │
└─────────────────────────────────────────────────────────────────┘
```

---

## Data Integrity Guarantees

| Mechanism | Where | Purpose |
|-----------|-------|---------|
| `campaign_sends_unique_idx` | `campaign_sends(campaign_id, subscriber_id)` | Prevents double-sending to same recipient |
| `subscribers_email_unique` | `subscribers(email)` | Prevents duplicate subscriber entries |
| `FOR UPDATE SKIP LOCKED` | Job queue claims | Race-condition-free multi-worker job pickup |
| `updateCampaignStatusAtomic` | Campaign state transitions | Only transitions from expected state |
| `bulkReserveSendSlots` | Pre-send reservation | DB-enforced exactly-once send reservation |
| `HMAC-SHA256 tokens` | Tracking URLs | Prevents forged opens/clicks |
| `lock_timeout=30s` | All DB pools | Prevents indefinite lock waits |
| `statement_timeout` | Main=120s, Import=300s | Prevents runaway queries |
| `Reconciliation check` | Post-campaign completion | Detects silently skipped recipients |
