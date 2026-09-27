// The daemon on the host: `bun src/main.ts`. Serves the API and the web app on the tailnet, and
// ticks the scheduler.
//
// Real ACP sessions, Apple container machines and the GitHub App arrive with M1's findings and M3.
// Until then it runs only in demo mode (I_INC_DEMO=1), with the scripted fake agent and a morning's
// worth of tickets, so the web app has something real to show.
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { FakeAgent, FakeChat, FakeHarness, FakeHelper, FakeMachines } from "@i-inc/core/testing";
import { createApp } from "./app.ts";
import { seedDemo, seedDemoLater, seedDemoTickets } from "./demo.ts";

const home = process.env.I_INC_HOME ?? join(homedir(), ".i-inc");
const port = Number(process.env.PORT ?? 7420);
const host = process.env.HOST ?? "127.0.0.1";
const web = process.env.I_INC_WEB ?? join(import.meta.dir, "../../web/dist");

if (process.env.I_INC_DEMO !== "1") {
  console.error(
    "i.inc: real employees need M1's adapters. Run with I_INC_DEMO=1 to try the daemon with a scripted agent.",
  );
  process.exit(1);
}

mkdirSync(home, { recursive: true });
const agent = new FakeAgent();
const harness = new FakeHarness();
const app = await createApp({
  dbPath: join(home, "demo.db"),
  clock: { now: () => Date.now() },
  machines: new FakeMachines(),
  agent,
  harness,
  helper: new FakeHelper(),
  chat: new FakeChat(),
  ...(process.env.I_INC_TOKEN ? { token: process.env.I_INC_TOKEN } : {}),
  log: (m) => console.log(new Date().toISOString(), m),
});

if (app.deps.registry.employees().length === 0) {
  seedDemo(app.deps.registry);
  seedDemoTickets(app.deps.tickets, agent, harness, Date.now());
  await app.daemon.tick();
  await app.daemon.idle();
  seedDemoLater(app.deps.tickets, agent, Date.now());
}
await app.daemon.tick();
setInterval(() => void app.daemon.tick(), 30_000);

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
  `i.inc daemon on http://${host}:${port} (demo mode)${existsSync(web) ? "" : " · build apps/web to serve the app"}`,
);
