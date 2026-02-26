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
- **Authentication:** Session-based authentication with bcrypt (cost factor 12) for password hashing. Multi-user access is supported with open registration. All API routes require authentication, except public endpoints for tracking, webhooks, health, and metrics.
- **Subscriber Management:** Features tag-based segmentation with GIN-indexed tags for rapid filtering. A refs system separates segment targeting codes from system tags for backward compatibility.
- **Campaign Management:** A 5-step wizard facilitates campaign creation, including a WYSIWYG HTML editor and MTA selection with auto-filled sender information.
- **Email Sending:** High-performance sending via Nodemailer with configurable speeds (500-60000 emails/min) and connection pooling. Supports concurrent processing of up to 5 campaigns. The sending engine uses a two-path architecture: a nullsink path for in-memory processing (bypassing SMTP) and a real SMTP path with chunked concurrency. Batch processing and write-behind buffers optimize database operations.
- **Tracking:** Implements open tracking (1x1 pixel) and click tracking (redirects with open-redirect prevention). All tracking URLs are HMAC-SHA256 signed for security. Campaign tag config is cached in-memory (60s TTL, max 500 entries) to minimize DB hits under high tracking volume.
- **Segmentation (DSL v2):** Employs a recursive rule DSL for advanced segmentation with nested groups (AND/OR combinators, max 3 depth). Supports 5 fields (email, tags, refs, date_added, ip_address) and 22 operators including refs-specific operators (has_ref, not_has_ref, has_any_ref, has_no_refs). A query compiler converts DSL rules into parameterized SQL.
- **CSV Import/Export:** Unified CSV format (`email;tags;refs;ip_address`) with auto-detection: if `refs` column present, triggers two-phase confirmation flow; if absent, processes immediately. Uses PostgreSQL COPY for high-performance imports (4 parallel COPY operations, 25k rows/batch) with chunked file uploads up to 1GB. Tag mode (merge/override) applies to tags only; refs always merge. Supports pre-import operations: "clean refs" (strip ref codes from existing subscribers) or "delete subscribers" (BCK-protected DELETE of matching rows, batched 50k/20ms). Refs operations never drop GIN indexes; tag-only imports >100k rows drop indexes temporarily only when no campaigns are actively sending (guard check protects segment queries during sends).
- **Job Queues:** PostgreSQL-backed job queues (`campaign_jobs`, `import_job_queue`) ensure race-condition-free, multi-worker processing with crash recovery. Leverages PostgreSQL LISTEN/NOTIFY for near-instant job pickup.
- **A/B Testing:** Manages campaign variants with split allocation, per-variant tracking, statistical significance calculation (proportion z-test), and automated winner declaration.
- **IP Warmup Schedules:** Provides automated IP warmup for new MTAs with configurable ramp curves, daily volume caps, and progress tracking.
- **Automation Workflows:** Trigger-based email sequences (e.g., `subscriber_added`, `tag_added`) with a multi-step workflow builder supporting actions like `send_email`, `wait`, `add_tag`, `remove_tag`.
- **Advanced Analytics:** Offers comprehensive analytics including engagement trends, cohort analysis, deliverability metrics, subscriber growth, and top campaign rankings.
- **Prometheus Metrics:** Full observability via a `/metrics` endpoint, providing counters, gauges, and histograms for various system activities.
- **MTA Password Encryption:** AES-256-GCM encryption at rest for SMTP credentials.
- **Database Health & Maintenance:** Automated cleanup system with configurable retention rules per table, running batched DELETE operations.
- **Security:** CSRF protection, Helmet.js security headers with CSP, CORS middleware, extensive input validation, HTML sanitization, 5-tier rate limiting, secure session management, and webhook authentication.
- **Email Send Retry:** Implements a two-tier retry system (individual email and campaign-level) with exponential backoff within a 12-hour window.
- **Robustness:** Includes graceful shutdown, memory monitoring with load shedding, automated campaign auto-resume on server restart, bounce webhook idempotency, and bulk-optimized batch webhook processing (single SELECT + bulk UPDATEs).
- **Modular Route Architecture:** Features a fully modular route architecture with 14 distinct route modules and shared utilities.
- **Data Integrity & Concurrency:** Utilizes PostgreSQL's transactional capabilities, atomic counter updates, unique indexes, and optimistic locking to ensure data consistency.
- **Production Architecture:** Employs PostgreSQL-backed job queues for horizontal scaling and crash recovery. Tag queue uses bulk grouped UPDATEs for higher throughput. Segment count cache auto-prunes expired entries every 5 minutes.
- **Nullsink SMTP Testing:** An internal SMTP server allows for testing campaigns without sending real emails.

## External Dependencies

- **PostgreSQL (Neon):** Primary database, hosted on Neon, configured for SSL. Connection pool defaults: 5 max (Neon), 10 max (local), configurable via `PG_POOL_MAX` env var. Import worker runs as a forked child process with its own pool: 2 max (Neon), 4 max (local), configurable via `PG_IMPORT_POOL_MAX`. A central connection budget system (`server/connection-budget.ts`) enforces the total connection limit (`PG_CONNECTION_LIMIT`, default 10 for Neon) across all pools: main pool + import worker + LISTEN/NOTIFY = total never exceeds limit. Main pool auto-computes as `limit - import - notify`.
- **Nodemailer:** Used for real SMTP email sending with pooling and retries.
- **`sanitize-html`:** For sanitizing HTML content in campaigns.
- **`connect-pg-simple`:** For persistent session management using PostgreSQL.
- **`bcrypt`:** For secure password hashing.
- **`helmet`:** For HTTP security headers.
- **`prom-client`:** Prometheus metrics client for Node.js.
- **Replit App Storage:** Utilized for persistent object storage of CSV files.