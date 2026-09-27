# i.inc UI lessons

Mistakes we've made, and the rule that prevents each. Newest last. Check these first.

## The token roles

Every colour in i.inc belongs to exactly one role. Never reuse a role's colour for another role.

| Role | Light | Used for | Never for |
| --- | --- | --- | --- |
| Ground, surface, lines | `#EEF0EA`, `#FBFBF8`, `#D5D9D1` | Page, cards, dividers | Meaning |
| Ink | `#1E2421` (muted `#4E5652`) | Text, primary buttons, done steps, the logo | Status |
| Working | `#DCEEDF` / `#1D5234` | Working status only | Buttons, categories |
| Reviewing | `#DDE7F6` / `#1D4476`, strip `#3A68A8` | Reviewing status only | Links, categories |
| Needs you | `#FCE8B8` / `#5A3A00`, border `#C48A12` | Needs you, unread counts | Decoration |
| Alarm | `#C4452B`, text `#8A2B17` | Failing checks, limit reached, blocked | Brand, primary actions |
| Neutral state | `#E6E8E3` / `#3F4642` | Off, coffee break, ticket types, projects | — |
| Identity | Slate, rose, lilac, stone, sand, clay, periwinkle tints | Avatars only | Any status |
| Materials | Floor `#E6D7BC`, desk `#CFAF82` | The office metaphor | UI chrome |

Type: Bricolage Grotesque for display, Figtree for body. Monospace only for code-like values (file
paths, branch names, structured briefs).

## Lessons

1. **One colour, five meanings (tell 2).** Terracotta was the logo dot, the New ticket and Send
   buttons, the current stage and "limit reached", so a card's current stage read like an alarm.
   → Primary actions are ink. The alarm colour is only for alarms.
2. **Identity colours collided with status (tell 2).** Kit's avatar was green (= Working), Grace's
   blue (= Reviewing); ticket types used the status colours. → Avatars use identity tints that match
   no status; types and projects are neutral chips with text.
3. **Terminal costume on the desks (tell 7).** Desk monitors showed green-on-black monospace for
   plain English, even for the PA. → Monitors use the body face; mono only for code-like values.
4. **A stock look (tell 9).** Cream ground, serif display and a terracotta accent is a common
   default (and close to Claude's own look). → The identity comes from the office materials (floor,
   desks); the chrome is neutral plaster and ink with a grotesque display face.
5. **The same state three times (tell 3).** "Needs you" was a header pill, a sidebar list and desk
   chips on one screen; "local only" appeared on every PA element. → Once per view. The list keeps
   the count; the desk keeps the chip.
6. **Spec text in the UI (tells 8, 10).** "Asks become errands on the Home lane of the board" and a
   placeholder explaining track records. → Show behaviour when it happens; empty states say only
   what's true ("No finished tickets yet").
7. **White on amber, white on terracotta (contrast).** Unread badges were 2.94:1 and Send was
   4.35:1. → Badges use the needs-you chip colours; buttons are ink. The checker catches this.
8. **Monitors too narrow (misalignment).** Status text wrapped to three lines and the monitor
   overlapped the avatar; "waiting on you" spilled into the padding. → Size decorative boxes for
   their longest copy, keep copy short, and look at the screenshot: the checker can't see two
   decorative shapes colliding.
9. **Half-empty cards (layout).** Desk cards stretched to fill the grid row with content in the top
   half. → Size the content to the cell, or let rows size to content. The checker's `sparse` warns.
10. **Passing checks painted in the Working green (tell 2).** The report showed "Tests 212/212" in
    the Working status colour, so a finished ticket looked like it was still running. → Passing
    checks are facts, not a status: neutral chips with a check mark.
11. **Whole cards and page regions left empty (layout).** My desk's bottom cards and the hiring
    page stretched to fill their rows with nothing in the lower half. The checker's `sparse` only
    caught one of them, because the others weren't grid cells or were just over its line. → Let
    rows size to their content (`align-items: start`), or fill them with real content from the
    spec; never stretch a card to match a taller neighbour. Look at the screenshot for this.
12. **A container reused a chip's class (tell 2).** Waiting cards on the office, board and inbox
    took the chip class `needs`, so every line of text inside turned the chip's brown. → Give
    containers their own state class (`waiting`); a chip's colour pair belongs to the chip alone.
13. **The checker measured the proxy's error page (tooling).** Chromium sent `127.0.0.1` through the
    environment's proxy, so the "no findings" for the app were about an error page. → The checker
    connects Chromium directly and fetches only HTTPS through the proxy, and it now fails loudly
    when a page doesn't load. Always look at the screenshot before trusting "no findings".
14. **The checker couldn't see inside Lit components (tooling).** It listed elements with
    `document.querySelectorAll`, which stops at shadow roots, so every "no findings" for the web
    app measured only the page shell. Dark-theme tags at 1.47:1 (`--neutral-fg` had no dark value)
    and a Send button pushed off the phone screen went unreported. → The checker walks open shadow
    roots, and flags a page that scrolls sideways. Run it in dark as well as light, and when a
    screenshot shows a problem the checker didn't report, fix the checker.
15. **A new token without its dark value (theming).** A token defined only in `:root` keeps its
    light value in the dark theme. → Every colour token gets a dark value in both dark blocks of
    `tokens.css`, or a comment saying why it is the same in both.
16. **Content under a fixed bar (layout).** The phone's tab bar is fixed; content may scroll under
    it, but the end of the page must clear it. → Pad the page by the bar's height. The checker
    ignores fixed bars while measuring overlap, then scrolls to the end and reports anything still
    under one.
17. **A button label wrapped (layout).** "✓ Urgent" broke onto two lines in a narrow form. →
    Buttons never wrap (`white-space: nowrap` on `.btn`); let the input beside them shrink
    (`min-width: 0`).
18. **Two avatars in one tint (identity).** Tints came from a hash of the id, so Kit and Grace wore
    the same rose; and slate, lilac and periwinkle side by side all read as lavender. → The tint is
    chosen at hiring (the least-worn one) and stored on the employee. The palette is ordered so the
    first hires get the most unlike tints; look at the office with the whole team, not one avatar.
