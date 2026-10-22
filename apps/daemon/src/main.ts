// The daemon on the host: `bun src/main.ts`. Serves the API and the web app on HOST (127.0.0.1 by
// default), and ticks the scheduler.
//
// By default it runs real employees: ACP sessions in Apple container machines, each signed in to its
// harnesses once at hiring, with the GitHub App and any account tokens from ~/.config/i-inc
// (config.ts). With I_INC_DEMO=1 it runs the scripted fake agent over a morning's worth of tickets
// instead, so the web app has something to show anywhere.
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { FakeAgent, FakeChat, FakeHarness, FakeHelper, FakeMachines } from "@i-inc/core/testing";
import { SessionHost } from "./ahp/session-host.ts";
import type { WsData } from "./ahp/transport.ts";
import { createApp } from "./app.ts";
import { configDir, readCredentials, webToken } from "./config.ts";
import { seedDemo, seedDemoLater, seedDemoProposals, seedDemoTickets } from "./demo.ts";
import { resolveVersion } from "./deploys.ts";
import { GitHubApp, readGitHubAppConfig } from "./github.ts";
import { installGuards, serverError } from "./guards.ts";
import { AppleMachines, defaultMachineSettings, wallsUp } from "./machines.ts";
import { killTracked, stopTracked } from "./proc.ts";
import { realPorts } from "./real.ts";
import { checkpoint } from "./retention.ts";

const home = process.env.I_INC_HOME ?? join(homedir(), ".i-inc");
const port = Number(process.env.PORT ?? 7420);
const host = process.env.HOST ?? "127.0.0.1";
const web = process.env.I_INC_WEB ?? join(import.meta.dir, "../../web/dist");

const demo = process.env.I_INC_DEMO === "1";
// The release this process runs, for /api/health: the deployer's checkouts know their own sha.
const version = resolveVersion(process.env, import.meta.dir);
const log = (m: string) => console.log(new Date().toISOString(), m);
// Before anything else can fail: a rejection or exception nobody handled is logged, not fatal.
installGuards({ log, exit: (code) => process.exit(code) });
const common = {
  knowledgeDir: join(home, "knowledge"),
  brainIndexPath: join(home, "brain-index.db"),
  clock: { now: () => Date.now() },
  // Real mode always needs the login token (config.ts), so the daemon can be served on the tailnet.
  ...(process.env.I_INC_TOKEN
    ? { token: process.env.I_INC_TOKEN }
    : process.env.I_INC_DEMO === "1"
      ? {}
      : { token: webToken() }),
  // While no owner account exists, the one-time setup code for the first-run signup is logged and
  // written here (mode 0600): read it with `cat ~/.i-inc/setup-code`.
  setupCodePath: join(home, "setup-code"),
  // The Host headers it answers: its own address, plus any in I_INC_HOSTS (comma-separated).
  hosts: [
    `${host}:${port}`,
    `localhost:${port}`,
    ...(process.env.I_INC_HOSTS?.split(",").filter(Boolean) ?? []),
  ],
  log,
  configDir: configDir(),
  version,
  // The deployer (apps/deployer) records every attempt here; GET /api/deploys and the push read it.
  deploysPath: join(home, "deploys.jsonl"),
  // AHP clients that can't send a cookie or header may push the token with `authenticate` instead.
  ...(process.env.I_INC_AHP_DEFERRED_AUTH === "1" ? { ahpDeferredAuth: true } : {}),
};
mkdirSync(home, { recursive: true });

// What storage cleanup measures or trims on the host (storage.ts). The container data folder and the
// deployer's releases are only measured.
const releases = process.env.I_INC_RELEASES ?? join(homedir(), "i-inc-releases");
const storagePaths = {
  home,
  logDir: join(homedir(), "Library", "Logs"),
  containerData:
    process.env.I_INC_CONTAINER_DATA ??
    join(homedir(), "Library", "Application Support", "com.apple.container"),
  ...(existsSync(releases) ? { releases } : {}),
};

const credentials = demo ? {} : readCredentials();
// The GitHub App, once it's set up (docs/github-app.md). Without it, tickets run with no branch or PR.
const appConfig =
  !demo && existsSync(join(configDir(), "github-app.json")) ? readGitHubAppConfig() : undefined;
const agent = new FakeAgent();
const harness = new FakeHarness();
const real = demo
  ? undefined
  : realPorts({
      credentials,
      log,
      // Every push is made here on the host, from the mirrors; main's commits are written to the ledger the
      // deployer checks (T68).
      // The repo the deployer deploys: what it runs on the host needs your OK (I_INC_REPO, as the deployer's).
      deployRepo: process.env.I_INC_REPO ?? "firstprateek/i-inc",
      hostPush: { mirrors: join(home, "push-mirrors"), ledger: join(home, "pushed-main.jsonl") },
      ...(appConfig
        ? { github: { tokens: new GitHubApp(appConfig), slug: appConfig.slug ?? "i-inc-bot" } }
        : {}),
    });
const app = demo
  ? await createApp({
      ...common,
      dbPath: join(home, "demo.db"),
      storagePaths,
      machines: new FakeMachines(),
      agent,
      harness,
      helper: new FakeHelper(),
      chat: new FakeChat(),
    })
  : await createApp({
      ...common,
      dbPath: join(home, "i-inc.db"),
      storagePaths,
      ...(real as NonNullable<typeof real>),
    });

// SQLite's quick integrity check. A failure is logged and pushed to the owner, and the daemon serves on.
await app.storage.checkIntegrity();

if (!demo) {
  if (!appConfig) log("no GitHub App yet (docs/github-app.md): tickets get no branch or PR");
  if (app.deps.registry.projects().length === 0) {
    log("no projects yet: PUT /api/projects/<id> with {repo, checks}");
  }
}

if (demo && app.deps.registry.employees().length === 0) {
  seedDemo(app.deps.registry);
  app.daemon.ensureKnowledge();
  seedDemoTickets(app.deps.tickets, agent, harness, Date.now());
  await app.daemon.tick();
  await app.daemon.idle();
  await app.handle(
    new Request(`http://${host}:${port}/api/tickets/1/decide`, {
      method: "POST",
      headers: {
        host: `${host}:${port}`,
        "content-type": "application/json",
        ...(process.env.I_INC_TOKEN ? { authorization: `Bearer ${process.env.I_INC_TOKEN}` } : {}),
      },
      body: JSON.stringify({ decision: "approve" }),
    }),
  );
  await app.daemon.idle();
  seedDemoLater(app.deps.tickets, agent, Date.now());
  seedDemoProposals(app.deps.proposals, Date.now());
}
// Agents an earlier daemon left running (it crashed, was killed, or a deploy did not wait for it) are
// stopped before anything launches: every launch waits for this sweep (reaper.ts), so no agent this
// daemon starts can be taken for a leftover. It runs on every machine that is up, all at once.
// Home machines (a personal assistant's sandbox) are looked at first: the sweep runs in one only if the
// walls job has confirmed it is walled off (egress-wall.ts).
const watchHome = async () => {
  if (demo || !(app.deps.machines instanceof AppleMachines)) return;
  if (!wallsUp(defaultMachineSettings)) return; // the watch below already stops every machine
  await app.deps.machines
    .watchHome()
    .then((stopped) => stopped.length && log(`the home wall doesn't cover ${stopped.join(", ")}: stopped`))
    .catch((err) => log(`home wall check failed: ${err}`));
};
// A write token an older daemon left in a sandbox's gh config is gone first: every running sandbox is signed
// out of GitHub (T68); a session signs its machine in again with a read-only token for its own repo.
if (real) {
  void real
    .resignAll()
    .then(
      (n) =>
        n &&
        log(
          `signed ${n} sandbox(es) out of GitHub (the first session that needs it signs in again, read-only)`,
        ),
    )
    .catch((err) => log(`re-signing the sandboxes failed: ${err}`));
}
if (real) {
  void watchHome()
    .then(() => real.sweepAgents())
    .then((n) => n && log(`stopped ${n} agent(s) an earlier daemon left running`))
    .catch((err) => log(`sweeping for leftover agents failed: ${err}`));
}
// Machines an earlier daemon left running are recorded, so the idle sweep in the first tick can stop them.
if (!demo) {
  await app.daemon
    .adoptRunning()
    .then((ids) => ids.length && log(`machines already running: ${ids.join(", ")}`))
    .catch((err) => log(`couldn't list the running machines: ${err}`));
}
// A first tick that fails is logged (tick() never rejects) and the daemon serves anyway; the next tick
// tries again. Nothing in the database may keep it from coming up.
await app.daemon.tick().catch((err) => log(`first tick failed: ${err}`));
setInterval(() => void app.daemon.tick().catch((err) => log(`tick failed: ${err}`)), 30_000);

// A failed deploy (rolled back, or never switched) becomes a push, once.
const watchDeploys = () => void app.deploys.check().catch((err) => log(`deploy notifications: ${err}`));
watchDeploys();
setInterval(watchDeploys, 30_000);

// Bounded growth (T52): trim the host and clean any machine that is up, idle and due, every ten
// minutes. A machine about to be stopped is cleaned by the daemon's own pass (daemon.ts, sleepIdle).
const maintain = () => void app.storage.maintain().catch((err) => log(`storage maintenance failed: ${err}`));
setTimeout(maintain, 2 * 60_000).unref();
setInterval(maintain, 10 * 60_000);

// Brain copies in machines their employee has left (or that were stopped when it was tried) are removed.
setInterval(
  () => void app.deps.brainFeed.reconcile().catch((err) => log(`brain: couldn't tidy copies: ${err}`)),
  10 * 60_000,
);

// Each team sandbox in use stays signed in to GitHub as the bot.
if (real) {
  setInterval(
    () => void real.keepLoginsFresh().catch((err) => log(`GitHub sign-in renewal failed: ${err}`)),
    5 * 60_000,
  );
}

// If the walls go down, nothing new starts (assertWalls), and the machines already running stop.
if (!demo && app.deps.machines instanceof AppleMachines) {
  const machines = app.deps.machines;
  setInterval(() => {
    if (wallsUp(defaultMachineSettings)) return;
    void machines
      .stopAll()
      .then((stopped) => stopped.length && log(`the walls are down: stopped ${stopped.join(", ")}`))
      .catch((err) => log(`the walls are down, and stopping the machines failed: ${err}`));
  }, 30_000);
}

// The open machines are declared to the walls job, and a home machine whose address the walls let out (it
// restarted with a new one) or whose user has root again is stopped (egress-wall.ts).
setInterval(() => void watchHome(), 30_000);

/** The web app's build, with index.html for every other path. */
async function serveWeb(req: Request): Promise<Response> {
  const path = normalize(new URL(req.url).pathname).replace(/^(\.\.[/\\])+/, "");
  const file = Bun.file(join(web, path === "/" ? "index.html" : path));
  if (await file.exists()) return new Response(file);
  return new Response(Bun.file(join(web, "index.html")));
}

app.ahp.transport.start();
// Idle conversations are suspended, so their agents don't hold the sandbox.
if (app.ahp.backend instanceof SessionHost) app.ahp.backend.start();
const server = Bun.serve<WsData>({
  port,
  hostname: host,
  idleTimeout: 60,
  // Never Bun's development error page: it prints source excerpts and absolute paths. A route that
  // throws answers with a plain JSON error, and the log has the details.
  development: false,
  error: serverError(log),
  fetch: (req, server) => {
    // Conversations speak AHP over a WebSocket on this same port (src/ahp/transport.ts).
    if (app.ahp.transport.matches(req)) {
      const g = app.ahp.transport.guard(req);
      if ("refusal" in g) return g.refusal;
      if (server.upgrade(req, { data: g.data })) return undefined;
      return new Response("websocket upgrade failed", { status: 400 });
    }
    return new URL(req.url).pathname.startsWith("/api/") || !existsSync(web)
      ? app.handle(req, { peer: server.requestIP(req)?.address })
      : serveWeb(req);
  },
  websocket: app.ahp.transport.websocket,
});

// SIGTERM (launchd, the deployer's kickstart) and SIGINT: stop the agents politely (session/cancel,
// close their stdin, kill after a short grace), close the sockets, fold the database's log back in,
// and leave inside launchd's exit timeout (20 s by default); a second signal leaves at once.
let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) process.exit(1);
  stopping = true;
  log(`${signal}: stopping`);
  const hard = setTimeout(() => {
    log("shutdown took too long: leaving");
    process.exit(1);
  }, 12_000);
  try {
    // First: stopping the agents ends their turns, and nothing that does must reach a phone.
    app.ahp.push.close();
    server.stop();
    app.ahp.transport.stop();
    const agent = app.deps.agent as { shutdown?: (graceMs?: number) => Promise<void> };
    await Promise.all([
      app.ahp.backend instanceof SessionHost ? app.ahp.backend.shutdown() : undefined,
      agent.shutdown?.(),
    ]);
    // Scripts and commands run detached, so launchd's kill of the daemon's group would miss them.
    stopTracked();
    // Whatever ignored both the end of its stdin and the kill of its client, in every machine that is
    // up (a stopped one is not started to look), all at once, within a few seconds.
    if (real) await real.sweepAgents({ all: true, timeoutMs: 8000 });
    app.ahp.host.close();
    await new Promise((r) => setTimeout(r, 50)); // let the runs the close ended write their last lines
    checkpoint(app.db);
    app.db.close();
  } catch (err) {
    log(`shutdown: ${err instanceof Error ? err.message : err}`);
  }
  // Nothing detached outlives the daemon: launchd's kill of its group would not reach it.
  killTracked();
  clearTimeout(hard);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
console.log(
  `i.inc daemon ${version.slice(0, 7)} on http://${host}:${port}${demo ? " (demo mode)" : ""}${existsSync(web) ? "" : " · build apps/web to serve the app"}`,
);
