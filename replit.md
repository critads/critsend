# Critsend - Email Marketing Platform

## Overview

Critsend is an email marketing platform designed for efficient management and engagement of large subscriber bases. It offers comprehensive subscriber management with tag-based segmentation, a user-friendly campaign creation wizard, and flexible Mail Transfer Agent (MTA) configurations. The platform supports high-volume email sending with configurable speeds, detailed tracking (opens/clicks), and automatic unsubscribe handling. Key features include production-grade CSV import/export with batch processing, a complete REST API for integration, and capabilities to ensure email deliverability and data integrity. The business vision is to provide a scalable, reliable, and feature-rich solution for businesses to effectively communicate with their audience, driving engagement and marketing success.

## User Preferences

I want iterative development.
I prefer to be asked before making major changes.
I prefer clear and concise explanations.
I prefer high-quality code that is well-documented and maintainable.
I prefer that you use a structured approach to problem-solving.
I prefer that you break down complex tasks into smaller, manageable steps.
Do not make changes to the `design_guidelines.md` file.

## Documentation Map

This file is a high-level overview. Deep forensic/design detail lives in `docs/`:
- **`docs/architecture-history.md`** — verbatim root-cause/fix/contract notes for the resilience, tracking, queue, storage, and maintenance subsystems (the back-reference target for the summaries below).
- `docs/architecture.md` — broader architecture reference.
- `docs/pressure-guard-audit.md`, `docs/load-shed-saturation-diagnosis.md`, `docs/reclaim-tracking-tokens.md`, `docs/prometheus-alerts.md` — focused deep-dives.

Keep this file light: when a feature needs more than ~2 sentences of forensic detail, move the detail to `docs/architecture-history.md` and leave a one-line summary + back-reference here.

## System Architecture

The Critsend platform uses a modern web stack: React, TypeScript, Vite, TailwindCSS, and Shadcn/UI for the frontend, and Express.js with TypeScript for the backend. PostgreSQL, managed with Drizzle ORM, serves as the primary data store, optimized for large datasets with advanced indexing. The system supports multi-user access with session-based authentication and AES-256-GCM encryption for sensitive data.

**UI/UX Decisions:**
The UI/UX follows Material Design 3 principles, featuring a clean, modern aesthetic with dark/light mode support, full mobile responsiveness, and a card-based layout. It uses Inter for text and JetBrains Mono for technical displays, with blue as the primary accent color.

**Technical Implementations & Design Choices:**
- **Authentication:** Session-based authentication with bcrypt for password hashing. All API routes require authentication, except public tracking, webhooks, health, and metrics endpoints.
- **Subscriber Management:** Features tag-based segmentation with GIN-indexed tags, a refs system for segment targeting, and a 7-day cooling-off period for unsubscribed contacts.
- **Campaign Management:** A 5-step wizard for campaign creation, including a WYSIWYG HTML editor and MTA selection. Supports A/B testing with variant tracking and automated winner declaration.
- **Email Sending:** High-performance sending via Nodemailer with configurable speeds and connection pooling. Supports concurrent campaign processing with a two-path architecture (in-memory nullsink and real SMTP).
- **Tracking:** Open tracking (1×1 pixel) and click tracking (redirects with open-redirect prevention); all tracking URLs are HMAC-SHA256 signed, capture enriched context (IP, country, device, browser, OS), and use opaque UUID tokens with branded short URLs. Every outbound send path funnels through the single `prepareTrackedHtml` chokepoint in `server/email-service.ts` (personalize → image rewrite → unsubscribe URL → pixel + click rewrite → footer) — add new send paths via this helper or they silently lose tracking (guard test: `tests/prepare-tracked-html.test.ts`). Send-time "pretty/disguised" URL rewriting is ON by default (kill-switch `PRETTY_TRACKING_URLS=false`). Events are buffered in-memory and batch-inserted to an isolated pool; engagement counters are cached on `campaigns` with a 15-min reconciler. **Full detail (chokepoint invariant, pretty-URL routes, lifecycle-stage reconciler invariant, FBL-as-unsubscribe handling):** `docs/architecture-history.md`.
- **Segmentation (DSL v2):** Employs a recursive rule DSL for advanced segmentation with nested groups (AND/OR combinators, max 3 depth) and server-side pagination for segments. Includes targeted, cached subscriber counts with auto-invalidation.
- **CSV Import/Export:** Unified CSV format with auto-detection for refs and tags. Uses PostgreSQL COPY for high-performance imports with chunked file uploads, tag mode, pre-import operations, email deduplication, and live row counters. Supports forced tags/refs and removal of tags/refs.
- **Job Queues:** Dual-mode system with PostgreSQL-backed queues (SKIP LOCKED and LISTEN/NOTIFY) and optional BullMQ + Redis. The campaign sender claim is FIFO by `campaigns.created_at` with an aged-job fairness tie-breaker (`JOB_FAIRNESS_PROMOTE_MIN`, default 15min) so an old re-enqueuing campaign can't starve younger ones. **Never mutate `campaigns.created_at` to reprioritize** — it is the immutable launch-ancestry key both the sender FIFO and the drain's deferred-subscriber serialization depend on. Detail: `docs/architecture-history.md`.
- **Automation Workflows:** Trigger-based email sequences with a multi-step workflow builder.
- **Advanced Analytics:** Comprehensive analytics including engagement trends, cohort analysis, deliverability, and subscriber growth.
- **Prometheus Metrics:** Full observability via a `/metrics` endpoint and an in-app **System Metrics** dashboard displaying key performance indicators.
- **Security:** CSRF protection, Helmet.js security headers with CSP, CORS, extensive input validation, HTML sanitization, 5-tier rate limiting, secure session management, and webhook authentication.
- **Maintenance — `tracking_tokens` retention:** `tracking_tokens` is a daily RANGE-partitioned table on `created_at` (partitions `tracking_tokens_pYYYYMMDD`; helper `server/tracking-partitions.ts`). Retention runs daily at 01:00 Europe/Paris and **DROPs** whole day-partitions older than `TRACKING_TOKEN_RETENTION_DAYS` (default 90; prod 7), topping up a 7-day forward buffer. **drizzle-kit push is shielded** from this table via `tablesFilter` in `drizzle.config.ts` — never remove that filter or `deploy/deploy.sh`'s `drizzle-kit push --force` will rewrite it. Full partitioning/migration/cutover history (prod cutover 2026-06-01, legacy dropped 2026-06-04, ~284 GB reclaimed): `docs/architecture-history.md`.
- **Robustness:** Graceful shutdown, memory monitoring with load shedding, bounce-webhook idempotency, bulk-optimized batch webhook processing, and automated campaign auto-resume (MTA-down + DB connection errors) running in BOTH the worker and the always-up web process via a guarded atomic flip (`resumeCampaignAtomic`) plus a bounded force-resume backstop (`MTA_FORCE_RESUME_AFTER_MS`). Web-process guardians rescue stuck import/campaign jobs; bootstrap migrations use advisory locks + `CREATE INDEX CONCURRENTLY`. Detail: `docs/architecture-history.md`.
- **Repository Pattern:** Storage layer decomposed into focused repository modules for subscriber, campaign, import, MTA, job, and system management.
- **Data Integrity & Concurrency:** Utilizes PostgreSQL's transactional capabilities, atomic counter updates, unique indexes, and optimistic locking.
- **Real-Time SSE Progress:** Server-Sent Events push instant progress updates for import, flush, and campaign jobs, with Redis integration for split-process mode.
- **Process Separation:** Supports a split-process architecture with dedicated web server and worker processes, utilizing Neon's PgBouncer pooled endpoints for database connections.
- **Pool Saturation Safety Net:** Layered defenses (connection timeouts, load shedding, request lease tracking, bounce webhook buffering) prevent pool starvation and ensure service availability, with detailed Prometheus metrics for monitoring.
- **Resilience & Observability:** A series of production-incident-driven hardening passes (503-attribution traceability, bootstrap-lock self-heal for PgBouncer transaction pooling, parallelized pressure-guard drain, drain process isolation, real-time snowball ratio, drain tracking-parity, head-of-line blocking fix, stuck-pending self-heal). Full forensic detail (root causes, evidence, fixes, contracts) lives in **[`docs/architecture-history.md`](docs/architecture-history.md)**.
- **Nullsink SMTP Testing:** An internal SMTP server allows for testing campaigns without sending real emails.
- **Marketing Pressure Guard:** Hard **2h gap** between any two emails to the same contact across **all** campaigns (production constant in `server/services/pressure-guard.ts`; `PRESSURE_WINDOW_HOURS` env honoured only in non-prod). An atomic CAS reserves send slots; losers are enqueued as deferred sends and drained by a worker by volume priority with a configurable fairness slice (`PRESSURE_GUARD_FAIRNESS_PCT`), ordered by `campaigns.created_at` (NOT `started_at`). **Architectural rule:** any singleton background job through Neon's PgBouncer pooled URL MUST use lease-table leader election (`pressure_guard_leader`), NEVER session-level `pg_try_advisory_lock` (leaks on transaction-pooled backends). Counters, Prometheus metrics, per-campaign/admin queue endpoints, and a flush audit table are exposed. Full forensic history: `docs/architecture-history.md`.
- **Self-Hosted Deployment:** Provided `deploy/` directory includes PM2 configuration, Nginx setup, idempotent bootstrap script, deployment script, and GitHub Actions workflow for automated deployments.
- **PMTA Queue Monitoring:** A background collector (`server/services/pmta-collector.ts`) SSHes into the PMTA host every 5 minutes, runs `pmta show queue <domain>` for each domain in `PMTA_DOMAINS` (validated to prevent shell injection), and persists one snapshot per (domain, tick) to `pmta_queue_snapshots`. HTTP routes serve cached rows only (never SSH on the request path); `POST /api/pmta/refresh` forces a tick. Singleton scheduling uses a lease-table leader election (`pmta_collector_leader`). Required secrets: `PMTA_SSH_{HOST,PORT,USER,PRIVATE_KEY}`, `PMTA_DOMAINS`. Frontend page at `/pmta`. Detail: `docs/architecture-history.md`.

## External Dependencies

- **PostgreSQL (Neon):** Primary database, hosted on Neon Launch plan, configured for SSL.
- **Nodemailer:** Used for real SMTP email sending with pooling and retries.
- **`sanitize-html`:** For sanitizing HTML content in campaigns.
- **`connect-pg-simple`:** For persistent session management using PostgreSQL.
- **`bcrypt`:** For secure password hashing.
- **`helmet`:** For HTTP security headers.
- **`prom-client`:** Prometheus metrics client for Node.js.
- **`geoip-lite`:** Local database for IP address to country/city lookup.
- **`ua-parser-js`:** For parsing user agent strings to extract device, browser, and OS information.
- **Object Storage for CSV imports:** Selected via the `STORAGE_BACKEND` env var. Production runs on `hetzner` (Hetzner Object Storage, S3-compatible) to avoid "CSV file not found" errors from local-disk storage; required env vars `HETZNER_S3_{ENDPOINT,REGION,BUCKET,ACCESS_KEY,SECRET_KEY}` (activation guide `deploy/HETZNER_S3_SETUP.md`). Implementation `server/storage-backends/hetzner-s3.ts` (multipart uploads, bounded timeouts, typed errors distinguishing user-re-upload vs operator-fix vs client-retry). Hardened against Hetzner `503 SlowDown` via adaptive client retry + a deferred upload-to-worker pattern (the request path only stages the file locally and enqueues; the worker uploads as its first step and requeues on transient errors). Fallbacks: `local` and `replit`. Full detail (throttle hardening, deferred-upload correctness rules): `docs/architecture-history.md`.
- **Import DB connection-acquire retry:** `server/services/conn-retry.ts` (`isTransientConnError`/`withConnRetry`) retries ONLY connection-class errors (connect-timeout / `08xxx` / `57P01` / ECONN* / EPIPE — never SQL/data errors) across three layers: the dedicated import pool, the shared main pool (via a retrying `storage` Proxy), and the import-job poller. All import writes use absolute values and idempotent DML so retry-after-reset can't double-apply; the one exclusion is `CREATE INDEX CONCURRENTLY` (denylisted). Coverage `tests/conn-retry.test.ts`. Full 3-layer detail + retry-safety rules: `docs/architecture-history.md`.
