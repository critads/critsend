# Critsend Design Guidelines

## Design Approach
**Selected Approach:** MailerLite-Inspired Clean Minimal Design  
**Justification:** Light, spacious interface that prioritizes usability and readability. Green is used sparingly as an accent color for actions and active states. White sidebar with subtle left-edge glow creates visual interest while maintaining a clean aesthetic.

**Reference Inspiration:** MailerLite's 2024 UI refresh - light sidebar, gray canvas background, white content cards, minimal shadows

## Color System

### Primary Colors
- **Primary Green:** HSL 152 76% 36% - Used sparingly for action buttons, links, active states
- **Accent Green:** HSL 152 40% 95% - Light green for selected states and hover backgrounds

### Light Mode
- **Background:** HSL 150 5% 95% (soft gray - canvas background)
- **Card Background:** HSL 0 0% 100% (pure white)
- **Foreground:** HSL 150 10% 15% (dark charcoal)
- **Muted Foreground:** HSL 150 8% 45% (medium gray for secondary text)
- **Border:** HSL 150 5% 88% (very subtle gray)

### Sidebar (Light Mode)
- **Background:** HSL 0 0% 100% (white)
- **Foreground:** HSL 150 10% 35% (gray text)
- **Active State:** HSL 152 45% 95% background with HSL 152 76% 30% text
- **Left Edge Glow:** Subtle green gradient on left edge (4px wide)

### Dark Mode
- **Background:** HSL 150 10% 10% (dark gray)
- **Card Background:** HSL 150 8% 14% (elevated dark)
- **Foreground:** HSL 0 0% 95% (near white)
- **Muted Foreground:** HSL 150 5% 55% (muted gray)
- **Primary:** HSL 152 76% 50% (brighter green for contrast)

## Typography
- **Primary Font:** Inter (Google Fonts)
- **Monospace Font:** JetBrains Mono (for technical content)

**Hierarchy:**
- Page Titles: text-2xl font-semibold (used sparingly)
- Section Headers: text-lg font-semibold
- Card Titles: text-base font-medium
- Body Text: text-sm font-normal
- Helper Text: text-sm text-muted-foreground
- Data Labels: text-[11px] uppercase tracking-wider font-medium text-muted-foreground/60
- Code/Technical: font-mono text-sm

## Layout System

**Spacing Philosophy:** Generous whitespace for a clean, breathable design

**Spacing Units:** Use Tailwind units of 2, 3, 4, 6, 8, 12
**Common Patterns:**
- Page padding: p-6 or p-8
- Card padding: p-5 or p-6
- Section gaps: space-y-6
- Form field gaps: space-y-4
- Tight element spacing: space-y-0.5 or space-y-1

**Grid Structure:**
- Dashboard stats: grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4
- Main content: White cards on gray background
- Sidebar width: 14rem (224px)

## Component Library

### Sidebar
- White/light background (not dark gradient)
- Subtle green glow on left edge using CSS pseudo-elements
- Navigation items use muted-foreground color
- Active items get light green background (sidebar-accent) with green text
- Section labels: Uppercase, very small (11px), muted color
- Compact navigation buttons (h-9 rounded-md)

### Header
- White background (bg-card)
- Minimal height (h-12)
- Subtle bottom border
- Contains only essential controls (sidebar toggle, theme toggle)

### Dashboard Cards
- White background with very subtle shadow (shadow-sm)
- Hover state: slightly stronger shadow (shadow-md)
- Clean borders using border-border
- Stat cards: Icon in colored circle, large number display

### Buttons
- Primary: Green background (#00a651), white text - use sparingly
- Secondary: Light gray background
- Ghost: Transparent with subtle hover state
- Outline: Border only
- Destructive: Red for dangerous actions
- All buttons use rounded-md (small radius)

### Forms
- Clean field styling with subtle borders
- Labels above inputs
- Help text in muted-foreground
- Error states in destructive color

### Status Badges
- Small, rounded pill shape
- Color-coded for different states
- Use secondary variant as default

## Responsive Behavior
- Mobile: Single column, hamburger menu
- Tablet: Collapsed sidebar icon-only mode
- Desktop: Full sidebar with text labels

## Animations
**Minimal & Purposeful:**
- transition-colors for hover states
- transition-shadow for card hovers
- duration-200 for smooth but quick transitions
- NO decorative animations

## Key Design Principles
1. **Light & Spacious:** White cards on gray background creates clear content separation
2. **Green as Accent:** Use green sparingly for actions and active states, not as dominant color
3. **Consistent Radius:** rounded-md (0.375rem) throughout for subtle rounding
4. **Clean Typography:** Clear hierarchy with restrained use of font weights
5. **Subtle Shadows:** Very light shadows that don't distract
6. **Token-Based:** All colors through CSS variables for easy theming
