// Run by `bun` from bun.test.ts: the AHP host and transport on a real Bun.serve, with a scripted agent.
// Prints {"port": N} when it is listening.
import { AhpHost } from "../../src/ahp/host.ts";
import { AhpTransport, type WsData } from "../../src/ahp/transport.ts";
import { same } from "../../src/auth.ts";
import { openDb } from "../../src/db.ts";
import { ScriptedBackend } from "./support.ts";

const token = process.env.TOKEN ?? "tok";
const backend = new ScriptedBackend();
const host = new AhpHost({
  db: await openDb(":memory:"),
  backend,
  verifyToken: (t) => same(t, token),
  limits: { maxMessageBytes: 64 * 1024 },
});
const transport = new AhpTransport(host, {
  token,
  keepaliveMs: Number(process.env.KEEPALIVE_MS ?? 300),
  idleTimeoutSec: Number(process.env.IDLE_SEC ?? 1),
});
transport.start();
const made = await host.createSession({ provider: "fake" });
const server = Bun.serve<WsData>({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 60,
  fetch(req, srv) {
    if (!transport.matches(req)) return new Response("not found", { status: 404 });
    const g = transport.guard(req);
    if ("refusal" in g) return g.refusal;
    if (srv.upgrade(req, { data: g.data })) return undefined;
    return new Response("upgrade failed", { status: 400 });
  },
  websocket: transport.websocket,
});
console.log(JSON.stringify({ port: server.port, ...made }));
