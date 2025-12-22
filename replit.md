# Critsend - Email Marketing Platform

A powerful email marketing platform capable of managing multi-million email profiles with advanced segmentation, campaign management, and sending capabilities.

## Overview

Critsend is a full-featured email marketing tool with:
- Subscriber management with tag-based segmentation
- CSV import/export with batch processing (20,000 rows per batch)
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

## Notes

- Import processing uses 20,000 row batches to prevent memory issues
- Campaign sending is simplified (production would use job queue like Bull/BullMQ)
- PostgreSQL indexes on email and tags for performance
- BCK tag always excludes subscribers from receiving newsletters
