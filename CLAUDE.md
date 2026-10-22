# i.inc — notes for agents

i.inc is a personal company of AI engineers. The owner hires agent employees, each with a brain (a
git-backed wiki), working in its team's sandbox (a walled Linux VM; one per team). They get tickets on a board and return PRs
that are already checked, reviewed and proven. The spec is [docs/spec.md](docs/spec.md). It is the
source of truth for behavior, words and safety, so read it before changing anything.

## Status

i.inc is built and runs on the owner's Mac mini ([docs/architecture.md](docs/architecture.md) is the current
picture and wins over the spec where they differ):
- `packages/core`: the pure pipeline (stages per effort, checkpoints and resume, the report), engines and
  switch rules, the scheduler, errands and outbound permissions, follow-ups, the retro and knowledge routing,
  and the brain's page format, maps and retrieval. Tested against fakes for every port.
- `apps/daemon`: the SQLite event log, the registry, the tick loop, the API, the real ACP client and the Apple
  container machine provider, the GitHub App, host-side pushes, the AHP host behind Conversations, the brain
  index, feed and harvest, push notifications, storage clean-up and serving the web app.
- `apps/deployer`: the separate LaunchAgent that deploys `main` to the mini behind a guard (host code
  deploys only with the owner's approval or an owner-merged PR).
- `apps/web`: the PWA, with three areas (Conversations, Work, Company) and a Needs you page.
- `tools/host`, `tools/m1`: the host scripts (walls, relay, installers, sign-ins); `tools/e2e`: browser runs
  against a local daemon.

`I_INC_DEMO=1` still runs the daemon with a scripted agent and a morning's worth of tickets, without a mini.

Not built yet: the PA's mail, calendar and web-errand tools (the errand loop and the walls are), agents
asking the owner questions mid-conversation (no adapter supports it), agent teams talking to each other, and
MCP tools and skills.

**Picking up the work?** Start with [docs/handoff.md](docs/handoff.md) (operations and how things work) and
[docs/coord.md](docs/coord.md) (who does what, the API contracts and the log). [docs/audit/T63-report.md](docs/audit/T63-report.md)
is the last full audit.

## Where work can happen

- **Cloud sessions** (claude.ai/code on this repo) can work on the docs, the web app and the pure
  pipeline core, which are tested against fakes and need only this repo.
- **Anything that touches the Mac mini** needs a session on the owner's Mac. The mini is on the home
  tailnet, and cloud sessions can't reach it. That includes Apple container, the `pf` rules, sign-ins
  and the daemon's host setup (see [docs/m1-runbook.md](docs/m1-runbook.md) and `tools/host`).

## Layout

| Path | What |
| --- | --- |
| `packages/core` | The company: tickets and errands, stages, employees, roles and duties, engines, accounts, scheduling, switch rules, engine per duty, the helper-model interface, outbound permissions, the brain's page format, maps and retrieval, report and Usage (spend and bottleneck) assembly. Plain TypeScript, no I/O |
| `apps/daemon` | Runs on the host: the SQLite event log, ACP sessions, the AHP host, the machine provider (Apple container), the GitHub App and host-side pushes, the brain, the API, push |
| `apps/deployer` | The automatic deployer LaunchAgent, with its review guard |
| `apps/web` | The Conversations, Work (board, releases, tickets), Needs you and Company (team, brain, projects, usage, settings) views: a PWA built from Lit components, light with a dark theme |
| `images/employee` | The base image every team sandbox is built from |
| `tools` | `host` (walls, relay, installers, sign-ins), `m1` (the first hand-run tests and the walls tests), `github-app`, `e2e`, `ui-check` |
| `docs` | The spec, the architecture, the handoff, the coordination log, the design docs and the audits |

## Conventions

- Use Duet's toolchain: a pnpm workspace, TypeScript, Biome and Vitest. UI components are Lit web
  components. Server code is plain `Request`/`Response`, served by Bun on the host and by Node in
  tests.
- The core has no I/O. It is tested against a scripted fake ACP agent and a fake machine provider, so
  the whole pipeline runs in tests without spending tokens.
- Everything must build and test on Linux. Only the machine provider and the host setup are
  macOS-specific.
- Use conventional commits (`feat:`, `fix:`, `chore:`, `docs:`), because Release Please will cut the
  releases.
- Use the spec's words:
  - employee, role, duty, engine, account;
  - standing order, switch rule, usage cap;
  - ticket, stage, gate, privileged request;
  - brain, handbook;
  - errand, home data, home tools, outbound permission, web errand;
  - engine per duty, helper model, My desk, goal.

  The product is written "i.inc", and the repo is `i-inc`.
- Keep the safety model intact. Employees are lenient inside their sandbox and walled outside it: no
  LAN, a bot GitHub identity, no write credentials in any sandbox (every push is made by the daemon on
  the host from a verified bundle), and only the owner merges. The team is the trust boundary: one
  sandbox and one Unix user per team, and agents have root. A PA's walls are tighter: its own
  sandbox, no root, no internet, home data only to local engines, no credentials, and what leaves goes
  through outbound permissions. Any change that weakens a wall needs the owner's explicit approval.

## UI work

Any UI change (the web app, design canvases, HTML mockups) goes through the `ui-review` skill in
`.claude/skills/ui-review`: read it against the tells and our lessons, then render it with the
checker and look at the screenshots. Add new lessons there when a review finds a new mistake.

## Commands

- `pnpm install`, then `pnpm check` (Biome), `pnpm typecheck` and `pnpm test` (Vitest). CI runs all
  three on every PR.
- `pnpm --filter @i-inc/web build`, then `I_INC_DEMO=1 pnpm --filter @i-inc/daemon start`: the daemon
  in demo mode on http://127.0.0.1:7420, serving the web app (Bun; `bun:sqlite` on the host,
  `node:sqlite` in tests). `pnpm --filter @i-inc/web dev` runs the app with hot reload against it.
- `node tools/ui-check/check.mjs [--out dir] [--size WxH] [--dark] [--before setup.js] <file.html | url> ...`: render pages in
  Chromium and report overlap, covered text, overflow, contrast, near-miss alignment, missing
  accessible names and fonts that didn't load. Exits 1 on errors.

