# V1 plan: clarity, conversations, brain, GitHub, automatic deploys

Status: proposal for the owner's review, 2026-10-20. Companion docs:
[conversations.md](conversations.md) and [brain.md](brain.md).

## The owner's direction (2026-10-20)

The product works but is confusing. V1 is: a clear, consistent app on the laptop browser;
**Conversations** as an excellent agentic surface; a **Brain** that is an indexed wiki; GitHub
projects end to end. Then: views for operating agents remotely and the phone, a robust
self-improvement loop, agent teams, MCP tools and skills, and other surfaces via AHP.

Decisions: conversations can do anything, including code changes, with permission modes; the
brain updates itself without asking; deploys to the mini become automatic.

## 1. Clarity: one mental model

Today there are about a dozen views with no home, and four of them (Office, Inbox, My desk, Board) overlap.
V1 has three areas:

| Area | What it answers | Built from today's views |
| --- | --- | --- |
| **Conversations** | "Let me work with an agent" | Chat (rebuilt, see conversations.md) |
| **Work** | "What is happening, what needs me, what shipped?" | Board, ticket pages, Inbox (as the "Needs you" filter), releases |
| **Company** | "Who works here, what do they know, where do they work?" | Office floor and Hiring (Team), Handbook and brains (Brain), Projects, Setup (Settings), Desk's spend (Usage) |

- Laptop top bar: **Conversations · Work · Company**, a **Needs you (n)** badge that opens the
  filtered list, and the account menu. The customisable "All views" menu goes; the three areas
  replace it.
- Phone tabs: **Conversations · Work · Needs you · Company**.
- Laptop home: Conversations. Phone home: Needs you.
- **First run:** until it's done, Conversations shows a short **Getting started** checklist:
  connect GitHub (install the bot on your repos) → add a project (import or create) → meet your
  team (Ada exists; hire more) → start your first conversation. Every empty state says what to do
  next.
- **Words used everywhere:** *conversation* (you and an agent, live), *ticket* (work the pipeline
  runs on its own), *employee*, *team*, *project* (a GitHub repo), *brain* (what the company and
  each employee knows).
- One layout language (docs/layout.md) stays; the page templates are reused, not redesigned.

## 2. Conversations

See [conversations.md](conversations.md): real ACP agent sessions, live, with permission modes,
and the daemon as an AHP host.

## 3. Brain

See [brain.md](brain.md): markdown pages in git, a SQLite FTS index, maps always in the prompt,
the most relevant pages retrieved automatically, the agent tending its own pages.

## 4. GitHub projects

The pieces exist (#63: import, recipe detection, new-project bootstrap) but feel rough, and the bot
only sees repos you added to its install.
- **Company → Projects** lists every repo the bot can see, with a clear "Give i.inc access to more
  repos" link to the bot's GitHub settings.
- **Add a project:** pick a repo; i.inc detects the checks; you confirm the recipe and the mode
  (direct or owner-merges).
- **New project:** name, template, private or public. i.inc creates the repo only if you allow the
  bot to create repos, otherwise it asks you to create an empty one and then fills it.
- **Start working:** every project page has "Start a conversation" and "New ticket". A
  conversation works on its own branch and can open a PR or, in direct mode, push after review.

## 5. Automatic deploys

A small **deployer** runs on the mini as its own LaunchAgent, separate from the daemon, so a broken
daemon can never stop its own repair:

1. Every 2 minutes it checks `origin/main`. A new commit with green CI (checked through the GitHub
   API) becomes a candidate.
2. It builds the candidate in a fresh release folder (`releases/<sha>`: worktree, frozen install,
   web build), and starts it once on a spare port with demo data as a smoke test.
3. **Drain:** it waits until no ticket stage or conversation turn is running (at most 30 minutes;
   conversations show "updating in a minute").
4. It switches the `current` link to the new release, restarts the daemon and checks health
   (`/api/auth`, the web app, the AHP handshake).
5. On failure it switches back, restarts, notifies you, and never retries that commit.
6. Every deploy shows under Work → Releases and as a push notification.

No sudo is involved. Installing the deployer's LaunchAgent is a one-time host change, so the
install command is shown to you first. Recommended: add the deployer, the walls scripts and the
login code to the protected paths, so self-changes there still wait for you.

## 6. A robust self-improvement loop

From this week's evidence:
- **Follow-ups are lost.** 23 agent follow-ups were dropped once the daily budget (3) ran out.
  They should queue under Work → Proposed for you to accept or decline, not vanish.
- **Disk grows about 4 GB a day.** Closed tickets' working copies and reviewers' copies are never
  removed. Clean them up a few days after a ticket closes.
- **Feedback button** on every screen (phone too): it files a ticket with your words, a
  screenshot and the current screen, so using the app becomes the way to improve it.
- **CI gains a Playwright smoke test** of the main flows (sign in, start a conversation, open a
  ticket, every top-level area), so a self-change cannot quietly break the app before it deploys.
- **Undeployed work.** 18 of Ada's commits are merged but not live today; automatic deploys fix
  that for good.

## 7. Keeping the front end separate

- Sessions go over AHP (any surface can attach).
- Everything else stays REST, with its types moved into a shared package (`packages/api`) so a
  second client can import them; versioned routes arrive when that second client does.
- Per-device login tokens come with the first non-browser surface.

## 8. Order and owners

Suggested, for the owner to change:

| Phase | Work | Suggested owner |
| --- | --- | --- |
| 0, this week | Follow-up queue, disk clean-up, prune merged branches, correct the brain claims in the docs | Ada, as i.inc tickets |
| 1a | AHP spike and decision | Claude |
| 1b | Brain V1 (format, index, retrieval into tickets, diff-harvest writes) | Antigravity |
| 1c | Session host, event mapper, state store; Conversations screen | Claude |
| 1d | Three-area structure, first-run checklist, rename to Conversations | Codex |
| 1e | GitHub projects flow | Codex |
| 1f | Automatic deploys | Antigravity |
| 2 | Remote operation views, phone layout, Feedback button, CI smoke test | to be decided |
| 3 | Agent teams (aligned with A2A), MCP tools and skills (discovered via Google's [Agentic Resource Discovery](https://www.heise.de/en/news/Agentic-Resource-Discovery-Search-engine-for-AI-agents-11338833.html), ARD), more AHP surfaces | later |

1b and 1c are independent and can run in parallel. 1d can start right away. 1f needs the owner's
OK on the LaunchAgent install command.

## Glossary of the protocols

- **ACP** (Agent Client Protocol): one client driving one agent. i.inc already uses it with Claude
  Code, Gemini, Codex and OpenCode.
- **AHP** (Agent Host Protocol, Microsoft): a host shares live agent sessions with many clients.
  The proposal makes the i.inc daemon an AHP host.
- **ARD** (Agentic Resource Discovery, Google and partners, v0.9 draft): how agents find tools,
  skills, MCP servers and other agents (`ai-catalog.json` at a well-known path, plus registries).
  Relevant when MCP tools and skills arrive.
- **A2A** (Agent2Agent): agent-to-agent messaging. A candidate for agent teams.
