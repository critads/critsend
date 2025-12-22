# Critsend Design Guidelines

## Design Approach
**Selected Approach:** Design System - Material Design 3  
**Justification:** Email marketing platforms require information density, data visualization, complex forms, and real-time status updates. Material Design 3 provides robust components for data-heavy applications while maintaining clarity and usability.

**Reference Inspiration:** Mailchimp's dashboard clarity + Linear's modern typography + SendGrid's data presentation

## Typography
- **Primary Font:** Inter (Google Fonts)
- **Monospace Font:** JetBrains Mono (for email addresses, API keys, SMTP settings)

**Hierarchy:**
- Page Titles: text-3xl font-bold
- Section Headers: text-xl font-semibold
- Card Titles: text-lg font-medium
- Body Text: text-base font-normal
- Helper Text: text-sm text-gray-600
- Data Labels: text-xs uppercase tracking-wide font-medium
- Code/Technical: font-mono text-sm

## Layout System
**Spacing Units:** Tailwind units of 2, 4, 6, 8, 12, 16  
**Common Patterns:**
- Page padding: p-6 lg:p-8
- Card padding: p-6
- Section gaps: space-y-6
- Form field gaps: space-y-4
- Button spacing: px-6 py-3

**Grid Structure:**
- Dashboard stats: grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6
- Campaign lists: Single column with full-width cards
- Settings panels: Two-column split (lg:grid-cols-3) - sidebar + content

## Component Library

**Navigation:**
- Persistent left sidebar (280px) with collapsible mobile drawer
- Top bar: Breadcrumbs, user profile, notifications
- Sidebar sections: Dashboard, Campaigns, Subscribers, Segments, MTAs, Analytics, Settings, API Docs

**Dashboard Cards:**
- Elevated cards with subtle shadow (shadow-sm)
- Stat cards: Large number display with trend indicators
- Quick action buttons prominently placed

**Data Tables:**
- Striped rows for readability
- Sticky headers on scroll
- Row actions dropdown (3-dot menu)
- Inline editing for tags
- Bulk selection checkboxes
- Pagination + item count display

**Forms:**
- Grouped sections with dividers
- Field labels above inputs (not floating)
- Inline validation with icon indicators
- Help text below fields
- Multi-step wizard for campaign creation (stepper component)
- Tag input: Chip-based interface with autocomplete

**Progress Indicators:**
- Import progress: Horizontal bar with percentage + status text
- Campaign sending: Real-time progress with stats (sent/pending/failed)
- Background jobs: Toast notifications with live updates

**Campaign Builder:**
- Vertical step progression (left sidebar)
- Preview panel (right side) for email rendering
- Sticky action buttons (Save Draft, Schedule, Send)

**Stats/Analytics:**
- Line charts for opens/clicks over time
- Donut charts for engagement metrics
- Heatmap for optimal send times
- Exportable data tables

**Modals:**
- Delete confirmations with warning styling
- API key display with copy button
- Import CSV: Drag-drop zone with file preview

**Buttons:**
- Primary: Solid with high contrast
- Secondary: Outlined
- Danger: Red accent for destructive actions
- Icon buttons for inline actions
- Loading states with spinner

**Status Badges:**
- Draft, Scheduled, Sending, Sent, Paused (color-coded)
- Tag badges with remove icon
- Rounded-full pill shape

## Special Features

**Real-time Updates:**
- WebSocket indicators for live job status
- Auto-refreshing counters
- Toast notifications for background processes

**WYSIWYG Editor:**
- Full-width modal editor
- Toolbar with formatting options
- Code view toggle
- Preview device selector (desktop/mobile)

**API Documentation:**
- Code snippets with syntax highlighting
- Copy-to-clipboard functionality
- Interactive request/response examples
- Endpoint list with method badges (GET, POST, etc.)

## Responsive Behavior
- Mobile: Single column, hamburger menu, simplified tables (card view)
- Tablet: Collapsed sidebar, two-column grids
- Desktop: Full sidebar, multi-column layouts

## Animations
**Minimal & Purposeful:**
- Smooth transitions for dropdowns (duration-200)
- Fade-in for modals
- Skeleton loaders for data fetching
- NO scroll animations or decorative motion

## Images
**No hero images required** - This is a utility application focused on functionality, not marketing. Focus on data visualization and interface clarity.