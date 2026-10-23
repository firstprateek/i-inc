# Architecture (since the 2026-10-17 redesign)

The web app's shared Page, Wide, and Split templates are described in [layout.md](layout.md).

The owner reviewed the design on 2026-10-17 and simplified it, so the company can run more on its
own and sign in to each subscription once. This page is the current picture. Where it differs from
[spec.md](spec.md), this page wins; the spec says so where it's affected.

## The pieces

**The owner** sets goals, teams and project settings, OKs changes to protected paths, cuts releases
(for now), and reads reports.

**The daemon** runs on the Mac mini, outside every sandbox:

- the scheduler and the ticket pipeline (`packages/core`);
- the registry: teams, employees, engines, accounts and projects;
- knowledge: the handbook, with a section per team, and each employee's brain, as git repos;
- the GitHub bot, "i.inc bot", which mints tokens and keeps each sandbox signed in to GitHub;
- the web app and API, on 127.0.0.1:7420, served over Tailscale.

**A team** is a group of employees, and its **sandbox**: one walled machine, `inc-<team>`, about
12G and 6 CPUs, where all its members work.

- Each subscription (Claude, Antigravity) is signed in once per sandbox, and every agent on the
  team uses that sign-in (`tools/host/sign-in-claude.sh`, `tools/host/sign-in-antigravity.sh`).
- Each ticket works in its own folder, `/home/employee/work/inc-<ticket>`, and gets its own range
  of 100 ports in `$I_INC_PORTS`.
- The daemon renews the sandbox's GitHub sign-in every 25 minutes, so sessions of any length can push.
- Employees with no team work in the company's sandbox, `inc-company`.

**A project** is a repo with a check recipe and a policy (`PUT /api/projects/:id`):

| Setting | Default | |
| --- | --- | --- |
| `mode` | `direct` | `direct`: reviewed work goes straight to main. `owner-merges`: a draft PR the owner merges |
| `protectedPaths` | `.github/`, Release Please's config | Changes there wait for the owner's OK |
| `followUpsPerDay` | 3 | Tickets agents may file for themselves |
| `autoRelease` | `false` | Whether merged tickets trigger an automatic project release |

## Access

The daemon runs locally on the mini at `127.0.0.1:7420`.

- **Tailscale Service:** served via Tailscale Service `svc:iinc` on standard HTTPS:
  `tailscale serve --bg --service=svc:iinc --https=443 http://127.0.0.1:7420`
  This publishes the service at `https://iinc.<tailnet>.ts.net` with an automatically managed TLS certificate, allowing phone and desktop browsers to connect without custom port numbers. (The earlier `:8443` serve configuration was removed.)
- **Host validation:** the daemon validates the `Host` header against `I_INC_HOSTS` (configured as `iinc.<tailnet>.ts.net`, plus local loopback addresses). Unrecognized host headers receive an HTTP 421 response, protecting against DNS rebinding.
- **SSH tunnel fallback:** an SSH tunnel remains available if Tailscale is down:
  `ssh -L 7420:127.0.0.1:7420 <mini>`, then open `http://127.0.0.1:7420`.

## Owner authentication

Access to the API and web app is restricted to the owner:

- **Initial state:** `GET /api/auth` returns `{ "initialized": boolean, "setupCodeRequired": boolean }`: whether an owner account exists, and whether the signup form must ask for the setup code.
- **First-run signup needs a one-time setup code.** A daemon with a token and no owner makes a random code, logs it and writes it to `~/.i-inc/setup-code` (mode 0600), so only someone who can read the machine's files or log can create the owner account (before this, the first visitor on the tailnet could). The code is deleted once the owner exists, is never logged (the log names the file), is limited to 5 wrong guesses per client per 10 minutes, and 20 wrong guesses in all refuse signup for an hour and replace it once (a client is the last `X-Forwarded-For` hop from the loopback proxy, else its socket address; identity headers are not part of the key), and the daemon token (`~/.config/i-inc/web-token`) works in its place. A loopback-only rule was rejected: `tailscale serve` proxies from loopback, so every tailnet visitor looks local, and the phone could not do the first run.
- **Signup:** `POST /api/signup` (`{ "username", "password", "setupCode" }`, password at least 8 characters) creates the owner account in SQLite (`owner_account` table) with `scrypt` hashing (`salt:hash`, 16-byte random salt, 64-byte key) and signs the browser in. Once initialized, subsequent signup attempts return 409.
- **Sessions:** an open AHP socket is bound to the session it came in on and is closed when that is signed out or expires. Every login makes a random session token (`web_sessions`: its sha-256, creation and expiry; 30 days, renewed by use). It is the `i_inc` cookie: `HttpOnly; SameSite=Strict; Path=/`, and `Secure` on every Host but loopback. An open AHP socket or `/api/events` stream closes with its session. Password and token logins are throttled per client (10 wrong in 10 minutes, then 429; 100 wrong in an hour from anyone refuse logins for 15 minutes). The daemon token is never given to a browser; bearer-token auth stays for scripts and the deployer.
- **Login:** `POST /api/login` accepts `{ "username", "password" }`, verifying the hash in constant time (`scryptSync` and `timingSafeEqual`). Token login (`{ "token" }` matching `~/.config/i-inc/web-token`) remains supported as a fallback, with a 1-second delay on failure. Both start a session.
- **Logout:** `POST /api/logout` revokes the session (a copied cookie stops working) and clears the cookie.
- **Browsers signed in before sessions** hold the daemon token as their cookie. It is still accepted and is swapped for a session cookie on the browser's next request.

## Engines and harnesses

The daemon connects to AI agents through the Agent Client Protocol (ACP) and local models:

- **Harnesses in sandboxes:**
  - `claude-code` (`acp-claude`): Claude subscription, signed in once per team sandbox via `tools/host/sign-in-claude.sh`.
  - `antigravity` (`acp-antigravity`): Google AI Pro subscription, signed in once per team sandbox via `tools/host/sign-in-antigravity.sh`. An OAuth callback relay endpoint (`POST /api/teams/:id/antigravity-callback`, contract C8) delivers the `http://127.0.0.1:<port>/?code=…` redirect into the sandbox using `AppleMachines.deliverCallback`.
  - `codex` (`acp-codex`): Codex CLI through the pinned maintained ACP adapter, using a team sandbox subscription sign-in. Engines, model selection, duty assignments and fallbacks use the same pipeline as the other cloud harnesses. See [Codex setup](codex.md) for new/existing-machine provisioning and owner sign-in. Cloud engines cannot process home data.
  - `opencode` (`acp-opencode`): OpenCode harness running local open models (e.g. `qwen3:8b`, registered with `local: true`) routed through the container gateway to the host's Ollama relay port (`11434`).
- **Local Ollama helper and chat (`apps/daemon/src/ollama.ts`):**
  - `OllamaHelper`: runs fast local classification (intent detection for `ask`, `note`, `question`) and yes/no evaluations directly against Ollama without launching a sandbox.
  - `OllamaChat`: powers interactive 1:1 chat between the owner and employees on local Ollama (`qwen3:8b`, `think: false`), maintaining the employee's role, current ticket context, and recent notes.

## Account caps and rate limits

- **Monthly spending caps:** `PUT /api/accounts/:id` accepts an optional `monthlyCap`. Account costs and caps are listed in `GET /api/accounts`.
- **Live rate-limit meters:** live Claude utilization metrics (`fiveHourUtilization`, `sevenDayUtilization`, `resetsAt`, `status`, `updatedAt`) are polled and exposed in `GET /api/accounts` and `GET /api/office` (contract C7), rendered visually as utilization meters in `<inc-office>`.

## Sandboxes and isolation

- **Inspection (`GET /api/sandboxes`, contract C1):** reports team sandbox state (`running`, `stopped`, `missing`, `error`), CPU and memory specs, and sign-in status (`claude`, `antigravity`, `codex`, `github`).
- **No boot on read:** inspecting sandboxes parses `container machine ls` output and never starts or boots a stopped VM merely to report status. Credential files are only probed if the machine is already running; otherwise cached or default states are returned.
- **Sandbox DNS filter (`apps/daemon/src/dns.ts`):** a custom DNS filter on the sandbox network gateway intercepts DNS queries. It refuses any lookup for `.ts.net` or `.local` domains (returning `REFUSED`, RCODE=5), ensuring tailnet machine names and local hostnames cannot be resolved or leaked from inside sandboxes.
- **The walls (`pf`):** outbound internet is permitted, but connections to the local LAN, the tailnet subnet, and the host (except the gateway API and Ollama relay ports) are blocked. Machines run only while the walls job confirms firewall state every minute (`/var/run/i-inc-walls.ok`). The walls are closed unless opened: only machines in the pf table `<open_machines>` (which `tools/host/walls.sh` fills from the list the daemon writes, `apps/daemon/src/egress-wall.ts`) get the internet and DNS, so a personal assistant's sandbox gets only Ollama (through an allowlisting proxy), and the daemon runs nothing in any machine until its live address is where the walls' acknowledgement (`/var/run/i-inc-walls.open`) says it should be.

## Releases

- **Policy:** projects configure release behavior via `PUT /api/projects/:id` with `autoRelease: boolean` (contract C9).
- **Status:** `GET /api/releases` returns all recorded `ProjectRelease` objects and `pending` merged tickets awaiting release.
- **Manual release:** `POST /api/projects/:id/release` `{ "tag"?: string }` cuts a release for all unreleased merged tickets on a project (HTTP 201).
- **Desk integration:** `<inc-desk>` displays recent releases and pending unreleased tickets. Automatic release cuts can be enabled per project once workflows are proven.

## Web Push notifications

- **Backend (`apps/daemon/src/push.ts`, contract C2):** sends push notifications to subscribed browsers using RFC 8291 (aes128gcm) payload encryption and RFC 8292 VAPID headers.
- **Key management:** VAPID keys are stored at `~/.config/i-inc/vapid.json` (mode 0600) and exposed via `GET /api/push/key`. In-memory keys are generated when no config directory is provided (e.g. tests).
- **Subscriptions:** managed via `POST /api/push/subscribe` and `POST /api/push/unsubscribe`.
- **Triggers:** notifications are sent for three critical events:
  - `needs-you`: when a ticket reaches a gate requiring owner intervention (e.g. protected paths or policy decision);
  - `report-ready`: when a ticket completes and its report is published;
  - `main-red`: when CI on main fails after a direct merge.
- **Deduplication and reliability:** sent notification keys (`push:<ticketId>:<eventIndex>`) are recorded atomically in the SQLite `push_sent` table before transmission to prevent duplicates. A baseline on startup prevents re-notifying historical events, and requests timeout after 5 seconds to avoid blocking the daemon tick loop.

## Live updates and transcripts

- **Live SSE updates (`GET /api/events`, contract C3):**
  - Server-Sent Events stream delivering real-time invalidation notifications: `event: ticket` with `{ "id": "<ticket id>" }` on ticket updates, and `event: office` with `{}` on employee or team changes.
  - Streams send an initial `: connected` comment immediately on connection, emit keepalive comments (`: keepalive`) every 25 seconds, specify `x-accel-buffering: no`, and buffer events using a `ReadableStream` with `highWaterMark: 64`, closing the stream if the queue remains sustained full (`desiredSize <= 0`) to drop stalled clients cleanly.
- **Session transcripts (`GET /api/tickets/:id/sessions`, contract C4, in review):**
  - Records ACP session turns (messages, tool names, and tool statuses) structured per ticket stage.
  - Automatically redacts sensitive patterns (such as authorization headers and tokens) before persisting to SQLite, enforcing item size limits (4 KB) and session caps.

## The web app

The frontend is an installable, mobile-responsive single-page app built with Lit components (`apps/web`):

- **Mobile pass:** every view is optimized for mobile (390x844) and desktop (1440x900) screens, supporting both light and dark themes with comfortable touch targets, responsive tables, and adapted navigation.
- **Installable PWA:** includes a web app manifest, application icons, and a service worker implementing an offline shell and handling Web Push notifications.
- **First load (T63):** the entry chunk is the shell, the router and Lit (about 90 KB, 24 KB brotli). Each screen group is its own chunk, loaded when its route first opens (`components/views.ts` maps a route to the code it needs, and the shell shows "Loading" in the frame until it arrives); the AHP client loads behind the first Needs you count. Fonts are self-hosted woff2 in `src/fonts` (`font-display: swap`; no third-party request). `vite build` writes `.br` and `.gz` beside every text file, and `precompressed.json` with the hash of each source and copy (the daemon uses a copy only when both still match, so a restored or copied file is never trusted by its date; without the manifest it compresses itself); it never serves a file that is a link; the daemon (`apps/daemon/src/web-static.ts`) sends the best one the browser accepts, `Cache-Control: immutable` for the hashed files under `/assets`, `no-cache` plus an ETag for `index.html`, `sw.js` and the rest, and a 404 for a missing `/assets` file. Every file carries `X-Content-Type-Options: nosniff`; the document also gets a Content-Security-Policy (own origin for script, worker, font and manifest; inline styles; `data:` and `blob:` images; `connect-src` this host including its `ws:`/`wss:` for AHP; no framing, no plugins), `Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`.
- **Setup screens (`<inc-setup>`):** centralized management for Teams, Projects (mode, protected paths, follow-up budgets, check recipes, auto-release), Engines and Accounts (displaying the "local" badge for Ollama), and sandbox sign-in statuses.
- **Per-duty engines:** employee hiring and editing allows configuring distinct engines per duty (`build`, `review`, `verify`) in addition to default and fallback engines (`EmployeeEngines.perDuty`).
- **Board on the phone (`<inc-board>`):** provides a quick ticket filing form, badges identifying agent-filed follow-up tickets, protected paths warning cards, and a digest of recent reports.

## A ticket, in direct mode

1. **Pick up:** a fresh branch from main in the team's sandbox, kept local.
2. **Plan** (Medium and High effort): no gate; nothing waits for the owner.
3. **Build.**
4. **Checks:** the project's recipe, with up to 5 fix attempts before an engine switch.
5. **Prove** (Medium and High): a verifier checks each done-when item.
6. **Review:** with fresh eyes, seeing only the ticket and the diff. The reviewer is another employee
   with the review duty if there is one; otherwise the builder's seat on a different engine, so a
   different AI reviews; otherwise a fresh session. At most 2 rounds, then the work goes on, with
   any open disagreement in the report.
7. **Gates:** if the change touches protected paths, it waits for the owner's OK. Then rebase on
   main, the checks again, and a push to main. If main moved meanwhile, rebase and try again.
8. **CI on main:** if it fails, the same ticket becomes the fix, first in line. If main is still red
   2 hours after the push, the push is reverted and the ticket fails honestly.
9. **Report:** to the board, with up to 3 follow-up tickets the builder noticed. The ticket closes
   without waiting for the owner.
10. **Retro:** lessons go to the brains and the handbook.

GitHub refuses the bot any change to `.github/workflows`, which keeps the repo's secrets (Duet's
release signing key) out of agents' reach. So a reviewed workflow change waits for the owner, who
pushes it with `tools/host/push-for-owner.sh` and then OKs the ticket.

## Knowledge

- **The handbook:** the company's shared knowledge, with a section per team for its conventions.
- **Each employee's brain:** what it learned itself.

Both live on the mini, outside the sandboxes, as markdown git repos. Every page has frontmatter; a
disposable SQLite FTS5 index (`<home>/brain-index.db`, rebuilt from git, healing by itself when a
repo changes behind the daemon's back) and a map per scope serve search and retrieval (contract C19).

**They reach agents by copy, never by serving** (the sandboxes cannot reach the mini). Before a
session the daemon (`brain-feed.ts`) puts the employee's readable scopes in its sandbox at
`/home/employee/brain/<employee>/`: the handbook, its team's section and its own brain, each with an
`INDEX.md`, plus a `brain` search command that needs only the image's Node. The copy goes over
`machine run -i` as one script carrying a tar stream, only what changed since the last copy, into a
git repository whose baseline commit is the snapshot (so T58 can harvest an agent's edits as a diff;
a refresh keeps those edits). Never another employee's brain, another team's section or a PA's home
data. The same daemon code then builds the query from the task, ranks pages (BM25 with a boost for the
closest scope, one link away from the best two, about 3,000 tokens), and appends the maps and the
matching pages to every ticket stage's brief and to every conversation turn, marking pages built
from untrusted content. Which pages were used per stage and per turn is recorded and shown on the
ticket page and in the Conversations context panel. The design is in [design/brain.md](design/brain.md).
Timings for the index (1,000-page rebuild, query latency, hostile input, 10,000-page maps) are an
opt-in benchmark, `pnpm bench`, and a 1,000-page copy and retrieval run prints its timings with
`I_INC_BENCH=1` (`test/brain-bench.test.ts`); neither is part of the default assertions.

## Safety that stays

- **The walls** around every sandbox: the internet, but not the home network, the tailnet or the
  mini. Nothing runs in a sandbox unless the walls job confirmed them in the last two minutes, and
  machines stop when they drop.
- **The bot** is its own GitHub identity, never the owner's, with no settings, workflow or secret
  powers.
- **Honest reports**, and a daily budget on agents' own tickets, so a loop can't spend the week's
  quota.

What a shared sandbox gives up: agents on a team can see and change each other's folders. A
prompt-injected agent could interfere with a teammate's work, but not reach past the walls.

## The host

- `inc.i.walls` (root): the walls, every minute; `inc.i.restart` (root): a restart on the 1st of
  each month, for a macOS bug that stops finished connections expiring after ~49.7 days of uptime.
- `inc.i.container`, `inc.i.daemon` and `inc.i.ollama-relay`: Apple's container service, the
  daemon and the Ollama relay, at login.
- `inc.i.deployer`: the automatic deployer (`apps/deployer`, installed by `tools/host/install-deployer.sh`).
  It is separate from the daemon and runs from the owner's checkout (`~/i-inc`), so a broken daemon
  cannot stop its own repair. The daemon runs from `~/i-inc-releases/current`, a link to one of the last
  5 release folders (`~/i-inc-releases/<sha>`: a clone at that commit, with `node_modules` and the web
  build). Every 2 minutes the deployer takes a commit on `main` whose CI concluded `success` (GitHub's
  public API, no credentials), builds it, smoke-tests it on a spare port in demo mode, waits for the
  daemon's `GET /api/health` to say `busy: false`, repoints `current`, kickstarts `inc.i.daemon`, and
  waits for `/api/health` to report the new sha; on any failure it switches back and never retries that
  commit. Each attempt is a line in `~/.i-inc/deploys.jsonl` (C21), which the daemon serves at
  `GET /api/deploys` and turns into a push when a deploy fails. Its state (bad commits, a deploy in
  flight) is `~/i-inc-releases/state.json`; the single-instance lock is `~/i-inc-releases/deployer.lock`.
  How to see, pause, force and roll back: [handoff.md](handoff.md#deploying-to-the-mini).
