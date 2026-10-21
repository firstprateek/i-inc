// The deployer: `bun apps/deployer/src/main.ts`, run by the LaunchAgent inc.i.deployer (tools/host).
// It runs from the owner's checkout (~/i-inc), never from a release, so a broken release can never stop
// its own repair.
//
//   (no flags)          loop forever: a cycle every 2 minutes
//   --once              one cycle, then exit
//   --force-after <min> switch even if the daemon is still busy after this many minutes
//   --sha <full sha>    with --once: deploy main's tip even though it does not descend from the running release
//   --seed              make the checkout's HEAD the first release and point `current` at it
//   --rollback [sha]    roll back by hand to the previous deployed release (or sha, if it was deployed before);
//                       refuses while the daemon is busy unless --force; marks the release it leaves as bad
//   --status            print the deployer's state and exit
//
// The flags other than the loop take the same lock as the service: pause it first
// (launchctl bootout gui/$(id -u)/inc.i.deployer).
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GitHubCi } from "./ci.ts";
import { LaunchdDaemon } from "./daemon.ts";
import { Deployer } from "./deployer.ts";
import { FsReleases } from "./releases.ts";
import { GitRemote } from "./remote.ts";
import { run } from "./shell.ts";
import { ProcessSmoke } from "./smoke.ts";
import { FileLock, FileStore } from "./store.ts";
import { type Clock, defaultSettings, type Settings } from "./types.ts";

const env = process.env;
const home = homedir();
const checkout = env.I_INC_CHECKOUT ?? join(home, "i-inc");
const root = env.I_INC_RELEASES ?? join(home, "i-inc-releases");
const incHome = env.I_INC_HOME ?? join(home, ".i-inc");
const port = Number(env.PORT ?? 7420);
const repo = env.I_INC_REPO ?? "firstprateek/i-inc";
const pollMs = Number(env.I_INC_DEPLOY_POLL_MS ?? 120_000);

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  const v = i >= 0 ? args[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
};

const clock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

const forceMin = value("--force-after") ?? env.I_INC_FORCE_AFTER_MIN;
const settings: Settings = {
  ...defaultSettings,
  forceAfterMs:
    forceMin !== undefined && Number.isFinite(Number(forceMin)) ? Number(forceMin) * 60_000 : undefined,
};

const releasesDir = (sha: string) => join(root, sha);
const remote = new GitRemote(checkout, run, "main", releasesDir);
const releases = new FsReleases({ root, checkout, originUrl: () => remote.originUrl(), shell: run });
const store = new FileStore(join(root, "state.json"), join(incHome, "deploys.jsonl"));
const deployer = new Deployer({
  clock,
  remote,
  ci: new GitHubCi({ repo, checkName: env.I_INC_CI_CHECK ?? "check", clock }),
  releases,
  smoke: new ProcessSmoke({ clock, releaseDir: (sha) => releases.dir(sha), bun: process.execPath }),
  daemon: new LaunchdDaemon({
    shell: run,
    uid: process.getuid?.() ?? 501,
    label: "inc.i.daemon",
    url: `http://127.0.0.1:${port}`,
  }),
  store,
  lock: new FileLock(join(root, "deployer.lock")),
  settings,
  log,
});

if (flag("--status")) {
  console.log(
    JSON.stringify(
      { current: await releases.current(), releases: await releases.list(), state: store.state() },
      null,
      2,
    ),
  );
  process.exit(0);
}

mkdirSync(root, { recursive: true });
if (!deployer.acquire()) {
  log(
    "another deployer holds the lock: exiting (pause the service first: launchctl bootout gui/$(id -u)/inc.i.deployer)",
  );
  // Non-zero, so launchd keeps trying (every 30 s) instead of leaving the deployer off for good.
  process.exit(1);
}
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    deployer.release();
    process.exit(0);
  });
}

if (flag("--seed")) {
  const head = await run("git", ["rev-parse", "HEAD"], { cwd: checkout });
  const sha = head.output.trim();
  if (head.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`cannot read HEAD of ${checkout}`);
  if (!existsSync(join(root, sha))) {
    log(`seeding the first release from ${checkout} at ${sha.slice(0, 7)}`);
    await releases.build(sha, checkout);
  }
  if (!(await releases.current())) await releases.point(sha);
  deployer.noteSeeded((await releases.current()) ?? sha);
  log(`current is ${(await releases.current())?.slice(0, 7)}`);
  deployer.release();
  process.exit(0);
}

if (flag("--rollback")) {
  const r = await deployer
    .rollbackByHand(value("--rollback"), { force: flag("--force") })
    .catch((err: unknown) => {
      log(`not rolled back: ${err instanceof Error ? err.message : String(err)}`);
      deployer.release();
      process.exit(1);
    });
  log(`rolled back: ${JSON.stringify(r)}`);
  deployer.release();
  process.exit(0);
}

await deployer.recover().catch((err) => log(`recovery failed: ${String(err)}`));
if (flag("--once")) {
  const allowed = value("--sha");
  if (allowed) {
    if (!/^[0-9a-f]{40}$/.test(allowed)) {
      log("--sha needs the full 40-character commit sha");
      deployer.release();
      process.exit(2);
    }
    deployer.allowRewrite(allowed);
    log(`${allowed.slice(0, 7)} is allowed even if it does not continue the running release`);
  }
  const r = await deployer.cycle();
  log(`cycle: ${r.action}`);
  deployer.release();
  process.exit(0);
}
log(`deployer started: watching ${repo} main every ${Math.round(pollMs / 1000)} s, releases in ${root}`);
for (;;) {
  try {
    await deployer.cycle();
  } catch (err) {
    log(`cycle failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  await clock.sleep(pollMs);
}
