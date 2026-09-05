# Web design system

Phoenix's shared web components implement the [Paper library](https://app.paper.design/file/01M1PXJYW6YGH9Q0MEVZA3HSN1/A-0/FPC-0) within the existing theme and Base UI foundations. Desktop uses the same components. React Native keeps native components; share domain logic through `packages/client-runtime`, not DOM components.

Semantic foreground, muted, border, background, primary and status colors preserve custom themes and dark appearance. Paper's 28/36 destination heading, 13/16 underline tabs, 24px section rhythm and subtle curved area fills live in shared patterns.

## Component ownership

| Layer            | Location                                           | Responsibility                                                              |
| ---------------- | -------------------------------------------------- | --------------------------------------------------------------------------- |
| Theme            | `apps/web/src/index.css` and theme palette helpers | Semantic colors, typography, control radius, appearance                     |
| Primitives       | `apps/web/src/components/ui`                       | Base UI controls, tabs, buttons, badges, tables, popovers, dialogs, sidebar |
| Page frame       | `WorkspacePageHeader`, `WorkspacePageContainer`    | Titlebar integration, responsive content width and spacing                  |
| Page patterns    | `apps/web/src/components/patterns`                 | Heading with icon, metadata and actions; metrics                            |
| Charts           | `apps/web/src/components/charts`                   | Monotone line/area renderer; geometry lives in `packages/shared`            |
| Feature adapters | For example `apps/web/src/components/usage`        | Provider identity, aggregation, account scope, quotas and data loading      |

Extend these layers as destinations migrate. Do not introduce a second button, theme, sidebar state model, or page configuration language. Compose primitives directly when a pattern has no shared behavior. Route navigation remains links; `Tabs` switches panels within a page with Base UI keyboard behavior.

## Charts

`LineAreaChart` takes ordered periods and series with stable IDs, labels, colors, optional icons and one finite nonnegative value per period. Zero means known inactivity. Features must communicate missing or offline sources separately. Series share a zero baseline and are not stacked. The scale uses visible series. Formatting and timezone handling remain in the caller.

The renderer uses shape-preserving cubic curves, 2px strokes and 0.055 area opacity. One sample renders as a point. Mouse hover and left/right, Home/End keys expose the same period values; Escape dismisses the readout. It has no animation loop or chart dependency. `UsageBreakdownChart` and `UsageReportChart` adapt shared client-runtime series, preserving daily/hourly formatting and provider icons. Mobile uses `components/charts/LineAreaChart` with the same geometry and shared series; its previous platform-specific bar renderers have been removed.

## Gallery

With the normal web development server running, visit `/design-system.html` on that server's origin. This separate Vite HTML entry renders fixtures without pairing, account access or a backend connection. It is a development gallery, not a product route or part of the default production build.

Examples include light/dark appearance, destination heading, metrics, underline tabs, tables, buttons, status badges, multi-series and zero-activity charts. Inspect narrow widths and keyboard focus when changing shared patterns. Extend the gallery alongside each reusable pattern.

## Migration boundary

Usage consumes the shared headings, concealed values, metrics, tabs and chart rendering. Its account sidebar, account header and environment table use the existing sidebar, dialog and table primitives. Account editing reuses provider settings. Project/thread reports and their charts consume explicit server attribution and creation history. Account quotas and the compact hover summary use native quota windows; absent pools remain unavailable. Keep native quota interpretation in provider adapters and preserve environment identity when connecting those screens.

Usage replacement includes removing the superseded UI, routes, styles, helpers and tests in the same change that replaces their behavior. Keep one active implementation; do not retain an old/new Usage switch or compatibility wrappers for internal component APIs. Reuse working data collectors rather than treating their age as a reason to replace them.

Compatibility is confined to actual data boundaries: older supported Usage contracts, buckets without source IDs and older provider availability snapshots. Keep those paths documented and covered by focused tests so mixed-version environments retain correct totals and uncertainty. They must not preserve obsolete presentation behavior.
