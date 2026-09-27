// The daemon on the host: `bun src/main.ts`. Serves the API on the tailnet and ticks the scheduler.
//
// Real ACP sessions, Apple container machines and the GitHub App arrive with M1's findings and M3.
// Until then it runs only in demo mode (I_INC_DEMO=1), with the scripted fake agent, so the web app
// has something real to talk to.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FakeAgent, FakeHarness, FakeMachines } from "@i-inc/core/testing";
import { createApp } from "./app.ts";
import { seedDemo } from "./demo.ts";

const home = process.env.I_INC_HOME ?? join(homedir(), ".i-inc");
const port = Number(process.env.PORT ?? 7420);
const demo = process.env.I_INC_DEMO === "1";

if (!demo) {
  console.error(
    "i.inc: real employees need M1's adapters. Run with I_INC_DEMO=1 to try the daemon with a scripted agent.",
  );
  process.exit(1);
}

mkdirSync(home, { recursive: true });
const app = await createApp({
  dbPath: join(home, "demo.db"),
  clock: { now: () => Date.now() },
  machines: new FakeMachines(),
  agent: new FakeAgent(),
  harness: new FakeHarness(),
  ...(process.env.I_INC_TOKEN ? { token: process.env.I_INC_TOKEN } : {}),
  log: (m) => console.log(new Date().toISOString(), m),
});
if (app.deps.registry.employees().length === 0) seedDemo(app.deps.registry);

await app.daemon.tick();
setInterval(() => void app.daemon.tick(), 30_000);

Bun.serve({ port, hostname: process.env.HOST ?? "127.0.0.1", fetch: app.handle });
console.log(`i.inc daemon on http://${process.env.HOST ?? "127.0.0.1"}:${port} (demo mode)`);
