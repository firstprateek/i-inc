// The action store: state survives a restart, snapshots keep the replay short, the log is pruned
// behind snapshots and capped, secrets never reach it, and the counter never goes backwards.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AhpHost } from "../../src/ahp/host.ts";
import { sanitizeAction } from "../../src/ahp/sanitize.ts";
import { ActionType, ResponsePartKind, ROOT, SessionLifecycle, TurnState } from "../../src/ahp/wire.ts";
import { openDb } from "../../src/db.ts";
import { type Any, gate, rig, ScriptedBackend, turnStarted } from "./support.ts";

const tmp = () => join(mkdtempSync(join(tmpdir(), "ahp-store-")), "ahp.db");
const settle = () => new Promise<void>((r) => setTimeout(r, 0));
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));

async function restart(
  path: string,
  o: { snapshotEvery?: number; retainMs?: number; maxActionRows?: number } = {},
) {
  const t = await rig({ path, limits: o });
  return t;
}

describe("persistence across a restart", () => {
  it("rebuilds every channel to the same state and continues the serverSeq without reuse", async () => {
    const path = tmp();
    const one = await rig({ path });
    const { session, chat } = await one.session();
    const c = one.client();
    await c.init([ROOT, session, chat]);
    c.dispatch(chat, turnStarted("first", "t1"));
    await one.host.idle();
    const seqBefore = one.host.serverSeq;
    const before = {
      chat: plain(one.host.chatState(chat)),
      session: plain(one.host.sessionState(session)),
      root: plain(one.host.state(ROOT)),
    };

    const two = await restart(path);
    expect(two.host.serverSeq).toBe(seqBefore);
    expect(plain(two.host.chatState(chat))).toEqual(before.chat);
    expect(plain(two.host.sessionState(session))).toEqual(before.session);
    expect(plain(two.host.state(ROOT))).toEqual(before.root);
    expect(two.host.sessionOfChat(chat)).toBe(session);

    // a client on the new host subscribes, talks, and the numbers carry on
    const d = two.client();
    await d.init([ROOT, session, chat]);
    d.dispatch(chat, turnStarted("second", "t2"));
    await two.host.idle();
    expect(Math.min(...d.actions().map((e) => e.serverSeq))).toBe(seqBefore + 1);
    expect(two.host.chatState(chat)?.turns.map((t) => t.message.text)).toEqual(["first", "second"]);
  });

  it("replays only the tail after the latest snapshot, and still arrives at the same state", async () => {
    const path = tmp();
    const one = await rig({ path, limits: { snapshotEvery: 4 } });
    const { chat } = await one.session();
    const c = one.client();
    await c.init([ROOT, chat]);
    for (let i = 0; i < 4; i++) {
      c.dispatch(chat, turnStarted(`m${i}`, `t${i}`));
      await one.host.idle();
    }
    expect(one.db.all("SELECT * FROM ahp_snapshots WHERE channel = ?", chat).length).toBeGreaterThan(0);
    expect(one.db.all("SELECT * FROM ahp_snapshots WHERE channel = ?", chat).length).toBeLessThanOrEqual(2);
    const logs: string[] = [];
    const db = await openDb(path);
    const two = new AhpHost({
      db,
      backend: new ScriptedBackend(),
      now: () => one.time.now,
      log: (m) => logs.push(m),
    });
    expect(plain(two.chatState(chat))).toEqual(plain(one.host.chatState(chat)));
    const total = two.store.countChannelActionsAfter(chat, 0);
    const tail = two.store.countChannelActionsAfter(chat, two.store.snapshotSeq(chat));
    expect(two.store.snapshotSeq(chat)).toBeGreaterThan(0);
    expect(tail).toBeLessThan(total);
    expect(logs[0]).toMatch(/rebuilt \d+ channels/);
  });

  it("ends a turn that was running when the daemon died, keeping the text so far, and says why", async () => {
    const path = tmp();
    const one = await rig({ path });
    const { session, chat } = await one.session();
    const c = one.client();
    await c.init([ROOT, session, chat]);
    const g = gate();
    one.backend.script = async (run, be) => {
      be.text(run, "half an answ");
      await g.promise;
      return { kind: "complete" };
    };
    c.dispatch(chat, turnStarted("go", "t1"));
    await settle();
    expect(one.host.chatState(chat)?.activeTurn?.id).toBe("t1");
    // "crash": a second host over the same database, the first never finishes
    const two = await restart(path);
    const st = two.host.chatState(chat);
    expect(st?.activeTurn).toBeUndefined();
    expect(st?.turns[0]?.state).toBe(TurnState.Error);
    expect(st?.turns[0]?.responseParts[0]).toMatchObject({ content: "half an answ" });
    const err = st?.turns[0]?.responseParts.at(-1);
    expect(err).toMatchObject({ kind: ResponsePartKind.Error, resumable: false });
    expect(JSON.stringify(err)).toContain("host_restarted");
    // the chat takes a new message
    const d = two.client();
    await d.init([ROOT, chat]);
    d.dispatch(chat, turnStarted("again", "t2"));
    await two.host.idle();
    expect(two.host.chatState(chat)?.turns[1]?.state).toBe(TurnState.Complete);
    // (the first host is the one that "died": its script is never let go)
  });

  it("fails a session that was still being created, and restores the agents list from the backend", async () => {
    const path = tmp();
    const one = await rig({ path });
    const { session } = await one.session();
    // pretend the process died between the channel and its ready action
    one.db.run("DELETE FROM ahp_actions WHERE channel = ? AND action LIKE '%session/ready%'", session);
    one.db.run("DELETE FROM ahp_snapshots");
    const two = await restart(path);
    expect(two.host.sessionState(session)?.lifecycle).toBe(SessionLifecycle.Failed);
    expect(two.host.agents().map((a) => a.provider)).toEqual(["fake"]);
  });

  it("keeps a client's origin on replayed actions, so it can tell its own from others'", async () => {
    const t = await rig();
    const { session, chat } = await t.session();
    const c = t.client("laptop");
    await c.init([ROOT, session, chat]);
    const seq = c.dispatch(chat, turnStarted("mine", "t1"));
    await t.host.idle();
    const echoed = c.actions(chat).find((e) => e.action.type === ActionType.ChatTurnStarted);
    expect(echoed?.origin).toEqual({ clientId: "laptop", clientSeq: seq });
    const phone = t.client("phone");
    const r = await phone.reconnect(0, [chat]);
    const replayed = r.actions.find((e: Any) => e.action.type === ActionType.ChatTurnStarted);
    expect(replayed.origin).toEqual({ clientId: "laptop", clientSeq: seq });
    const agentSide = r.actions.find((e: Any) => e.action.type === ActionType.ChatResponsePart);
    expect(agentSide.origin).toBeUndefined();
  });
});

describe("pruning the log", () => {
  it("drops rows a snapshot covers once they are past retention, and a stale reconnect then gets snapshots", async () => {
    const path = tmp();
    const t = await rig({ path, limits: { snapshotEvery: 3, retainMs: 1000 } });
    const { session, chat } = await t.session();
    const c = t.client();
    await c.init([ROOT, session, chat]);
    for (let i = 0; i < 3; i++) {
      c.dispatch(chat, turnStarted(`m${i}`, `t${i}`));
      await t.host.idle();
    }
    const stale = c.lastSeq - 5;
    const rowsBefore = (t.db.all("SELECT COUNT(*) AS n FROM ahp_actions")[0] as { n: number }).n;
    t.time.now += 5000;
    t.host.prune();
    const rowsAfter = (t.db.all("SELECT COUNT(*) AS n FROM ahp_actions")[0] as { n: number }).n;
    expect(rowsAfter).toBeLessThan(rowsBefore);
    expect(t.host.store.floor()).toBeGreaterThan(0);
    // the state is still what it was, from snapshots plus whatever tail is left
    const again = await restart(path, { snapshotEvery: 3 });
    expect(plain(again.host.chatState(chat))).toEqual(plain(t.host.chatState(chat)));
    expect(plain(again.host.sessionState(session))).toEqual(plain(t.host.sessionState(session)));
    // an up-to-date client still replays; a stale one (below the floor) gets snapshots
    const fresh = again.client();
    expect((await fresh.reconnect(again.host.serverSeq, [chat])).type).toBe("replay");
    const old = again.client();
    expect((await old.reconnect(stale, [chat])).type).toBe("snapshot");
    expect(plain(old.state(chat))).toEqual(plain(again.host.chatState(chat)));
  });

  it("never reuses a serverSeq after the whole log was pruned", async () => {
    const path = tmp();
    const t = await rig({ path, limits: { snapshotEvery: 2, retainMs: 0 } });
    const { chat } = await t.session();
    const c = t.client();
    await c.init([ROOT, chat]);
    c.dispatch(chat, turnStarted("x", "t1"));
    await t.host.idle();
    t.time.now += 10;
    t.host.prune();
    const high = t.host.serverSeq;
    const left = (t.db.all("SELECT MAX(server_seq) AS m FROM ahp_actions")[0] as { m: number | null }).m ?? 0;
    expect(left).toBeLessThanOrEqual(high);
    const again = await restart(path);
    expect(again.host.serverSeq).toBe(high);
    const d = again.client();
    await d.init([ROOT, chat]);
    d.dispatch(chat, turnStarted("y", "t2"));
    await again.host.idle();
    expect(Math.min(...d.actions().map((e) => e.serverSeq))).toBeGreaterThan(high);
  });

  it("caps the number of rows kept behind snapshots, oldest first, and never touches the tail", async () => {
    const t = await rig({ limits: { snapshotEvery: 2, maxActionRows: 5, retainMs: 10 ** 12 } });
    const { chat } = await t.session();
    const c = t.client();
    await c.init([ROOT, chat]);
    for (let i = 0; i < 4; i++) {
      c.dispatch(chat, turnStarted(`m${i}`, `t${i}`));
      await t.host.idle();
    }
    t.host.prune();
    const rows = t.db.all("SELECT server_seq, channel FROM ahp_actions ORDER BY server_seq") as {
      server_seq: number;
      channel: string;
    }[];
    expect(rows.length).toBeLessThan(20);
    const snap = t.host.store.latestSnapshot(chat)?.seq ?? 0;
    // everything after the chat's latest snapshot is still there
    expect(rows.filter((r) => r.channel === chat && r.server_seq > snap).length).toBe(
      t.host.store.countChannelActionsAfter(chat, snap),
    );
  });

  it("caps the content blobs, dropping the oldest and keeping the newest", async () => {
    const t = await rig({ limits: { maxBlobBytes: 100 } });
    const a = t.host.putContent("a".repeat(60));
    t.time.now += 1;
    const b = t.host.putContent("b".repeat(60));
    const c = await (async () => {
      const x = t.client();
      await x.init();
      return x;
    })();
    expect((await c.rpc("resourceRead", { channel: ROOT, uri: a.uri })).error).toBeTruthy();
    expect((await c.call("resourceRead", { channel: ROOT, uri: b.uri })).data).toBe("b".repeat(60));
    expect(b.sizeHint).toBe(60);
  });
});

describe("what is persisted from an agent", () => {
  it("redacts secrets in tool input and output, in the log and in the state", async () => {
    const t = await rig();
    const { chat } = await t.session();
    const c = t.client();
    await c.init([ROOT, chat]);
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    t.backend.script = async (run, be) => {
      run.emit({
        type: ActionType.ChatToolCallStart,
        turnId: run.turnId,
        toolCallId: "x",
        toolName: "execute",
        displayName: "curl",
      });
      run.emit({
        type: ActionType.ChatToolCallReady,
        turnId: run.turnId,
        toolCallId: "x",
        invocationMessage: `curl -H "Authorization: Bearer ${token}" https://api.github.com`,
        toolInput: JSON.stringify({ command: `export GITHUB_TOKEN=${token}` }),
        confirmed: "not-needed" as never,
      });
      be.done(run, "x", `{"token": "${token}", "key": "sk-live-abcdefghijklmnop"}\nAKIAABCDEFGHIJKLMNOP`);
      be.text(run, `use ${token}`);
      return { kind: "complete" };
    };
    c.dispatch(chat, turnStarted("go", "t1"));
    await t.host.idle();
    const everything = JSON.stringify([
      t.db.all("SELECT action FROM ahp_actions"),
      t.db.all("SELECT state FROM ahp_snapshots"),
      t.host.chatState(chat),
      c.envelopes,
    ]);
    expect(everything).not.toContain(token);
    expect(everything).not.toContain("sk-live-abcdefghijklmnop");
    expect(everything).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(everything).toContain("[redacted]");
    // structure is left alone: ids and ContentRef URIs survive the redactor's hex and base64 rules
    const ref = t.host.putContent("diff body");
    expect(
      sanitizeAction({
        uri: ref.uri,
        data: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=",
        toolCallId: "a".repeat(40),
      }),
    ).toEqual({
      uri: ref.uri,
      data: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=",
      toolCallId: "a".repeat(40),
    });
  });

  it("caps long strings, and shrinks an action that is still too big", async () => {
    const huge = "z".repeat(500_000);
    const capped = sanitizeAction(
      { result: { content: [{ type: "text", text: huge }] } },
      { maxString: 1000, maxAction: 10_000 },
    ) as Any;
    expect(capped.result.content[0].text.length).toBeLessThan(1100);
    expect(capped.result.content[0].text).toContain("more characters not kept");
    const many = {
      content: Array.from({ length: 200 }, (_, i) => ({ type: "text", text: `${i}`.repeat(2000) })),
    };
    const shrunk = JSON.stringify(sanitizeAction(many, { maxString: 2000, maxAction: 20_000 }));
    expect(shrunk.length).toBeLessThan(40_000);
    // through the host: a runaway tool output is cut before it is logged
    const t = await rig({ caps: { maxString: 2000 } });
    const { chat } = await t.session();
    const c = t.client();
    await c.init([ROOT, chat]);
    t.backend.script = async (run, be) => {
      be.tool(run, "x");
      be.done(run, "x", huge);
      return { kind: "complete" };
    };
    c.dispatch(chat, turnStarted("go", "t1"));
    await t.host.idle();
    const rows = t.db.all("SELECT LENGTH(action) AS n FROM ahp_actions") as { n: number }[];
    expect(Math.max(...rows.map((r) => r.n))).toBeLessThan(5000);
  });
});
