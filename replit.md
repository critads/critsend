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

The Critsend platform uses a modern web stack: React, TypeScript, Vite, TailwindCSS, and Shadcn/UI for the frontend, and Express.js with TypeScript for the backend. PostgreSQL, managed with Drizzle ORM, serves as the primary data store, optimized for large datasets with advanced indexing. The system supports multi-user access with session-based authentication and AES-256-GCM encryption for sensitive data.

**UI/UX Decisions:**
The UI/UX follows Material Design 3 principles, featuring a clean, modern aesthetic with dark/light mode support, full mobile responsiveness, and a card-based layout. It uses Inter for text and JetBrains Mono for technical displays, with blue as the primary accent color.

**Technical Implementations & Design Choices:**
- **Authentication:** Session-based authentication with bcrypt for password hashing. All API routes require authentication, except public tracking, webhooks, health, and metrics endpoints.
- **Subscriber Management:** Features tag-based segmentation with GIN-indexed tags, a refs system for segment targeting, and a 30-day cooling-off period for unsubscribed contacts enforced by `suppressed_until` timestamps.
- **Campaign Management:** A 5-step wizard for campaign creation, including a WYSIWYG HTML editor and MTA selection. Supports A/B testing with variant tracking and automated winner declaration.
- **Email Sending:** High-performance sending via Nodemailer with configurable speeds and connection pooling. Supports concurrent campaign processing with a two-path architecture (in-memory nullsink and real SMTP).
- **Tracking:** Implements open tracking (1x1 pixel) and click tracking (redirects with open-redirect prevention). All tracking URLs are HMAC-SHA256 signed. Captures enriched context (IP, country, device, browser, OS) and uses a link registry for opaque UUID tokens in tracking links, along with branded short tracking URLs. Tracking events are buffered in-memory and flushed in batched multi-row inserts to a dedicated `pg.Pool` for isolation.
- **Segmentation (DSL v2):** Employs a recursive rule DSL for advanced segmentation with nested groups (AND/OR combinators, max 3 depth) and server-side pagination for segments. Includes targeted, cached subscriber counts with auto-invalidation.
- **CSV Import/Export:** Unified CSV format with auto-detection for refs and tags. Uses PostgreSQL COPY for high-performance imports with chunked file uploads, tag mode, pre-import operations, email deduplication, and live row counters. Supports forced tags/refs.
- **Job Queues:** Dual-mode system: PostgreSQL-backed queues with SKIP LOCKED and LISTEN/NOTIFY, and optional BullMQ + Redis for advanced features.
- **Automation Workflows:** Trigger-based email sequences with a multi-step workflow builder.
- **Advanced Analytics:** Comprehensive analytics including engagement trends, cohort analysis, deliverability, and subscriber growth.
- **Prometheus Metrics:** Full observability via a `/metrics` endpoint covering key platform operations.
- **Security:** CSRF protection, Helmet.js security headers with CSP, CORS, extensive input validation, HTML sanitization, 5-tier rate limiting, secure session management, and webhook authentication.
- **Robustness:** Includes graceful shutdown, memory monitoring with load shedding, automated campaign auto-resume, bounce webhook idempotency, and bulk-optimized batch webhook processing. Web-process guardians rescue stuck import and campaign jobs.
- **Repository Pattern:** Storage layer decomposed into focused repository modules for subscriber, campaign, import, MTA, job, and system management.
- **Data Integrity & Concurrency:** Utilizes PostgreSQL's transactional capabilities, atomic counter updates, unique indexes, and optimistic locking.
- **Real-Time SSE Progress:** Server-Sent Events push instant progress updates for import, flush, and campaign jobs, with Redis integration for split-process mode.
- **Process Separation:** Supports a split-process architecture with dedicated web server and worker processes, each with optimized database connection pooling. Includes multi-layered pool saturation safety nets with load shedding, error handling, and dedicated pools for tracking and bounce handling.
- **Nullsink SMTP Testing:** An internal SMTP server allows for testing campaigns without sending real emails.
- **Self-Hosted Deployment:** Provided `deploy/` directory includes PM2 configuration, Nginx setup, idempotent bootstrap script, deployment script, and GitHub Actions workflow for automated deployments.

## External Dependencies

- **PostgreSQL (Neon):** Primary database, hosted on Neon Launch plan, configured for SSL.
- **Nodemailer:** Used for real SMTP email sending with pooling and retries.
- **`sanitize-html`:** For sanitizing HTML content in campaigns.
- **`connect-pg-simple`:** For persistent session management using PostgreSQL.
- **`bcrypt`:** For secure password hashing.
- **`helmet`:** For HTTP security headers.
- **`prom-client`:** Prometheus metrics client for Node.js.
- **Replit App Storage:** Utilized for persistent object storage of CSV files (when `STORAGE_BACKEND=replit`).
- **`geoip-lite`:** Local database for IP address to country/city lookup.
- **`ua-parser-js`:** For parsing user agent strings to extract device, browser, and OS information.