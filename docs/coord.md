# Coordination: Claude ⇄ Antigravity

The single source of truth for who does what. Both agents `git pull` before reading this file and
push after changing it. Edits to this file go straight to `main` (commit message `coord: …`); all
other work goes through a branch and PR. [architecture.md](architecture.md) is the design;
[handoff.md](handoff.md) is background.

## How we work

- **Lanes, by folder.** `web` (Claude): `apps/web`, UI and design. `daemon` (Antigravity):
  `apps/daemon`, `packages/core`, `tools/host`, `images/`, the mini. Never edit the other lane's
  folders; if a task needs both, write its contract under **API contracts** first and split it.
- **Claim before working:** set the task's Status to `claimed (<agent>)`, add a `CLAIM` log line,
  commit and push. Never take a task the other agent has claimed.
- **One branch and PR per task** (`t<ID>-<slug>`). The other agent reviews it (`REVIEW` in the
  log): read the diff, run `pnpm check && pnpm typecheck && pnpm test`. Merge when CI is green and
  the review is ok, or after one loop with no review for a change that's tested and in one lane.
- **The mini:** add `DEPLOY-LOCK <agent>` to the log before deploying or changing anything there,
  and `DEPLOY-UNLOCK <agent>` after. Ask the owner before any `sudo`, sign-in or network change.
- **The owner:** a task that needs them gets `QUESTION <task> → owner: …` in the log; carry on with
  other work meanwhile. Whoever hears the answer writes it as `ANSWER`.
- **Each loop:** pull → read → handle log lines addressed to you → review PRs waiting on you →
  take the highest open task in your lane → work → push → update this file → sleep ~20 min.
- **Rules that always hold:** the repo is public (no secrets, tokens, account names or home
  addresses); conventional commits, no model names; never weaken the walls; UI changes get checked
  with `tools/ui-check/check.mjs` at 1440x900 and 390x844, light and dark.

Log format: `YYYY-MM-DD HH:MM <from> → <to>: <VERB> <task> — <text>`, with verbs CLAIM, DONE,
HANDOFF, REVIEW, BLOCKED, QUESTION, ANSWER, DEPLOY-LOCK, DEPLOY-UNLOCK. Newest at the bottom.

## Goals (only the owner changes these)

1. **A polished product the owner uses daily, on laptop and phone:** seamless, easy, responsive.
2. **One short address that works anywhere:** a Tailscale Service, `https://iinc.<tailnet>.ts.net`,
   with a real certificate, so the phone can install it as an app with notifications.
3. **The local agent** (OpenCode on Ollama) available in the product.
4. **Dogfooding:** i.inc improves i.inc, with the owner giving suggestions through the product.

## Tasks

| ID | Task | Lane | Status | Branch / PR | Needs | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | Tailscale Service `iinc`: owner creates `svc:iinc` in the admin console (ask with exact steps); the mini serves it (`tailscale serve --service=svc:iinc --https=443 http://127.0.0.1:7420`); add its name to `I_INC_HOSTS`; an access rule limiting it to the owner's devices; document it | daemon | open | | owner | Don't touch Duet's port 443 on the mini's own name |
| T2 | Local engine end to end: account `local` and engine `qwen` (opencode, `qwen3:8b`, `local: true`); prove an OpenCode session in the sandbox through the Ollama relay | daemon | open | | | |
| T3 | `GET /api/sandboxes` (contract C1) | daemon | open | | | |
| T4 | Setup screens: Teams, Projects (mode, protected paths, follow-up budget, recipe), Engines and accounts (add one, "local" badge), sandbox sign-in status | web | open | | T3 | Existing PUT routes for teams/projects/engines/accounts |
| T5 | Mobile pass on every view (390x844 and 1440x900, light and dark): navigation, touch targets, forms, tables | web | open | | | |
| T6 | Installable app: manifest, icons, service worker with an offline shell | web | open | | | |
| T7 | Web Push backend: VAPID keys in `~/.config/i-inc`, subscribe/unsubscribe, sends on needs-you, report-ready, main-red (contract C2) | daemon | open | | | |
| T8 | Push opt-in in settings, and the service worker's push handler | web | open | | T6, T7 | |
| T9 | Live updates: `GET /api/events` server-sent events (contract C3) | daemon | open | | | |
| T10 | Views refresh from the event stream instead of reloading | web | open | | T9 | |
| T11 | Board on the phone: a quick new-ticket form, agent-filed follow-ups marked, the protected-paths card, a digest of recent reports | web | open | | | |
| T12 | Session transcripts: keep each ACP session's messages and tool calls per ticket (contract C4) | daemon | open | | | |
| T13 | Transcript view on the ticket page | web | open | | T12 | |
| T14 | Dogfooding: register i-inc as a project (recipe `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm typecheck`, `pnpm test`), with no automatic deploy to the mini | daemon | open | | owner | Ask the owner: direct or owner-merges for i-inc |
| T15 | Refresh `handoff.md` (its next steps are stale) and `architecture.md` for what's built | daemon | open | | | |
| T16 | Hiring: choose engines per duty, see each engine's harness and "local" badge | web | open | | T2 | |

## API contracts

**C1 `GET /api/sandboxes`** → `{ "sandboxes": [{ "team": "engineering", "machine": "inc-engineering",
"state": "running" | "stopped" | "missing", "cpus": 6, "memory": "12G",
"signedIn": { "claude": boolean, "antigravity": boolean, "github": boolean } }] }`

**C2 Web Push** → `GET /api/push/key` → `{ "publicKey": "<VAPID public key>" }`;
`POST /api/push/subscribe` with a browser `PushSubscription` JSON → `{ "ok": true }`;
`POST /api/push/unsubscribe` `{ "endpoint" }` → `{ "ok": true }`. Notifications carry
`{ "title", "body", "url": "#/ticket/<id>" }`.

**C3 `GET /api/events`** (text/event-stream) → `event: ticket` with `data: { "id": "<ticket id>" }`
whenever a ticket's events change; `event: office` with `data: {}` when employees or teams change.
Heartbeat comment every 25 s.

**C4 `GET /api/tickets/:id/sessions`** → `{ "sessions": [{ "stage", "employeeId", "engineId",
"startedAt", "endedAt", "items": [{ "kind": "text" | "tool", "text"?: string, "title"?: string,
"status"?: string, "at": number }] }] }`, newest last; text capped at 4 KB per item.

## Log

2026-10-17 21:00 claude → all: DONE setup — coord.md created; goals and tasks T1–T16 from the owner's review. Antigravity takes the `daemon` lane, Claude the `web` lane.
