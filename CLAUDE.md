# i.inc — notes for agents

i.inc is a personal company of AI engineers. The owner hires agent employees, each with its own
machine (a Linux VM) and a brain (a git-backed wiki). They get tickets on a board and return PRs
that are already checked, reviewed and proven. The spec is [docs/spec.md](docs/spec.md). It is the
source of truth for behavior, words and safety, so read it before changing anything.

## Status

M2's core is in `packages/core`, tested against fakes for every port:
- the In progress loop from an event log (stages per effort, checkpoints and resume, the report);
- engines (engine per duty, switch rules, the home-data wall);
- the scheduler (assignments, standing orders, working hours, caps, account headroom);
- errands and outbound permissions;
- the owner's decision, follow-ups, the retro and knowledge routing, and handoffs;
- My desk's spend and bottleneck maths.

M3 has started:
- `apps/daemon`: the SQLite event log, the company registry, the tick loop that joins the scheduler to
  the runner, the API, and serving the web app;
- `apps/web`: the office, board, ticket, My desk and inbox views as Lit components, light and dark.

Real ACP sessions, machines and the GitHub App wait for M1's findings, so for now the daemon runs only
in demo mode, with the scripted agent and a morning's worth of tickets. Chat and hiring need their
own API next.

Nothing runs on the Mac mini yet: M1 is next there ([docs/m1-runbook.md](docs/m1-runbook.md)). The
milestones are in the spec, §14.

## Where work can happen

- **Cloud sessions** (claude.ai/code on this repo) can work on the spec, the design track, and M2's
  pipeline core. The core is pure TypeScript, tested against fakes.
- **Anything that touches the Mac mini** needs a session on the owner's Mac. The mini is on the home
  tailnet, and cloud sessions can't reach it. That includes M1: Apple container, the `pf` rules,
  sign-ins, and the daemon's host setup. The steps are in [docs/m1-runbook.md](docs/m1-runbook.md).

## Planned layout

| Path | What |
| --- | --- |
| `packages/core` | The company: tickets and errands, stages, employees, roles and duties, engines, accounts, scheduling, switch rules, engine per duty, local model pools, the helper-model interface, outbound permissions, goals, report and My desk assembly. Plain TypeScript, no I/O |
| `apps/daemon` | Runs on the host: the SQLite event log, ACP sessions, the machine provider (Apple container), the GitHub App, the home tools, the API, push |
| `apps/web` | The office, board, chat, My desk, ticket, report and inbox views (a PWA built from Lit components, light with a dark theme) |
| `images/employee` | The base image every employee machine is built from |
| `docs` | The spec, and later the design directions |

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
- Keep the safety model intact. Employees are lenient inside their machine and walled outside it: no
  LAN, a bot GitHub identity, and only the owner merges. A PA's walls are tighter: home data goes
  only to local engines, the PA has no internet and no credentials, and what leaves goes through
  outbound permissions. Any change that weakens a wall needs the owner's explicit approval.

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
- `node tools/ui-check/check.mjs [--out dir] [--size WxH] [--dark] <file.html | url> ...`: render pages in
  Chromium and report overlap, covered text, overflow, contrast, near-miss alignment, missing
  accessible names and fonts that didn't load. Exits 1 on errors.

