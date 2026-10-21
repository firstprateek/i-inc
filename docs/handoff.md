# Handoff: where i.inc stands, and what's next

For the web route layout system and responsive behavior, see [layout.md](layout.md).

For the next session, local or cloud. Read this, then [CLAUDE.md](../CLAUDE.md) and [coord.md](coord.md).
It replaces the context the earlier cloud session had. Update it as you work, and remove each item
as it lands.

## Where things stand

Merged on `main` and live on the mini:

| Area | What's there |
| --- | --- |
| Access & auth | Tailscale Service `svc:iinc` serves HTTPS on standard port 443 at `https://iinc.<tailnet>.ts.net` (`I_INC_HOSTS` configured; old `:8443` removed). Owner auth via `POST /api/signup`, `POST /api/login`, `POST /api/logout`, `GET /api/auth` with `scrypt` hashing in SQLite, `i_inc` cookie, and bearer token fallback |
| Engines & sandboxes | Teams share a sandbox (`inc-<team>`, 12G, 6 CPUs) with Claude (`claude-code`) and Antigravity (Google AI Pro, `antigravity`) signed in once; Codex (`codex`) support added, sandbox provisioning and owner sign-in pending; Antigravity OAuth callback relay (`POST /api/teams/:id/antigravity-callback`); OpenCode (`opencode`, `local: true`) using local Ollama via the container gateway relay (port 11434); local `OllamaHelper` (yes/no & intent classification) and `OllamaChat` (1:1 chat) |
| Isolation & safety | Sandbox inspection (`GET /api/sandboxes`, C1) without booting stopped VMs on read; sandbox DNS filter (`apps/daemon/src/dns.ts`) refusing `.ts.net` and `.local`; firewall walls (`pf`) refreshed every minute; monthly scheduled host restart |
| Caps & releases | Account `monthlyCap` and live Claude rate-limit utilization meters (`GET /api/accounts`, `GET /api/office`); project releases (`GET /api/releases`, `POST /api/projects/:id/release`, `autoRelease` setting, `<inc-desk>`) |
| Web Push | Backend VAPID key file in `~/.config/i-inc/vapid.json`, dedicated `push_sent` SQLite table preventing duplicate notifications, startup baseline, 5 s timeout, triggering on `needs-you`, `report-ready`, and `main-red` (C2); web Push opt-in UI and service worker push handler (PR #46 merged) |
| Live updates | Server-Sent Events stream (`GET /api/events`, C3, daemon PR #40 merged) broadcasting `ticket` and `office` updates with `: keepalive` heartbeats every 25 s, `x-accel-buffering: no`, and `highWaterMark: 64` backpressure handling; web app refetches reactively from the event stream (web PR #44 merged) |
| Session transcripts | Session lifecycle & transcript storage (`GET /api/tickets/:id/sessions`, C4, PR #43 merged); transcript view on ticket page (`<inc-transcript>`, PR #45 merged) with failure isolation, secret redaction, and 500 items/session cap; broadened redaction for AWS AKIA IDs, URL credentials, unpadded base64, YAML/CLI flags, and single-quoted JSON without over-redacting keyboard keys (PR #54 merged) |
| Web application | Mobile pass (1440x900 & 390x844, light/dark), installable PWA (manifest, icons, offline shell service worker), Setup screens (`<inc-setup>`), per-duty engine assignment in hiring (`<inc-hiring>`), phone board (`<inc-board>`), push notification opt-in, mobile bottom tab bar (`role="tab"`, haptic press, 44px+ targets, PR #50), instant optimistic chat with thinking indicator & retry (PR #49), Company brain / Handbook discoverability & team sections (PR #51), office tab route fix (PR #48), mobile touch audit & tap regression suite (PR #52), test teardown hygiene & ui-check sse stream fix (PR #53), engine edit + delete routes for engines, accounts, teams, projects (C11, PR #55), and images on a new ticket (#12: picked or pasted in `<inc-new-ticket>`, sent as one multipart `POST /api/tickets` with the `x-i-inc-upload` header, PNG/JPEG/WebP/GIF checked by their bytes, at most 6 of 10 MB, stored in `ticket_attachments`, served by `GET /api/tickets/:id/attachments/:n`, thumbnails on the ticket page, and copied to `<worktree>/.inc/attachments/` at pick-up, which the brief lists), and images added later (#15: `POST /api/tickets/:id/attachments` for any ticket that isn't done, and `POST /api/tickets/:id/decide` as multipart for a "Not quite" reply, with the same checks and 24 per ticket; an `owner-attached` event tells a run that's under way, which copies them in with `Workspace.attach` before the builder's next session and says so in that brief; the picker is the shared `ImagePicker` controller), and images with a chat message (#16: `GET /api/chat/:id` returns the employee's `current` ticket and how many images it has; when there is one, `<inc-chat>` offers an image button and paste, labelled "For #N"; `POST /api/chat/:id` as multipart, a `message` JSON field naming the ticket plus `image` files, skips the helper and goes to that ticket as `owner-attached` and then `owner-message`, with the same checks; a ticket that's no longer current gets a 409 with the new `current`; images with no text record no note; the owner's chat entry keeps the image numbers for its thumbnails), and images for a reviewer or verifier (#17: before its session, `Workspace.checkout` checks the branch out in its own machine, from origin, as a worktree marked `i-inc.copy` that later rounds reset to the new push, leaving a builder's worktree on a shared machine alone; then `Workspace.attach` copies the images it doesn't have yet; if that fails, the seat is skipped as `helper-unavailable`; direct mode keeps the branch in the builder's machine, so only the images reach a reviewer on another team) |
| Dogfooding | Project `i-inc` registered on the mini in direct mode (`checks`: install, check, typecheck, test; `autoRelease: false`; protected paths set) and assigned to Ada; first ticket #7 completed autonomously end-to-end (Ada build on Claude, Gemini review, direct push to main `d7239dc`, CI green, retro knowledge recorded, follow-ups #8 and #9 filed) |

All tasks T1–T27 and pipeline maintenance PRs #53–#55 are merged to `main` and deployed live on the Mac mini.
All tests pass (`pnpm check && pnpm typecheck && pnpm test` — 408 tests passing across 41 test files).

## Operations

### Coordination source of truth
[docs/coord.md](coord.md) is the single source of truth for who does what between agents (Claude, Antigravity and Codex). All task claiming, PR reviews, deploy locks, and heartbeats are recorded there. Edits to `coord.md` go straight to `main`; all other code changes go through a feature branch and PR.

### Deploying to the mini

**Once the deployer is installed, deploys are automatic** (T54, [v1-plan §5](design/v1-plan.md)): you do
nothing. Every 2 minutes the LaunchAgent `inc.i.deployer` looks at `origin/main`. A new commit whose
CI check (`check`, read from the public GitHub API) concluded `success` is built in
`~/i-inc-releases/<sha>`, smoke-tested on a spare port in demo mode, held until the running daemon is
idle (no ticket stage or chat turn; at most 30 minutes, then it retries next cycle), switched in
(`~/i-inc-releases/current` is repointed and `inc.i.daemon` is kickstarted) and health-checked
(`GET /api/health` must report the new sha within 90 s). Any failure puts the previous release back,
records it and sends a push ("Deploy of abc1234 failed: … — rolled back"). A failed build, smoke test or
health check is retried once from clean, and written off (never tried again) only if it fails again; a
temporary failure (full disk, network, timeout) is retried with back-off (2, 4, 8 … up to 60 min) and
never written off. Newer commits are tried at once. Only a commit that continues the running release is
deployed: after a force-push to an older or unrelated commit it logs a warning, records
`skipped-ancestry` and pushes; allow it with `--once --sha <full sha>`. The last 5 releases are kept,
and never the running one or the one before it. Nothing needs root.

- **See deploys:** My desk → Releases → Deploys (the last 8), `GET /api/deploys` (the last 20),
  `tail -n 5 ~/.i-inc/deploys.jsonl` (`{at, sha, from, outcome, reason, durationMs}`, outcome is one of
  `deployed`, `rolled-back`, `failed-build`, `failed-smoke`, `skipped-ci`), and one line per state change
  in `~/Library/Logs/i-inc-deployer.log`. `curl -s http://127.0.0.1:7420/api/health` says which sha is
  running and whether it is busy.
- **Pause:** `launchctl bootout gui/$(id -u)/inc.i.deployer`. Resume:
  `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/inc.i.deployer.plist`.
- **Deploy now (force):** the loop already deploys within 2 minutes of green CI. To skip waiting for
  the daemon to go idle, pause the deployer, then
  `cd ~/i-inc && bun apps/deployer/src/main.ts --once --force-after 0` (a daemon that does not answer
  `/api/health` counts as busy too)
  (`--force-after <minutes>` switches anyway once the daemon has stayed busy that long; a ticket cut
  short resumes by itself after the restart).
- **Roll back by hand:** pause the deployer, then
  `cd ~/i-inc && bun apps/deployer/src/main.ts --rollback [sha]`. It points `current` at the previous
  release that was actually deployed (never a build that was only waiting to be switched to; or `sha`,
  which must be an earlier deployed release still in `~/i-inc-releases`), kickstarts the daemon, records
  it, and marks the release you left as bad so it is not deployed again (the one you roll back to is
  never marked). It refuses while the daemon is busy or not answering unless you add `--force`. Then
  resume the deployer. Without the marking, the deployer would redeploy main's tip on its next cycle.
- **A commit you want retried** after it was marked bad: delete its key from `bad` in
  `~/i-inc-releases/state.json` (with the deployer paused). `bun apps/deployer/src/main.ts --status`
  prints that state.
- **The deployer's own code** runs from `~/i-inc`, not from a release, so a broken release can never
  stop its own repair. It does not update itself: after changes under `apps/deployer`, run
  `cd ~/i-inc && git pull && launchctl kickstart -k gui/$(id -u)/inc.i.deployer`. Keep
  `apps/deployer`, `tools/host` and the login code in the protected paths so a self-change there waits
  for you.
- **Install (once, on the mini, as the owner):** `cd ~/i-inc && git pull && sh tools/host/install-deployer.sh`
  prints the plan and changes nothing; `sh tools/host/install-deployer.sh --apply` does it (seeds
  `~/i-inc-releases` from `~/i-inc`'s HEAD, points the daemon plist at `~/i-inc-releases/current`
  keeping its environment, restarts the daemon and checks its health, loads `inc.i.deployer`; the old
  daemon plist is kept as `inc.i.daemon.plist.pre-deployer`; the edit is exact and a second run changes nothing).
  `install-daemon.sh` keeps the daemon on `~/i-inc-releases/current` once the deployer is installed; a copy
  from a checkout older than that change would reset the daemon plist to `~/i-inc`, so run
  `install-deployer.sh --apply` again if you ever do that. `sh tools/host/install-deployer.sh --rollback-install`
  restores it, removes the deployer and checks the restored daemon's health.

Before the deployer is installed, deploy by hand:
1. `cd ~/i-inc && git pull`
2. `pnpm install --frozen-lockfile && pnpm --filter @i-inc/web build`
3. `launchctl kickstart -k gui/$(id -u)/inc.i.daemon`
4. `curl -sf https://iinc.<tailnet>.ts.net/api/auth`

### Sandbox sign-in scripts (`tools/host`)
Each team's sandbox signs in to harnesses once using host tools:
- **Claude:** `sh tools/host/sign-in-claude.sh <team id> [cpus] [memory]` runs `claude auth login --claudeai` inside the machine and verifies sign-in status.
- **Antigravity:** `sh tools/host/sign-in-antigravity.sh <team id> [cpus] [memory]` initiates the Google AI Pro sign-in flow and relays the local OAuth callback into the machine. The daemon also exposes `POST /api/teams/:id/antigravity-callback` to relay callbacks programmatically.

- **Codex:** follow [Codex setup](codex.md) to provision the pinned harness in new or existing team machines, then run `sh tools/host/sign-in-codex.sh <team id>` when the owner is ready. The device-code flow stays in the sandbox; Setup → Sandboxes reports only sign-in status. No login is performed as part of deployment.

### Sandbox won't boot: hostname already exists
When macOS or Apple's container framework terminates abruptly or gets out of sync, `container-apiserver` can retain a stale registration (`hostname(s) already exist: ["inc-<team>.machine."]`). The daemon automatically recovers from transient machine failures using safe `container machine stop <name>` retries and exponential backoff (30s → 1m → 2m … up to 10m) without churning tickets.

If the machine enters persistent `stale-hostname` backoff (visible in Setup > Sandboxes and ticket waiting line):
1. **Never delete** the machine, its volumes, or disks.
2. Ask the owner before restarting the container daemon on the host.
3. Once approved, restart the Apple container service on the Mac mini:
   ```sh
   container system stop && container system start
   ```
4. Verify the machine state:
   ```sh
   container machine ls
   ```
5. In i.inc web under Setup > Sandboxes, click **Retry now** (or call `POST /api/sandboxes/:team/retry`) to immediately wake the team sandbox and resume tickets at their current stage.

### Adding repos to the GitHub App
Before the bot can work on tickets for a repository (e.g. `firstprateek/i-inc`), the repository must be explicitly added to the **i.inc bot** GitHub App installation in GitHub settings:
1. Navigate to GitHub `Settings` → `Applications` → `Installed GitHub Apps` → `i.inc bot` → `Configure`.
2. Under **Repository access**, select and add the repository.
3. Verify with `node tools/github-app/check.mjs`.

## Next steps, in order

1. **Verify live experience on phone:**
   - Access `https://iinc.<tailnet>.ts.net/` on mobile: test PWA install, Push notification opt-in, live SSE updates on ticket board, and session transcript drawer.
2. **Check ticket images on the mini and an iPhone (#14):** checked on Linux, but not yet on the mini.
   The two steps are in [m1-findings.md, "M3: ticket images"](m1-findings.md#m3-ticket-images-14).
3. **Continue dogfooding follow-up tickets:**
   - Watch Ada pick up and run filed follow-up tickets #8 ("Reset chat state in willUpdate...") and #9 ("Keep chat draft per employee...").

## Decisions already made (don't reopen)

- **Views and UI:**
  - three views: office, board and 1:1 chat;
  - a PA arrives in v1, after the GitHub loop works (M6);
  - light by default with a dark theme, and Lit components.
- **Engines:**
  - The Google engine is Antigravity; Gemini CLI no longer serves Google AI Pro.
  - Each employee's machine signs in to Claude with the owner's subscription (`claude auth login`),
    once, at hiring. The owner chose this on 2026-09-28 over the model-only token from `claude
    setup-token`, accepting that a full login reaches the owner's claude.ai connectors. A token in
    `~/.config/i-inc/credentials.json` still works for any account.
  - Cloud engines stay. A private cloud is only noted for later.
  - Home data goes only to local models; the local model runs on Ollama (`qwen3:8b`).
- **Credentials:**
  - A session's credentials go into its machine with `container machine run -e NAME`, copied from
    the environment of that one `container` process. They're in no command line, never on the
    machine's disk, and gone when the session ends (m1-findings.md, "M3: credentials").
  - The GitHub App is named **i.inc bot** (slug `i-inc-bot`), on the owner's personal account.
    Plain "i.inc" is refused: Apps share names with accounts, and an account `i-inc` exists. Its private key lives on the mini at `~/.config/i-inc/github-app.pem`, mode
    0600 in a 0700 folder, and never in the repo.
- **Brains:**
  - They live on the mini and are never pushed.
  - Shared facts go in the handbook; personality and duty lessons stay in each employee's brain.
- **Proof, My desk and goals:**
  - Proof images are copied into the PR, unless something in them is private; then the PR gets a
    tailnet link.
  - My desk counts hardware and electricity with simple maths. Its watt figures await a plug
    meter; M1 measured the chip only.
  - Goals live only in i.inc, with no GitHub milestone sync in v1.
- **The 2026-10-17 redesign:** one sandbox per team; direct to main by default (owner-merges per
  project); the reviewer is another employee, else a different engine, else a fresh session, at most
  2 rounds; protected paths (workflows, release config) need the owner; red main is fixed by the same
  ticket or reverted after 2 hours; agents file follow-ups within a daily budget; the owner cuts
  releases for now; Hermes stays off.
- **The repo is public:**
  - no secrets, tokens, account names or home addresses in it;
  - no model identifiers in commits or PRs;
  - conventional commits.

## Working conventions

- **The owner likes to talk ideas through first.** "Give me your thoughts" means thoughts, not
  action.
- **Keep status messages short.** The owner asks for concise next steps and what's needed from them.
- **Every UI change goes through the `ui-review` skill.** Run `tools/ui-check/check.mjs` at
  1440x900 and 390x844, in light and dark, and look at the screenshots.
- **Branches and PRs:** open a PR per coherent chunk, and the owner merges. After a merge, start the
  next branch from `main`.
