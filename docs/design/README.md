# Design

The chosen direction, one screen per file. Each is a static HTML mockup at its real size: open it in
a browser, or run `node tools/ui-check/check.mjs docs/design/<file>.html`. The live canvas with all
of them (and the first pass's three directions) is the design artifact linked from the PRs.

| Screen | File | Size |
| --- | --- | --- |
| Office, the desktop home | `office.html` | 1440 × 900 |
| Board, with the Home lane | `board.html` | 1440 × 900 |
| Chat: Kit drafts a ticket | `chat.html` | 1440 × 900 |
| Ticket: report and timeline | `ticket.html` | 1440 × 900 |
| Hiring a PA | `hiring.html` | 1440 × 900 |
| My desk | `desk.html` | 1440 × 900 |
| Phone: inbox | `inbox.html`, `inbox-dark.html` | 390 × 844 |
| Phone: chat with Pip | `pip-chat.html` | 390 × 844 |
| Phone: the report | `report.html` | 390 × 844 |
| Phone: other Needs you kinds | `needs-you.html` | 390 × 844 |

The colour roles, type and the mistakes we've already made are in
`.claude/skills/ui-review/references/i-inc-lessons.md`. The web app (`apps/web`) builds these as Lit
components with the same tokens.
