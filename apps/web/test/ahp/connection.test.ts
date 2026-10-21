import { afterEach, describe, expect, it } from "vitest";
import { AhpConnection } from "../../src/ahp/connection.ts";
import { ActionType, ROOT, ToolCallStatus, USER_ORIGIN } from "../../src/ahp/wire.ts";
import { CHAT, chatState, hosts, SESSION, tick, until } from "./fake-host.ts";

// biome-ignore lint/suspicious/noExplicitAny: scripted JSON.
type Any = any;

const micro = (fn: () => void) => {
  let off = false;
  queueMicrotask(() => {
    if (!off) fn();
  });
  return () => {
    off = true;
  };
};

const open: AhpConnection[] = [];
afterEach(() => {
  for (const c of open.splice(0)) c.stop();
});

function setup(o: Partial<ConstructorParameters<typeof AhpConnection>[0]> = {}) {
  const h = hosts();
  const conn = new AhpConnection({
    connect: h.connect,
    clientId: "me",
    backoff: () => 5,
    schedule: micro,
    pingMs: 0,
    ...o,
  });
  open.push(conn);
  return { h, conn };
}

const delta = (partId: string, content: string, turnId = "t1") => ({
  type: "chat/delta",
  turnId,
  partId,
  content,
});
const turnStarted = (turnId = "t1") => ({
  type: "chat/turnStarted",
  turnId,
  startedAt: "2026-10-21T10:00:01.000Z",
  message: { text: "hi", origin: USER_ORIGIN },
});
const mdPart = (turnId = "t1") => ({
  type: "chat/responsePart",
  turnId,
  part: { kind: "markdown", id: "p1", content: "" },
});
const active = (conn: AhpConnection) => conn.chat(CHAT)?.activeTurn?.responseParts;
const text = (conn: AhpConnection) =>
  (active(conn)?.[0] as Any)?.content ?? (conn.chat(CHAT)?.turns.at(-1)?.responseParts[0] as Any)?.content;

describe("AhpConnection", () => {
  it("connects, subscribes, and applies actions in serverSeq order", async () => {
    const { h, conn } = setup();
    const seen: string[][] = [];
    conn.onChange((u) => seen.push([...u]));
    conn.start();
    conn.watch(SESSION);
    conn.watch(CHAT);
    await until(() => conn.info.status === "open" && conn.chat(CHAT) && conn.session(SESSION));
    expect(conn.root()).toEqual({ agents: [] });
    const host = h.made[0];
    if (!host) throw new Error("no host");
    host.send(CHAT, turnStarted());
    host.send(CHAT, mdPart());
    for (const w of ["a", "b", "c", "d"]) host.send(CHAT, delta("p1", w));
    await until(() => text(conn) === "abcd");
    // a duplicate (an action a snapshot or replay already had) is skipped, not applied twice
    host.transport.send({
      jsonrpc: "2.0",
      method: "action",
      params: { channel: CHAT, action: delta("p1", "d"), serverSeq: host.seq },
    } as never);
    await tick(10);
    expect(text(conn)).toBe("abcd");
    expect(conn.lastSeenServerSeq).toBe(host.seq);
  });

  it("notifies at most once per animation frame, however many deltas arrive", async () => {
    const frames: (() => void)[] = [];
    const { h, conn } = setup({
      schedule: (fn) => {
        frames.push(fn);
        return () => {};
      },
    });
    conn.start();
    conn.watch(CHAT);
    await until(() => conn.chat(CHAT));
    for (const f of frames.splice(0)) f();
    let calls = 0;
    conn.onChange(() => calls++);
    const host = h.made[0] as NonNullable<(typeof h.made)[number]>;
    host.send(CHAT, turnStarted());
    host.send(CHAT, mdPart());
    for (let i = 0; i < 500; i++) host.send(CHAT, delta("p1", "x"));
    await until(() => text(conn)?.length === 500);
    expect(frames.length).toBe(1);
    for (const f of frames.splice(0)) f();
    expect(calls).toBe(1);
  });

  it("reconnects after a drop, asking for a replay from the last serverSeq it saw", async () => {
    const { h, conn } = setup();
    conn.start();
    conn.watch(CHAT);
    await until(() => conn.info.status === "open" && conn.chat(CHAT));
    const first = h.made[0] as NonNullable<(typeof h.made)[number]>;
    first.send(CHAT, turnStarted());
    await until(() => conn.chat(CHAT)?.activeTurn);
    const statuses: string[] = [];
    conn.onInfo((i) => statuses.push(i.status));
    await first.drop();
    await until(() => conn.info.status === "open" && h.made.length === 2, 3000);
    expect(statuses).toContain("reconnecting");
    const asked = h.made[1]?.received.find((m) => m.method === "reconnect");
    expect(asked?.params).toMatchObject({ clientId: "me", lastSeenServerSeq: first.seq });
  });

  it("replays what it missed", async () => {
    const { h, conn } = setup();
    conn.start();
    conn.watch(CHAT);
    await until(() => conn.info.status === "open" && conn.chat(CHAT));
    const first = h.made[0] as NonNullable<(typeof h.made)[number]>;
    first.send(CHAT, turnStarted());
    first.send(CHAT, mdPart());
    first.send(CHAT, delta("p1", "one "));
    await until(() => text(conn) === "one ");
    const seen = conn.lastSeenServerSeq as number;
    // the connection drops; two deltas happen while the client is away
    const seenAt = seen;
    h.onConnect = (second) => {
      second.seq = seenAt + 2;
      second.onReconnect = (p) => {
        expect(p.lastSeenServerSeq).toBe(seenAt);
        expect(p.subscriptions).toContain(CHAT);
        return {
          type: "replay",
          missing: [],
          actions: [
            { channel: CHAT, action: delta("p1", "one "), serverSeq: seenAt },
            { channel: CHAT, action: delta("p1", "two "), serverSeq: seenAt + 1 },
            { channel: CHAT, action: delta("p1", "three"), serverSeq: seenAt + 2 },
          ],
        };
      };
    };
    await first.drop();
    await until(() => conn.info.status === "open" && text(conn) === "one two three", 3000);
    expect(conn.info.everOpen).toBe(true);
    expect(conn.lastSeenServerSeq).toBe(seen + 2);
  });

  it("falls back to a snapshot when the host cannot replay", async () => {
    const { h, conn } = setup();
    conn.start();
    conn.watch(CHAT);
    await until(() => conn.info.status === "open" && conn.chat(CHAT));
    const first = h.made[0] as NonNullable<(typeof h.made)[number]>;
    first.send(CHAT, turnStarted());
    await until(() => conn.chat(CHAT)?.activeTurn);
    h.onConnect = (second) => {
      second.onReconnect = () => ({
        type: "snapshot",
        snapshots: [
          { resource: ROOT, state: { agents: [{ provider: "opus" }] }, fromSeq: 900 },
          { resource: CHAT, state: chatState({ title: "From the snapshot", turns: [] }), fromSeq: 900 },
        ],
      });
    };
    await first.drop();
    await until(() => conn.info.status === "open" && conn.chat(CHAT)?.title === "From the snapshot", 3000);
    expect(conn.chat(CHAT)?.activeTurn).toBeUndefined();
    expect(conn.root()?.agents).toHaveLength(1);
  });

  it("starts fresh when the host does not know the client at all", async () => {
    const { h, conn } = setup();
    conn.start();
    conn.watch(CHAT);
    await until(() => conn.info.status === "open" && conn.chat(CHAT));
    (h.made[0] as NonNullable<(typeof h.made)[number]>).send(CHAT, turnStarted());
    await until(() => conn.chat(CHAT)?.activeTurn);
    await (h.made[0] as NonNullable<(typeof h.made)[number]>).drop();
    // the default FakeHost answers reconnect with an error: the client initializes again
    await until(() => conn.info.status === "open" && h.made.length === 2, 3000);
    const second = h.made[1] as NonNullable<(typeof h.made)[number]>;
    expect(second.received.map((m) => m.method)).toContain("initialize");
    expect(conn.chat(CHAT)?.activeTurn?.id).toBe("t1");
  });

  it("shows a reconnecting state while the host is unreachable, and keeps trying with growing waits", async () => {
    const waits: number[] = [];
    const { h, conn } = setup({
      backoff: (n) => {
        waits.push(n);
        return 3;
      },
    });
    h.failNext(3);
    conn.start();
    await until(() => conn.info.status === "open", 3000);
    expect(waits).toEqual([1, 2, 3]);
    expect(conn.info.attempt).toBe(0);
    expect(conn.info.error).toBeNull();
  });

  it("says first connecting, then reconnecting, once it has been open", async () => {
    const { h, conn } = setup({ backoff: () => 200 });
    conn.start();
    await until(() => conn.info.status === "open");
    h.failNext(5);
    await (h.made[0] as NonNullable<(typeof h.made)[number]>).drop();
    await until(() => conn.info.status === "reconnecting");
    expect(conn.info.retryAt).toBeGreaterThan(Date.now());
    conn.retryNow();
    await tick(20);
    expect(conn.info.status).toBe("reconnecting");
  });

  it("shows the outcome when another client answered a confirmation first, not an error", async () => {
    const { h, conn } = setup();
    const rejected: Any[] = [];
    conn.onRejected((r) => rejected.push(r));
    conn.start();
    conn.watch(CHAT);
    await until(() => conn.chat(CHAT));
    const host = h.made[0] as NonNullable<(typeof h.made)[number]>;
    host.send(CHAT, turnStarted());
    host.send(CHAT, {
      type: "chat/toolCallStart",
      turnId: "t1",
      toolCallId: "tc1",
      toolName: "edit",
      displayName: "Edit a",
    });
    host.send(CHAT, {
      type: "chat/toolCallReady",
      turnId: "t1",
      toolCallId: "tc1",
      invocationMessage: "Edit a",
      options: [{ id: "allow-once", label: "Allow once", kind: "approve", group: 0 }],
    });
    const call = () => (active(conn)?.[0] as Any)?.toolCall;
    await until(() => call()?.status === ToolCallStatus.PendingConfirmation);
    // another device answers first...
    host.send(
      CHAT,
      {
        type: "chat/toolCallConfirmed",
        turnId: "t1",
        toolCallId: "tc1",
        approved: true,
        confirmed: "user-action",
        selectedOptionId: "allow-once",
      },
      { clientId: "phone", clientSeq: 4 },
    );
    await until(() => call()?.status === ToolCallStatus.Running);
    // ...and this client's own, later answer is refused
    const answer = {
      type: ActionType.ChatToolCallConfirmed,
      turnId: "t1",
      toolCallId: "tc1",
      approved: true,
      confirmed: "user-action",
    } as never;
    const sent = conn.dispatch(CHAT, answer);
    expect(sent.ok).toBe(true);
    host.reject(
      CHAT,
      answer,
      { clientId: "me", clientSeq: 1 },
      "that call is no longer waiting for an answer",
    );
    await until(() => rejected.length === 1);
    expect(rejected[0].reason).toMatch(/no longer waiting/);
    expect(conn.confirmation("tc1")).toEqual({ byMe: false, approved: true, optionId: "allow-once" });
    expect(call().status).toBe(ToolCallStatus.Running);
    expect(conn.info.status).toBe("open");
  });

  it("remembers that it was this client that answered", async () => {
    const { h, conn } = setup();
    conn.start();
    conn.watch(CHAT);
    await until(() => conn.chat(CHAT));
    const host = h.made[0] as NonNullable<(typeof h.made)[number]>;
    host.send(CHAT, turnStarted());
    host.send(CHAT, {
      type: "chat/toolCallStart",
      turnId: "t1",
      toolCallId: "tc1",
      toolName: "edit",
      displayName: "Edit a",
    });
    host.send(CHAT, {
      type: "chat/toolCallReady",
      turnId: "t1",
      toolCallId: "tc1",
      invocationMessage: "Edit a",
    });
    host.send(
      CHAT,
      { type: "chat/toolCallConfirmed", turnId: "t1", toolCallId: "tc1", approved: false, reason: "denied" },
      { clientId: "me", clientSeq: 9 },
    );
    await until(() => conn.confirmation("tc1"));
    expect(conn.confirmation("tc1")?.byMe).toBe(true);
  });

  it("pages older turns with fetchTurns, and takes a bigger window when the host forgot the cursor", async () => {
    const { h, conn } = setup();
    const turns = Array.from({ length: 12 }, (_, i) => ({
      id: `t${i}`,
      message: { text: `q${i}`, origin: USER_ORIGIN },
      responseParts: [],
      usage: undefined,
      state: "complete",
    }));
    conn.start();
    await until(() => conn.info.status === "open");
    const first = h.made[0] as NonNullable<(typeof h.made)[number]>;
    first.states.set(CHAT, chatState({ turns }));
    conn.watch(CHAT, { turns: 4 });
    await until(() => conn.chat(CHAT));
    expect(conn.chat(CHAT)?.turns.map((t) => t.id)).toEqual(["t8", "t9", "t10", "t11"]);
    expect(conn.chat(CHAT)?.turnsNextCursor).toBe("before:t8");
    await conn.fetchTurns(CHAT);
    expect(conn.chat(CHAT)?.turns.map((t) => t.id)).toEqual(["t6", "t7", "t8", "t9", "t10", "t11"]);
    // after a drop the new host has no window for this client: fetchTurns re-subscribes with a bigger one
    h.onConnect = (second) => {
      second.onReconnect = () => ({ type: "replay", missing: [], actions: [] });
      second.windowCursor = undefined;
    };
    await first.drop();
    await until(() => conn.info.status === "open", 3000);
    await conn.fetchTurns(CHAT);
    expect(conn.chat(CHAT)?.turns.length).toBeGreaterThanOrEqual(6 + 4);
    expect(new Set(conn.chat(CHAT)?.turns.map((t) => t.id)).size).toBe(conn.chat(CHAT)?.turns.length);
  });

  it("tells a view when its conversation no longer exists on the host", async () => {
    const { h, conn } = setup();
    conn.start();
    await until(() => conn.info.status === "open");
    const host = h.made[0] as NonNullable<(typeof h.made)[number]>;
    host.states.delete("ahp-chat:/nope");
    conn.watch("ahp-chat:/nope");
    await until(() => conn.isGone("ahp-chat:/nope"));
    expect(conn.chat("ahp-chat:/nope")).toBeUndefined();
  });

  it("refuses to send while disconnected, with a reason, instead of throwing", () => {
    const { conn } = setup();
    expect(conn.dispatch(CHAT, { type: ActionType.ChatTurnCancelled, turnId: "t" } as never)).toEqual({
      ok: false,
      error: expect.stringMatching(/Not connected/),
    });
  });

  it("lets go of everything when stopped: the socket, the channels, the timers", async () => {
    const { h, conn } = setup();
    conn.start();
    conn.watch(SESSION);
    const off = conn.watch(CHAT);
    await until(() => conn.chat(CHAT));
    expect(conn.channelCount).toBe(3);
    off();
    expect(conn.channelCount).toBe(2);
    const host = h.made[0] as NonNullable<(typeof h.made)[number]>;
    conn.stop();
    expect(conn.channelCount).toBe(1);
    expect(conn.chat(CHAT)).toBeUndefined();
    expect(conn.info.status).toBe("stopped");
    await until(() => host.closed);
    // no reconnect after a stop
    await tick(40);
    expect(h.made.length).toBe(1);
    // and it can be started again
    conn.start();
    await until(() => conn.info.status === "open");
    expect(h.made.length).toBe(2);
  });

  it("unsubscribes from a channel when its last watcher lets go", async () => {
    const { h, conn } = setup();
    conn.start();
    const a = conn.watch(CHAT);
    const b = conn.watch(CHAT);
    await until(() => conn.chat(CHAT));
    a();
    expect(conn.chat(CHAT)).toBeDefined();
    b();
    await until(() =>
      (h.made[0] as NonNullable<(typeof h.made)[number]>).received.some((m) => m.method === "unsubscribe"),
    );
    expect(conn.chat(CHAT)).toBeUndefined();
  });

  it("signals the roster when sessions come and go", async () => {
    const { h, conn } = setup();
    let n = 0;
    conn.onRoster(() => n++);
    conn.start();
    await until(() => conn.info.status === "open");
    const before = n;
    (h.made[0] as NonNullable<(typeof h.made)[number]>).notify("root/sessionSummaryChanged", {
      channel: ROOT,
      session: SESSION,
      changes: {},
    });
    await until(() => n > before);
  });
});
