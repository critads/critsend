# Critsend Design Guidelines

## Design Approach
**Selected Approach:** MailerLite-Inspired Modern Design  
**Justification:** Clean, professional email marketing platform with excellent usability. Green color scheme conveys growth and reliability. Gradient sidebar creates visual depth while maintaining clarity.

**Reference Inspiration:** MailerLite's modern UI + clean typography + gradient sidebar design

## Color System

### Primary Colors
- **Primary Green:** HSL 152 76% 42% - Used for buttons, links, active states
- **Primary Dark:** HSL 160 50% 10% - Dark accents and text

### Sidebar Gradient
- **From:** HSL 152 76% 28% (bright green)
- **To:** HSL 160 50% 10% (dark forest)
- **Direction:** Top to bottom (180deg)

### Light Mode
- **Background:** HSL 0 0% 97% (light gray-white)
- **Card Background:** HSL 0 0% 100% (pure white)
- **Foreground:** HSL 160 10% 15% (dark charcoal)
- **Muted:** HSL 160 10% 96% (very light gray)
- **Border:** HSL 160 10% 90% (subtle gray)

### Dark Mode
- **Background:** HSL 160 20% 8% (dark green-gray)
- **Card Background:** HSL 160 15% 12% (slightly elevated)
- **Foreground:** HSL 0 0% 98% (near white)
- **Primary:** HSL 152 76% 48% (brighter green for contrast)

## Typography
- **Primary Font:** Inter (Google Fonts)
- **Monospace Font:** JetBrains Mono (for email addresses, API keys, SMTP settings)

**Hierarchy:**
- Page Titles: text-2xl font-semibold
- Section Headers: text-lg font-semibold
- Card Titles: text-base font-medium
- Body Text: text-sm font-normal
- Helper Text: text-sm text-muted-foreground
- Data Labels: text-xs uppercase tracking-wide font-medium
- Code/Technical: font-mono text-sm

## Layout System
**Spacing Units:** Tailwind units of 2, 4, 6, 8, 12, 16  
**Common Patterns:**
- Page padding: p-6
- Card padding: p-6
- Section gaps: space-y-6
- Form field gaps: space-y-4
- Button spacing: Use button variants, not custom padding

**Grid Structure:**
- Dashboard stats: grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6
- Campaign lists: Single column with full-width cards
- Settings panels: Two-column split

## Component Library

**Navigation:**
- Left sidebar (240px) with gradient background
- Navigation items: White text with white/10 hover background
- Active items: white/15 background
- Section labels: Uppercase, white/40 color
- Clean header with minimal elements

**Sidebar Styling:**
- Gradient background from green to dark
- White text throughout
- Subtle white/10 borders
- Rounded-lg navigation buttons
- No section labels for main nav (cleaner look)

**Dashboard Cards:**
- White background with subtle border
- Minimal shadow usage
- Stat cards: Large number display with trend indicators
- Quick action buttons prominently placed

**Buttons:**
- Primary: Green background, white text
- Secondary: Light gray background
- Destructive: Red for dangerous actions
- Ghost: Transparent with hover state
- Outline: Border only

**Forms:**
- Grouped sections with dividers
- Field labels above inputs
- Inline validation with icon indicators
- Help text below fields in muted color

**Status Badges:**
- Use badge variants for states
- Draft, Scheduled, Sending, Sent, Paused (color-coded)
- Rounded pill shape

## Responsive Behavior
- Mobile: Single column, hamburger menu
- Tablet: Collapsed sidebar, two-column grids
- Desktop: Full sidebar, multi-column layouts

## Animations
**Minimal & Purposeful:**
- Smooth transitions for dropdowns (duration-200)
- Fade-in for modals
- Skeleton loaders for data fetching
- NO scroll animations or decorative motion

## Key Design Principles
1. **Clean & Professional:** Minimal visual clutter
2. **Consistent Spacing:** Same padding across similar elements
3. **Clear Hierarchy:** Use typography and color to guide attention
4. **Accessible:** Good contrast ratios, clear focus states
5. **Responsive:** Works well on all device sizes
