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
- **Subscriber Management:** Features tag-based segmentation with GIN-indexed tags for rapid filtering and a refs system for segment targeting.
- **Campaign Management:** A 5-step wizard facilitates campaign creation, including a WYSIWYG HTML editor and MTA selection.
- **Email Sending:** High-performance sending via Nodemailer with configurable speeds and connection pooling. Supports concurrent processing of up to 5 campaigns, using a two-path architecture (in-memory nullsink and real SMTP).
- **Tracking:** Implements open tracking (1x1 pixel) and click tracking (redirects with open-redirect prevention). All tracking URLs are HMAC-SHA256 signed.
- **Segmentation (DSL v2):** Employs a recursive rule DSL for advanced segmentation with nested groups (AND/OR combinators, max 3 depth), supporting 5 fields and 22 operators.
- **CSV Import/Export:** Unified CSV format with auto-detection for refs and tags. Uses PostgreSQL COPY for high-performance imports (4 parallel operations, 25k rows/batch) with chunked file uploads up to 1GB. Features tag mode (merge/override), pre-import operations, email deduplication, and live row counters with ETA. Import execution is in-process async for efficiency.
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
- **Robustness:** Includes graceful shutdown, memory monitoring with load shedding, automated campaign auto-resume, bounce webhook idempotency, and bulk-optimized batch webhook processing.
- **Modular Route Architecture:** Features a fully modular route architecture with 14 distinct route modules and shared utilities.
- **Repository Pattern (Phase 4):** Storage layer decomposed into 6 focused repository modules under `server/repositories/`: `subscriber-repository.ts` (subscriber CRUD, segments, GIN index management, tag operations), `campaign-repository.ts` (campaign CRUD, sends, nullsink, analytics), `import-repository.ts` (import jobs, queue, refs/staging), `mta-repository.ts` (MTAs, email headers), `job-repository.ts` (campaign job queue, flush jobs, send retries, error logs), `system-repository.ts` (users, maintenance, healthCheck, cross-repo analytics). `server/storage.ts` is a thin aggregator (<35 lines) that spreads all repositories into the `IStorage` interface. `server/storage-interface.ts` holds the full interface definition.
- **Data Integrity & Concurrency:** Utilizes PostgreSQL's transactional capabilities, atomic counter updates, unique indexes, and optimistic locking.
- **Production Architecture:** Employs PostgreSQL-backed job queues for horizontal scaling and crash recovery. Segment count cache auto-prunes expired entries.
- **Real-Time SSE Progress:** Server-Sent Events (`GET /api/jobs/stream`) push instant progress updates for import, flush, and campaign jobs, using an in-process `EventEmitter` hub.
- **Nullsink SMTP Testing:** An internal SMTP server allows for testing campaigns without sending real emails.

## External Dependencies

- **PostgreSQL (Neon):** Primary database, hosted on Neon Launch plan, configured for SSL. Managed connection pooling and resilience.
- **Nodemailer:** Used for real SMTP email sending with pooling and retries.
- **`sanitize-html`:** For sanitizing HTML content in campaigns.
- **`connect-pg-simple`:** For persistent session management using PostgreSQL.
- **`bcrypt`:** For secure password hashing.
- **`helmet`:** For HTTP security headers.
- **`prom-client`:** Prometheus metrics client for Node.js.
- **Replit App Storage:** Utilized for persistent object storage of CSV files.