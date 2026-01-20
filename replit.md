# Critsend - Email Marketing Platform

A powerful email marketing platform capable of managing multi-million email profiles with advanced segmentation, campaign management, and sending capabilities.

## Overview

Critsend is a full-featured email marketing tool with:
- Subscriber management with tag-based segmentation
- CSV import/export with production-grade batch processing (20,000 rows per batch, 1GB file limit via chunked upload)
- Campaign creation wizard with WYSIWYG HTML editing
- Multiple MTA (Mail Transfer Agent) configurations
- Email tracking (opens/clicks)
- Configurable sending speeds (500-3000 emails/min)
- Unsubscribe handling with BCK blocklist tag
- Complete REST API with documentation

## Tech Stack

- **Frontend**: React + TypeScript + Vite + TailwindCSS + Shadcn/UI
- **Backend**: Express.js + TypeScript
- **Database**: PostgreSQL with Drizzle ORM
- **Routing**: Wouter (frontend)
- **State Management**: TanStack Query

## Project Structure

```
├── client/src/
│   ├── components/         # UI components (shadcn, app-sidebar, theme)
│   ├── pages/              # Page components
│   │   ├── dashboard.tsx   # Main dashboard with stats
│   │   ├── subscribers.tsx # Subscriber management with pagination
│   │   ├── segments.tsx    # Segment builder with rules
│   │   ├── mtas.tsx        # MTA configuration
│   │   ├── campaigns.tsx   # Campaign listing
│   │   ├── campaign-new.tsx # 6-step campaign wizard
│   │   ├── import.tsx      # CSV import with drag-drop
│   │   ├── export.tsx      # Export subscribers
│   │   ├── analytics.tsx   # Detailed campaign metrics
│   │   ├── headers.tsx     # Email headers management
│   │   └── api-docs.tsx    # API documentation
│   ├── lib/                # Query client and utilities
│   └── App.tsx             # Main app with routing
├── server/
│   ├── index.ts            # Express server entry
│   ├── routes.ts           # All API endpoints
│   ├── storage.ts          # Database storage layer
│   └── db.ts               # Drizzle database connection
├── shared/
│   └── schema.ts           # Database schema + types + Zod schemas
└── design_guidelines.md    # UI design guidelines
```

## Database Schema

- **subscribers**: Email list with tags array, optimized for millions of records
- **segments**: Rule-based filtering with AND/OR logic
- **mtas**: SMTP server configurations
- **campaigns**: Email campaigns with tracking settings
- **campaignStats**: Opens, clicks, and link tracking
- **importJobs**: CSV import job tracking
- **emailHeaders**: Custom X-headers for emails

## Key Features

### BCK Tag (Blocklist)
Subscribers with the "BCK" tag are automatically excluded from all campaigns. This tag is added when someone unsubscribes.

### Sending Speeds
- Slow: 500 emails/min
- Medium: 1,000 emails/min
- Fast: 2,000 emails/min
- Godzilla: 3,000 emails/min

### Segment Rules
Rules filter subscribers based on tags:
- `contains`: Tag contains the value
- `not_contains`: Tag does not contain the value
- `equals`: Tag exactly matches
- `not_equals`: Tag does not match
- Logic operators: AND, OR

### Tracking
- Open tracking via 1x1 transparent pixel
- Click tracking via redirect links
- Optional tagging on open/click/unsubscribe

## API Endpoints

See `/api-docs` in the application for complete API documentation.

### Main Endpoints
- `GET/POST /api/subscribers` - List/create subscribers
- `GET/POST /api/segments` - List/create segments
- `GET/POST /api/mtas` - List/create MTAs
- `GET/POST /api/campaigns` - List/create campaigns
- `POST /api/import` - Upload CSV file
- `GET /api/export` - Download subscribers as CSV
- `GET /api/dashboard/stats` - Dashboard statistics
- `GET /api/analytics/*` - Analytics data

### Tracking Endpoints
- `GET /api/track/open/:campaignId/:subscriberId` - Track email opens
- `GET /api/track/click/:campaignId/:subscriberId` - Track link clicks
- `GET /api/unsubscribe/:campaignId/:subscriberId` - Handle unsubscribes

## Design Choices

- Material Design 3 inspired with clean, modern look
- Dark/light mode support
- Mobile responsive design
- Font: Inter (primary), JetBrains Mono (code/technical)
- Primary color: Blue for action elements
- Card-based layout for organization

## Development Commands

```bash
npm run dev          # Start development server
npm run db:push      # Push schema to database
npm run build        # Build for production
```

## Production Architecture

### PostgreSQL-Backed Job Queues
- **Campaign Jobs**: `campaign_jobs` table with `FOR UPDATE SKIP LOCKED` for race-condition-free multi-worker processing
- **Import Jobs**: `import_job_queue` table for background CSV processing with file-based storage
- **Crash Recovery**: Stale jobs automatically recovered (2min heartbeat timeout for imports, 30min for campaigns)
- **Horizontal Scaling**: Multiple workers can safely claim jobs using row-level locking

### Chunked File Upload System
- **Large File Support**: Files >25MB automatically use chunked upload (25MB chunks) to bypass platform request size limits
- **Maximum File Size**: Supports files up to 1GB total size
- **Streaming Assembly**: Chunks are streamed directly to output file during assembly, avoiding memory spikes
- **Progress Tracking**: Real-time upload progress shown in UI as chunks are sent
- **Validation**: Chunk index bounds validation prevents disk abuse; missing chunk detection before assembly
- **Error Recovery**: Automatic cleanup of temp files and remaining chunks on failure
- **Upload Sessions**: 1-hour auto-expiry for abandoned upload sessions

### Production-Grade CSV Import Processing
- **File-Based Storage**: CSV files stored on disk (`uploads/imports/{job_id}.csv`) instead of database
- **Chunked Processing**: 5,000-row batches for bounded memory usage
- **Heartbeat Mechanism**: Workers update heartbeat every 30 seconds; jobs with no heartbeat for 2 minutes are recovered
- **Bulk Upserts**: PostgreSQL `ON CONFLICT` with tag array merging for 10x+ performance
- **Progress Tracking**: Real-time `processed_lines` / `total_lines` updates
- **Automatic Cleanup**: CSV files deleted after successful processing to save disk space

### Real SMTP Email Sending
- **Nodemailer**: Connection pooling (5 connections, 100 messages per connection)
- **Retry Logic**: 3 retries with exponential backoff for transient errors
- **TLS Security**: Certificate validation enabled by default (override with `SMTP_SKIP_TLS_VERIFY=true`)
- **Tracking Injection**: Automatic open pixel and click tracking URL rewriting

### Nullsink SMTP Testing Server
- **Built-in Test MTA**: Internal SMTP server (port 2525) for testing campaigns without sending real emails
- **MTA Mode Field**: MTAs can be set to "real" or "nullsink" mode
- **Configurable Latency**: Simulate network delays (0-5000ms) for realistic throughput testing
- **Failure Injection**: Configurable failure rate (0-100%) for stress testing error handling
- **Capture Storage**: All test emails stored in `nullsink_captures` table with timing metrics
- **Test Metrics Dashboard**: Real-time throughput stats, emails/second, average latency
- **Race-Condition Safe**: Per-send latency/failure simulation prevents config clobber between concurrent campaigns

### Session Management
- **PostgreSQL Sessions**: Using `connect-pg-simple` for persistent sessions
- **Secure Cookies**: Production-grade cookie settings with 30-day expiry

### Tracking Security
- **HMAC-SHA256 Signed URLs**: All tracking URLs are cryptographically signed
- **Timing-Safe Comparison**: Prevents timing attacks on signature verification
- **Required Secrets**: Application fails fast if `TRACKING_SECRET` or `SESSION_SECRET` missing

### Reliable Tag Queue System
- **Fire-and-Forget Tracking**: Tracking endpoints return immediately (1x1 pixel or redirect), queueing tag operations asynchronously
- **Guaranteed Delivery**: `pending_tag_operations` table stores pending tag additions with retry logic
- **Background Worker**: Processes tag queue every 500ms with atomic PostgreSQL operations
- **Exponential Backoff**: Failed operations retry with delays of 1s, 2s, 4s, 8s, 16s (max 5 retries)
- **Automatic Cleanup**: Successfully processed operations removed; failed operations kept for debugging
- **Monitoring Endpoint**: `GET /api/tag-queue/stats` returns pending/processing/completed/failed counts

### Subscriber Flush Job System
- **Background Deletion**: `DELETE /api/subscribers` starts a background job instead of immediate deletion (returns 202 with jobId)
- **Batch Processing**: Deletes 10,000 subscribers per batch with 50ms delay between batches to prevent database overload
- **Progress Tracking**: `GET /api/subscribers/flush/:id` returns real-time progress (processedRows, totalRows, status)
- **Cancellation Support**: `POST /api/subscribers/flush/:id/cancel` stops the job mid-process
- **UI Progress Bar**: Frontend shows real-time deletion progress with ability to cancel

### Health & Monitoring
- `GET /api/health` - Database connection status and uptime
- `GET /api/health/ready` - Readiness probe for orchestration
- `GET /api/metrics` - Campaign/subscriber/tracking metrics
- `GET /api/tag-queue/stats` - Tag queue processing statistics

## Concurrency & Data Integrity

The campaign sending system implements production-grade safeguards:

### Race Condition Prevention
- **Job Queue Serialization**: Campaigns are processed through PostgreSQL-backed job queue with `FOR UPDATE SKIP LOCKED` for multi-worker safety
- **Atomic Counter Updates**: Uses SQL `SET sent_count = sent_count + 1` instead of read-then-write to prevent lost updates
- **ON CONFLICT DO NOTHING**: campaign_sends table uses PostgreSQL's upsert pattern to atomically prevent duplicate sends
- **Optimistic Locking**: Campaign status updates use expected status checks to prevent concurrent state changes

### Database Integrity
- **Unique Index**: `campaign_sends` has a unique constraint on `(campaign_id, subscriber_id)` enforced at database level
- **GIN Index**: `subscribers.tags` uses a GIN index for fast array containment queries
- **Single Transaction**: `recordSendAndUpdateCounters()` combines insert + counter updates in a single SQL CTE for atomicity

### Key Storage Methods
- `reserveSendSlot()` - Phase 1: Insert 'pending' record BEFORE SMTP attempt (prevents duplicates)
- `finalizeSend()` - Phase 2: Update to 'sent'/'failed' and adjust counters AFTER SMTP result
- `recordSendAndUpdateCounters()` - Combined method (deprecated, uses two-phase internally)
- `updateCampaignStatusAtomic()` - Status changes with optimistic locking
- `incrementCampaignSentCount()` / `incrementCampaignFailedCount()` - Thread-safe counter updates
- `recoverOrphanedPendingSends()` - Cleanup stale pending rows (called at campaign start)
- `forceFailPendingSend()` - Reconciliation for individual invariant violations

## Environment Variables

### Required
- `DATABASE_URL` - PostgreSQL connection string
- `SESSION_SECRET` - Secret for session signing (min 32 chars recommended)

### Optional
- `TRACKING_SECRET` - Separate secret for tracking URL signing (defaults to SESSION_SECRET)
- `SMTP_SKIP_TLS_VERIFY` - Set to "true" to disable TLS certificate validation (development only)

## Notes

- Import processing uses 20,000 row batches to prevent memory issues
- Campaign sending uses PostgreSQL-backed job queue for distributed processing
- PostgreSQL GIN index on tags array for fast segment filtering
- BCK tag always excludes subscribers from receiving newsletters
