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
- **Subscriber Management:** Tag-based segmentation with GIN-indexed tags for fast filtering.
- **Campaign Management:** A 6-step wizard guides campaign creation with WYSIWYG HTML editing.
- **Email Sending:** Configurable sending speeds (500-3000 emails/min) via Nodemailer with connection pooling and retry logic.
- **Tracking:** Open tracking (1x1 pixel), click tracking (redirects), and optional tagging on interactions. All tracking URLs are HMAC-SHA256 signed for security.
- **Segmentation:** Rule-based filtering with support for nested groups, various field operators, and performance optimizations like segment count caching and specialized database indexes (pg_trgm for email, GIN for tags).
- **CSV Import/Export:** Production-grade batch processing for imports (5,000 rows per batch, 4 parallel workers) with chunked file uploads supporting up to 1GB files. Exports utilize streaming for large datasets.
- **Job Queues:** PostgreSQL-backed job queues (`campaign_jobs`, `import_job_queue`) with `FOR UPDATE SKIP LOCKED` ensure race-condition-free multi-worker processing and crash recovery for campaign sending and CSV imports.
- **Reliable Tag Queue:** Asynchronous, guaranteed delivery of tag operations through a `pending_tag_operations` table with retry logic and a background worker.
- **Subscriber Flush System:** Background job for large subscriber deletions with progress tracking and cancellation.
- **Security:** CSRF protection (double-submit token), extensive input validation, HTML sanitization, rate limiting on API endpoints, and secure session management using PostgreSQL.
- **Robustness:** Graceful shutdown, memory monitoring, and automated campaign auto-resume on server restart.

**System Design Choices:**
- **Microservices-adjacent approach:** While a monolithic application, concerns are separated into logical modules (client, server, shared).
- **Data Integrity & Concurrency:** Utilizes PostgreSQL's transactional capabilities, atomic counter updates, unique indexes, and optimistic locking to prevent race conditions and ensure data consistency during high-volume operations like email sending.
- **Production Architecture:** Employs PostgreSQL-backed job queues for horizontal scaling and crash recovery of background processes. Chunked file upload and persistent object storage handle large file operations efficiently.
- **Nullsink SMTP Testing:** An internal SMTP server allows for testing campaigns without sending real emails, offering configurable latency and failure injection for robust testing.

## External Dependencies

- **PostgreSQL:** Primary database for all application data.
- **Nodemailer:** Used for real SMTP email sending with connection pooling and retry mechanisms.
- **`sanitize-html`:** For sanitizing HTML content in campaigns to prevent injection attacks.
- **`connect-pg-simple`:** For persistent session management using PostgreSQL.
- **Replit App Storage:** Utilized for persistent object storage of CSV files, ensuring data survives deployments.