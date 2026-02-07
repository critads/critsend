# Critsend - Email Marketing Platform

## Overview

Critsend is an email marketing platform designed for managing and engaging with large subscriber bases. It offers advanced segmentation, campaign management, and robust email sending capabilities. The platform aims to provide a comprehensive solution for businesses needing to communicate effectively with multi-million email profiles. Its core capabilities include subscriber management with tag-based segmentation, CSV import/export, a campaign creation wizard with WYSIWYG editing, multiple Mail Transfer Agent (MTA) configurations, email tracking (opens/clicks), configurable sending speeds, unsubscribe handling, and a complete REST API.

## User Preferences

I want iterative development.
I prefer to be asked before making major changes.
I prefer clear and concise explanations.
I prefer high-quality code that is well-documented and maintainable.
I prefer that you use a structured approach to problem-solving.
I prefer that you break down complex tasks into smaller, manageable steps.
Do not make changes to the `design_guidelines.md` file.

## System Architecture

The Critsend platform is built with a modern web stack. The frontend utilizes React with TypeScript, Vite, TailwindCSS, and Shadcn/UI for a responsive and modern user experience. Wouter handles client-side routing, and TanStack Query manages state. The backend is an Express.js application written in TypeScript, providing a comprehensive REST API. Data persistence is managed by PostgreSQL with Drizzle ORM.

**Key Architectural Decisions & Features:**

*   **UI/UX:** Inspired by Material Design 3, featuring a clean aesthetic, dark/light mode, mobile responsiveness, and a card-based layout. It uses Inter for primary text and JetBrains Mono for code.
*   **Data Management:**
    *   **Subscriber Segmentation:** Rule-based filtering on tags, email, date_added, and IP address with nested group support. Utilizes PostgreSQL's GIN index for tags and `pg_trgm` for email fields to ensure high performance.
    *   **Database Schema:** Optimized for large datasets, including tables for `subscribers`, `segments`, `mtas`, `campaigns`, `campaignStats`, `importJobs`, and `emailHeaders`.
    *   **BCK Tag:** A special "BCK" tag automatically blocklists unsubscribed users from all campaigns.
*   **Email Sending:**
    *   **Configurable Sending Speeds:** Supports various speeds from 500 to 3,000 emails/minute.
    *   **MTA Management:** Allows configuration of multiple SMTP servers using Nodemailer for sending.
    *   **Tracking:** Implements open tracking (1x1 pixel) and click tracking (redirects) with optional tagging.
    *   **Nullsink SMTP Server:** An internal SMTP server (port 2525) for testing campaigns without live sending, featuring configurable latency and failure injection.
*   **Job Processing & Scalability:**
    *   **PostgreSQL-Backed Job Queues:** Uses `campaign_jobs` and `import_job_queue` tables with `FOR UPDATE SKIP LOCKED` for concurrent and race-condition-free processing, enabling horizontal scaling and crash recovery.
    *   **Chunked File Uploads:** Supports large CSV files (up to 1GB) via chunked uploads, streamed directly to object storage.
    *   **Parallel Batch Processing:** CSV imports process 5,000-row batches with 4 concurrent workers for high throughput, utilizing bulk upserts with `ON CONFLICT` for efficiency.
    *   **Reliable Tag Queue:** Asynchronously processes tag additions from tracking events using a `pending_tag_operations` table with retry logic and exponential backoff to ensure guaranteed delivery.
    *   **Background Deletion:** Subscriber deletion is handled by a background flush job processing 10,000 subscribers per batch with progress tracking and cancellation support.
*   **Security & Integrity:**
    *   **Concurrency Control:** Employs `FOR UPDATE SKIP LOCKED`, atomic counter updates, `ON CONFLICT DO NOTHING`, and optimistic locking for campaign status to ensure data integrity during concurrent operations.
    *   **Tracking URL Security:** HMAC-SHA256 signed URLs with timing-safe comparison to prevent tampering.
    *   **Rate Limiting:** Implements API rate limiting for different endpoints to prevent abuse.
    *   **HTML Sanitization:** Sanitizes campaign HTML content using `sanitize-html` to prevent script injection.
    *   **Session Management:** Uses `connect-pg-simple` for persistent, secure PostgreSQL-backed sessions.

## External Dependencies

*   **Database:** PostgreSQL
*   **Frontend Frameworks/Libraries:** React, TypeScript, Vite, TailwindCSS, Shadcn/UI, Wouter, TanStack Query
*   **Backend Frameworks/Libraries:** Express.js, TypeScript, Drizzle ORM
*   **Email Sending:** Nodemailer
*   **Security/Utilities:** `sanitize-html`, `connect-pg-simple`
*   **Object Storage:** Replit App Storage (backed by Google Cloud Storage for CSV files)