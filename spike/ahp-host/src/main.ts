// Standalone host process for the demo: PORT, DB, TOKEN, SNAPSHOT_EVERY, PRUNE=1 (prune the log below snapshots on start).
import { dirname } from "node:path";
import { AhpHost } from "./host.ts";
import { serve } from "./serve.ts";

const dir = dirname(new URL(import.meta.url).pathname);
const host = new AhpHost({
  dbPath: process.env.DB ?? "ahp-spike.db",
  agent: ["bun", `${dir}/fake-acp-agent.ts`],
  snapshotEvery: Number(process.env.SNAPSHOT_EVERY ?? 50),
  log: (m) => console.log(`[host] ${m}`),
});
if (process.env.PRUNE === "1") host.pruneToSnapshots();
const server = serve(host, { port: Number(process.env.PORT ?? 4100), token: process.env.TOKEN });
console.log(`[host] listening ws://127.0.0.1:${server.port}/ahp`);
process.on("SIGTERM", () => {
  host.close();
  process.exit(0);
});
