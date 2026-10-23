# The employee image

Every employee machine is made from this image (spec §5 and §12). It grew out of M1's
`tools/m1/machine/Dockerfile` and install scripts. The [Dockerfile](Dockerfile) says what's in it
and why.

## Build and check it (on the mini)

```bash
container build -t local/i-inc-employee:latest images/employee
container machine create --name inc-imagecheck --cpus 4 --memory 6G --home-mount none local/i-inc-employee:latest
cat images/employee/check.sh | container machine run -i -u employee -n inc-imagecheck -- bash -s
container machine delete inc-imagecheck
```

**The walls and the build.** Once the new walls are installed (docs/handoff.md, T66) they are closed
unless opened: an address gets the internet only if the daemon has declared it. The daemon declares every
running machine except a personal assistant's, and every running container in `container ls`, which leaves
machines out. So `container build` (its builder is the container `buildkit`) and any `container run` keep
their internet while the daemon runs, within about half a minute of starting; so does a machine you make by
hand, such as `inc-imagecheck`. If the daemon is stopped nothing new is declared and a build has no network:
start the daemon first. Check with `container ls` and, on the mini, `cat /var/run/i-inc-walls.open`.
Machines don't reach each other (T70): the walls drop traffic between two machines, so a build or a check
that needs to talk to another machine has to go through the host.

**Launchers in older machines.** A rebuilt image only reaches machines made after it, but the daemon copies
the release's `acp-env.sh`, `launchers/acp-*` and `claude-settings.json` into a running machine whose launcher
is older (it finds out in the sweep before a launch and in Setup's probe; apps/daemon `updateLauncher`), as
root and after checking the walls. A stopped machine is updated the next time it is up. `tools/host/update-machine.sh`
does the same by hand.
A personal assistant's sandbox is made by the daemon, not by hand, and has its user's sudo removed (so
`check.sh`'s "sudo needs no password" line fails there on purpose).

**ripgrep and the local model's window (T71).** The image installs `ripgrep` (`rg`). OpenCode's glob and grep tools
run on it and cannot download it in a machine with no internet. A machine made before this has none: copy it in
with `sh tools/host/fetch-rg.sh` and then `sh tools/host/update-machine.sh <team id>` (no rebuild, no recreate).
`opencode.json` uses the model `qwen3-8b-32k` (`qwen3:8b` with a 32,768-token window), which the host creates once with
`sh tools/host/ollama-pa-model.sh` (docs/handoff.md, "Checking a PA works"): the endpoint OpenCode uses cannot set a
window per request, and a prompt that does not fit is cut at the front without an error.

The image includes the pinned Codex ACP adapter and its matching Codex CLI, but no Codex sign-in.
For an existing team sandbox, the owner can install those pins with
`sh tools/host/provision-codex.sh <team-id>`; it checks the host walls and updates only that
existing sandbox. Sign in separately with `sh tools/host/sign-in-codex.sh <team-id>` and check the
boolean result with `sh tools/host/codex-status.sh <team-id>`. See [Codex sandbox setup](../../docs/codex.md)
for the owner-run procedure.

[`check.sh`](check.sh) needs no credentials. It checks the user, the tools, git's credential helper,
that OpenCode offers only local models, and that Docker starts on first use. It also checks that
each launcher starts in its folder and answers ACP's `initialize`.

## First build, 2026-09-28 (container 1.4.1)

- **The build took 107 s**, and 51 s when only the launchers changed. A fresh machine's disk is 3.6
  GB, against `m1-test`'s 5.3 GB after a day of work. npm's strict install-script rule passed with
  only OpenCode's postinstall allowed, so none of the other packages needs one.
- **All 20 checks passed:**
  - Node 24.21.0, pnpm 10.34.5, git 2.43.0 and gh 2.101.0;
  - Claude's ACP adapter 0.81.2, OpenCode 1.18.32, and the Antigravity CLI 1.2.12 with its ACP
    server;
  - Docker 29.1.3, started by its socket;
  - the launchers answered `initialize` in their folders: Claude's in 0.1 s, Antigravity's in 1.0 s
    and OpenCode's in 0.5 s.
- **Duet's recipe ran green in it** (`pnpm install --frozen-lockfile`, `pnpm lint`,
  `pnpm typecheck`, `pnpm test`) in 5 s, through the harness's own script (`checksScript`).
- **`machine run -u employee`** runs as uid 1000, with the `docker` group and
  `HOME=/home/employee`. Without `-u`, commands run as the machine's copy of the host's account.

Three quirks came up:

- **Apple's builder silently skipped `COPY bin/ /usr/local/bin/`.** The step reported done, and
  copied nothing. So the Dockerfile names each launcher, and lists them, which fails the build if
  one is missing.
- **`machine run -i` refuses SSH's own stdin** with "Inappropriate ioctl for device", as in
  `ssh <mini> 'container machine run -i … bash -s' < script`. Through `cat |` it works, and so does
  Node's `spawn`, which is how the daemon runs it.
- **A new machine's first boot fails now and then.** Right after `machine create`, the machine
  stopped at once, and `machine run` failed with "Operation not supported by device". The next
  `machine run` booted it. It happened twice, once with a name that had just been deleted and once
  with a new one. So `AppleMachines.ensureUp` boots a new machine itself, trying up to three times.
