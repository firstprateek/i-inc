# Web layout language

The web app has three areas, each with its own tabs, and three route templates from `apps/web/src/components/layout.ts`. They are a shared
layout vocabulary, not per-screen width guesses. The route-to-template map is `layoutForRoute()` in
`components/app.ts`; authenticated route headings, including loading and offline states, stay in the
same frame. The unauthenticated login screen uses the Page frame too.

## Areas and tabs (T61)

The app has three areas. The route model lives in `apps/web/src/routes.ts`; the shell is `components/app.ts`.

| Area | Hash | Tabs (each a hash) |
| --- | --- | --- |
| **Conversations** | `#/conversations[/<employee>]` | none; hosts the chat and, until done or dismissed, the Getting started checklist |
| **Work** | `#/work` (Board) | Board `#/work/board` · Needs you `#/work/needs-you` · Releases `#/work/releases`; a ticket is `#/ticket/<id>` and lights Work |
| **Company** | `#/company` (Team) | Team `#/company/team` (and `/hiring[/<id>]`) · Brain `#/company/brain[/<id>]` · Projects `#/company/projects` · Usage `#/company/usage` · Settings `#/company/settings[/teams\|engines\|sandboxes\|notifications]` |

- **Top bar (laptop):** Conversations · Work · Company, a **Needs you (n)** badge that opens Work → Needs you,
  and the account menu (theme, sign out). The laptop opens on Conversations.
- **Phone tabs (bottom bar):** Conversations · Work · Needs you · Company. The phone opens on Work → Needs you.
  The header keeps only the mark and the account menu.
- **Tab row:** one per area, in the page header (the `tabs` slot of `IncLayout`, so Page, Wide and Split share
  it). It is `role="tablist"` with one tab stop: Left/Right/Home/End move between tabs, Space or Enter opens one.
  Tabs are at least 44px tall; on a narrow screen the strip scrolls sideways rather than wrapping. The
  Needs you count is the same number everywhere (`needs-you.ts`).
- **Old hashes** (`#/inbox`, `#/office`, `#/board`, `#/chat`, `#/desk`, `#/handbook`, `#/brain/<id>`,
  `#/hiring`, `#/setup/*`, `#/more`) are rewritten in place (`history.replaceState`) by `legacyTarget()`. Push
  links (`#/ticket/<id>`, `#/ticket/<id>/assign`) are unchanged.
- **Templates by route:** Conversations, Brain and Settings are Split; the board and Team are Wide;
  Needs you, Releases, tickets, hiring, Projects and Usage are Page (`layoutForRoute()`).
- **Words:** conversation, ticket, employee, team, project, brain. The browser title is
  `<tab> · <area> · i.inc` (for example `Board · Work · i.inc`).

## Templates

| Template | Width and use | Scrolling |
| --- | --- | --- |
| **Page** | A centred band up to `--page-width` (840px). Use for Needs you, Releases, ticket details, Usage, Projects and hiring. | The application shell's `<main>` scrolls. Forms and ticket detail stack within the Page width, even on a wide viewport. |
| **Wide** | A centred header band at Page width and content up to `--wide-width` (1400px). Use for the board and the Team floor, whose columns and floor need room. | The shell's `<main>` scrolls vertically; the wide content may scroll horizontally only where its own data view intentionally does so. |
| **Split** | A full-width header above a 300px (280–320px) navigation/sidebar and flexible working pane. Use for Conversations, Brain and Settings sections. The header follows the outer frame's left and right tracks so it aligns with the sidebar and work pane. | Sidebar and working pane own their scroll positions. The app shell main stays fixed on Split routes so its scroll position cannot compete with either pane. |

Login opts into a compact Page frame at `--compact-page-width` (24rem) so its title and form share
one centred reading band. Its standalone host owns a bounded scroller and applies the shared
`--layout-mobile-gutter` plus safe-area insets on all four edges, so login stays comfortably inset
without relying on the authenticated shell's viewport padding.

At widths below 1100px, Split navigation becomes a horizontally scrollable strip above the work area.
At 900px and below, the app also switches its global navigation to the phone tab bar. The work area
uses the remaining height; short landscape and keyboard-open chat states keep the conversation and
composer useful. Login is outside the authenticated shell and has its own bounded scroller and
safe-area-aware viewport gutter, independent of shell inset ownership.

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
