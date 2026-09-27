# M1 findings

Started 2026-09-27. The mini (`<mini>` below) runs macOS 26.2 (25C56). Apple container 1.4.1,
installed 2026-09-27 (step 2).

M1 is run from a Claude Code session on the owner's Mac, over SSH to the mini, rather than from a
session on the mini itself. Read-only steps run as `ssh <mini> 'bash -s' < script`. Steps that need
`sudo`, or a sign-in, run in a terminal with `ssh -t`, so the owner types the password or does the
login.

| Question | Answer | Evidence |
| --- | --- | --- |
| ACP stdio works through the machine boundary | Yes, for Claude Code (adapter), Antigravity (its ACP server) and OpenCode, each with tool calls in bypass mode | step 5 |
| Sign-in works inside the machine (each harness) | Yes for Claude Code and Antigravity: a link, then a code pasted back. OpenCode needs none. Gemini CLI no longer serves Google AI Pro | step 4 |
| `rate_limit_event` passes through the Claude adapter | Yes, as `usage_update._meta["_claude/rateLimit"]`, with status, reset times and use of both windows. Antigravity reports nothing | step 5 |
| `pf` walls hold (internet ok; LAN, tailnet, host blocked; Ollama ok) | Yes: 13 of 13 checks, nothing gets in, and connections are logged | step 3 |
| Ollama reachable from a machine | Yes, through a relay on the machines' gateway. Ollama itself stays on loopback | step 3 |
| Docker inside a machine | pending (step 7) | |
| Resume on another engine from a brief | Yes. Claude planned, then Gemini through Antigravity built from the brief alone, to draft PR firstprateek/duet#7, and CI passed | step 6 |
| Machine memory idle / busy, and K for this host | Idle: 0.56 GB on the host. Busy and K: pending (step 7). Before any machine, the host uses 11.7 GB of 32 GB with no model loaded (17.4 GB until DisplayLink was stopped) | steps 1 and 2 |
| Host power idle / busy (W) | pending (step 7) | |

## 1. Host check (read only)

Ran [`tools/m1/host-check.sh`](../tools/m1/host-check.sh) on the mini on 2026-09-27, then listed
its largest processes with `ps`. Nothing was changed.

**The host matches §12:**

| | §12 says | Found |
| --- | --- | --- |
| macOS | 26.2 | 26.2 (25C56) |
| Chip and cores | 10 cores | Apple M4 (Mac16,10): 10 cores, 4 performance and 6 efficiency |
| Memory | 32 GB | 32 GB |
| Free disk | about 309 GB | 330 GB (307 GiB) free of 494 GB |
| Hypervisor | — | available |

**Memory in use before any machine exists: 17.4 GB of 32 GB.** That's with no Ollama model loaded,
normal memory pressure and no swap: 15.6 GB of app memory, 1.7 GB wired. Most of it is
software the headless mini doesn't need:

- a USB display driver's helper (DisplayLink's `CrashRestartHelper`) holds 5.6 GB after 55 days of
  uptime, which looks like a leak;
- photo and media analysis take about 1.5 GB;
- Tailscale takes 0.65 GB.

This matters for K. §12 expects about 3 machines awake at 6 GB each, next to Ollama's 6–10 GB.
With 17.4 GB already in use, 32 − 17.4 − (6 to 10) leaves 5–9 GB for machines, which is one
machine at 6 GB. Freeing the display driver's 5.6 GB would make it two. That's unless an idle
machine uses much less than its limit, since memory is used on demand. Step 2 measures that.

**Ollama:**

- It's the Homebrew formula, version 0.30.4-rc1, run as the LaunchAgent `homebrew.mxcl.ollama`, and
  it's running.
- Its environment sets `OLLAMA_FLASH_ATTENTION` and `OLLAMA_KV_CACHE_TYPE`. `OLLAMA_HOST` isn't set,
  so **it listens on loopback only (port 11434), and a machine can't reach it as things stand.**
  Step 3 has to choose how machines reach it. Changing where Ollama listens changes the host's
  walls, so it needs the owner's approval.
- Pulled: `qwen2.5-coder:14b` (9.0 GB), `gemma4:12b` (7.6 GB), `gemma4:e2b` (7.2 GB), `qwen3:8b`
  (5.2 GB), `qwen2.5:7b-instruct` (4.7 GB) and `nomic-embed-text` (274 MB).
- No model was loaded during the check, so §12's "6–10 GB while a model is loaded" is still to be
  measured (step 7).

**Colima and Docker are installed and stopped**, as §12 says:

- Colima 0.10.3: profile `default` (2 CPUs, 2 GiB, Docker runtime) is stopped.
- Docker CLI 29.5.3: the engine isn't reachable.
- No Colima, Lima, QEMU or Docker processes are running, and no Virtualization.framework VMs.

**Apple container isn't installed**, as §12 says.

**For step 3: what the walls must block.** These listen on all interfaces, not just loopback:

- TCP 22 (Remote Login);
- TCP 443 and two high ports (Tailscale, including `tailscale serve`);
- TCP 5000 and 7000 (AirPlay receiver);
- TCP high ports for `rapportd` and `symptomsd`;
- UDP 137–138 (NetBIOS), 3722 (`rapportd`), 5353 (mDNS) and 41641 (Tailscale).

Duet's relay and sorter listen on loopback only, and so does Ollama. The application firewall is
off, and `/etc/pf.conf` is the stock file, with only Apple's anchors. Checking whether pf is enabled
needs `sudo`, so step 3 does it. `bridge0` already exists (it's the Thunderbolt bridge), so the
machines' interface will be a new one.

## Freeing memory before step 2

On the owner's request, DisplayLink was stopped on 2026-09-27. No DisplayLink device is attached,
and the one display is driven by the M4 directly. Its restart helper and XPC service were unloaded
(`launchctl bootout gui/<uid>/com.displaylink.CrashRestartHelper`, then `…XpcService`), and its app
was quit. **Memory in use fell from 17.4 GB to 11.8 GB.** The app and its login-window agent are
still installed, so DisplayLink starts again at the next login until they're removed.

With 11.8 GB in use, 32 − 11.8 − (6 to 10) leaves 10–14 GB for machines, which is one or two at
6 GB. What's left is mostly macOS (WindowServer alone is 1 GB) and Tailscale (0.6 GB). The largest
remaining lever is Ollama: by default it keeps up to 3 models loaded at once
(`OLLAMA_MAX_LOADED_MODELS`), each for 5 minutes after its last request. Two large models loaded
together would take all of that headroom. A cap on Ollama is a change to the host, so it waits for
the owner.

Also on the owner's request: Safari was quit, Logi Options+ and an unused agent gateway were
removed, and Spotlight indexing was turned off for the system volume. For the data volume,
`mdutil` over SSH fails with error -405, presumably because SSH sessions lack Full Disk Access. Memory in use was
then 12.3 GB, including 0.7 GB for Apple container's API server (below).

## 2. Apple container and one machine

**Install.** The signed installer for 1.4.1 was downloaded to the mini and checked before
installing:

- its SHA-256 matched the release;
- `pkgutil --check-signature` showed "Developer ID Installer: Apple Inc. - Containerization" and
  Apple notarization.

Then `sudo installer -pkg … -target /`, and `container system start --enable-kernel-install`.
Starting took 29 s, including downloading the default kernel (kata-containers 3.32.0, a 697 MB
archive, checked against its digest). `container system status` reports the service running.

**The API server's memory.** With no containers, `container-apiserver` holds 714 MB, right after
installing the kernel. To measure again after a restart, before the machine is created.

**What the docs say** (1.4.1, `docs/container-machine.md` and `command-reference.md`), which the
machine has to account for:

- `machine create` mounts the host home directory read-write and gives the machine half the host's
  memory unless told otherwise, so the flags `--home-mount none --cpus 4 --memory 6G` are needed.
- It makes a Linux user named after the host account, and `machine run` runs as that user.
- It has no network option, so a machine joins the `default` network, which carries IPv4 and IPv6.
- Memory freed inside a VM isn't returned to macOS until the VM restarts
  (`docs/technical-overview.md`). K has to count each awake machine at its full limit.
- Nested virtualization needs `--virtualization` and a custom kernel with `CONFIG_KVM=y`.

**After a restart, the service is small.** The four services (API server, machine API server,
network and images) hold about 16 MB together. The 714 MB was left over from installing the
kernel. The host is at 11.7 GB before any machine.

**The image** is [`tools/m1/machine/Dockerfile`](../tools/m1/machine/Dockerfile): Ubuntu 24.04 with
systemd, after Apple's example. Two problems came up, both fixed:

- **Rosetta.** The image builder's VM uses Rosetta by default, and the mini has none, so the first
  build failed with "Rosetta is not installed". The images are arm64, so the host's
  `~/.config/container/config.toml` now sets `[build] rosetta = false`. The service reads it at
  start, so it needed a restart.
- **`/sbin/init`.** The first machine didn't boot: `exec: /sbin/init: not found`. Apple's example
  gets `/sbin/init` through `unminimize`. Without that, only `systemd-sysv` provides it, so the
  Dockerfile installs it.

A build then takes 22–29 s, for 56 MB of packages and 227 MB installed.

**The machine:**
`container machine create --name m1-test --cpus 4 --memory 6G --home-mount none local/m1-machine:ubuntu-24.04`

| | |
| --- | --- |
| Create, with the image already built | 0.6 s |
| Cold boot to the first command | 0.55 s |
| Cold boot to systemd running | 0.65 s (104 ms of it in userspace) |
| A command in a running machine | 0.06 s |
| Stop | 10.9 s |
| Host memory while idle | 0.56 GB: the VM process 534 MB, its runtime helper 21 MB. Inside, 181 MB of 6 GB is used |
| Disk on the host | 1.4 GB. It's sparse, and the machine sees 504 GB |

- **Inside:** Ubuntu 24.04.5 on kernel 6.18.35, 4 CPUs, and systemd running with no failed units.
- **The user** has the host account's name and uid (501), and passwordless `sudo`.
- **No home mount.** The only host mounts are Apple's read-only `/sbin.machine` and a marker file,
  `/etc/.machine.initialized`.
- **`machine run` needs `-i` when its stdin is a pipe,** or stdin from `/dev/null` otherwise.
  Without either, it fails with "Inappropriate ioctl for device". With `-i`, piped stdin and
  stdout pass through the machine boundary, which is what ACP needs (step 5).
- **Stopping is slow,** probably because systemd, as PID 1, doesn't exit on SIGTERM, so the stop
  waits out a timeout. Waking a machine takes under a second, so sleep and wake stay cheap.

**The network, for step 3:**

- The machine is on Apple container's `default` network: 192.168.64.0/24, with the gateway at
  192.168.64.1 on the host interface `bridge100` (member `vmenet0`). The interface appears only
  while a machine runs.
- It also has IPv6: a ULA /64 (`<machines-ula>::/64`), with addresses from the host's router
  advertisements and a default route through the host. The walls have to cover IPv6 too.
- DNS goes to the host: `nameserver 192.168.64.1`, search domain `machine`. The walls have to
  allow DNS to the gateway, or give machines another resolver.
- A machine's IP changes on every boot (.7, .8, .10 so far), so the walls must target the subnet,
  not addresses.
- `machine run` passes its command through a login shell, which splits quoted arguments again.
  Scripts go in on stdin instead: `machine run -i -n m1-test -- bash -s < script`.

## 3. The walls (`pf`)

**Before the walls.** [`tools/m1/walls-test.sh`](../tools/m1/walls-test.sh) runs inside the
machine. The targets are passed in when it runs, so no home address is written down. With no
walls and no Ollama forwarder, 9 of its 13 checks came out wrong. The machine reached:

- the host: SSH on the gateway, on its LAN address and on its tailnet address, and AirPlay;
- the router: ping and DNS;
- another LAN device;
- another tailnet device, through the host's Tailscale.

IPv4 internet and DNS worked. IPv6 internet didn't work at all, and Ollama wasn't reachable, since
it listens on loopback only.

**DNS leaks tailnet names.** Through the host's resolver, a machine can look up the tailnet's
device names (MagicDNS answers for the host). `.local` names don't resolve. The walls stop
connections to those addresses, but the names still leak. When the daemon exists, it should
answer the machines' DNS itself and refuse the tailnet's domain.

**The walls, as planned** (tools in [`tools/m1/pf/`](../tools/m1/pf)):

- [`i-inc-machines.pf`](../tools/m1/pf/i-inc-machines.pf) is loaded into a sub-anchor of Apple's
  (`com.apple/010.i-inc-machines`), so `/etc/pf.conf` stays untouched.
  - Machines get the internet over IPv4, with each new connection logged to `pflog0`.
  - From the host they get only DHCP, DNS and Ollama.
  - Nothing on the LAN, the tailnet, other machines or the rest of the host.
  - No IPv6 beyond neighbour discovery.
  - No connections opened to them.
- `apply.sh` checks and loads the rules, and turns pf on with a reference token of its own.
  `remove.sh` undoes it. `capture.sh` records pf's log and the machines' DNS lookups, since pf
  logs addresses and the lookups turn them into domains.
- [`tools/m1/ollama-forward.mjs`](../tools/m1/ollama-forward.mjs) listens on the gateway address
  only and pipes to Ollama on loopback. Ollama's own settings don't change, and nothing outside
  the machines can reach it.

**With the walls** (loaded on 2026-09-27, with the owner typing the `sudo` password once):

- **pf was already on.** Apple container's network had turned it on when the machine started. The
  only other anchors were Apple's AirDrop and application firewall anchors, and ours sorts before
  them.
- **The relay** listens on 192.168.64.1:11434 only, while Ollama stays on 127.0.0.1. From the
  machine, all six models show through it.
- **The walls test: all 13 checks as wanted.** Internet over IPv4, DNS and Ollama work. The host's
  SSH (on all three of its addresses) and AirPlay, the router, another LAN device, another
  tailnet device, IPv6 and the metadata address are all refused.
- **Nothing gets in.** Before the walls, the host could connect to a listener in the machine.
  With them, the attempt is dropped and times out.
- **The logs name what a machine contacts.** Over the 3-minute capture, the pf log has one line
  per allowed connection (example.com's address on 443, the relay) and per refused attempt, each
  with the rule that matched. The DNS capture on `bridge100` has the names looked up
  (`example.com`, A and AAAA), which map those addresses back to domains.
- **The host is unaffected.** Its internet, Ollama on loopback, SSH into it, and Duet's relay over
  Tailscale all still answer. The rules only match traffic on `bridge100`.
- **Not yet done:**
  - The rules, pf's reference and the relay don't survive a reboot. The daemon's host setup
    (M3) should load them at boot.
  - The relay binds to an address that exists only while a machine runs, so the daemon should
    start it with the first machine.
  - Traffic between two machines is untested, since there's only one.

## 4. Harnesses and sign-in

**Installed** in the machine with [`tools/m1/install-harnesses.sh`](../tools/m1/install-harnesses.sh),
with pinned versions:

- Node 24.21.0, checked against nodejs.org's SHA-256;
- Claude Code 2.1.283, with Anthropic's native installer;
- Claude's ACP adapter, `@agentclientprotocol/claude-agent-acp` 0.81.2;
- OpenCode 1.18.32, whose ACP mode is `opencode acp`. It's pointed at Ollama through the relay
  (`~/.config/opencode/opencode.json`).

npm is kept in `~/.local`, so global installs need no `sudo`. Two things to know:

- **npm 11 skips install scripts unless they're allowed.** OpenCode's `postinstall` and
  `@github/keytar`'s native build were skipped. Both tools still ran. The base image should pass
  `--allow-scripts`, or accept the skip deliberately.
- **Commands run by `machine run` get a non-login shell**, so `~/.local/bin` isn't on its `PATH`.
  Use `bash -l`, or absolute paths.

**Claude:** sign-in without a browser works in principle. `claude` prints a link, and in SSH
sessions and containers the browser page shows a code to paste back. The link is too long for the
terminal, though: it wraps, and copying it breaks it. The credential lands in
`~/.claude/.credentials.json`, mode 0600. For i.inc, `claude setup-token` fits better: it mints a
one-year token that is only printed. The daemon would store that token and hand it to each session
as `CLAUDE_CODE_OAUTH_TOKEN`, so no login lives in the machine.

**Gemini CLI no longer serves Google AI Pro.** Google stopped serving personal Google AI Pro,
Ultra and free accounts in Gemini CLI on June 18, 2026. "Sign in with Google" completes, then
silently falls back to asking for an API key (google-gemini/gemini-cli#28717, open). An API key
is billed and limited separately from the subscription, so the owner chose not to use one, and
Gemini CLI was uninstalled.

**Antigravity takes its place.** Google's replacement for Gemini CLI is Antigravity CLI (`agy`),
and its ACP server is in the ACP registry (`antigravity-acp`, with a linux-arm64 build).
[`tools/m1/install-antigravity.sh`](../tools/m1/install-antigravity.sh) installs both:

- `agy` 1.2.12 comes from Google's installer, which checks the download against its SHA-512.
- The ACP server 1.2.1 is a native binary: a 321 MB zip, 999 MB unpacked.

**The keyring turned out not to be needed.** Reports say `agy` keeps its sign-in only in a Secret
Service keyring on headless Linux, so gnome-keyring went in first. Two things went wrong with it:

- It pulled in about 90 packages of GTK and desktop libraries, even without recommends.
- With an empty password it wanted to confirm in a window, which a machine can't show.

A random password kept in a 0600 file made it work. But `agy` 1.2.12 keeps its sign-in in
`~/.gemini/antigravity-cli/antigravity-oauth-token` (0600, with a refresh token), and it answers
in a fresh session with or without the keyring. The install script no longer installs one.

| Harness | Sign-in without a browser | Where the credential lives | Check |
| --- | --- | --- | --- |
| Claude Code 2.1.283 | Yes: a link, then a code pasted back. The link wraps in the terminal, so copying it breaks it; opening it in a browser from the host worked | `~/.claude/.credentials.json`, 0600 | `claude -p` answers |
| Antigravity 1.2.12 | Yes: a link, then a code pasted back. `SSH_CONNECTION` must be set, or it looks for a browser | `~/.gemini/antigravity-cli/antigravity-oauth-token`, 0600, with a refresh token | `agy -p` answers in a fresh session |
| OpenCode 1.18.32 | Not needed: it uses the local models, through the relay | none | `opencode run` answers on qwen3:8b |
| Gemini CLI 0.61.0 | Google sign-in no longer works for AI Pro. Uninstalled | none | none |

Ollama loaded qwen3:8b for OpenCode with a 32k context: 8.1 GB, all on the GPU. That fits §12's
"6–10 GB while a model is loaded".

## 5. Driving an employee over ACP

[`tools/m1/acp-probe.ts`](../tools/m1/acp-probe.ts) runs on the host with Node's own TypeScript
support.

- **How it starts the agent:** through `container machine run -i -n m1-test -- acp-<agent>`. Those
  are one-word launchers from [`tools/m1/acp-launchers.sh`](../tools/m1/acp-launchers.sh), because
  `machine run` re-splits arguments.
- **What it does:** speaks ACP JSON-RPC over the agent's stdio, and asks for a file to be created
  and listed.
- **What it gives the agent:** no file or terminal access on the host, so everything happens
  inside the machine. Each run's messages go to `/tmp/m1/acp-<agent>.jsonl` on the host. They're
  not in the repo, because they carry account details.

| | Claude Code (adapter 0.81.2) | Antigravity (ACP server 1.2.1) | OpenCode 1.18.32 on qwen3:8b |
| --- | --- | --- | --- |
| ACP over the machine boundary | yes, protocol 1 | yes, protocol 1 | yes, protocol 1 |
| Bypass mode | `bypassPermissions` (modes: default, acceptEdits, plan, auto, bypassPermissions) | `yolo` (modes: default, auto_edit, yolo) | none offered, but it asked for no permissions |
| Tool calls, all logged | 2, no permission requests | 3, then 1 on the second run, no permission requests | 2, no permission requests |
| Time for the prompt | 5 s | 7–9 s | 141 s, most of it before the first tool call |
| Resumes a session (`loadSession`) | not advertised | yes | yes |
| Usage and limits over ACP | a `usage_update` for each step, plus `rate_limit_event` (below) | none | none |

**`rate_limit_event` comes through Claude's adapter.** It arrives as a `usage_update` whose
`_meta["_claude/rateLimit"]` holds these fields:

- `status` (for example `allowed`), `rateLimitType` (`five_hour`) and `resetsAt`;
- the overage status;
- `unifiedWindows`, with `utilization` and `resetsAt` for both the five-hour and the seven-day
  window. This run showed 0.59 and 0.46.

That's enough for the office's account meters without waiting for a "limit reached" error. The
adapter only sends it once an answer has reported usage.

**Antigravity's ACP server has a sign-in of its own.** It doesn't reuse the CLI's. On `session/new`
it answers "Authentication required", and the client calls `authenticate` with `oauth-personal`.
That prints a Google link whose callback is a server on `127.0.0.1` inside the machine, which no
browser outside can reach:

1. The owner signed in on the host's browser.
2. The owner copied the failed `127.0.0.1:<port>/?code=…` address.
3. The owner delivered it with `curl` from a shell in the machine.

The daemon can do this relay itself later. The sign-in is kept in
`~/.gemini/antigravity-acp/acp_token.json` (0600, with a refresh token), and the next session
needed none.

**Models on Google AI Pro, through Antigravity:** Gemini 3.8, 3.7 and 3.6 Flash (each high, medium
or low), `gemini-pro-agent` and `gemini-3.1-pro-low`.

**A full Claude login reaches the owner's claude.ai connectors.** In its reply, Claude mentioned
the owner's Gmail, Google Calendar and Google Drive connectors. They weren't authorized, so it
couldn't use them, but a full `/login` inside a machine exposes whatever connectors the account
has. That would be a way from an engineering machine to home data. Tokens from `claude setup-token`
"can only make model requests" and can't reach connectors, so they're the credential employees
should get.

**OpenCode lists hosted models.** Next to the local models, it offers its own free hosted ones
("OpenCode Zen"). A PA's machine must pin OpenCode to local providers only, or a mistake could send
home data out.

## 6. A real ticket, then an engine switch

**The ticket** ([`tools/m1/step6/ticket-1.md`](../tools/m1/step6/ticket-1.md)): on Duet, list
`pnpm lint` and `pnpm typecheck` under the README's Development section. The owner chose a trivial
ticket for this test.

**Access.** A fine-grained token, limited to Duet with Contents and Pull requests write, was pasted
by the owner into `gh auth login` inside the machine:

- `gh` keeps it in `~/.config/gh/hosts.yml`, since the machine has no keyring;
- git pushes through `gh`'s credential helper;
- commits carry a neutral identity, "Test employee (i.inc)".

**Stage A, Plan: Claude Code over ACP, 29 s, 4 tool calls.** It cloned Duet, made the branch
`inc/1-readme-dev-commands`, and wrote `~/work/inc-1/plan.md` and `notes.md`. The plan has the
exact two lines, where they go (the `#` aligned at column 16), where each command comes from
(package.json, CI, CLAUDE.md), four checks, and the risks. As told, it edited and committed
nothing.

**The switch.** The Claude session ended.
[`tools/m1/step6/brief.sh`](../tools/m1/step6/brief.sh) built the resume brief from the machine:
the ticket, the plan, the notes, `git log` and status, and the last error (none), followed by
[the build steps](../tools/m1/step6/build-steps.md).

**Stage B, Build and Checks: Gemini 3.8 Flash through Antigravity, 110 s, 31 tool calls.** It
started from the brief alone, in `yolo` mode, with no permission requests. It then:

1. made the planned edit;
2. ran the plan's checks: only README.md changed, with 2 insertions; every comment sits at column
   16; both scripts exist;
3. committed `docs: list lint and typecheck under Development`;
4. pushed the branch;
5. opened the draft PR firstprateek/duet#7;
6. added to the notes.

GitHub CI ran on the draft PR, and lint, types and tests passed.

**What the second engine got right:** everything the ticket asked for. It placed, aligned and
worded the lines exactly as planned, and ran every planned check.

**What it lost:**

- Nothing material on a ticket this size.
- Re-orienting took about 20 s and 8 tool calls. It re-read the plan and notes, although the
  brief already quoted them.
- The plan's optional `pnpm lint && pnpm typecheck` failed, because the machine has no pnpm. The
  brief has no facts about the machine, so neither engine knew. CI covered it.
- The PR shows the owner's account as its author, because the fine-grained token is the owner's.
  The bot identity comes with the GitHub App (M3).

**For the resume brief:**

- It should say what the machine has and lacks, such as package managers, and whether the checks
  ran.
- It can point to files instead of quoting them, since the new engine reads them anyway.

## What the spec should change

Candidates so far. Those marked "to confirm" wait for the step named.

- **§12:** Apple container is at 1.4.1, not 1.0.
- **§9 and §12, "memory is used on demand":** that holds only until a machine has been busy. Guest
  memory isn't returned to macOS until the machine restarts. So an idle machine should be stopped,
  not left running, and waking takes under a second. To confirm, with K, in step 7.
- **§5, the walls:**
  - From the host, machines need DHCP and DNS as well as i.inc's API and Ollama.
  - IPv6 is refused rather than walled by address, because the LAN's prefix changes.
  - Machines reach Ollama through a relay on their gateway, not by Ollama listening beyond
    loopback. Once the daemon exists, its API can carry that, which leaves one host port open.
  - The daemon should answer the machines' DNS itself, so it can log names per employee and
    refuse the tailnet's names.
- **§15, the base image:** a machine's user takes the host account's name and uid unless the image
  ships its own `/etc/machine/create-user.sh`. An employee's machine should use a user of its own.
- **§5, §8 and §13, the Google engine (done in this PR):** Gemini CLI on Google AI Pro is replaced
  by Antigravity's ACP server on Google AI Pro. There's a new risk entry on vendors moving
  subscriptions. The core's `AgentHarness` type in `packages/core/src/model.ts` still lists
  `"gemini-cli"` and should get `"antigravity"` instead; that's left to a core change.
- **§5, credentials (done in this PR):** Claude's credential for an employee is a model-only token
  from `claude setup-token`, handed to each session. A full login stored in the machine would also
  reach the owner's claude.ai connectors (mail, calendar, drive).
- **§8, accounts (done in this PR):** `rate_limit_event` is confirmed to pass through the adapter,
  with the use of each window. Antigravity's ACP server reports no usage, so Google AI Pro limits
  are known only from its errors.
- **§7, the PA:** its OpenCode must be pinned to local providers. OpenCode also offers hosted
  models of its own.
