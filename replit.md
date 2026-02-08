# Critsend - Email Marketing Platform

## Overview

Critsend is a robust email marketing platform designed to manage and engage large subscriber bases efficiently. It offers comprehensive subscriber management with advanced tag-based segmentation, a user-friendly campaign creation wizard with WYSIWYG editing, and flexible Mail Transfer Agent (MTA) configurations. The platform supports high-volume email sending with configurable speeds, detailed email tracking (opens/clicks), and automatic unsubscribe handling. Key capabilities include production-grade CSV import/export with batch processing, a complete REST API for integration, and features to ensure email deliverability and data integrity. The business vision is to provide a scalable, reliable, and feature-rich solution for businesses to effectively communicate with their audience, driving engagement and marketing success.

## User Preferences

I want iterative development.
I prefer to be asked before making major changes.
I prefer clear and concise explanations.
I prefer high-quality code that is well-documented and maintainable.
I prefer that you use a structured approach to problem-solving.
I prefer that you break down complex tasks into smaller, manageable steps.
Do not make changes to the `design_guidelines.md` file.

## System Architecture

The Critsend platform is built with a modern web stack, featuring a React, TypeScript, Vite, TailwindCSS, and Shadcn/UI frontend for a responsive and intuitive user experience. The backend is an Express.js and TypeScript application, ensuring robust API services. PostgreSQL, coupled with Drizzle ORM, serves as the primary data store, optimized for handling millions of records with advanced indexing for efficient querying.

**UI/UX Decisions:**
The UI/UX adheres to Material Design 3 principles, offering a clean, modern aesthetic with dark/light mode support and full mobile responsiveness. It utilizes Inter for primary text and JetBrains Mono for technical displays, with blue as the primary accent color. A card-based layout organizes information effectively.

**Technical Implementations & Design Choices:**
- **Authentication:** Session-based auth with bcrypt password hashing (cost factor 12). First-user-only registration for admin setup. All API routes protected by auth middleware except public endpoints (tracking, webhooks, health). Login/register/logout endpoints at `/api/auth/*`.
- **Subscriber Management:** Tag-based segmentation with GIN-indexed tags for fast filtering.
- **Campaign Management:** A 6-step wizard guides campaign creation with WYSIWYG HTML editing.
- **Email Sending:** Configurable sending speeds (500-3000 emails/min) via Nodemailer with connection pooling and retry logic.
- **Tracking:** Open tracking (1x1 pixel), click tracking (redirects with open-redirect prevention), and optional tagging on interactions. All tracking URLs are HMAC-SHA256 signed with timing-safe verification. Click tracker validates URL protocols (http/https only) and rejects invalid signatures with 403.
- **Segmentation:** Rule-based filtering with support for nested groups, various field operators, and performance optimizations like segment count caching and specialized database indexes (pg_trgm for email, GIN for tags).
- **CSV Import/Export:** Production-grade batch processing for imports (5,000 rows per batch, 4 parallel workers) with chunked file uploads supporting up to 1GB files. CSV-only file type validation. Exports utilize streaming for large datasets.
- **Job Queues:** PostgreSQL-backed job queues (`campaign_jobs`, `import_job_queue`) with `FOR UPDATE SKIP LOCKED` ensure race-condition-free multi-worker processing and crash recovery for campaign sending and CSV imports.
- **Reliable Tag Queue:** Asynchronous, guaranteed delivery of tag operations through a `pending_tag_operations` table with retry logic and a background worker.
- **Subscriber Flush System:** Background job for large subscriber deletions with progress tracking and cancellation.
- **MTA Password Encryption:** AES-256-GCM encryption at rest for SMTP credentials, backwards-compatible with legacy plaintext. Passwords masked in list views.
- **Security:** CSRF protection with timing-safe validation, Helmet.js security headers with CSP configured, CORS middleware with configurable origins, extensive input validation, HTML sanitization, 5-tier rate limiting, secure session management (httpOnly, sameSite=lax, 24h lifetime), webhook authentication with timing-safe X-Webhook-Secret, error response sanitization, SESSION_SECRET enforcement in production.
- **Robustness:** Graceful shutdown with connection draining, memory monitoring with load shedding (503 responses when critical), automated campaign auto-resume on server restart, bounce webhook idempotency via tag-based deduplication.
- **Audit Hardening (Feb 2026):** Auth rate limiter (10 attempts/15min), request correlation IDs (x-request-id), CSV export formula injection prevention, response body logging redaction, deleteAllSubscribers OOM fix (SQL rowCount), DB transactions for campaign create/update/resume+job enqueue and import job creation+queue, MTA transporter pool invalidation on update/delete, LIKE wildcard escaping in segment builder, TRACKING_SECRET lazy initialization, DB health check in /api/health, campaign rate limiter applied to routes, TypeScript LSP errors resolved (logger accepts unknown types).

**System Design Choices:**
- **Modular Route Architecture:** Routes split into domain-focused modules under `server/routes/` (subscribers, segments, mtas, tracking, webhooks, analytics) with shared helpers. Campaign, import/export, and background workers remain in main `routes.ts`.
- **Data Integrity & Concurrency:** Utilizes PostgreSQL's transactional capabilities, atomic counter updates, unique indexes, and optimistic locking to prevent race conditions and ensure data consistency during high-volume operations like email sending.
- **Production Architecture:** Employs PostgreSQL-backed job queues for horizontal scaling and crash recovery of background processes. Chunked file upload and persistent object storage handle large file operations efficiently.
- **Nullsink SMTP Testing:** An internal SMTP server allows for testing campaigns without sending real emails, offering configurable latency and failure injection for robust testing.
- **Database Migrations:** Uses Drizzle Kit generate for migration files (in `./migrations/`) providing an audit trail of schema changes.
- **Testing:** Vitest test framework with unit tests covering crypto module, tracking URL signing, schema validation, and logger. 17 tests in 4 test files.

## External Dependencies

- **PostgreSQL:** Primary database for all application data.
- **Nodemailer:** Used for real SMTP email sending with connection pooling and retry mechanisms.
- **`sanitize-html`:** For sanitizing HTML content in campaigns to prevent injection attacks.
- **`connect-pg-simple`:** For persistent session management using PostgreSQL.
- **`bcrypt`:** For secure password hashing with configurable cost factor.
- **`helmet`:** For HTTP security headers (X-Content-Type-Options, X-Frame-Options, etc.).
- **Replit App Storage:** Utilized for persistent object storage of CSV files, ensuring data survives deployments.