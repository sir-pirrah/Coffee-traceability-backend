# Coffee Traceability Frontend Design Specification

## Design Language

A clean enterprise dashboard with an agriculture/coffee identity.

### Color Palette

  Purpose           Color
  ----------------- -------------------------------
  Primary sidebar   `#0B3D20` (Deep Forest Green)
  Sidebar hover     `#14532D`
  Accent green      `#2E7D32`
  Coffee brown      `#6F4E37`
  Amber highlight   `#D4A017`
  Background        `#F7F8F5`
  Surface           `#FFFFFF`
  Border            `#E7E7E7`
  Text primary      `#1F2937`
  Text secondary    `#6B7280`
  Success           `#22C55E`
  Warning           `#F59E0B`
  Error             `#DC2626`

## Typography

-   Font: **Inter**
-   Headings: 700 weight
-   Section titles: 600
-   Body: 400
-   KPI numbers: 700
-   Border radius: 16px (cards), 12px (buttons)
-   Shadow: `0 4px 18px rgba(0,0,0,.06)`

## Icons

Use **Lucide Angular**.

Sidebar: - Dashboard → LayoutDashboard - Farmers → Users - Coffee
Batches → Package - Processing → GitBranch - Warehouse → Warehouse -
Blockchain Explorer → ShieldCheck - Reports → FileBarChart - Users →
UserCog - Roles & Permissions → KeyRound - Settings → Settings - Verify
Coffee → QrCode

Top bar: - Menu → Menu - Search → Search - Notifications → Bell - Theme
→ Moon - Cooperative → Building2

KPI cards: - Farmers → Users - Coffee Batches → Package - Received →
Bean/Coffee icon substitute (Package/OpenBox if needed) - Storage →
Warehouse - Sold → ShoppingCart

## Layout

### Left Sidebar (280px)

Logo at top. Sections: - MAIN - MANAGEMENT - VERIFICATION

Active item: - Green highlight - White icon - Rounded pill

Bottom: User avatar, name, role.

### Top Bar

Left: - Menu button - Page title

Center: - Large search box

Right: - Notifications - Theme toggle - Cooperative selector

## Dashboard Content

### KPI Row

Five cards: 1. Total Farmers 2. Coffee Batches 3. Coffee Received (kg)
4. In Storage (kg) 5. Sold (kg)

Each card: - Circular icon background - Large metric - Green trend
indicator

### Main Grid

Left (≈65%) - Coffee Movement Overview (line chart)

Middle - Recent Activities

Right - Doughnut chart: Coffee Grades - Blockchain Status card

### Bottom

Left Recent Coffee Batches table: - Batch ID - Farmer - Grade - Weight -
Status badge - Date

Right Quick Actions: - New Batch - Generate QR Code - Add to Warehouse -
Generate Report - Verify Coffee Batch

## Status Badge Colors

-   Received: Light Green
-   Processing: Amber
-   Milling: Purple
-   In Storage: Blue
-   Sold: Green

## Spacing

-   Page padding: 24px
-   Card gap: 24px
-   Internal padding: 20px
-   Table row height: 56px

## Responsiveness

Desktop: - Sidebar fixed - 3-column dashboard

Tablet: - Collapsible sidebar - 2-column dashboard

Mobile: - Drawer navigation - KPI cards stacked - Tables scroll
horizontally

## Animations

-   150--200ms ease
-   Card hover: translateY(-2px)
-   Button ripple
-   Fade-in on page load

## Accessibility

-   WCAG AA contrast
-   Keyboard navigation
-   Visible focus states
-   ARIA labels
