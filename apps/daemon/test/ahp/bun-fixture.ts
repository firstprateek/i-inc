// Run by `bun` from bun.test.ts: the AHP host and transport on a real Bun.serve, with a scripted agent.
// Prints {"port": N} when it is listening.
import { AhpHost } from "../../src/ahp/host.ts";
import { AhpTransport, type WsData } from "../../src/ahp/transport.ts";
import { same } from "../../src/auth.ts";
import { openDb } from "../../src/db.ts";
import { migrate } from "../../src/schema.ts";
import { WebSessions } from "../../src/web-sessions.ts";
import { ScriptedBackend } from "./support.ts";

const token = process.env.TOKEN ?? "tok";
const backend = new ScriptedBackend();
const host = new AhpHost({
  db: await openDb(":memory:"),
  backend,
  verifyToken: (t) => same(t, token),
  limits: { maxMessageBytes: 64 * 1024 },
});
// Browser sessions on a clock the test can move (/__advance), so expiry is testable on a real socket.
const authDb = await openDb(":memory:");
migrate(authDb);
let now = Date.now();
const sessions = new WebSessions(authDb, () => now);
const transport = new AhpTransport(host, {
  token,
  sessions,
  keepaliveMs: Number(process.env.KEEPALIVE_MS ?? 300),
  idleTimeoutSec: Number(process.env.IDLE_SEC ?? 1),
});
transport.start();
const made = await host.createSession({ provider: "fake" });
const server = Bun.serve<WsData>({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 60,
  async fetch(req, srv) {
    const url = new URL(req.url);
    // Test controls, on the loopback port of a throwaway fixture.
    if (url.pathname === "/__session") return Response.json(sessions.create());
    if (url.pathname === "/__revoke") {
      sessions.revoke(url.searchParams.get("token") ?? "");
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__advance") {
      now += Number(url.searchParams.get("ms"));
      return Response.json({ ok: true });
    }
    if (!transport.matches(req)) return new Response("not found", { status: 404 });
    const g = transport.guard(req);
    if ("refusal" in g) return g.refusal;
    if (srv.upgrade(req, { data: g.data })) return undefined;
    return new Response("upgrade failed", { status: 400 });
  },
  websocket: transport.websocket,
});
console.log(JSON.stringify({ port: server.port, ...made }));
