# Web layout language

The web app uses three route templates from `apps/web/src/components/layout.ts`. They are a shared
layout vocabulary, not per-screen width guesses. The route-to-template map is `layoutForRoute()` in
`components/app.ts`; authenticated route headings, including loading and offline states, stay in the
same frame. The unauthenticated login screen uses the Page frame too.

## Templates

| Template | Width and use | Scrolling |
| --- | --- | --- |
| **Page** | A centred band up to `--page-width` (840px). Use for inbox, ticket details, My desk, hiring, More, and setup forms. | The application shell's `<main>` scrolls. Forms and ticket detail stack within the Page width, even on a wide viewport. |
| **Wide** | A centred header band at Page width and content up to `--wide-width` (1400px). Use for the board and office, whose columns, floor, and reports need room. | The shell's `<main>` scrolls vertically; the wide content may scroll horizontally only where its own data view intentionally does so. |
| **Split** | A full-width header above a 300px (280–320px) navigation/sidebar and flexible working pane. Use for chat, handbook/brain, and Setup sections. The header follows the outer frame's left and right tracks so it aligns with the sidebar and work pane. | Sidebar and working pane own their scroll positions. The app shell main stays fixed on Split routes so its scroll position cannot compete with either pane. |

Login opts into a compact Page frame at `--compact-page-width` (24rem) so its title and form share
one centred reading band. It remains Page layout and scrolls inside its bounded host on a short screen.

At widths below 1100px, Split navigation becomes a horizontally scrollable strip above the work area.
At 900px and below, the app also switches its global navigation to the phone tab bar. The work area
uses the remaining height; short landscape and keyboard-open chat states keep the conversation and
composer useful. Login is outside the authenticated shell and has its own bounded scroller, including
safe-area padding.

## Shared API

- `IncLayout` renders the common route frame, visible page heading, optional subtitle/actions slots,
  and a Page, Wide, or Split content band. Page and Wide headers share the centred Page-width band;
  Split headers span the full frame above both grid tracks. Put route titles in the `heading` slot;
  keep actions in the `actions` slot so they stay aligned to the right of the heading.
- `layoutStyles` provides `.layout-page-band`, `.layout-wide-content`, `.layout-split`,
  `.layout-split-sidebar`, `.layout-split-work`, `.layout-stack`, and the shared header pieces for
  use inside a component's own Lit shadow root. Components opt in explicitly because styles do not
  cross Lit shadow boundaries.
- `LAYOUT_BREAKPOINTS` is the shared source for route and structural breakpoints. Keep media rules
  in CSS tied to these values; do not add one-off Page/Wide widths to individual views.
- `tokens.css` defines the shared widths, sidebar, gutters, and spacing. Use these tokens for route
  layout and spacing. A card can still have its own internal responsive rules when its controls need
  a narrower arrangement.

The route frame owns the visible `<h1>`. Child views should use `<h2>` for their own sections rather
than repeating the route heading. An action button belongs in the frame's actions slot where the
component boundary allows it. Hiring remains an independently owned component; the outer Page frame
constrains its available width without changing hiring-specific markup or behavior.

## Choosing a layout

Centre forms, lists, and readers to keep line lengths and scan paths calm. Keep the board and office
Wide: centring their headers while giving columns and the floor up to 1400px solves the competing
needs better than forcing every view into one width. Do not make a child component's max-width
silently align its content to the left inside a wider route frame; use `layout-page-band` or
`layout-wide-content` when a subregion should be narrower.

## Accessibility and verification

Keep text contrast at least 4.5:1, non-text contrast at least 3:1, interactive targets at least
44px, and form text at least 16px. Keep content within safe areas and prevent accidental horizontal
overflow. Split-pane scroll areas must have a bounded height and `min-height: 0`; verify that the
pane itself scrolls while the document and shell main remain fixed. Intentional horizontal nav strips
are exempt from the no-sideways-scroll check.

The route layout test checks the actual routed frame for every route and separately checks login.
For visual changes, review 1440x900, 1280x720, 1000x800, 390x844, 320x568, and 844x390 in both themes.
Also exercise phone tab taps. At wide sizes,
check Page routes for centred content, check board and office for usable breadth, and check inner
forms (including project protected paths) for clipped controls. At Split sizes, check independently
scrolling panes, responsive navigation, short-height chat, and the phone tab bar.
