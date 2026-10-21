// Memory stays bounded: idle chats nobody is looking at live on disk and come back identical.
import { describe, expect, it } from "vitest";
import { AhpHost } from "../../src/ahp/host.ts";
import { ActionType, ROOT } from "../../src/ahp/wire.ts";
import { gate, rig, ScriptedBackend, TestClient, turnStarted } from "./support.ts";

const plain = (x: unknown) => JSON.parse(JSON.stringify(x));

/** A chat with `turns` finished turns of about 2 KB each, as if it had been used for a long time. */
function bigChat(chat: string, turns: number) {
  return {
    resource: chat,
    title: "Long one",
    status: 1,
    modifiedAt: "2026-10-20T10:00:00.000Z",
    turns: Array.from({ length: turns }, (_, i) => ({
      id: `${chat.slice(-6)}-t${i}`,
      startedAt: "2026-10-20T10:00:00.000Z",
      duration: 1000,
      message: { text: `question ${i} ${"q".repeat(200)}`, origin: { kind: "user" } },
      responseParts: [{ kind: "markdown", id: `p${i}`, content: `answer ${i} ${"a".repeat(1700)}` }],
      state: "complete",
    })),
  };
}

async function manyChats(n: number, turns: number, limits = {}) {
  const t = await rig({ limits });
  const made = [];
  for (let i = 0; i < n; i++) made.push(await t.session());
  // write each chat's history into the store as a snapshot, then start a host afresh over it
  for (const m of made) t.host.store.snapshot(m.chat, t.host.serverSeq, bigChat(m.chat, turns));
  const logs: string[] = [];
  const host = new AhpHost({
    db: t.db,
    backend: new ScriptedBackend(),
    now: () => t.time.now,
    limits,
    log: (m) => logs.push(m),
  });
  return { t, host, made, logs };
}

describe("memory", () => {
  it("starts with no idle chat in memory, lists sessions without reading any, and keeps at most 20 as they are used", async () => {
    const { host, made } = await manyChats(100, 300);
    expect(host.loadedChats).toBe(0);
    const list = new TestClient(host, "list");
    await list.init();
    expect((await list.call("listSessions", { channel: ROOT, limit: 200 })).items).toHaveLength(100);
    expect(host.loadedChats).toBe(0); // a list needs only the sessions' own catalogue

    const first = plain(host.chatState(made[0]?.chat as string));
    expect(first.turns).toHaveLength(300);
    let peak = 0;
    for (const m of made) {
      expect(host.chatState(m.chat)?.turns).toHaveLength(300);
      peak = Math.max(peak, host.loadedChats);
    }
    expect(peak).toBeLessThanOrEqual(20);
    expect(host.loadedChats).toBeLessThanOrEqual(20);
    // the first one was put out of memory long ago and comes back exactly as it was
    expect(plain(host.chatState(made[0]?.chat as string))).toEqual(first);
  });

  it("keeps the heap bounded across a hundred long chats", async () => {
    const { host, made } = await manyChats(100, 300);
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    const before = process.memoryUsage().heapUsed;
    for (const m of made) host.chatState(m.chat);
    gc?.();
    const grown = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
    // 100 chats of ~0.6 MB of JSON each, all in memory, would be well over 150 MB of objects
    if (gc) expect(grown).toBeLessThan(80);
    expect(host.loadedChats).toBeLessThanOrEqual(20);
  });

  it("also holds the chats in memory to a size, not only a count", async () => {
    const { host, made } = await manyChats(10, 300, { maxLoadedBytes: 1_200_000 }); // about two chats
    for (const m of made) host.chatState(m.chat);
    expect(host.loadedChats).toBeLessThanOrEqual(3);
    expect(host.loadedChats).toBeGreaterThanOrEqual(1);
  });

  it("never puts a chat out of memory while a client watches it or a turn is running", async () => {
    const t = await rig({ limits: { maxLoadedChats: 2 } });
    const chats = [];
    for (let i = 0; i < 6; i++) chats.push(await t.session());
    const watcher = t.client();
    await watcher.init([ROOT, chats[0]?.chat as string]);
    const g = gate();
    t.backend.script = async () => {
      await g.promise;
      return { kind: "complete" };
    };
    const driver = t.client();
    await driver.init([ROOT]);
    driver.dispatch(chats[1]?.chat as string, turnStarted("work", "t1"));
    await new Promise((r) => setTimeout(r, 5));
    t.backend.script = async () => ({ kind: "complete" });
    for (const c of chats.slice(2)) t.host.chatState(c.chat);
    // watched and running chats are held; the others make way
    expect(t.host.hasActiveTurn(chats[1]?.chat as string)).toBe(true);
    expect(watcher.state(chats[0]?.chat as string)).toBeDefined();
    expect(t.host.loadedChats).toBeLessThanOrEqual(4);
    g.resolve();
    await t.host.idle();
    expect(t.host.chatState(chats[1]?.chat as string)?.turns[0]?.state).toBe("complete");
    watcher.disconnect();
    for (const c of chats) t.host.chatState(c.chat);
    expect(t.host.loadedChats).toBeLessThanOrEqual(2);
  });

  it("applies actions to a chat that was out of memory, replays it to a reconnecting client, and continues the numbers", async () => {
    const t = await rig({ limits: { maxLoadedChats: 1 } });
    const a = await t.session();
    const b = await t.session();
    const c1 = t.client("one");
    await c1.init([ROOT, a.chat]);
    c1.dispatch(a.chat, turnStarted("first", "t1"));
    await t.host.idle();
    const seen = c1.lastSeq;
    c1.disconnect();
    t.host.chatState(b.chat); // a goes out of memory
    expect(t.host.hasActiveTurn(a.chat)).toBe(false);
    expect(t.host.loadedChats).toBe(1);
    const before = plain(t.host.chatState(a.chat));
    t.host.chatState(b.chat);
    const c2 = t.client("two");
    await c2.init([ROOT]);
    c2.dispatch(a.chat, turnStarted("second", "t2")); // a client need not be subscribed to write
    await t.host.idle();
    const after = t.host.chatState(a.chat);
    expect(after?.turns.map((x) => x.message.text)).toEqual(["first", "second"]);
    expect(plain(after?.turns[0])).toEqual(before.turns[0]);
    const c3 = t.client("one");
    const r = await c3.reconnect(seen, [a.chat]);
    expect(r.type).toBe("replay");
    expect(c3.state(a.chat)).toBeUndefined(); // it never held a snapshot; the replay has the actions
    expect(
      r.actions.some((e: { action: { type: string } }) => e.action.type === ActionType.ChatTurnStarted),
    ).toBe(true);
    expect(t.host.serverSeq).toBeGreaterThan(seen);
  });
});

describe("memory is given back when the work is over, not at the next write", () => {
  const settle = () => new Promise<void>((r) => setTimeout(r, 5));

  it("after a burst of turns, the chats that did the work go out of memory when their turns end", async () => {
    const t = await rig({ limits: { maxLoadedChats: 3, evictEveryMs: 3_600_000 } });
    const chats = [];
    for (let i = 0; i < 40; i++) chats.push(await t.session());
    const g = gate();
    t.backend.script = async () => {
      await g.promise;
      return { kind: "complete" };
    };
    const driver = t.client();
    await driver.init([ROOT]);
    for (const [i, c] of chats.entries()) driver.dispatch(c.chat, turnStarted("work", `t${i}`));
    await settle();
    expect(t.host.loadedChats).toBe(40); // all working: all held
    g.resolve();
    await t.host.idle();
    await settle();
    // nothing wrote after the last turn ended; the chats are out of memory all the same
    expect(t.host.loadedChats).toBeLessThanOrEqual(3);
    // and they come back whole
    expect(t.host.chatState(chats[7]?.chat as string)?.turns[0]?.state).toBe("complete");
  });

  it("when a client lets go of a chat, or goes away", async () => {
    const t = await rig({ limits: { maxLoadedChats: 1, evictEveryMs: 3_600_000 } });
    const chats = [];
    for (let i = 0; i < 6; i++) chats.push(await t.session());
    const a = t.client("a");
    const b = t.client("b");
    await a.init([ROOT, ...chats.slice(0, 3).map((c) => c.chat)]);
    await b.init([ROOT, ...chats.slice(3).map((c) => c.chat)]);
    expect(t.host.loadedChats).toBe(6); // six watched: all held, over the limit
    await a.call("unsubscribe", { channel: chats[0]?.chat as string });
    expect(t.host.isLoaded(chats[0]?.chat as string)).toBe(false);
    expect(t.host.isLoaded(chats[1]?.chat as string)).toBe(true); // still watched by a
    b.disconnect();
    expect(t.host.loadedChats).toBeLessThanOrEqual(3); // a's two chats, and at most one more
    expect(t.host.isLoaded(chats[1]?.chat as string)).toBe(true);
  });

  it("on a short timer, whatever else happens", async () => {
    const t = await rig({ limits: { maxLoadedChats: 1, evictEveryMs: 20 } });
    const chats = [];
    for (let i = 0; i < 5; i++) chats.push(await t.session());
    const a = t.client("a");
    await a.init([ROOT, ...chats.map((c) => c.chat)]);
    expect(t.host.loadedChats).toBe(5);
    // the client lets go in a way that tells the host nothing (a half-closed socket, say)
    for (const c of chats) a.conn.subs.delete(c.chat);
    expect(t.host.loadedChats).toBe(5);
    await new Promise((r) => setTimeout(r, 120));
    expect(t.host.loadedChats).toBeLessThanOrEqual(1);
    t.host.close();
  });
});

describe("the guards that keep a chat in memory, one at a time", () => {
  let host: AhpHost;
  /** Any write to a chat looks at what is over the limits. */
  const write = (chat: string) =>
    host.apply(chat, { type: ActionType.ChatIsReadChanged, isRead: true } as never);

  it("a chat a client watches stays, though the limit is one", async () => {
    const t = await rig({ limits: { maxLoadedChats: 1, evictEveryMs: 3_600_000 } });
    host = t.host;
    const chats: { session: string; chat: string }[] = [];
    for (let i = 0; i < 4; i++) chats.push(await t.session());
    const watcher = t.client();
    await watcher.init([ROOT, chats[0]?.chat as string]);
    for (const c of chats.slice(1)) write(c.chat);
    expect(t.host.isLoaded(chats[0]?.chat as string)).toBe(true);
    expect(t.host.loadedChats).toBeLessThanOrEqual(2);
  });

  it("a chat with a turn in its state stays, even if no run is recorded for it", async () => {
    const t = await rig({ limits: { maxLoadedChats: 1, evictEveryMs: 3_600_000 } });
    host = t.host;
    const chats: { session: string; chat: string }[] = [];
    for (let i = 0; i < 4; i++) chats.push(await t.session());
    t.host.apply(
      chats[0]?.chat as string,
      {
        type: ActionType.ChatTurnStarted,
        turnId: "orphan",
        startedAt: new Date().toISOString(),
        message: { text: "hi", origin: { kind: "user" } },
      } as never,
    );
    expect(t.host.hasActiveTurn(chats[0]?.chat as string)).toBe(true);
    for (const c of chats.slice(1)) write(c.chat);
    expect(t.host.isLoaded(chats[0]?.chat as string)).toBe(true);
    expect(t.host.hasActiveTurn(chats[0]?.chat as string)).toBe(true);
  });

  it("a chat whose run is still going stays, in the moment after its turn is recorded as over", async () => {
    const t = await rig({ limits: { maxLoadedChats: 1, evictEveryMs: 3_600_000 } });
    host = t.host;
    const chats: { session: string; chat: string }[] = [];
    for (let i = 0; i < 4; i++) chats.push(await t.session());
    const mine = chats[0]?.chat as string;
    let loadedAtTheEnd: boolean | undefined;
    t.host.hooks.onApplied = (channel, action) => {
      if (channel !== mine || action.type !== ActionType.ChatTurnComplete) return;
      for (const c of chats.slice(1)) write(c.chat); // writes elsewhere, over the limit
      loadedAtTheEnd = t.host.isLoaded(mine);
    };
    const driver = t.client();
    await driver.init([ROOT]);
    driver.dispatch(mine, turnStarted("work", "t1"));
    await t.host.idle();
    expect(loadedAtTheEnd).toBe(true);
  });
});
