// AHP over a WebSocket at /ahp on the daemon's own Bun.serve (same port, same login).
//
// One JSON-RPC message per text frame (spec: Transport). Before the socket exists the HTTP upgrade
// goes through the same locks as the REST API: the `i_inc` cookie or a bearer token (401), the Host
// allow-list (421) and, because browsers attach cookies to cross-site WebSocket handshakes, an Origin
// allow-list (403; SameSite=Strict is the first lock, this is the second). The protocol's own
// `authenticate` is accepted too, when `deferredAuth` lets a client in without credentials: it must
// then push the token within seconds or it is dropped.
//
// Everything about the socket's health lives here (keepalive pings under the HTTP idle timeout,
// a hard frame size, closing on error); what a frame means is the host's business.
import { credential, hostAllowed, originAllowed, sessionCookie } from "../auth.ts";
import type { AhpHost, Conn, Socket } from "./host.ts";

export interface TransportOptions {
  /** The login token. Unset: no login (demo mode and tests), like the REST API. */
  token?: string;
  /**
   * Live browser sessions: the `i_inc` cookie may hold one (web-sessions.ts). A socket opened with one is
   * bound to it: it is closed when the session is revoked (sign-out) or expires, and a frame that arrives
   * after that is dropped.
   */
  sessions?: { valid(raw: string): boolean; onRevoke?(f: () => void): void };
  /** The Host headers it answers, such as "127.0.0.1:7420". Unset: any. */
  hosts?: string[];
  /** Let a client upgrade without credentials and push the token with `authenticate` instead. */
  deferredAuth?: boolean;
  /** Protocol-level ping interval. Must stay under the server's idle timeout (60 s). */
  keepaliveMs?: number;
  /** How long a client that upgraded without credentials has to authenticate. */
  authDeadlineMs?: number;
  /** The WebSocket's idle timeout in seconds (Bun closes a socket with no traffic for this long). */
  idleTimeoutSec?: number;
}

export const AHP_PATH = "/ahp";

export interface WsData {
  authed: boolean;
  /** The browser session this socket was opened with, if it was (not for a bearer token). */
  session?: string;
  conn?: Conn;
  deadline?: ReturnType<typeof setTimeout>;
}

/** The part of Bun's ServerWebSocket we use, so the glue can be tested with a stand-in. */
export interface BunSocket {
  data: WsData;
  send(text: string): number;
  close(code?: number, reason?: string): void;
  ping(): void;
  getBufferedAmount(): number;
}

export class AhpTransport {
  private timer: ReturnType<typeof setInterval> | undefined;

  private readonly handlers: ReturnType<AhpTransport["makeHandlers"]>;
  /** The open sockets that ride on a browser session. */
  private readonly bound = new Set<BunSocket>();

  constructor(
    readonly host: AhpHost,
    private readonly o: TransportOptions = {},
  ) {
    this.handlers = this.makeHandlers();
    o.sessions?.onRevoke?.(() => this.sweep());
  }

  /** Closes every socket whose session is gone (signed out, or expired). */
  sweep(): void {
    for (const ws of [...this.bound]) {
      const s = ws.data.session;
      if (s !== undefined && !this.o.sessions?.valid(s)) this.signedOut(ws);
    }
  }

  private signedOut(ws: BunSocket): void {
    this.bound.delete(ws);
    ws.close(1008, "signed out");
  }

  /** Is this request for the AHP socket? */
  matches(req: Request): boolean {
    return new URL(req.url).pathname === AHP_PATH;
  }

  /**
   * The locks on the upgrade. A refusal to send back, or undefined to upgrade. `data` is what to
   * hand to `server.upgrade`.
   */
  guard(req: Request): { refusal: Response } | { data: WsData } {
    const no = (status: number, error: string) => ({
      refusal: new Response(JSON.stringify({ error }), {
        status,
        headers: { "content-type": "application/json" },
      }),
    });
    let authed = true;
    let session: string | undefined;
    if (this.o.token) {
      const how = credential(req, this.o.token, this.o.sessions);
      if (!how) {
        if (!this.o.deferredAuth) return no(401, "unauthorized");
        authed = false;
      } else if (how === "session") session = sessionCookie(req);
    }
    const host = req.headers.get("host") ?? "";
    if (!hostAllowed(this.o.hosts, host)) return no(421, `not served as ${host}`);
    if (!originAllowed(this.o.hosts, req.headers.get("origin")))
      return no(403, "cross-site websocket refused");
    if (req.method !== "GET" || req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return no(426, "websocket upgrade required");
    }
    if (this.host.full(authed)) return no(503, "too many connections");
    return { data: { authed, ...(session !== undefined ? { session } : {}) } };
  }

  /** `websocket` for Bun.serve. */
  get websocket() {
    return this.handlers;
  }

  private makeHandlers() {
    return {
      // Frames above this are closed by the server itself (1009), before they are buffered whole.
      maxPayloadLength: this.host.limits.maxMessageBytes,
      // The server's HTTP idle timeout is 60 s; pings every 25 s (below) keep a quiet socket well inside it.
      idleTimeout: this.o.idleTimeoutSec ?? 60,
      sendPings: true,
      backpressureLimit: this.host.limits.maxBufferedBytes * 2,
      closeOnBackpressureLimit: true,
      open: (ws: BunSocket) => this.open(ws),
      message: (ws: BunSocket, m: string | Buffer | ArrayBuffer | Uint8Array) => this.message(ws, m),
      pong: (ws: BunSocket) => {
        if (ws.data.conn) this.host.touch(ws.data.conn);
      },
      close: (ws: BunSocket) => this.close(ws),
    };
  }

  open(ws: BunSocket): void {
    const socket: Socket = {
      send: (text) => {
        // 0 means the frame was dropped; the host would rather lose the connection than a frame.
        if (ws.send(text) === 0) throw new Error("frame dropped");
      },
      close: (code, reason) => ws.close(code, reason),
      bufferedAmount: () => ws.getBufferedAmount(),
      ping: () => ws.ping(),
    };
    const conn = this.host.connect(socket, ws.data.authed);
    if (!conn) return; // the host closed it
    ws.data.conn = conn;
    if (ws.data.session !== undefined) this.bound.add(ws);
    if (!ws.data.authed) {
      ws.data.deadline = setTimeout(() => {
        if (!conn.authed) ws.close(1008, "authenticate first");
      }, this.o.authDeadlineMs ?? 10_000);
      ws.data.deadline.unref?.();
    }
  }

  message(ws: BunSocket, m: string | Buffer | ArrayBuffer | Uint8Array): void {
    const conn = ws.data.conn;
    if (!conn) return;
    // Signed out (or expired) since the last frame: nothing more is read from this socket.
    if (ws.data.session !== undefined && !this.o.sessions?.valid(ws.data.session)) {
      this.signedOut(ws);
      return;
    }
    const text = typeof m === "string" ? m : Buffer.from(m as ArrayBuffer).toString("utf8");
    void Promise.resolve(this.host.receive(conn, text)).catch(() => {});
  }

  close(ws: BunSocket): void {
    if (ws.data.deadline) clearTimeout(ws.data.deadline);
    this.bound.delete(ws);
    if (ws.data.conn) this.host.disconnect(ws.data.conn);
  }

  /** Starts the keepalive pings and the idle reaper. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sweep(); // a session that expired closes its sockets
      this.host.keepalive();
    }, this.o.keepaliveMs ?? 25_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
