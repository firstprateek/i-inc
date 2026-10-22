# Web layout language

The web app has three areas, each with its own tabs, plus one top-level page of its own (Needs you), and three route
templates from `apps/web/src/components/layout.ts`. They are a shared
layout vocabulary, not per-screen width guesses. The route-to-template map is `layoutForRoute()` in
`components/app.ts`; authenticated route headings, including loading and offline states, stay in the
same frame. A failed request never takes a view away: the frame has a `notice` slot above the
content, where the shell puts the "Can't reach i.inc" banner (`components/offline.ts`) or a "Couldn't
refresh" notice with a retry, and the view stays mounted with its data and anything typed into it
(`components/loader.ts` keeps `data` on a failed refresh, drops out-of-order answers, and guards
button presses with `press()`). The unauthenticated login screen uses the Page frame too.

## Areas, tabs and Needs you (T61, T64)

The app has three areas and one destination of its own. The route model lives in `apps/web/src/routes.ts`; the shell is
`components/app.ts`.

| Where | Hash | Tabs (each a hash) |
| --- | --- | --- |
| **Conversations** | `#/conversations[/<id>]` | none; hosts the Conversations screen (below). Its centre pane is the New conversation screen when nothing is open, and carries the Getting started checklist under the composer until it is done or dismissed |
| **Work** | `#/work` (Board) | Board `#/work/board` · Releases `#/work/releases`; a ticket is `#/ticket/<id>` and lights Work |
| **Company** | `#/company` (Team) | Team `#/company/team` (and `/hiring[/<id>]`) · Brain `#/company/brain[/<id>]` · Projects `#/company/projects` · Usage `#/company/usage` · Settings `#/company/settings[/teams\|engines\|sandboxes\|notifications]` |
| **Needs you** (in no area) | `#/needs-you` | none: one page, titled "Needs you" |

Needs you is **one top-level destination**, not a tab: it shows what waits for the owner (conversations asking for a
permission, tickets at a gate, unassigned tickets, follow-up proposals, brain policy proposals) and what is ready to approve.

- **Top bar (laptop):** Conversations · Work · Company, a **Needs you (n)** link to `#/needs-you` (outlined; filled
  and `aria-current="page"` while you are on it, with no area highlighted), and the account menu (theme, sign out).
  The laptop opens on Conversations.
- **Phone tabs (bottom bar):** Conversations · Work · Needs you · Company; Needs you goes to `#/needs-you` and lights
  there. The phone opens on Needs you. The header keeps only the mark and the account menu.
- **Tab row:** one per area, in the page header (the `tabs` slot of `IncLayout`, so Page, Wide and Split share
  it). It is `role="tablist"` with one tab stop: Left/Right/Home/End move between tabs, Space or Enter opens one.
  Tabs are at least 44px tall; on a narrow screen the strip scrolls sideways rather than wrapping. The
  Needs you count is the same number everywhere (`needs-you.ts`). Needs you has no tab row (its heading block is
  the shorter one a ticket has).
- **Old hashes** (`#/inbox`, `#/work/needs-you`, `#/office`, `#/board`, `#/chat`, `#/desk`, `#/handbook`, `#/brain/<id>`,
  `#/hiring`, `#/setup/*`, `#/more`) are rewritten in place (`history.replaceState`) by `legacyTarget()`. Push
  links (`#/ticket/<id>`, `#/ticket/<id>/assign`) are unchanged.
- **Templates by route:** Conversations, Brain and Settings are Split; the board and Team are Wide;
  Needs you, Releases, tickets, hiring, Projects and Usage are Page (`layoutForRoute()`).
- **Words:** conversation, ticket, employee, team, project, brain. The browser title is
  `<tab> · <area> · i.inc` (for example `Board · Work · i.inc`); Needs you is `Needs you · i.inc`.

## Conversations screen (T60)

`#/conversations` is a Split route that lays three panes out itself (`components/conversations.ts`); each pane owns its
scroll, and the app shell's `<main>` stays fixed. The page header above them is the shared frame header and does not
change.

| Width | Layout |
| --- | --- |
| 1200px and up | List (260-300px) · thread (flexible, content up to 820px) · context panel (280-340px, collapsible, remembered in `localStorage`) |
| 768-1199px | List · thread; the context panel is a drawer over the right edge, closed until asked for |
| Under 768px | One column. `#/conversations` is the list on its own (the New conversation screen instead while there are no conversations); `#/conversations/<id>` is the thread with a back button; the context panel is a bottom sheet (72dvh, with a backdrop, focus on its close button, Escape closes) |

- **New conversation, like Claude's chat:** with nothing open (no conversations yet, or none selected) the centre
  pane is the **New conversation screen** (`conv-draft.ts`): one centred column, top-aligned at a fixed place, with the
  employee and project pickers above the composer and the mode picker inside it. Defaults: the employee and project last
  used (`localStorage`, `prefs.ts`), else the first employee and no project; the mode the employee last ran in, else bypass
  permissions. The agent's own mode list is known only once its session is open, so until then the picker shows the
  remembered mode's label (and the list the agent offered last time), and the thread's own picker takes over. The
  conversation is created when the first message is sent. The left column has no form: **New conversation** only opens
  this screen (on a phone, `#/conversations?new=1`) and the list's empty state is one small muted line, "No
  conversations yet". The Getting started checklist is a compact card **below the composer**, so it appears after it has
  loaded without moving anything above it (it is not above the conversations any more).
- **Heading:** the route's heading is one short line (`dense`, no subtitle; layout.md's allowance for a route with no
  tab row). On a phone's thread view it is visually hidden (still read by a screen reader), since Back and the
  thread's title replace it. While the composer has focus on a phone the tab bar steps aside (no gap above the keyboard).
- **Scrolling:** the list, the thread and the context panel each have one scroll container. The thread follows a
  streaming reply only while you are within 80px of the bottom; scrolling up shows **Jump to latest**. Scrolling to the
  top pages older turns in (`fetchTurns`) and keeps the reader's place. At most about 30 turns are in the DOM until you
  ask for more, and finished turns use `content-visibility: auto`. **Jump to latest** sits in the dock above the
  composer (never over the text), only when you are more than 80px from the bottom.
- **Touch targets:** on a coarse pointer the small text buttons (`link-btn`, Copy, a tool card's head) are 44px tall.
- **Composer:** pinned under the thread, up to 40% of the height as it grows; safe-area bottom inset respected. On a
  phone whose keyboard covers the layout (iOS), the screen lifts by the keyboard's height from `visualViewport`; where
  the viewport resizes with the keyboard (`interactive-widget=resizes-content`) nothing is added.
- **Focus and keys:** the list is one tab stop (Arrow Up/Down move between rows); rows, cards and the composer have
  visible focus rings; every control is a button (navigation to the old chat is the one link).
- **Tokens:** code, diffs and syntax colours are `--code-bg`, `--tk-*` and `--diff-*` in `tokens.css`, with a dark pair,
  each at least 4.5:1 on its background.

## The header rule

An area's page header (title, subtitle, actions) and its tab row **always span the frame** (the same box as
the widest content: the shell's content area, 1400px at most and centred on a wider screen) and **never move or
change height between tabs or areas**. Only the content below follows its template: Page content is a reading
band of about 840px centred inside that frame; Wide and Split use the whole frame. So the Conversations, Work and
Company headings start at the same x (20px at 1440, 260px at 1920) and the same y, and the Company tab row stays
where it is when you switch Team, Brain, Projects, Usage and Settings. To keep this true:
- every route has the same top padding (`main`, including a route that owns its scrolling);
- the heading block is at least 44px tall, so a route with an action button and one without place the title alike;
- put the action in the `actions` slot and the tab row in the `tabs` slot; never add a per-route width or margin to a header;
- a route with no tab row (Conversations, a ticket) has a shorter header, but its title is at the same x and y.

## Templates

| Template | Width and use | Scrolling |
| --- | --- | --- |
| **Page** | The header spans the frame; the content is a centred band up to `--page-width` (840px). Use for Needs you, Releases, ticket details, Usage, Projects and hiring. | The application shell's `<main>` scrolls. Forms and ticket detail stack within the Page width, even on a wide viewport. |
| **Wide** | The header spans the frame and the content uses it, up to `--wide-width` (1400px). Use for the board and the Team floor, whose columns and floor need room. | The shell's `<main>` scrolls vertically; the wide content may scroll horizontally only where its own data view intentionally does so. |
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
  and a Page, Wide, or Split content band. Every header spans the frame (see the header rule above);
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
