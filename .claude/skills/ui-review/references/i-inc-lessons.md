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
