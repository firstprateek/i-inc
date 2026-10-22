# T64: UX walk-through

The lead walked the product as the owner (laptop 1440×900, phone 375×812, demo mode) and decided the changes below. Each
entry is the finding, the decision, and where it was fixed. PR 1 is `t64-needs-you-conversations`, PR 2 is
`t64-work-cleanups`.

## PR 1: Needs you home and Conversations

1. **Needs you appeared three times** (top-bar pill, a Work tab, the phone bottom tab) and each did something different.
   - Decision: one top-level destination, `#/needs-you`, titled "Needs you", with no tab row. The laptop pill is a link to it
     (count, active state), the phone tab goes to it, Work keeps Board and Releases. `#/work/needs-you` and `#/inbox`
     redirect. The phone home stays Needs you; the laptop home stays Conversations.
   - Fixed in: PR 1 (`routes.ts`, `components/app.ts`, `docs/layout.md`).
2. **New conversation opened a form in the left column**, next to a duplicate empty state in the centre.
   - Decision: like Claude's chat. The button opens the draft in the centre pane: one centred composer with employee,
     project and mode pickers (defaults: last used employee and project; the employee's remembered mode, else bypass). The
     conversation is created on the first send. The left form is gone. The centre draft is also the "nothing selected" view;
     the list's empty state is one small muted line. Until the agent's mode list is known the picker shows the remembered
     mode's label (and the list it offered last time).
   - Fixed in: PR 1 (`conv-draft.ts`, `conversations/prefs.ts`, `conv-list.ts`, `conversations.ts`).
3. **Demo mode had no conversation backend** ("No agent is connected to conversations yet").
   - Decision: a small scripted agent in the daemon's own process.
   - Fixed in: PR 1 (`apps/daemon/src/demo-agent.ts`, wired in `main.ts`). It streams a reply with a read, a plan, and an
     command that asks for permission (it starts in bypass, like the draft says, and always asks before running its test command, so the permission card shows).
4. **Getting started appeared after load and pushed the page down** under the pointer.
   - Decision: move it into the centre empty state as a compact card, below the composer, so nothing above it can move. Chosen
     over reserving its height because its state (done, dismissed) is only known after load, and reserving would leave a gap
     for people who have finished it.
   - Fixed in: PR 1. Measured in `tools/e2e/home-flow` (`pnpm e2e home-flow`): with the data held back 1.5 s, the composer and
     heading are 0 px apart before and after the card appears, at 1440×900 and 390×844.

## PR 2: Work, ticket and clean-ups

5. **The board** had a "New ticket" form above it, a "Proposed" band, and a "Recent reports" list, so the kanban was not the
   first thing.
   - Decision: the kanban is first and the columns share the full width; "New ticket" is a header action opening the form in a
     dialog; "Proposed" leaves the board (proposals live in Needs you); reports move into the Done column's cards.
   - Fixed in: PR 2.
6. **A ticket page did not show what was asked.**
   - Decision: the body and "done when" list go at the top, collapsible when long, above the current gate or status.
   - Fixed in: PR 2.
7. **Times and statuses**: UTC times, and whimsical statuses ("Coffee break").
   - Decision: every time in the owner's local zone in a friendly format ("resumes 2:14 AM"), never "UTC"; plain statuses
     ("Idle", "Waiting for tokens until 2:14 AM").
   - Fixed in: PR 2.
8. **Releases**: "Cut release" offered for projects with nothing to release; a "General" row.
   - Decision: "Up to date" instead of the button when there is nothing unreleased; "General" is relabelled or hidden (see PR 2).
   - Fixed in: PR 2.
9. **Projects**: when the GitHub App is not set up, a long paragraph and several links.
   - Decision: one compact notice with a button, above the list.
   - Fixed in: PR 2.
10. **Brain** showed approve and decline buttons for legacy policy proposals.
    - Decision: they are Needs you cards. The Brain page shows the handbook, map and Changes feed only.
    - Fixed in: PR 2 (the Needs you cards already exist from PR 1's page).
