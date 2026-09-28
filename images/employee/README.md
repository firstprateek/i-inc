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
- **A machine recreated under a name that was just deleted didn't boot at first.** It stopped at
  once, and `machine run` failed with "Operation not supported by device". The next `machine run`
  booted it. `AppleMachines.ensureUp` boots with `machine run` anyway, so the daemon gets past this.
