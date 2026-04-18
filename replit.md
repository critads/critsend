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

## System Architecture

The Critsend platform uses a modern web stack: React, TypeScript, Vite, TailwindCSS, and Shadcn/UI for the frontend, and Express.js with TypeScript for the backend. PostgreSQL, managed with Drizzle ORM, serves as the primary data store, optimized for large datasets with advanced indexing.

**UI/UX Decisions:**
The UI/UX follows Material Design 3 principles, featuring a clean, modern aesthetic with dark/light mode support, full mobile responsiveness, and a card-based layout. It uses Inter for text and JetBrains Mono for technical displays, with blue as the primary accent color.

**Technical Implementations & Design Choices:**
- **Authentication:** Session-based authentication with bcrypt for password hashing. Multi-user access is supported with open registration. All API routes require authentication, except public endpoints for tracking, webhooks, health, and metrics.
- **Subscriber Management:** Features tag-based segmentation with GIN-indexed tags for rapid filtering and a refs system for segment targeting. A `suppressed_until` timestamp column on `subscribers` enforces a **30-day cooling-off period** after any unsubscribe event: the segment compiler appends `AND (suppressed_until IS NULL OR suppressed_until < NOW())` to all subscriber fetch queries, silently excluding suppressed contacts from every campaign send without any extra per-message check. On startup a bootstrap migration retroactively backfills subscribers who unsubscribed in the last 7 days.
- **Campaign Management:** A 5-step wizard facilitates campaign creation, including a WYSIWYG HTML editor and MTA selection.
- **Email Sending:** High-performance sending via Nodemailer with configurable speeds and connection pooling. Supports concurrent processing of up to 5 campaigns, using a two-path architecture (in-memory nullsink and real SMTP).
- **Tracking:** Implements open tracking (1x1 pixel) and click tracking (redirects with open-redirect prevention). All tracking URLs are HMAC-SHA256 signed. Each event captures enriched context: IP address, country, city (via `geoip-lite` local DB), device type, browser name, and OS (via `ua-parser-js`) — stored in `campaign_stats` columns `ip_address`, `user_agent`, `country`, `city`, `device_type`, `browser`, `os`. Click tracking uses the **link registry** (`campaign_links` table): destination URLs are stored server-side with opaque UUID tokens; tracking links emit `?lid=<token>&sig=<hmac>` so no destination URL is visible in email source. Backward compat retained for legacy `?url=` format. `preregisterCampaignLinks()` is called once per campaign before the send loop to batch-create all link tokens. **Branded short tracking URLs** (`/c/{8-char-token}` for clicks, `/u/{8-char-token}` for unsubscribes) are generated per-batch via `tracking_tokens` table with batch unnest inserts; short tokens take precedence over HMAC-signed URLs when `batchClickTokens`/`batchUnsubTokens` are populated in `TrackingOptions`.
- **Segmentation (DSL v2):** Employs a recursive rule DSL for advanced segmentation with nested groups (AND/OR combinators, max 3 depth), supporting 5 fields and 22 operators. The `/segments` page uses **server-side pagination** (`GET /api/segments?paginate=true&page=&limit=` returns `{segments,total,page,limit}`) and **targeted, cached subscriber counts** (`GET /api/segments/counts?ids=id1,id2&refresh=true`). Counts use the in-process 5-minute `getSegmentSubscriberCountCached` helper, are auto-invalidated on subscriber import / flush completion, and can be force-refreshed via the "Refresh counts" button (`refresh=true`) — preventing the per-load N×COUNT(*) cost on the 1M-row subscribers table.
- **CSV Import/Export:** Unified CSV format with auto-detection for refs and tags. Uses PostgreSQL COPY for high-performance imports (4 parallel operations, 25k rows/batch) with chunked file uploads up to 1GB. Features tag mode (merge/override), pre-import operations, email deduplication, and live row counters with ETA. Import execution is in-process async for efficiency. Supports **forced tags/refs** (`forcedTags`, `forcedRefs` on `importJobs` table): when set, all imported rows receive exactly these values, overriding any tags/refs columns in the CSV.
- **Job Queues:** Dual-mode job queue system: PostgreSQL-backed queues with SKIP LOCKED and LISTEN/NOTIFY, and optional BullMQ + Redis for advanced features like DLQ and exponential backoff.
- **A/B Testing:** Manages campaign variants with split allocation, per-variant tracking, statistical significance, and automated winner declaration.
- **IP Warmup Schedules:** Provides automated IP warmup for new MTAs with configurable ramp curves and daily volume caps.
- **Automation Workflows:** Trigger-based email sequences (e.g., `subscriber_added`) with a multi-step workflow builder supporting actions like `send_email`, `wait`, `add_tag`, `remove_tag`.
- **Advanced Analytics:** Offers comprehensive analytics including engagement trends, cohort analysis, deliverability metrics, and subscriber growth.
- **Prometheus Metrics:** Full observability via a `/metrics` endpoint with 27+ metrics covering email sending, queue depth, DB stats, HTTP requests, bounces, and more.
- **Load & Chaos Testing:** Shell scripts (`scripts/load-test.sh`, `scripts/chaos-test.sh`) for end-to-end validation.
- **MTA Password Encryption:** AES-256-GCM encryption at rest for SMTP credentials.
- **Database Health & Maintenance:** Automated cleanup system with configurable retention rules and batched DELETE operations.
- **Security:** CSRF protection, Helmet.js security headers with CSP, CORS middleware, extensive input validation, HTML sanitization, 5-tier rate limiting, secure session management, and webhook authentication.
- **Email Send Retry:** Implements a two-tier retry system (individual email and campaign-level) with exponential backoff and campaign send reconciliation.
- **Transactional Outbox:** Eliminates data-loss window in the campaign sending engine by writing subscriber IDs to `campaign_sends` with `status='attempting'` before SMTP chunks and updating status after delivery.
- **Robustness:** Includes graceful shutdown, memory monitoring with load shedding, automated campaign auto-resume, bounce webhook idempotency, and bulk-optimized batch webhook processing. **Web-process guardians** run in the web process to rescue stuck work when the worker is down: the **Import Guardian** (every 30s) resets orphaned `processing` imports with stale heartbeats (>5 min) back to `pending`, then claims stale pending jobs as fallback; the **Campaign Guardian** (every 60s) detects campaigns stuck in `sending` with no active job and re-enqueues them automatically.
- **Modular Route Architecture:** Features a fully modular route architecture with 14 distinct route modules and shared utilities.
- **Repository Pattern (Phase 4):** Storage layer decomposed into 6 focused repository modules under `server/repositories/`: `subscriber-repository.ts` (subscriber CRUD, segments, GIN index management, tag operations), `campaign-repository.ts` (campaign CRUD, sends, nullsink, analytics), `import-repository.ts` (import jobs, queue, refs/staging), `mta-repository.ts` (MTAs, email headers), `job-repository.ts` (campaign job queue, flush jobs, send retries, error logs), `system-repository.ts` (users, maintenance, healthCheck, cross-repo analytics). `server/storage.ts` is a thin aggregator (<35 lines) that spreads all repositories into the `IStorage` interface. `server/storage-interface.ts` holds the full interface definition.
- **Data Integrity & Concurrency:** Utilizes PostgreSQL's transactional capabilities, atomic counter updates, unique indexes, and optimistic locking.
- **Production Architecture:** Employs PostgreSQL-backed job queues for horizontal scaling and crash recovery. Segment count cache auto-prunes expired entries.
- **Real-Time SSE Progress:** Server-Sent Events (`GET /api/jobs/stream`) push instant progress updates for import, flush, and campaign jobs. In split-process mode, the worker publishes to a Redis `job-progress` channel; the web server's SSE bridge subscribes and forwards events to connected clients. Falls back to direct in-process EventEmitter when Redis is not configured.
- **Process Separation (Phase 5):** `server/dev-launcher.ts` spawns two isolated processes — the web server (`PROCESS_TYPE=web`, pool max=20) and the worker (`PROCESS_TYPE=worker`, pool max=8). `server/worker-main.ts` is the worker entry point. `server/connection-budget.ts` applies PROCESS_TYPE-aware pool sizing. A `HEADROOM_RESERVE=12` constant ensures the monolith fallback pool is capped at 33 (total 38/50), leaving 12 connections of headroom to prevent cascade timeouts under load. The "Start application" workflow runs `tsx server/dev-launcher.ts`.
- **Nullsink SMTP Testing:** An internal SMTP server allows for testing campaigns without sending real emails.

## Self-Hosted Deployment

The `deploy/` directory contains all files needed to run Critsend on a dedicated Linux server:
- **`deploy/ecosystem.config.cjs`** — PM2 config that starts `critsend-web` (`dist/index.cjs`, PROCESS_TYPE=web) and `critsend-worker` (`dist/worker-main.cjs`, PROCESS_TYPE=worker) from compiled production artifacts. Both use `env_file: ".env"` for secret loading.
- **`deploy/nginx.conf`** — Nginx reverse proxy: HTTP→HTTPS redirect, proxy to port 5000, SSE/WebSocket headers, gzip, 1.1 GB upload limit.
- **`deploy/setup.sh`** — Idempotent bootstrap: installs nvm, Node.js 20, PM2, Nginx, Certbot on Ubuntu 22.04.
- **`deploy/deploy.sh`** — Everyday deploy sequence: `git pull → npm ci → npm run build → drizzle-kit push → pm2 reload`.
- **`deploy/github-actions-deploy.yml`** — GitHub Actions workflow to auto-deploy on push to `main` via SSH. Requires `SSH_HOST`, `SSH_USER`, `SSH_KEY` secrets.
- **`DEPLOY.md`** — Full step-by-step migration guide covering VPS provisioning, first deploy, and troubleshooting.
- **`.env.example`** — Documents all 31 env vars with [REQUIRED]/[OPTIONAL] labels and defaults.

The development workflow remains on Replit: edit → commit → `git push` → server auto-deploys via GitHub Actions.

## External Dependencies

- **PostgreSQL (Neon):** Primary database, hosted on Neon Launch plan, configured for SSL. Managed connection pooling and resilience.
- **Nodemailer:** Used for real SMTP email sending with pooling and retries.
- **`sanitize-html`:** For sanitizing HTML content in campaigns.
- **`connect-pg-simple`:** For persistent session management using PostgreSQL.
- **`bcrypt`:** For secure password hashing.
- **`helmet`:** For HTTP security headers.
- **`prom-client`:** Prometheus metrics client for Node.js.
- **Replit App Storage:** Utilized for persistent object storage of CSV files (when `STORAGE_BACKEND=replit`; default is local disk).