# M1 findings

Started 2026-09-27. The mini (`<mini>` below) runs macOS 26.2 (25C56). Apple container 1.4.1,
installed 2026-09-27 (step 2).

M1 is run from a Claude Code session on the owner's Mac, over SSH to the mini, rather than from a
session on the mini itself. Read-only steps run as `ssh <mini> 'bash -s' < script`. Steps that need
`sudo`, or a sign-in, run in a terminal with `ssh -t`, so the owner types the password or does the
login.

| Question | Answer | Evidence |
| --- | --- | --- |
| ACP stdio works through the machine boundary | pending (step 5). Piped stdin and stdout already pass through `machine run -i` | step 2 |
| Sign-in works inside the machine (each harness) | pending (step 4) | |
| `rate_limit_event` passes through the Claude adapter | pending (step 5) | |
| `pf` walls hold (internet ok; LAN, tailnet, host blocked; Ollama ok) | Yes: 13 of 13 checks, nothing gets in, and connections are logged | step 3 |
| Ollama reachable from a machine | Yes, through a relay on the machines' gateway. Ollama itself stays on loopback | step 3 |
| Docker inside a machine | pending (step 7) | |
| Resume on another engine from a brief | pending (step 6) | |
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
