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
import { createApp } from "./app.ts";
import { configDir, readCredentials } from "./config.ts";
import { seedDemo, seedDemoLater, seedDemoTickets } from "./demo.ts";
import { GitHubApp, readGitHubAppConfig } from "./github.ts";
import { AppleMachines, defaultMachineSettings, wallsUp } from "./machines.ts";
import { realPorts } from "./real.ts";

const home = process.env.I_INC_HOME ?? join(homedir(), ".i-inc");
const port = Number(process.env.PORT ?? 7420);
const host = process.env.HOST ?? "127.0.0.1";
const web = process.env.I_INC_WEB ?? join(import.meta.dir, "../../web/dist");

const demo = process.env.I_INC_DEMO === "1";
const log = (m: string) => console.log(new Date().toISOString(), m);
const common = {
  knowledgeDir: join(home, "knowledge"),
  clock: { now: () => Date.now() },
  ...(process.env.I_INC_TOKEN ? { token: process.env.I_INC_TOKEN } : {}),
  // The Host headers it answers: its own address, plus any in I_INC_HOSTS (comma-separated).
  hosts: [`${host}:${port}`, `localhost:${port}`, ...(process.env.I_INC_HOSTS?.split(",") ?? [])],
  log,
};
mkdirSync(home, { recursive: true });

const credentials = demo ? {} : readCredentials();
// The GitHub App, once it's set up (docs/github-app.md). Without it, tickets run with no branch or PR.
const appConfig =
  !demo && existsSync(join(configDir(), "github-app.json")) ? readGitHubAppConfig() : undefined;
const agent = new FakeAgent();
const harness = new FakeHarness();
const app = demo
  ? await createApp({
      ...common,
      dbPath: join(home, "demo.db"),
      machines: new FakeMachines(),
      agent,
      harness,
      helper: new FakeHelper(),
      chat: new FakeChat(),
    })
  : await createApp({
      ...common,
      dbPath: join(home, "i-inc.db"),
      ...realPorts({
        credentials,
        log,
        ...(appConfig
          ? { github: { tokens: new GitHubApp(appConfig), slug: appConfig.slug ?? "i-inc-bot" } }
          : {}),
      }),
    });

if (!demo) {
  if (!appConfig) log("no GitHub App yet (docs/github-app.md): tickets get no branch or PR");
  if (app.deps.registry.projects().length === 0) {
    log("no projects yet: PUT /api/projects/<id> with {repo, checks}");
  }
  log("the helper model and chat are the fakes until they use Ollama");
}

if (demo && app.deps.registry.employees().length === 0) {
  seedDemo(app.deps.registry);
  app.daemon.ensureKnowledge();
  seedDemoTickets(app.deps.tickets, agent, harness, Date.now());
  await app.daemon.tick();
  await app.daemon.idle();
  await app.handle(
    new Request("http://i.inc/api/tickets/1/decide", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.I_INC_TOKEN ? { authorization: `Bearer ${process.env.I_INC_TOKEN}` } : {}),
      },
      body: JSON.stringify({ decision: "approve" }),
    }),
  );
  await app.daemon.idle();
  seedDemoLater(app.deps.tickets, agent, Date.now());
}
await app.daemon.tick();
setInterval(() => void app.daemon.tick(), 30_000);

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

/** The web app's build, with index.html for every other path. */
async function serveWeb(req: Request): Promise<Response> {
  const path = normalize(new URL(req.url).pathname).replace(/^(\.\.[/\\])+/, "");
  const file = Bun.file(join(web, path === "/" ? "index.html" : path));
  if (await file.exists()) return new Response(file);
  return new Response(Bun.file(join(web, "index.html")));
}

Bun.serve({
  port,
  hostname: host,
  fetch: (req) =>
    new URL(req.url).pathname.startsWith("/api/") || !existsSync(web) ? app.handle(req) : serveWeb(req),
});
console.log(
  `i.inc daemon on http://${host}:${port}${demo ? " (demo mode)" : ""}${existsSync(web) ? "" : " · build apps/web to serve the app"}`,
);
