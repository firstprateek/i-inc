# i.inc — notes for agents

i.inc is a personal company of AI engineers. The owner hires agent employees, each with its own
machine (a Linux VM) and a brain (a git-backed wiki). They get tickets on a board and return PRs
that are already checked, reviewed and proven. The spec is [docs/spec.md](docs/spec.md). It is the
source of truth for behavior, words and safety, so read it before changing anything.

## Status

Docs only (M0); nothing is built yet. The milestones are in the spec, §13.

## Where work can happen

- **Cloud sessions** (claude.ai/code on this repo) can work on the spec, the design track, and M2's
  pipeline core. The core is pure TypeScript, tested against fakes.
- **Anything that touches the Mac mini** needs a session on the owner's Mac. The mini is on the home
  tailnet, and cloud sessions can't reach it. That includes M1: Apple container, the `pf` rules,
  sign-ins, and the daemon's host setup.

## Planned layout

| Path | What |
| --- | --- |
| `packages/core` | The company: tickets, stages, employees, roles and duties, engines, accounts, scheduling, switch rules, report assembly. Plain TypeScript, no I/O |
| `apps/daemon` | Runs on the host: the SQLite event log, ACP sessions, the machine provider (Apple container), the GitHub App, the API, push |
| `apps/web` | The office, board, ticket, report and inbox views (a PWA) |
| `images/employee` | The base image every employee machine is built from |
| `docs` | The spec, and later the design directions |

## Conventions

- Use Duet's toolchain: a pnpm workspace, TypeScript, Biome and Vitest. Server code is plain
  `Request`/`Response`, served by Bun on the host and by Node in tests.
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
  - brain, handbook.

  The product is written "i.inc", and the repo is `i-inc`.
- Keep the safety model intact. Employees are lenient inside their machine and walled outside it: no
  LAN, a bot GitHub identity, and only the owner merges. Any change that weakens a wall needs the
  owner's explicit approval.

## Commands

None yet. They arrive with the first code.
