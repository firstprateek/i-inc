// The /ahp socket: the locks on the upgrade, the limits on a connection, and that nothing leaks.
import { describe, expect, it } from "vitest";
import { AhpTransport, type BunSocket, type WsData } from "../../src/ahp/transport.ts";
import { ROOT } from "../../src/ahp/wire.ts";
import { same } from "../../src/auth.ts";
import { type Any, FakeSocket, rig, TestClient, turnStarted } from "./support.ts";

const TOKEN = "s3cret-token";
const upgrade = (headers: Record<string, string> = {}, url = "http://127.0.0.1:7420/ahp") =>
  new Request(url, {
    headers: { host: "127.0.0.1:7420", upgrade: "websocket", connection: "Upgrade", ...headers },
  });

async function transport(o: ConstructorParameters<typeof AhpTransport>[1] = {}, limits = {}) {
  const t = await rig({
    limits,
    ...(o.token ? { verifyToken: (x: string) => same(x, o.token as string) } : {}),
  });
  return { ...t, tr: new AhpTransport(t.host, o) };
}
const refused = (r: ReturnType<AhpTransport["guard"]>) => ("refusal" in r ? r.refusal.status : 0);

describe("the locks on the upgrade", () => {
  it("answers 401 with no login, accepts the cookie or a bearer token, refuses a wrong one", async () => {
    const t = await transport({ token: TOKEN });
    expect(refused(t.tr.guard(upgrade()))).toBe(401);
    expect(refused(t.tr.guard(upgrade({ cookie: "i_inc=wrong" })))).toBe(401);
    expect(refused(t.tr.guard(upgrade({ authorization: "Bearer wrong" })))).toBe(401);
    expect(refused(t.tr.guard(upgrade({ authorization: "Basic abc" })))).toBe(401);
    expect(t.tr.guard(upgrade({ cookie: `a=1; i_inc=${TOKEN}; b=2` }))).toEqual({ data: { authed: true } });
    expect(t.tr.guard(upgrade({ authorization: `Bearer ${TOKEN}` }))).toEqual({ data: { authed: true } });
    // a token in the URL is not a login: it ends up in logs
    expect(refused(t.tr.guard(upgrade({}, `http://127.0.0.1:7420/ahp?tkn=${TOKEN}`)))).toBe(401);
  });

  it("checks the Host header (421) and the Origin of a browser (403)", async () => {
    const t = await transport({ token: TOKEN, hosts: ["127.0.0.1:7420", "iinc.tail.ts.net"] });
    const ok = { cookie: `i_inc=${TOKEN}` };
    expect(refused(t.tr.guard(upgrade({ ...ok, host: "evil.example" })))).toBe(421);
    expect(refused(t.tr.guard(upgrade({ ...ok, origin: "https://evil.example" })))).toBe(403);
    expect(refused(t.tr.guard(upgrade({ ...ok, origin: "http://127.0.0.1:7421" })))).toBe(403);
    expect(refused(t.tr.guard(upgrade({ ...ok, origin: "null" })))).toBe(403);
    expect(t.tr.guard(upgrade({ ...ok, origin: "http://127.0.0.1:7420" }))).toHaveProperty("data");
    expect(
      t.tr.guard(upgrade({ ...ok, host: "iinc.tail.ts.net", origin: "https://iinc.tail.ts.net" })),
    ).toHaveProperty("data");
    // no Origin at all: not a browser (a CLI, the phone app's own client), the token is the lock
    expect(t.tr.guard(upgrade(ok))).toHaveProperty("data");
    // the login comes first: a wrong token from a wrong origin is a 401, as on the REST API
    expect(refused(t.tr.guard(upgrade({ origin: "https://evil.example" })))).toBe(401);
  });

  it("is open when the daemon has no token (demo mode), still checks the rest, and wants a real upgrade", async () => {
    const t = await transport({ hosts: ["127.0.0.1:7420"] });
    expect(t.tr.guard(upgrade())).toHaveProperty("data");
    expect(refused(t.tr.guard(upgrade({ origin: "https://evil.example" })))).toBe(403);
    expect(
      refused(t.tr.guard(new Request("http://127.0.0.1:7420/ahp", { headers: { host: "127.0.0.1:7420" } }))),
    ).toBe(426);
    expect(t.tr.matches(upgrade())).toBe(true);
    expect(t.tr.matches(new Request("http://127.0.0.1:7420/api/board"))).toBe(false);
  });

  it("refuses an upgrade with 503 when the host is full", async () => {
    const t = await transport({}, { maxConnections: 1 });
    t.client();
    expect(refused(t.tr.guard(upgrade()))).toBe(503);
  });
});

describe("authenticate (the protocol's own login)", () => {
  it("lets a client in without credentials only when asked to, and only to authenticate", async () => {
    const strict = await transport({ token: TOKEN });
    expect(refused(strict.tr.guard(upgrade()))).toBe(401);

    const t = await transport({ token: TOKEN, deferredAuth: true });
    const g = t.tr.guard(upgrade());
    expect(g).toEqual({ data: { authed: false } });
    const c = new TestClient(t.host, "late", false);
    // The spec has a client initialize first: it may, but it gets no state, even if it asks for some.
    const early = await c.rpc("initialize", {
      channel: ROOT,
      protocolVersions: ["1.0.0"],
      clientId: "late",
      initialSubscriptions: [ROOT],
    });
    expect(early.result).toMatchObject({ protocolVersion: "1.0.0", snapshots: [] });
    expect(c.conn.subs.size).toBe(0);
    expect((await c.rpc("listSessions", { channel: ROOT })).error).toMatchObject({ code: -32007 });
    expect((await c.rpc("subscribe", { channel: ROOT })).error).toMatchObject({ code: -32007 });
    expect(
      (
        await c.rpc("reconnect", {
          channel: ROOT,
          clientId: "l",
          lastSeenServerSeq: 0,
          subscriptions: [ROOT],
        })
      ).error,
    ).toMatchObject({ code: -32007 });
    expect(
      (await c.rpc("resourceRead", { channel: ROOT, uri: "ahp-content:/00000000000000000000000000000000" }))
        .error,
    ).toMatchObject({ code: -32007 });
    expect((await c.rpc("ping", { channel: ROOT })).result).toBeNull(); // ping works before anything
    expect(
      (await c.rpc("authenticate", { channel: ROOT, resource: "https://iinc", token: "nope" })).error,
    ).toMatchObject({ code: -32007 });
    expect(
      (await c.rpc("authenticate", { channel: ROOT, resource: "https://iinc", token: TOKEN })).result,
    ).toBeNull();
    expect(
      (await c.rpc("initialize", { channel: ROOT, protocolVersions: ["1.0.0"], clientId: "late" })).result,
    ).toBeTruthy();
    // and once in, authenticate is harmless
    expect(
      (await c.rpc("authenticate", { channel: ROOT, resource: "x", token: "anything" })).result,
    ).toBeNull();
  });

  it("keeps unauthenticated sockets in a small pool of their own, so they can't crowd out the owner", async () => {
    const t = await transport(
      { token: TOKEN, deferredAuth: true },
      { maxConnections: 3, maxUnauthenticated: 2 },
    );
    const strangers = [new TestClient(t.host, "a", false), new TestClient(t.host, "b", false)];
    expect(strangers).toHaveLength(2);
    // a third stranger is turned away, at the upgrade and at the host
    expect(refused(t.tr.guard(upgrade()))).toBe(503);
    const s = new FakeSocket();
    expect(t.host.connect(s, false)).toBeUndefined();
    expect(s.closed?.code).toBe(1013);
    // and the owner, with credentials, still gets in, up to the authenticated cap
    expect(t.tr.guard(upgrade({ authorization: `Bearer ${TOKEN}` }))).toEqual({ data: { authed: true } });
    for (let i = 0; i < 3; i++) new TestClient(t.host, `o${i}`);
    expect(refused(t.tr.guard(upgrade({ authorization: `Bearer ${TOKEN}` })))).toBe(503);
    // a stranger who authenticates into a full pool is let go, not squeezed in
    const late = strangers[0] as TestClient;
    const r = await late.rpc("authenticate", { channel: ROOT, resource: "x", token: TOKEN });
    expect(r.error).toBeTruthy();
    await Promise.resolve();
    expect(late.socket.closed?.code).toBe(1013);
  });

  it("drops a client that keeps guessing, and one that never authenticates", async () => {
    const t = await transport({ token: TOKEN, deferredAuth: true, authDeadlineMs: 30 });
    const guess = new TestClient(t.host, "g", false);
    for (let i = 0; i < 3; i++) await guess.rpc("authenticate", { resource: "x", token: `guess-${i}` });
    expect(guess.socket.closed?.code).toBe(1008);
    expect(t.host.connectionCount()).toBe(0);

    // through the Bun glue, which owns the deadline
    const ws = fakeBunSocket({ authed: false });
    t.tr.open(ws);
    expect(t.host.connectionCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 80));
    expect(ws.closed?.code).toBe(1008);
  });
});

/** Stands in for Bun's ServerWebSocket: what the transport glue needs, with controls for a test. */
function fakeBunSocket(data: WsData = { authed: true }) {
  const sock = {
    data,
    sent: [] as string[],
    sendResult: 1,
    buffered: 0,
    closed: undefined as { code?: number | undefined; reason?: string | undefined } | undefined,
    pings: 0,
    send(text: string) {
      this.sent.push(text);
      return this.sendResult;
    },
    close(code?: number, reason?: string) {
      this.closed = { code, reason };
    },
    ping() {
      this.pings++;
    },
    getBufferedAmount() {
      return this.buffered;
    },
  };
  return sock satisfies BunSocket;
}

describe("the Bun glue", () => {
  it("opens a connection, passes frames to the host, and forgets everything on close", async () => {
    const t = await transport();
    const ws = fakeBunSocket();
    t.tr.websocket.open(ws);
    expect(t.host.connectionCount()).toBe(1);
    t.tr.websocket.message(
      ws,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { channel: ROOT, protocolVersions: ["1.0.0"], clientId: "x", initialSubscriptions: [ROOT] },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({ id: 1, result: { protocolVersion: "1.0.0" } });
    // a binary frame is read as text too
    t.tr.websocket.message(
      ws,
      Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping", params: {} })),
    );
    expect(JSON.parse(ws.sent[1] ?? "{}")).toMatchObject({ id: 2, result: null });
    expect(ws.data.conn?.subs.has(ROOT)).toBe(true);
    t.tr.websocket.close(ws);
    expect(t.host.connectionCount()).toBe(0);
    expect(ws.data.conn?.subs.size).toBe(0);
  });

  it("drops a connection whose frame the socket cannot take, and pongs count as life", async () => {
    const t = await transport();
    const ws = fakeBunSocket();
    t.tr.websocket.open(ws);
    t.tr.websocket.message(
      ws,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { channel: ROOT, protocolVersions: ["1.0.0"], clientId: "x", initialSubscriptions: [ROOT] },
      }),
    );
    ws.sendResult = 0; // Bun: the frame was dropped
    await t.host.createSession({ provider: "fake" }).catch(() => undefined);
    await t.session();
    expect(ws.closed?.code).toBe(1011);
    expect(t.host.connectionCount()).toBe(0);

    const live = fakeBunSocket();
    t.tr.websocket.open(live);
    const before = live.data.conn?.lastActive ?? 0;
    t.time.now += 1000;
    t.tr.websocket.pong(live);
    expect(live.data.conn?.lastActive).toBe(before + 1000);
  });

  it("starts and stops its keepalive timer, and exposes the limits to Bun.serve", async () => {
    const t = await transport({ keepaliveMs: 10, idleTimeoutSec: 7 }, { maxMessageBytes: 1234 });
    expect(t.tr.websocket).toMatchObject({
      maxPayloadLength: 1234,
      idleTimeout: 7,
      sendPings: true,
      closeOnBackpressureLimit: true,
    });
    const ws = fakeBunSocket();
    t.tr.websocket.open(ws);
    t.tr.start();
    t.tr.start(); // idempotent
    await new Promise((r) => setTimeout(r, 60));
    t.tr.stop();
    expect(ws.pings).toBeGreaterThan(1);
    const n = ws.pings;
    await new Promise((r) => setTimeout(r, 40));
    expect(ws.pings).toBe(n);
  });
});

describe("limits on a connection", () => {
  it("closes a connection that sends a frame over the size limit, without reading it", async () => {
    const t = await rig({ limits: { maxMessageBytes: 200 } });
    const c = t.client();
    await c.init();
    await t.host.receive(
      c.conn,
      JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping", params: { pad: "x".repeat(300) } }),
    );
    expect(c.socket.closed?.code).toBe(1009);
    expect(c.socket.frames.find((f) => f.id === 9)).toBeUndefined();
    expect(t.host.connectionCount()).toBe(0);
  });

  it("drops a slow consumer instead of buffering without end, and the others carry on", async () => {
    const t = await rig({ limits: { maxBufferedBytes: 1000 } });
    const { session, chat } = await t.session();
    const slow = t.client("slow");
    const fast = t.client("fast");
    await slow.init([ROOT, session, chat]);
    await fast.init([ROOT, session, chat]);
    slow.socket.buffered = 5000; // the peer is not reading
    fast.dispatch(chat, turnStarted("go", "t1"));
    await t.host.idle();
    expect(slow.socket.closed?.code).toBe(1013);
    expect(slow.socket.closed?.reason).toMatch(/slow consumer/);
    expect(t.host.connectionCount()).toBe(1);
    expect(slow.conn.subs.size).toBe(0);
    const sentToSlow = slow.socket.frames.length;
    expect(fast.state<Any>(chat).turns).toHaveLength(1); // the fast one saw it all
    // later traffic never touches the dropped socket
    fast.dispatch(chat, turnStarted("again", "t2"));
    await t.host.idle();
    expect(slow.socket.frames.length).toBe(sentToSlow);
    // and the slow client comes back by reconnecting and replaying what it missed
    slow.socket.buffered = 0;
    const back = t.client("slow");
    const r = await back.reconnect(slow.lastSeq, [ROOT, session, chat]);
    expect(r.type).toBe("replay");
    expect(back.lastSeq).toBe(t.host.serverSeq);
  });

  it("drops a connection whose socket throws on send", async () => {
    const t = await rig();
    const { chat } = await t.session();
    const gone = t.client();
    await gone.init([ROOT, chat]);
    gone.socket.throwOnSend = true;
    const other = t.client();
    await other.init([ROOT, chat]);
    other.dispatch(chat, turnStarted("go"));
    await t.host.idle();
    expect(t.host.connectionCount()).toBe(1);
    expect(gone.socket.closed?.code).toBe(1011);
  });

  it("closes a connection that floods it, then lets a calm one through", async () => {
    const t = await rig({ limits: { maxMessagesPerSecond: 5 } });
    const c = t.client();
    for (let i = 0; i < 5; i++) expect((await c.rpc("ping", { channel: ROOT })).result).toBeNull();
    await c.rpc("ping", { channel: ROOT }).catch(() => undefined);
    expect(c.socket.closed?.code).toBe(1008);
    const calm = t.client();
    for (let i = 0; i < 5; i++) await calm.rpc("ping", { channel: ROOT });
    t.time.now += 1500;
    for (let i = 0; i < 5; i++) await calm.rpc("ping", { channel: ROOT });
    expect(calm.socket.closed).toBeUndefined();
  });

  it("limits subscriptions per connection, in initialize, subscribe and reconnect", async () => {
    const t = await rig({ limits: { maxSubscriptions: 2 } });
    const a = await t.session();
    const b = await t.session();
    const c = t.client();
    await c.init([ROOT, a.chat]);
    expect((await c.rpc("subscribe", { channel: b.chat })).error).toMatchObject({ code: -32602 });
    expect((await c.rpc("subscribe", { channel: a.chat })).result).toBeTruthy(); // already held: fine
    c.notify("unsubscribe", { channel: a.chat });
    expect((await c.rpc("subscribe", { channel: b.chat })).result).toBeTruthy();
    const d = t.client();
    expect(
      (
        await d.rpc("initialize", {
          channel: ROOT,
          protocolVersions: ["1.0.0"],
          clientId: "d",
          initialSubscriptions: [ROOT, a.chat, b.chat],
        })
      ).error,
    ).toMatchObject({ code: -32602 });
    expect(
      (
        await t.client().rpc("reconnect", {
          channel: ROOT,
          clientId: "e",
          lastSeenServerSeq: 0,
          subscriptions: [ROOT, a.chat, b.chat],
        })
      ).error,
    ).toMatchObject({ code: -32602 });
  });

  it("refuses connections beyond the cap, closing the socket", async () => {
    const t = await rig({ limits: { maxConnections: 2 } });
    t.client();
    t.client();
    const s = new FakeSocket();
    expect(t.host.connect(s)).toBeUndefined();
    expect(s.closed?.code).toBe(1013);
    expect(t.host.connectionCount()).toBe(2);
  });
});

describe("keepalive", () => {
  it("pings every connection and closes the ones that went quiet", async () => {
    const t = await rig({ limits: { idleCloseMs: 90_000 } });
    const quiet = t.client();
    const chatty = t.client();
    await quiet.init();
    await chatty.init();
    t.host.keepalive();
    expect(quiet.socket.pings).toBe(1);
    expect(chatty.socket.pings).toBe(1);
    t.time.now += 60_000;
    await chatty.rpc("ping", { channel: ROOT }); // any frame is a sign of life
    t.time.now += 40_000;
    t.host.keepalive();
    expect(quiet.socket.closed?.code).toBe(1001);
    expect(chatty.socket.closed).toBeUndefined();
    expect(t.host.connectionCount()).toBe(1);
    // a pong counts too
    t.time.now += 60_000;
    t.host.touch(chatty.conn);
    t.time.now += 60_000;
    t.host.keepalive();
    expect(chatty.socket.closed).toBeUndefined();
  });
});

describe("no leaks", () => {
  it("forgets a connection's subscriptions and windows when it goes, and sends it nothing more", async () => {
    const t = await rig();
    const { session, chat } = await t.session();
    const live = t.client();
    await live.init([ROOT, session, chat]);
    const clients: TestClient[] = [];
    for (let i = 0; i < 20; i++) {
      const c = t.client();
      await c.init([ROOT, session]);
      await c.subscribe(chat, { turns: 1 });
      clients.push(c);
    }
    expect(t.host.connectionCount()).toBe(21);
    for (const c of clients) c.disconnect();
    expect(t.host.connectionCount()).toBe(1);
    for (const c of clients) {
      expect(c.conn.subs.size).toBe(0);
      expect(c.conn.windows.size).toBe(0);
      expect(c.conn.closed).toBe(true);
    }
    const frames = clients.map((c) => c.socket.frames.length);
    live.dispatch(chat, turnStarted("hi", "t1"));
    await t.host.idle();
    expect(clients.map((c) => c.socket.frames.length)).toEqual(frames);
    // disconnecting twice, or closing the host, is harmless
    clients[0]?.disconnect();
    t.host.close();
    expect(t.host.connectionCount()).toBe(0);
    expect(live.socket.closed?.code).toBe(1001);
  });

  it("stops a running turn when the host closes", async () => {
    const t = await rig();
    const { chat } = await t.session();
    const c = t.client();
    await c.init([ROOT, chat]);
    t.backend.script = (run) =>
      new Promise((resolve) => run.signal.addEventListener("abort", () => resolve({ kind: "cancelled" })));
    c.dispatch(chat, turnStarted("long", "t1"));
    await new Promise((r) => setTimeout(r, 0));
    t.host.close();
    await t.host.idle();
    expect(t.backend.runs[0]?.signal.aborted).toBe(true);
  });
});
