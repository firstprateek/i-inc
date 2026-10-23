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
- the GitHub bot, "i.inc bot": the daemon alone holds its write token and makes every push, open PR and
  CI read, and it keeps each sandbox signed in to GitHub with a **read-only**, repo-scoped token (below);
- the AHP host behind Conversations, and the brain's index, feed and harvest;
- the web app and API, on 127.0.0.1:7420, served over Tailscale.

The **deployer** is a separate LaunchAgent (see "The host") that puts `main` on the mini.

**A team** is a group of employees, and its **sandbox**: one walled machine, `inc-<team>`, about
12G and 6 CPUs, where all its members work.

- Each subscription (Claude, Antigravity, Codex) is signed in once per sandbox, and every agent on the
  team uses that sign-in (`tools/host/sign-in-claude.sh`, `sign-in-antigravity.sh`, `sign-in-codex.sh`).
- **The team is the trust boundary (T67, decided).** One sandbox and one Unix user per team, and agents
  have root. Per-employee Unix users were decided against: root reads every user's files, so they would
  isolate nothing unless root went, which breaks normal work, and a machine per employee would reverse the
  sandbox-per-team decision. Agents on a team trust each other. A **personal assistant** is the exception:
  hiring one makes a team `home-<id>` with only the PA, a sandbox with no root and no internet (only DHCP
  and the Ollama relay, behind pf walls that are closed unless opened, T66). **Machines cannot reach
  each other** (T70, #114): the bridge's filter flags make pf run on each member interface, so traffic between
  two sandboxes is dropped. This was verified on the mini on 2026-10-22: TCP and ping are blocked both ways,
  open machines keep the internet, DNS, Ollama and DHCP, and a 100 MB download completes. Not covered: a machine
  with raw-socket root forging frames; a PA's sandbox has no root.
- Each ticket works in its own folder, `/home/employee/work/inc-<ticket>`, and gets its own range
  of 100 ports in `$I_INC_PORTS`.
- The daemon renews the sandbox's read-only GitHub sign-in every 25 minutes. A sandbox cannot push at all
  (below).
- Employees with no team work in the company's sandbox, `inc-company`.

**A project** is a repo with a check recipe and a policy (`PUT /api/projects/:id`):

| Setting | Default | |
| --- | --- | --- |
| `mode` | `direct` | `direct`: reviewed work goes straight to main (pushed by the daemon). `owner-merges`: a draft PR the owner merges on GitHub; the ticket shows "Merge on GitHub" and "Close without merging", and closes by itself when the daemon sees the PR merged (it looks about every 5 minutes) |
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
- **The walls (`pf`):** an engineers' sandbox has the internet, but connections to the local LAN, the tailnet subnet, and the host (except the gateway API and Ollama relay ports) are blocked. Machines run only while the walls job confirms firewall state every minute (`/var/run/i-inc-walls.ok`, at most two minutes old). The walls are closed unless opened (T66): only machines in the pf table `<open_machines>` (which `tools/host/walls.sh` fills from the list the daemon writes, `apps/daemon/src/egress-wall.ts`) get the internet and DNS, so a personal assistant's sandbox gets only DHCP and the Ollama relay (an allowlisting HTTP proxy), and the daemon runs nothing in any machine until its live address is where the walls' acknowledgement (`/var/run/i-inc-walls.open`) says it should be. A PA's sandbox also has no root (the daemon removes its sudo before every launch). **One machine cannot reach another** on the bridge (T70, verified on the mini).
- **No write credentials in sandboxes (T68).** Agents run with bypassed permissions and can be prompt-injected, and the bot may push to `main` in direct mode, which the deployer puts on the host. So a sandbox holds only a **read-only token** (contents, pull requests, checks, metadata) limited to the repos its sessions work on (none if a session needs none); an agent's own `git push` is refused by GitHub. **Every push happens on the host** (`apps/daemon/src/host-push.ts`): the sandbox packs exactly the commit the pipeline checked into a git bundle (`bundle.ts`), and the daemon verifies it (one head, the tip is the expected sha, objects checked), unpacks it into a bare mirror (`~/.i-inc/push-mirrors`), scans the commits for credentials, holds protected paths itself, and pushes that sha with the write token, which exists only in the daemon's memory (an empty HOME, no hooks, no system or global git config). The default branch is never force-pushed. Bundles are capped at 10 MB.
- **Direct mode is advisory against a poisoned agent.** The checks and the review run in the builder's own sandbox, so a poisoned builder can fake them. For the repo the mini runs (i-inc), any change to host-executed code (everything but `docs/**/*.md` and top-level `*.md`, never agent instruction files) therefore waits for the owner's one-tap OK, **bound to the exact sha and the `git patch-id` of the diff on the card**; anything else keeps full direct mode. The daemon records each push of the default branch in a ledger (`~/.i-inc/pushed-main.jsonl`, with `ownerApproved`), and **the deployer deploys only ledgered, owner-approved commits, commits of a PR the owner merged, or docs-only commits** (`apps/deployer/src/review.ts`). Any other commit is skipped (never marked bad, nothing rolled back), recorded as `skipped-review`, and the owner is alerted by push.

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
- **The board in pages (T63):** the web app never fetches every ticket. `GET /api/board/summary` opens the board: each column's first cards (40; Done is newest first, 15) and its total, plus the report of each Done card (`reports`, so no request per card). `GET /api/board/column?column=&offset=&limit=` is "Show more"; `GET /api/board/cards?ids=` answers a live `ticket` event with just those cards (the board updates them in place, and asks for the summary again only for an old ticket it never loaded); `GET /api/board/recent` ranks who to offer for a ticket. `GET /api/needs-you` is the badge and the Needs you page in one answer (`count`, the tickets that wait, policy changes, proposals, conversations); the shell and the page share one request per refresh. A hidden tab skips event refetches and catches up when shown. `GET /api/board` (every ticket) remains for scripts. With 1,000 tickets, opening the board went from 24 requests / 2.4 MB to 6 / 53 KB, and one ticket event from 17 requests / 1.2 MB to 2 / 6 KB.
- **Session transcripts (`GET /api/tickets/:id/sessions`, contract C4):**
  - Records ACP session turns (messages, tool names, and tool statuses) structured per ticket stage.
  - Automatically redacts sensitive patterns (such as authorization headers and tokens) before persisting to SQLite, enforcing item size limits (4 KB) and session caps.
  - **Open the session (T69):** each stage's session is also a read-only AHP chat (`ahp-session:/ticket:<id>`), so it can be watched live or replayed in the Conversations thread view (`#/ticket/<id>/session/<id>`).

## Conversations

Conversations run on the **AHP host** in the daemon (`apps/daemon/src/ahp/`, the official `@microsoft/agent-host-protocol` 1.0.0 types and reducers; the host, ACP mapper and SQLite action store are ours). A conversation is a long-lived agent session with one employee, in that employee's team sandbox, on its own working copy (`conv-<id>`, branch `conv/<id>`). The web app is an AHP client over the `/ahp` WebSocket, behind the same login as the REST API. The mode picker lists the agent's own modes and **defaults to its bypass mode**; permission requests show as cards, the first answer from any device wins, and a push reaches the phone when nobody is watching. At most three conversations are live per team. "Make this a ticket" and "Open a PR" hand a conversation's work to the pipeline or to a draft PR (through the host-side push). Ticket stages can be watched or replayed with "Open the session" (T69). Agents cannot ask the owner questions in the middle of a conversation (no adapter supports it; a question arrives as text in the reply). Design: [design/conversations.md](design/conversations.md).

## Reliability (T63)

The audit's fixes ([audit/T63-report.md](audit/T63-report.md)), in one place:
- **Bad data does not stop the tick.** Agent replies are schema-checked before they are stored (`packages/core/src/validate.ts`); a stage whose reply cannot be read fails with "could not be read". The state fold skips an event it cannot read; an unreadable database row is quarantined (`event_quarantine`) and listed on the board as `unreadable`; each ticket is processed in its own try, and `tick()` never rejects. A ticket whose run keeps throwing backs off (30 s, doubling to 10 min) and fails after five errors in a row. Deleting an engine an employee uses is refused (409).
- **Children cannot kill or hang the daemon.** Every child's stdin has an error guard, process-level handlers log instead of exiting, and every wait has a limit: scripts 10 min, checks 30 min, `container` commands 5 min, agent start 2 min, and 30 min of agent silence (all settable, `GET`/`PUT /api/timeouts`). A timeout kills the process group and counts as stuck, so switch rules run and the deployer's drain can finish.
- **Restart and recovery.** A graceful stop (SIGTERM, a deploy) leaves in-flight tickets resumable: `AcpAgent.run` throws `ShuttingDown`, nothing is recorded, and the next start continues them. A push that landed but whose record was lost is recognised on replay (a `push-intended` event, checked against the host's mirror). Retry and any answer on a stuck card reset the failure counters. Machine boot and stop are serialised per machine. Running sandboxes are adopted at startup so they are stopped when idle.
- **Backups and disk.** A daily `VACUUM INTO ~/.i-inc/i-inc.db.autobak-<date>` when idle (30 days kept, the newest always), `PRAGMA quick_check` at startup (a failure is pushed and logged; the daemon keeps serving), and a low-disk gate: under 5 GB free (`minFreeGb`) no new ticket or conversation turn starts, and the ticket says why.
- **The container service heals itself (T73).** A machine that will not boot with `hostname(s) already exist` (it recurs after machine stops) makes the daemon wait until every machine is idle, restart the container service once (at most one per 30 minutes), wait for the walls job to confirm the rules, and retry the boots; otherwise the owner gets a Needs you card and a push. The PA's root removal can be repeated safely on every boot. A conversation boots a stopped sandbox first, home or team (T74). See handoff.md, "Sandbox won't boot".
- **Done-when is checked (T71).** Orientation and tidy tickets close only when their done-when is met, judged against the collected brain copy (one retry with feedback, then Needs you), and an errand is done when it proposes something or says why nothing is needed. **Not yet (T72, in progress):** a low-effort code ticket has no `prove` stage, and a medium or high ticket skips `prove` when nobody on the team has the verify duty, so both can close without their done-when being verified.
- **A PA works offline (T71, T74).** A PA's brief and every turn carry a short note on its machine (no internet, no sudo, no installs, the tools it has), its brain section is cut for its small window, and its model is `qwen3-8b-32k` (`qwen3:8b` with the 32k window set on the model). Its brief gives examples it can copy as they are, and the harvest drops junk frontmatter keys. `apps/daemon/scripts/converse.ts` is the smoke tool (handoff.md, "Checking a PA works").
- **Retries.** An upstream GitHub 5xx, a rate limit or a network blip is retried (with `retryAfter`) instead of failing the ticket; `waitForCi` no longer treats a failed rules lookup as "no required checks".
- **Sign-in.** A first-run signup needs a one-time setup code; every login is a revocable server-side session; failed logins and setup guesses are limited (see "Owner authentication").
- **Speed.** The tick folds only tickets that changed (a state cache), the knowledge lookup is indexed (it was quadratic), event text is capped at 16 KB, and the web app's first load, board and Needs you page are being paged and compressed (PRs #107 and #109, in review; see the audit report).

## The web app

The frontend is an installable, mobile-responsive single-page app built with Lit components (`apps/web`):

- **Three areas and a page of its own (T61, T64):** **Conversations**, **Work** (Board, Releases) and **Company** (Team, Brain, Projects, Usage, Settings); **Needs you** is its own top-level page (`#/needs-you`), not a tab. The laptop opens on Conversations and the phone on Needs you. Routes and templates are in [layout.md](layout.md).
- **Mobile pass:** every view is optimized for mobile (390x844) and desktop (1440x900) screens, supporting both light and dark themes with comfortable touch targets, responsive tables, and adapted navigation.
- **Installable PWA:** includes a web app manifest, application icons, and a service worker implementing an offline shell and handling Web Push notifications.
- **First load (T63):** the entry chunk is the shell, the router and Lit (about 90 KB, 24 KB brotli). Each screen group is its own chunk, loaded when its route first opens (`components/views.ts` maps a route to the code it needs, and the shell shows "Loading" in the frame until it arrives); the AHP client loads behind the first Needs you count. Fonts are self-hosted woff2 in `src/fonts` (`font-display: swap`; no third-party request). `vite build` writes `.br` and `.gz` beside every text file, and `precompressed.json` with the hash of each source and copy (the daemon uses a copy only when both still match, so a restored or copied file is never trusted by its date; without the manifest it compresses itself); it never serves a file that is a link; the daemon (`apps/daemon/src/web-static.ts`) sends the best one the browser accepts, `Cache-Control: immutable` for the hashed files under `/assets`, `no-cache` plus an ETag for `index.html`, `sw.js` and the rest, and a 404 for a missing `/assets` file. Every file carries `X-Content-Type-Options: nosniff`; the document also gets a Content-Security-Policy (own origin for script, worker, font and manifest; inline styles; `data:` and `blob:` images; `connect-src` this host including its `ws:`/`wss:` for AHP; no framing, no plugins), `Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`.
- **Settings (Company → Settings):** Teams (create, resize, people), Engines and accounts (the "local" badge for Ollama; adding never replaces an existing one, contract C24), Sandboxes (state, sign-ins, disk, retry) and Notifications. Projects (mode, protected paths, follow-up budgets, check recipes, auto-release) are under Company → Projects, which also adds a repo or starts a new one.
- **Per-duty engines:** employee hiring and editing allows configuring distinct engines per duty (`build`, `review`, `verify`) in addition to default and fallback engines (`EmployeeEngines.perDuty`).
- **Board (`<inc-board>`):** the kanban is first under the Work header; **New ticket** is a header action opening a dialog (a bottom sheet on a phone); agent-filed follow-ups are badged, and a finished ticket's report is on its Done card. Follow-up proposals, protected-path cards and policy changes are Needs you cards.
- **A failed request never takes a view away (T63):** the view stays mounted with its data and anything typed into it, and the shell shows a "Can't reach i.inc" or "Couldn't refresh" notice with a retry.

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
7. **Gates:** if the change touches protected paths (in the repo the mini runs, any host-executed code), it waits for the owner's OK, bound to the exact commit and diff. Then rebase on
   main, the checks again, and a push to main made **by the daemon on the host** from a verified bundle of exactly the checked sha. If main moved meanwhile, rebase and try again.
8. **CI on main:** if it fails, the same ticket becomes the fix, first in line. If main is still red
   2 hours after the push, the push is reverted and the ticket fails honestly.
9. **Report:** to the board, with up to 3 follow-up tickets the builder noticed (more wait under
   Needs you as proposals). The ticket closes without waiting for the owner. (In `owner-merges` mode
   it waits for the PR to be merged on GitHub instead, and closes by itself when it is.)
10. **Retro:** lessons go to the brains and the handbook (the agent's edits to its brain copy are harvested with no approval; every change is in Company → Brain → Changes with a revert).

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
ticket page and in the Conversations context panel.

**Writing back (T58) needs no approval.** The agent edits its copy like a person editing a wiki. When a
ticket ends, a conversation goes idle or ends, or the owner says "remember this", the daemon collects the
diff (`brain-harvest.ts`), checks it (allowed scopes, size limits, credentials redacted, no duplicate
pages, no home data in shared scopes) and commits it, with the ticket or conversation as provenance.
Every change is in Company → Brain → Changes with a one-click revert; a change to a company policy page
also sends the owner a push. A daily "Tend the brain" ticket (the librarian duty) merges duplicates and
prunes. Because a team shares one Unix user, a harvest is marked **untrusted** when another employee of
the same team had a session overlapping the copy (as it is for edits made after reading web pages or
issues); nothing is blocked, and revert is the remedy. The design is in [design/brain.md](design/brain.md).
Timings for the index (1,000-page rebuild, query latency, hostile input, 10,000-page maps) are an
opt-in benchmark, `pnpm bench`, and a 1,000-page copy and retrieval run prints its timings with
`I_INC_BENCH=1` (`test/brain-bench.test.ts`); neither is part of the default assertions.

## Safety that stays

- **The walls** around every sandbox: the internet, but not the home network, the tailnet or the
  mini. Nothing runs in a sandbox unless the walls job confirmed them in the last two minutes, and
  machines stop when they drop.
- **The bot** is its own GitHub identity, never the owner's, with no settings, workflow or secret
  powers, and its write token never enters a sandbox: every push is the daemon's, from a verified
  bundle at exactly the checked sha (T68).
- **The host runs only reviewed code.** The deployer deploys only ledgered, owner-approved commits,
  commits of a PR the owner merged, or docs-only commits; anything else is skipped and the owner is
  alerted (T54 and T68).
- **Honest reports**, and a daily budget on agents' own tickets, so a loop can't spend the week's
  quota.

What a shared sandbox gives up: the team is the trust boundary (one sandbox, one Unix user, agents
with root; T67). Agents on a team can see and change each other's folders and brain copies, so a
prompt-injected agent could interfere with a teammate's work, but not reach past the walls or push
code around review. In direct mode the checks and review run in the builder's own sandbox, so against
a poisoned agent they are advisory; that is why host-executed code in the repo the mini runs needs the
owner's OK. A PA is not in a shared sandbox, and one machine cannot reach another on the bridge (T70,
verified on the mini on 2026-10-22).

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
  public API, no credentials) **and that passes the guard** (every commit since the running release is
  ledgered with the owner's approval, is in a PR the owner merged, or is docs-only; otherwise it is
  skipped, recorded as `skipped-review`, and the owner gets a push), builds it, smoke-tests it on a spare port in demo mode, waits for the
  daemon's `GET /api/health` to say `busy: false`, repoints `current`, kickstarts `inc.i.daemon`, and
  waits for `/api/health` to report the new sha; on any failure it switches back and never retries that
  commit. Each attempt is a line in `~/.i-inc/deploys.jsonl` (C21), which the daemon serves at
  `GET /api/deploys` and turns into a push when a deploy fails. Its state (bad commits, a deploy in
  flight) is `~/i-inc-releases/state.json`; the single-instance lock is `~/i-inc-releases/deployer.lock`.
  How to see, pause, force and roll back: [handoff.md](handoff.md#deploying-to-the-mini).
