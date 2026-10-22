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
  `/api/health` counts as busy too, for up to 10 minutes; if launchd reports `inc.i.daemon` not running, or
  it stays silent for 10 minutes, the deploy goes ahead as the recovery path and says so in its record
  and push)
  (`--force-after <minutes>` switches anyway once the daemon has stayed busy that long; a ticket cut
  short resumes by itself after the restart).
- **Roll back by hand:** pause the deployer, then
  `cd ~/i-inc && bun apps/deployer/src/main.ts --rollback [sha]`. It points `current` at the previous
  release that was actually deployed (never a build that was only waiting to be switched to; or `sha`,
  which must be an earlier deployed release still in `~/i-inc-releases`), kickstarts the daemon, records
  it, and pauses auto-deploy at main's tip at that moment (nothing is marked bad), so the commit you
  rolled back from is not redeployed. `bun apps/deployer/src/main.ts --status` shows "paused after hand
  rollback at <sha7> — resumes on the next commit"; the next commit on main lifts the pause by itself,
  or `--resume` does. (If GitHub cannot be reached during the rollback, it pauses at the last tip the deployer saw; if it never saw one, the pause lasts until `--resume`.) The `deploys.jsonl` line has `sha` = the release now running and `from` = the one you left. It refuses while the daemon is busy or not answering unless you add `--force`.
  Then resume the deployer service.
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

### Home machines' egress wall (T66)

The walls are now **closed unless opened**. A machine gets the internet and DNS only if the daemon has declared
its address; every other address (a PA's sandbox, a machine nobody declared, an address a machine made up for
itself) gets only DHCP and Ollama on the gateway. A PA's sandbox, the machine of the team `home-<id>` or any team
with a PA in it, therefore has no internet, no DNS, no LAN, no tailnet and no host (spec §5 and §7). Engineers'
machines keep their internet. The design, and why:

- **Not a separate network.** Apple container 1.4.1 has `container network create`, but `machine create` has no
  `--network` option and the machine service attaches every machine to the built-in `default` network
  (`Sources/Services/MachineAPIService/Server/MachinesService.swift`, tag 1.4.1). Nothing to create at user level.
- **Why the table names the machines let out, not the one shut in.** The sandbox user has passwordless sudo, so a
  rule naming the PA's address could be dodged with `ip addr add`. With the table of open machines an unknown
  address is shut in. And the PA's user loses root anyway (below).
- **How the table is filled.** The daemon reads each machine's address from `container machine ls` (its IP column)
  and writes the running machines that may reach the internet to `/var/run/i-inc/open-machines` (a folder
  `walls.sh` makes for the owner). `walls.sh` (root, every minute and at once when that file changes) keeps only
  lines that are plain addresses of 192.168.64.0/24, writes `/var/run/i-inc-open-machines.table`, loads the rules
  (which read it), reads the table back from pf, runs `pfctl -k` for every address that left the table (pf keeps
  the state of a connection a rule once passed), and writes what pf holds to `/var/run/i-inc-walls.open`. It takes
  the walls marker away (so the daemon stops everything) if the rules lack the open-machines rule, the table
  differs from the declared list, pf is off or the gateway isn't on `bridge100`. No DHCP leases are used:
  container allocates addresses itself, so they would not list the machines.
- **The daemon checks the live address before every launch.** It runs `container machine ls`, finds the machine's
  current address and checks it against that file: in it for an engineers' machine, not in it for a PA's sandbox.
  This covers agents, scripts (brain copies, checks), callbacks and the sign-in probe, and refuses a machine that
  isn't running (`machine run` would boot it). A machine that woke at a new address waits, up to 90 s, until the
  walls let it out (declared at once, taken up when the file changes or within a minute); a ticket then shows why
  and Setup > Sandboxes shows the reason. A 30-second watch also declares machines that woke on their own.
- **A PA's sandbox has no root.** When the daemon creates or boots one it first runs a fixed script as root
  (`machine run -u root`) that deletes the sudoers entry, removes the user from the groups that are root in all but
  name (sudo, admin, wheel, docker, lxd, adm, disk) and leaves an empty immutable `/etc/sudoers.d/employee`; then
  as the user it checks `sudo -n true` fails, and checks that again before every launch and in the watch (root
  back means the machine is stopped). Nothing in a PA's workflow needs sudo: the launchers, the brain apply script
  and the daemon's scripts don't use it; `update-machine.sh` and `provision-codex.sh` now write as `-u root`
  instead of `sudo tee`; the storage trim (`sudo -n fstrim`) is best effort and is skipped.
  The brief still says the machine has sudo for engineers; a PA is told it does not. Docker is not available to
  a PA either. The weak point left is the guest kernel and whatever is setuid in the image.
- **Rolling out.** `main` deploys itself, the new rules arrive only when you run `install-walls.sh`. Until
  `/var/run/i-inc-walls.open` exists the daemon treats the walls as the old ones: engineers' machines run exactly
  as today (no extra checks), and a PA's sandbox is refused with "the walls need updating: run `sudo sh
  tools/host/install-walls.sh`" in the log, in Setup > Sandboxes and in any PA ticket. Once the file appears the
  new rules are assumed to be loaded and every machine is checked.
- **Ollama.** The relay `tools/m1/ollama-forward.mjs` is no longer a TCP pipe: it is an HTTP proxy that allows
  `/api/chat`, `/api/generate`, `/api/embed`, `/api/embeddings`, `/api/tags`, `/api/show`, `/api/ps`,
  `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings` and `/v1/models` with the method each needs, on the
  exact path, and only for a model that `/api/tags` lists as installed (cached 30 s), is not a cloud model and
  has no registry host in its name. Pull, push, create, copy, delete and blobs never reach Ollama. It serves every
  machine. A model you add with `ollama pull` on the mini shows up within 30 s. Re-install it:
  `sh tools/host/install-relay.sh`.
- **Engines.** A PA can use only local engines (`local: true`, not Codex), for every duty and fallback; hiring or
  editing refuses anything else and says "none is set up yet" when there is no local engine. `PUT /api/engines/:id`
  now refuses (409) to make an engine a PA uses non-local. The one local engine today is OpenCode on Ollama
  (`tools/m1/install-harnesses.sh`, relay at `http://192.168.64.1:11434/v1`); add it in Setup as an engine with harness
  OpenCode and "local" ticked.
- **No DNS for a PA, on purpose** (a lookup through the host's resolver can carry data out). A PA reaches the gateway
  by address. If an engine ever needs a name, that is a decision to make here first, not a rule to add.
- **Not verified, so not claimed: one machine reaching another.** L2-switched traffic between two machines on the
  bridge may never meet pf. `tools/m1/walls-test.sh` with `OTHER_MACHINE=<ip>` tests TCP and ping to another
  machine and sends a broadcast to `255.255.255.255:67` (to see whether the DHCP rule's broadcast reaches other
  machines: run `nc -ul 67` as root in the other machine first). Until that has passed on the mini, treat a PA's
  sandbox as able to reach other machines on the bridge, and through them the internet.

**Owner steps (once, on the mini).** Nothing needs creating at user level. Do it when no ticket is running: right
after the walls reload, each engineers' machine is shut in until the daemon declares it (up to half a minute).

1. `cd ~/i-inc && git pull` (the daemon deploys itself; the host scripts come from this checkout).
2. `sh tools/host/install-relay.sh` (as yourself) installs the allowlisting relay and restarts it.
3. `sudo sh tools/host/install-walls.sh` (from your own account, not a root shell: it needs `SUDO_USER`) loads the new
   rules, `walls.sh` and its plist (with a watch on the daemon's list), and records you as the owner of
   `/var/run/i-inc`. It ends with `the walls are up` and `open machines the walls hold now: 0`; within half a minute
   the daemon declares the running machines and the count follows.
4. Verify.
   (a) `sudo pfctl -a com.apple/010.i-inc-machines -s rules | grep open_machines` shows two rules (DNS and internet),
   and `sudo pfctl -a com.apple/010.i-inc-machines -t open_machines -T show` lists the running engineers' machines
   and no PA sandbox. `tail /var/log/i-inc-walls.log` shows `walls up` and no `walls down`.
   (b) In an engineers' machine: `container machine run -i -n inc-<team> -- env ROUTER=<ip> HOST_LAN=<ip>
   HOST_TAILNET=<ip> LAN_DEVICE=<ip:port> TAILNET_DEVICE=<ip:port> bash -s < tools/m1/walls-test.sh` ends
   `14 as wanted, 0 not`.
   (c) Start a PA's sandbox (give the PA a task). In it, the same command with `HOME_MACHINE=1` added ends
   `14 as wanted, 0 not` (internet, by name and by address, and DNS blocked; only Ollama open). As the user,
   `sudo -n true` must fail there: `container machine run -u employee -n inc-home-<id> -- sudo -n true` prints
   "a password is required".
   (d) With a second machine running, add `OTHER_MACHINE=<its address>` to (c); it ends `17 as wanted, 0 not` if
   machines can't reach each other (and prints what happened to the broadcast). Report the result here.
   (e) From a machine, `curl -s -X POST http://192.168.64.1:11434/api/pull -d '{"name":"evil.example/x/y"}'` answers
   403 `that call is not allowed`, and `curl -s http://192.168.64.1:11434/api/tags` still lists the models.

An existing PA sandbox from before this (`inc-home-<id>`, with sudo) needs no recreating: the daemon takes its
root away the next time it is used.

**If it goes wrong.** A PA ticket waiting with "the walls didn't settle for inc-… within 90 s" means the walls job
did not load the address: `tail /var/log/i-inc-walls.log`, `ls -l /var/run/i-inc /var/run/i-inc-walls.open`. If the
launchd watch does not fire the job still runs once a minute. An engineers' machine stuck on "isn't let out by the
walls yet" is the same. To take the new walls down, install the previous `tools/m1/pf/i-inc-machines.pf` and
`walls.sh` from git, run `sudo sh tools/host/install-walls.sh`, then `sudo rm -f /var/run/i-inc-walls.open`: with no
acknowledgement file the daemon treats the walls as the old ones again (a stale one stops everything).

**Reinstalling a LaunchAgent no longer leaves a service down.** `tools/host/launchd.sh` (used by `install-daemon.sh`,
`install-deployer.sh`, `install-relay.sh` and `install-walls.sh`) waits up to about 10 s for `launchctl print` to say a
service is gone after `bootout`, retries a `bootstrap` that fails with error 5, and if it still fails puts the plist
that was running back and loads it. The deployer installer restores the plist it replaced, not the older
pre-deployer backup. The deployer's own restart (`launchctl kickstart -k`) never boots out, so it needed no change.

### End-to-end checks and the test suite (`tools/e2e`, `pnpm test`)
- **End to end:** each `tools/e2e/<name>/run.mjs` drives the real web app in Chromium against a local daemon in a scratch
  HOME, with stand-ins for GitHub and the agents (no real credentials; screenshots at 1440x900 and 390x844, light and
  dark). Playwright is a pinned root devDependency, so a clean clone needs only:
  1. `pnpm install`
  2. `pnpm e2e:install` once, which downloads the Chromium that Playwright version drives (into Playwright's own
     cache, `~/Library/Caches/ms-playwright` on a Mac; nothing is added to the repo). CI does not do this: it runs `check`, `typecheck`
     and `test` only.
  3. `pnpm e2e` builds the web app and runs every script one after another (`pnpm e2e projects conversation-push` runs
     just those, `--no-build` skips the build, `--out dir` moves the screenshots, default `e2e-out/<name>`). Exit code 1
     if one fails. The scripts start the daemon and a stand-in GitHub with **`bun`**, so it must be on PATH.
  Before it runs anything, `tools/e2e/run-all.mjs` reads each script and refuses one that is not self-contained. This is a
  scan of the script's text, not a sandbox: a script may import only node built-ins, `playwright` by its bare name and
  files inside the repo, and may not name an absolute path (`/Users`, `/opt`, `/usr`, `~/`, `file:`), a `../` path that
  leaves the repo, the home folder, `NODE_PATH` or the global npm folder. It uses the repo's `node_modules`, the repo's
  files and temporary folders it makes. `PW_CHROMIUM=<path>` points at another Chromium. Bump Playwright to a version
  at least two weeks old, then `pnpm e2e:install` again (the browser build changes with it).
- **No clocks in the default suite.** A test never asserts that code was fast: busy machines and CI make that fail at
  random. What a test checks instead:
  - *Super-linear behaviour (ReDoS and rescans):* the scanners in `apps/web/src/conversations` report the characters each
    search looked at to a test-only probe (`probe.ts`, unset outside tests, so a call is one undefined read), and the test asserts
    that four times the text costs at most five times the count. Backtracking inside a regular expression cannot be counted,
    so those inputs (redaction in `apps/daemon/src/ahp/sanitize.ts`, markdown, the project matcher) run once under a
    budget of seconds that only a blow-up reaches (a quiet machine needs milliseconds).
  - *"Does not wait for X":* the order of events or the calls made (X was never asked for, the first agent was killed only
    after all were asked to stop), or a fake clock.
  - *Precise timings* (50 ms for 64 KB, 100 ms for a match, growth ratios between sizes) run only with `I_INC_BENCH=1`, on a
    quiet machine: `I_INC_BENCH=1 pnpm test` (or `pnpm bench` for the brain index).

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

### Adding or creating a project (T62)

All of it is in the web app under **Company → Projects** (`#/company/projects`), from the laptop or the phone.
The list shows each project's mode, checks, last ticket and open PRs, and every repo the bot can see that isn't
a project yet, each with **Add**.

- **The bot only sees repos you give it.** The page's **Give i.inc access to more repos** link opens this
  installation's settings on GitHub (**Repository access**: add the repo, save), then press **Refresh repos**
  (the list is cached for 30 seconds; Refresh asks again, at most every 3 seconds). Verify from the mini with
  `node tools/github-app/check.mjs`.
- **Add a project you already have:** **Add a repo** (or **Add** beside a repo). i.inc reads the repo and suggests the checks
  (`GET /api/github/repos/:owner/:name/inspect`); you confirm or edit the recipe and choose **Direct**
  (pushed to the main branch after i.inc's own review; the preselected choice, as in the daemon) or **Owner merges** (finished
  work waits as a pull request and only you merge it). It registers the project (`POST /api/projects/:id/bootstrap` with no template).
- **Start a new project:** **New project**: a name, a starter (TypeScript + Node, Web app, Python, Minimal) and Private or
  Public. What happens next depends on the installation (`GET /api/github/status` says which):
  - *An organization and the App has **Administration: write**:* the bot creates the empty repo
    (`POST /api/github/repos`), then fills it with the starter and adds the project. This permission is **off by default**
    (docs/github-app.md says never to grant it: it lets the bot change repo settings). Grant it only if you want that.
  - *A personal account, or an organization without that permission (the usual case):* GitHub doesn't let the bot create
    the repo. The page gives you a link to GitHub's new-repository page with the name and visibility filled in. Create it
    **empty** (README, `.gitignore` and licence off), and make sure the bot can see it (add it to the installation
    unless that is on **All repositories**). The page looks for it every 15 seconds while it is open (or press **Refresh now**), then
    fills it and adds the project.
  - The steps are shown on the page and survive a reload: the draft is kept in this browser and each step is worked out
    from GitHub, so closing the tab halfway just picks up again. A repo that already has any commit is never written
    over (the daemon checks GitHub's commit list, not its lagging size). Only a start that stopped part way, where every
    commit is the starter's own, can be carried on: press **Carry on filling it** and it adds the missing files and
    changes none that are there. A repo can be one project only.
- **Work on a project:** its page (`#/company/projects/<id>`) has the repo link, mode, checks (editable), recent tickets,
  releases, **Start a conversation** (`#/conversations?new=1&project=<id>`; see C14) and **New ticket** (the new-ticket form
  with this project chosen).
- **Errors** are sentences with something to do (GitHub rate limits, timeouts, a refused name, a key that GitHub rejects)
  and never "Can't reach i.inc", which is only for the daemon itself. The installation token never leaves the daemon or
  reaches a log.
- **Try it without GitHub:** `pnpm --filter @i-inc/web build`, then `node tools/e2e/projects/run.mjs` (a local daemon in a
  scratch HOME with a stand-in GitHub; Playwright; screenshots at 1440x900 and 390x844, light and dark).

### Adding repos to the GitHub App
Before the bot can work on tickets for a repository (e.g. `firstprateek/i-inc`), the repository must be explicitly added to the **i.inc bot** GitHub App installation in GitHub settings:
1. Navigate to GitHub `Settings` → `Applications` → `Installed GitHub Apps` → `i.inc bot` → `Configure`.
2. Under **Repository access**, select and add the repository.
3. Verify with `node tools/github-app/check.mjs`.

(The web app's **Give i.inc access to more repos** link goes to that page.)

### Using Conversations (T60)

`#/conversations` is the first screen of the app: talk to an employee about a project, watch the agent work live, and
answer it when it asks. The screen is the web app's AHP client (`apps/web/src/ahp/`, the official
`@microsoft/agent-host-protocol` 1.0.0 over the daemon's `/ahp` WebSocket; contract C22); the design is in
[design/conversations.md](design/conversations.md).

- **Start one:** **New conversation**, pick an employee and a project (or none), **Start**, then type the first message.
  Nothing is created until you send it (leave the page and nothing is kept); the first send creates the conversation (a
  few seconds on a cold sandbox; refused with 409 when the team already has three busy) and then sends the message.
  `#/conversations?new=1&project=<id>` opens the form preset to a project. The mode picker in the composer lists the
  agent's own modes and defaults to its bypass-permissions mode; change it in one click (the app remembers the last
  one you chose for that employee and uses it for their next new conversation).
- **While it works:** text streams in, "Thinking" is collapsed, each tool call is a one-line card (Read, Edit, Run,
  Search...) that opens to its input, output or diff, and the agent's plan is a checklist (also in the right panel).
  **Stop** interrupts. Typing during a turn offers **Steer** (runs next, ahead of the queue; Enter) or **Queue**
  (Alt+Enter); both are listed above the box and can be removed. A steering message does not interrupt the turn
  (ACP cannot inject into a running one): press Stop to do that.
- **It asks you:** a permission card shows the command or the file diff and the agent's own options (Allow once, Always
  allow, Deny). The first answer from any device wins; the other devices show "Allowed on another device". A pending
  card counts in the Needs you badge and is listed in Work > Needs you, which opens the conversation at the card.
- **Right panel** (the button in the thread header; remembered): project and branch, the plan, files changed (open one
  for its diff), brain pages used (from the session's `_meta["iinc.brain"]`: each page with its scope, marked "opened"
  when the agent read it itself and "untrusted" when it was built from outside content), usage and the
  account's 5-hour and 7-day meters. On a phone it is a bottom sheet.
- **Files:** paste, drop or pick images and text files (code, notes, logs, up to 256 KB each; they go to the agent as
  embedded resources). Binaries, PDFs and anything else are refused with a reason.
- **Limits** (the host refuses more, so the box says so first): a message is 256,000 characters, at most 6 attachments
  and 12 MB of them together. A message the host refuses goes back into the box with its images and the reason.
- **What you read is what is there:** control, bidi and zero-width characters in permission cards, paths, commands, diffs
  and titles show as `⟨U+202E⟩`; only http(s) and mailto links in a reply are clickable; a line over 4,000 characters
  in a reply is plain text.
- **Reconnecting:** if the host goes away a "Reconnecting..." banner shows and sending waits; the screen replays what
  it missed from the last `serverSeq` (or takes a fresh snapshot) and carries on.
- **Old chat** (the footer of the list, `#/conversations/old/<employee>`) is the previous small-model chat. It goes in
  the release after this one.
- **Trying it without real agents:** `apps/daemon/test/ahp/e2e-server.ts` runs the real daemon over the scripted fake
  agent and a fake Exec (`I_INC_HOME=<scratch dir> PORT=7611 bun apps/daemon/test/ahp/e2e-server.ts`, after building
  `apps/web`). Prompts starting `slow`, `hang`, `markdown`, `burst N` and `longtools` pick what it does.

### Push for conversations (T65)

When an agent in a conversation asks for permission (or, once adapters send them, a question) and you are not looking
at that conversation, your phone gets a notification that opens the card. The design line is in
[design/conversations.md](design/conversations.md) ("Permission modes"); the contract is C2 and C22 in [coord.md](coord.md).

- **Turn it on:** Company > Settings > Notifications. The device switch is the same as for tickets (on an iPhone,
  install i.inc to the Home Screen first). Under "What to be notified about": **Conversations need me** (on by default)
  and **A long reply finished** (off by default; only for a turn that ran a minute or more). They apply to every device.
- **What you get:** "<Employee> needs you" and a lock-screen-safe line: a command is only its program and a couple of
  well-known words (`Run: pnpm test`, `Run: mysql …`), a file its path (`Edit: src/app.ts`), a fetch its host. Arguments,
  file contents and diffs never appear.
  Tapping opens the app at the card: it scrolls into view, the first button has focus and the card is outlined for a
  moment. If you (or another device) answered it already, the thread says "Already answered on another device".
  Approving happens in the app, never from the lock screen (iOS has no notification buttons, and the card is where
  the diff is).
- **When it does not buzz:** nothing is sent for 20 s after the request appears, so answering at the laptop never
  buzzes the phone; nothing is sent while any signed-in page is open on that conversation, visible and focused (the
  page says so every 15 s while it is touched, stops after 2 minutes without a touch, and the host forgets it after 45 s); one push per request, ever; a newer request of the
  same conversation replaces the older notification (tag `conv-<id>`). When the request is answered, the turn ends
  or the conversation is archived, nothing is sent: a push that only closes a notification shows nothing, which spends
  Chrome's silent-push allowance and makes Apple revoke the subscription. The app closes stale notifications itself
  (by tag) when it is opened, regains focus or changes conversation, so a notification left up after an answer or a
  restart goes the next time you look.
- **Code:** `apps/daemon/src/ahp/conversation-push.ts` (the rules, `describeRequest` for the line),
  `AhpHost.observe`/`isWatched` and `iinc/presence` in `host.ts`, `GET/PUT /api/push/settings` in `api.ts`;
  `apps/web/public/sw.js` (push, tap), `apps/web/src/ahp/presence.ts`, `?card=` in `routes.ts` and `conv-thread.ts`.
- **Tests:** `apps/daemon/test/ahp/conversation-push.test.ts` (grace, watched, one per request, tag, nothing on answer, settings,
  redaction, the presence signal; also over the fake ACP agent), `apps/web/test/conversations/card-link.test.ts`,
  `apps/web/test/ahp/presence.test.ts`, the worker tests in `apps/web/test/push.test.ts`, and the browser run
  `node tools/e2e/conversation-push/run.mjs` (build `apps/web` first; it starts `apps/daemon/test/ahp/e2e-server.ts` in
  a scratch HOME with a fake push sender, `GET /__e2e/pushes` lists what it sent, and needs Playwright).
- **Not verified on a real phone:** the iOS Home Screen app and Android Chrome. Everything above is tested against
  fakes and in desktop Chromium. Check on a device: a tap from the lock screen lands on the card on iOS (the worker cannot
  navigate a window there, so it messages the app), that the app closes a stale notification when opened on iOS and Android, and that
  the visibility signal quiets the phone while the app is open.

### How the brain reaches agents (T57)

The brain is markdown in git on the mini; sandboxes cannot reach the mini, so it is **copied in**. All of it is in
`apps/daemon/src/brain-feed.ts` (the orchestration), `brain-snapshot.ts` and `brain-apply.sh` (the copy and the script
that applies it in the sandbox), `brain-tar.ts`, `brain-cli.cjs` (the `brain` command) and, in the core,
`packages/core/src/brain-prompt.ts` (paths, queries, prompt text). The contract is C19 in [coord.md](coord.md).

- **The copy.** Before every ticket stage and every conversation turn, the daemon makes sure
  `/home/employee/brain/<employee>/` in the employee's team sandbox is current: `company/`, `team-<teamId>/` and
  `personal/` (their own brain), a map `INDEX.md` in each, and `.bin/brain`. A team shares one sandbox and one Unix
  user, so each employee has a folder of their own; each copy holds only the scopes `readableScopes` gives that
  employee (never another employee's brain, another team's section, or a PA's home data). It needs nothing new in the
  image (Node 24, git, tar, bash are there), so **no image rebuild and no host step**.
- **Incremental.** The daemon remembers what it last sent to each machine and employee (`brain_synced`) and sends only
  changed files, as one `bash -s` script whose stdin carries a tar stream in base64. A delta is applied only if the
  sandbox holds exactly the snapshot it was made against; otherwise (a wiped sandbox, a restored backup) the whole
  copy is sent. An unchanged brain costs no script; the copy is re-checked at most every 5 minutes. A 1,000-page copy
  takes a few seconds the first time, a one-page change well under a second
  (`I_INC_BENCH=1 pnpm --filter @i-inc/daemon exec vitest run test/brain-bench.test.ts --reporter=verbose` prints them).
- **For T58 (writing).** The copy is a git repository whose baseline is the ref `refs/inc/baseline` (HEAD follows it
  until the agent commits something itself). What an agent changed is
  `git -C <copy> diff --name-status refs/inc/baseline` plus `git ls-files --others --exclude-standard`; folder to scope:
  `scopeOfDir` in `brain-prompt.ts`, and `.snapshot.json` lists them. A refresh **keeps the agent's local edits**: a
  file with local changes (or one the agent made) is left alone and the baseline keeps its old text, so the diff stays
  exactly the agent's work; it is logged as `brain: kept <employee>'s own edits to N page(s)…`. T58 should reset the
  baseline after harvesting. Symlinks in a copy are removed, and what they hid is restored from the baseline.
- **Limits and safety.** Names must be plain (`isSafeSnapshotPath`: relative, no `..`, no dot-files, no quotes,
  `$`, backticks, backslashes or control characters); a page over 256 KB is left out, and a copy is capped at 16 MB
  (what was left out is logged). The sandbox side refuses an archive that holds anything but plain files with plain
  names. Nothing about the walls changed: the copy goes in through `machine run -i`, like every other script.
- **If the copy fails** (a stopped machine, a timeout of 3 minutes), the session goes on and its prompt says the copy
  isn't available; the maps and the matching pages are still in the prompt.
- **The prompt.** Every ticket stage's brief ends with a `<brain>` section, and every conversation turn gets it as an
  extra text block after your message. It has the maps (at most about 150 lines each), and the pages retrieved for the
  task (top 5 by BM25 times the scope boost, one link away from the best two, about 3,000 tokens). In a conversation a
  page is sent once, and the maps again only when they changed or the agent lost its memory. Untrusted pages
  (`source: external`) are marked. The employee's `personality` page is never retrieved (the brief carries it).
  Demo mode has no sandboxes and adds nothing.
- **Home data and shared sandboxes.** Inside a team sandbox all employees are the same Unix user, with the internet
  open, so a PA's brain (home data, spec §7) must never be copied into a sandbox anyone else works in. **Chosen: a PA
  always has a team, and so a sandbox, of its own, and the API makes it so rather than refusing.** Hiring a PA (role
  "Personal Assistant") makes a team `home-<id>` ("<Name>'s home") with only the PA, sized 2 CPUs and 4G (change it
  with `PUT /api/teams/home-<id>` like any team's); the web form sends no team for a PA. A hire or an edit that names
  a team with other people, or a PA left in a shared team by an older version, moves the PA to its own team (the one
  it is alone in, or `home-<id>`). Refused (400, `needs a sandbox of its own`): putting anyone else into a PA's team,
  or a PA and others in `PUT /api/teams/:id`; `DELETE /api/teams/:id` of a team holding a PA is 409. A PA that still
  shares a sandbox gets **no copy** (its prompts still get its own pages) and the daemon removes any copy of it there.
  A PA's own brain is part of a session only for errands and orientation and for conversations with no project; code
  work gets a second copy of the PA's brain without its personal folder (`~/brain/<id>.code/`), so the two never share
  a folder. A copy is removed from the machine an employee moved away from (also when they leave), but never by
  starting a stopped machine: the removal stays recorded and is done when the machine is up. Ordinary employees of one
  team still share a Unix user, so an agent could read a colleague's folder under `/home/employee/brain/` with its
  own tools; the daemon never puts one employee's brain in another's folder or prompt, and making it impossible needs
  a user per employee in the image (an owner decision, not done). The PA's sandbox's egress wall (spec §7) is
  T66, below.
- **What the sandbox image must have.** Nothing is installed by the daemon, so these must be in the image (the current
  one has them, checked by reading the Dockerfile, not on a live machine): `bash`, `git` 2.28 or later, GNU `tar`,
  coreutils (`base64 -d`, `comm`, `sort`, `cp`, `mv`, `rm`, `cut`, `wc`, `tr`, `mkdir`, `dirname`, `chmod`, `mktemp`,
  `cat`), `find`, `sed`, `awk`, `grep`, and for `brain search` Node 22.13+ whose `node:sqlite` has FTS5, as `node` on
  PATH. The apply script checks them first and, if one is missing, copies nothing and the log says so
  (`couldn't copy <employee>'s brain into <machine>: the sandbox has no comm, which copying the brain needs`); the
  session goes on, and its prompt says the copy isn't available. A Node without SQLite FTS5 only loses `brain search`
  (log: `no usable Node with SQLite FTS5`).
- **How big a brief gets.** The maps are cut to about 150 lines in all (closest scope first, the rest summarised with a
  pointer to `brain search`), and the pages to about 3,000 tokens. Measured with `I_INC_BENCH=1` (test
  `brain-bench.test.ts`): a brief on a brain of 1,000 pages is about 6.2 KB (about 1,550 tokens with the pages that
  matched) and at 10,000 pages about 6.3 KB, 149 map lines; a conversation sends each scope's map again only when that
  map changed.
- **Seeing it.** `GET /api/tickets/:id/sessions` has `brain` per session (the ticket page lists them under each
  stage); the conversation's `_meta["iinc.brain"]` feeds the context panel. A page put in a prompt or opened by the
  agent (a tool call whose file location is in its copy) counts toward `use_count` and `last_used_at`.

#### Deploy steps for the owner (T57)

No image change, no `pf` change and no host script. Merge, let the deployer switch the release, then:

1. **The first start rebuilds the search index once** (the index schema moved to version 2, which also shrinks
   `~/.i-inc/brain-index.db` to its real size). Nothing to do; it logs nothing unless it fails.
2. **Run the page migration (T56, #78) on the mini.** It rewrites existing pages to the V1 format in one commit per
   repo and has not been run there yet. It needs an explicit home; look first, then apply:

   ```sh
   cd ~/i-inc-releases/current
   bun apps/daemon/scripts/brain-migrate.ts --home "$HOME/.i-inc"                  # dry run: prints what would change
   bun apps/daemon/scripts/brain-migrate.ts --home "$HOME/.i-inc" --apply --yes    # writes it
   ```

   The daemon can stay up: it notices the new commits by itself, no restart. (`--apply` skips a repo with
   uncommitted changes and says so.)
3. **Check it worked.** `curl -s -H "Authorization: Bearer $(cat ~/.config/i-inc/web-token)" "http://127.0.0.1:7420/api/brain/map?scope=company"`
   shows the map. Start a conversation or a ticket, then
   `container machine run -u employee -n inc-<team> -- ls /home/employee/brain/<employee>` lists `company`, `personal`
   (and `team-<team>`), and the conversation's context panel lists "Brain pages used".
4. If a copy looks wrong, deleting `/home/employee/brain/<employee>` in the sandbox is safe: the next session sends the
   whole copy again. Agent edits in it are lost when you do that.

## Storage and cleanup

Everything i.inc writes that can grow has a bound, a setting for it, and a place to see it (T52,
contract C23 in [coord.md](coord.md)).

**What is kept, and for how long** (the numbers are settings; defaults shown):

| What | Where | Kept |
| --- | --- | --- |
| A ticket's worktree (with `node_modules`, build output), a reviewer's or verifier's copy of the branch, and the ticket's images in them | `/home/employee/work/inc-<ticket>` in each team machine that worked on it | 3 days after the ticket closes or fails (`sandboxCleanupDays`; 0 turns it off). A copy stays whenever git can't vouch for it: any git failure, no git, unpushed commits or uncommitted changes. Copies with unpushed or uncommitted work go only after `unpushedKeepDays` (default 30, and it must be more than `sandboxCleanupDays`; the API refuses a pair that breaks this). The owner approving a ticket only lets uncommitted noise go, and only after a fresh `git fetch` shows HEAD is already on a remote branch; it never releases unpushed commits. The branch stays on GitHub |
| Package caches | `~/.cache` rebuildable folders, `~/.npm/_cacache`, the pnpm store | Under 2 GB each (`cacheCapGb`); over it, they are emptied, or `pnpm store prune` runs |
| Docker leftovers in a machine | stopped containers (3 days), dangling images, build cache (7 days) | Pruned each cleanup (`dockerPrune`) |
| Session transcripts | `ticket_session_items` | Every ticket's while open; 30 days after close, each session keeps its last 50 items and one line saying what went (`transcriptCompactDays`, `transcriptKeepItems`). Always capped at 500 items of 4 KB per session and 50 sessions per ticket |
| Events, chat, push and knowledge bookkeeping | SQLite | Forever: the event log is the source of truth, and the dedupe keys must stay or old events would notify again. They are small, and reported |
| Images you upload | `ticket_attachments` | Forever. At most 6 per request, 10 MB each, 24 per ticket; reported, never deleted |
| The database file | `~/.i-inc/i-inc.db` | `VACUUM` when 20% of it is free pages (and 16 MB), only while no ticket is running (`vacuumFreePct`); the write-ahead log is truncated |
| Logs | `~/Library/Logs/i-inc-*.log` | Rotated at 20 MB: copied, truncated in place at once (launchd keeps the file open) and gzipped to `.1.gz`, 5 kept (`logMaxMb`, `logKeep`). A line written in the gap between copy and truncation is lost. If the log starts with NUL bytes afterwards, its writer doesn't append: the daemon logs a warning, and the fix is to have the daemon write its own log file with O_APPEND |
| Database backups | `~/.i-inc/i-inc.db.autobak-*` (the daemon makes none yet) | Deleted after 30 days, except the newest (`backupMaxAgeDays`). A backup made by hand (`i-inc.db.bak-*`) is never touched, nor anything else in that folder |
| Brains and handbook | `~/.i-inc/knowledge` | Kept; `git gc --auto` weekly |
| Releases, `deploys.jsonl` | `~/i-inc-releases`, `~/.i-inc/deploys.jsonl` (T54) | The deployer's: measured here, not changed |
| Container data | `~/Library/Application Support/com.apple.container` (68 GB on 2026-10-20) | Measured with `du`, never changed. Images and machine disk files live here; the disk file of a machine is sparse and only shrinks if the machine hands blocks back (`fstrim`, tried after each cleanup, best effort: confirm on the mini that the number drops) |

**How the cleanup runs.** The daemon cleans a team's machine when it is already up and nothing is
using it: no session, and no running ticket whose builder or helper works there. It does it just
before it would stop the machine, so a cleanup never wakes one, at most once an hour per machine.
It locks the machine first: a session, ticket or conversation turn that wants to start there waits
(up to 5 minutes, and the ticket says its sandbox is being cleaned up), and the use is checked once
more right before the delete step. Conversations (T59) must call `storage.untilFree(machine, ms)`
before they start in a machine. VACUUM waits for the same busy notion as `GET /api/health`.
One script goes in on stdin (`machine run -i … bash -s`) and touches only `inc-<id>` and
`inc-<id>.pre-checkout` folders of tickets the daemon says are over, never a symlink or a folder
whose real path differs, and the caches above. The host side (transcripts, VACUUM, logs, backups)
runs at most once an hour. Each run logs one `[storage]` line with what it freed by category.

**How to see it.** Setup, Sandboxes shows each machine's disk and last cleanup and a card for the
Mac mini. `GET /api/storage` has all of it: per machine the disk file on the host, the disk inside
(measured while up), and what was freed; the host's database, knowledge, logs, uploads and container
data; and the daemon's memory with the size of every long-lived map (they should read 0 when idle). A
push says when a machine's disk passes 80%.

**Cleaning now.** With a login (cookie or `Authorization: Bearer`):

```sh
# what it would do (the default)
curl -X POST -H 'content-type: application/json' -d '{}' $BASE/api/storage/cleanup
# do it
curl -X POST -H 'content-type: application/json' -d '{"dryRun":false}' $BASE/api/storage/cleanup
# change a setting
curl -X PUT -H 'content-type: application/json' -d '{"sandboxCleanupDays":7}' $BASE/api/storage/settings
```

A machine that isn't running is skipped, with the reason in the answer.

**Not done.** Container images and build cache on the host (`container image ls` and its prune) are
a manual step; the commands weren't confirmed on the mini. Conversations' working copies
(`conv-<id>`, T59) need adding to `cleanupScript` when they exist. Whether `git fetch` works inside a copy (it needs the sandbox's GitHub sign-in as a git credential) is unconfirmed on the mini; if it doesn't, a merged ticket's dirty copy waits for `unpushedKeepDays`. The tick reads every ticket's
events each 30 seconds, so its cost grows with the number of tickets (for T63).

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
  - They live on the mini and are never pushed. Sandboxes get a read-only-by-convention copy of what each employee may
    read (T57), never the other way yet.
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
