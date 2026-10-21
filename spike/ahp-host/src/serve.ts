// The transport: AHP over a Bun.serve WebSocket at /ahp, one JSON-RPC message per text frame (spec: Transport).
// Auth is the daemon's own (apps/daemon/src/api.ts `authorized`): the `i_inc` cookie or a bearer token, checked
// during the HTTP upgrade, before any AHP message. Origin is checked too, because browsers attach cookies to
// cross-site WebSocket handshakes (SameSite=Strict stops that, the Origin check is the second lock).
import { timingSafeEqual } from "node:crypto";
import type { AhpHost, Conn } from "./host.ts";

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function authorized(req: Request, token: string): boolean {
  const bearer = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  const cookie = /(?:^|;\s*)i_inc=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
  // `?tkn=` is VS Code's own convention for a remote agent host's connection token (chat.remoteAgentHosts);
  // accepting it is what would let VS Code attach. Tokens in URLs end up in logs, so keep it tailnet-only.
  const tkn = new URL(req.url).searchParams.get("tkn") ?? undefined;
  return [bearer, cookie, tkn].some((t) => t !== undefined && same(t, token));
}

export interface ServeOptions {
  port: number;
  hostname?: string;
  token?: string;
  /** Allowed Origin values for browser clients (e.g. https://i-inc.tailnet.ts.net). */
  origins?: string[];
}

/** For the daemon: call `upgradeAhp` from the existing fetch handler and spread `ahpWebsocket(host)` into Bun.serve. */
export function ahpWebsocket(host: AhpHost) {
  let nextId = 1;
  return {
    open(ws: Bun.ServerWebSocket<{ conn?: Conn }>) {
      const conn: Conn = { id: nextId++, subs: new Set(), send: (m) => ws.send(JSON.stringify(m)) };
      ws.data.conn = conn;
      host.addConn(conn);
    },
    message(ws: Bun.ServerWebSocket<{ conn?: Conn }>, m: string | Buffer) {
      void host.handle(ws.data.conn!, typeof m === "string" ? m : m.toString("utf8"));
    },
    close(ws: Bun.ServerWebSocket<{ conn?: Conn }>) {
      if (ws.data.conn) host.dropConn(ws.data.conn);
    },
    // Tailscale Serve and most proxies close idle sockets; the AHP client sends `ping`, and Bun answers
    // protocol-level pings itself. 120 s idle keeps a quiet phone connection alive.
    idleTimeout: 120,
    sendPings: true,
  };
}

export function upgradeAhp(req: Request, server: Bun.Server<{ conn?: Conn }>, o: Pick<ServeOptions, "token" | "origins">): Response | undefined {
  if (new URL(req.url).pathname !== "/ahp") return undefined;
  if (o.token && !authorized(req, o.token)) return new Response("unauthorized", { status: 401 });
  const origin = req.headers.get("origin");
  if (origin && o.origins && !o.origins.includes(origin)) return new Response("cross-site websocket refused", { status: 403 });
  if (server.upgrade(req, { data: {} })) return undefined as never;
  return new Response("websocket upgrade required", { status: 426 });
}

export function serve(host: AhpHost, o: ServeOptions) {
  return Bun.serve<{ conn?: Conn }>({
    port: o.port,
    hostname: o.hostname ?? "127.0.0.1",
    fetch(req, server) {
      const r = upgradeAhp(req, server, o);
      if (r) return r;
      if (new URL(req.url).pathname === "/ahp") return undefined as never; // upgraded
      return new Response("not found", { status: 404 });
    },
    websocket: ahpWebsocket(host),
  });
}
