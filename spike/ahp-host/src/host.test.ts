// `bun test` from spike/ahp-host. In-process: the host with fake connections (no sockets), the real fake ACP agent.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatAction } from "@microsoft/agent-host-protocol";
import { AhpHost, type Conn } from "./host.ts";
import { configFromAcp, promptBlocks, TurnMapper } from "./map.ts";

const agent = ["bun", join(import.meta.dir, "fake-acp-agent.ts")];
const hosts: AhpHost[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.close();
});
const until = async (c: () => boolean, ms = 6000) => {
  const t = Date.now();
  while (!c()) {
    if (Date.now() - t > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
};

function fakeConn(id: number, clientId: string) {
  const out: any[] = [];
  const conn: Conn = { id, clientId, subs: new Set(), send: (m) => out.push(m) };
  return { conn, out, rejected: () => out.filter((m) => m.params?.rejectionReason) };
}
let rpcId = 1;
const call = async (h: AhpHost, c: ReturnType<typeof fakeConn>, method: string, params: any) => {
  const id = rpcId++;
  await h.handle(c.conn, JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  const r = c.out.find((m) => m.id === id);
  if (r?.error) throw new Error(`${method}: ${r.error.message}`);
  return r?.result;
};
const dispatch = (h: AhpHost, c: ReturnType<typeof fakeConn>, channel: string, action: any, clientSeq = 1) =>
  h.handle(c.conn, JSON.stringify({ jsonrpc: "2.0", method: "dispatchAction", params: { channel, clientSeq, action } }));

async function setup(db = join(mkdtempSync(join(tmpdir(), "ahp-t-")), "t.db")) {
  const host = new AhpHost({ dbPath: db, agent, snapshotEvery: 7 });
  hosts.push(host);
  const A = fakeConn(1, "A");
  const B = fakeConn(2, "B");
  host.addConn(A.conn);
  host.addConn(B.conn);
  await call(host, A, "initialize", { channel: "ahp-root://", protocolVersions: ["1.0.0"], clientId: "A" });
  await call(host, B, "initialize", { channel: "ahp-root://", protocolVersions: ["1.0.0"], clientId: "B" });
  const S = `ahp-session:/${crypto.randomUUID()}`;
  await call(host, A, "createSession", { channel: S, provider: "fake-acp" });
  const chat: string = host.state(S).defaultChat;
  for (const c of [A, B]) {
    await call(host, c, "subscribe", { channel: S });
    await call(host, c, "subscribe", { channel: chat });
  }
  return { host, A, B, S, chat, db };
}
const start = (h: AhpHost, c: any, chat: string, text: string, turnId = crypto.randomUUID()) => {
  void dispatch(h, c, chat, { type: "chat/turnStarted", turnId, startedAt: new Date().toISOString(), message: { text, origin: { kind: "user" } } });
  return turnId;
};
const pending = (h: AhpHost, chat: string) =>
  h.state(chat).activeTurn?.responseParts.find((p: any) => p.toolCall?.status === "pending-confirmation")?.toolCall;

describe("host", () => {
  test("rejects initialize with no common protocol version (-32005)", async () => {
    const h = new AhpHost({ dbPath: ":memory:", agent });
    hosts.push(h);
    const c = fakeConn(9, "x");
    h.addConn(c.conn);
    await expect(call(h, c, "initialize", { channel: "ahp-root://", protocolVersions: ["9.0.0"], clientId: "x" })).rejects.toThrow("unsupported protocol version");
    expect(c.out[0].error.code).toBe(-32005);
  });

  test("two clients race to confirm: exactly one wins, the other gets rejectionReason", async () => {
    const { host, A, B, chat } = await setup();
    const turnId = start(host, A, chat, "edit it");
    await until(() => pending(host, chat));
    const tc = pending(host, chat);
    const confirm = (approved: boolean, id: string) =>
      ({ type: "chat/toolCallConfirmed", turnId, toolCallId: tc.toolCallId, approved, confirmed: "user-action", ...(approved ? {} : { reason: "denied" }), selectedOptionId: id }) as any;
    await Promise.all([dispatch(host, A, chat, confirm(true, "allow-once")), dispatch(host, B, chat, confirm(false, "reject-once"))]);
    await until(() => host.state(chat).turns.length === 1);
    expect(A.rejected().length + B.rejected().length).toBe(1);
    expect(A.rejected().length).toBe(0); // A dispatched first
    const edit = host.state(chat).turns[0].responseParts.find((p: any) => p.toolCall?.toolName === "edit").toolCall;
    expect(edit.status).toBe("completed");
  });

  test("deny path: reject_once goes to ACP, tool call is cancelled, agent carries on", async () => {
    const { host, A, chat } = await setup();
    const turnId = start(host, A, chat, "edit it");
    await until(() => pending(host, chat));
    const tc = pending(host, chat);
    await dispatch(host, A, chat, { type: "chat/toolCallConfirmed", turnId, toolCallId: tc.toolCallId, approved: false, reason: "denied", selectedOptionId: "reject-once" });
    await until(() => host.state(chat).turns.length === 1);
    const t = host.state(chat).turns[0];
    expect(t.state).toBe("complete");
    expect(t.responseParts.find((p: any) => p.toolCall?.toolName === "edit").toolCall.status).toBe("cancelled");
    expect(t.responseParts.at(-1).content).toContain("left the file alone");
  });

  test("approve without selectedOptionId picks the agent's allow_once option", async () => {
    const { host, A, chat } = await setup();
    const turnId = start(host, A, chat, "edit it");
    await until(() => pending(host, chat));
    await dispatch(host, A, chat, { type: "chat/toolCallConfirmed", turnId, toolCallId: "tc-edit", approved: true, confirmed: "user-action" });
    await until(() => host.state(chat).turns.length === 1);
    expect(host.state(chat).turns[0].responseParts.find((p: any) => p.toolCall?.toolName === "edit").toolCall.status).toBe("completed");
  });

  test("a second turnStarted while one runs is rejected; queued messages run after", async () => {
    const { host, A, chat } = await setup();
    start(host, A, chat, "slow one");
    await until(() => host.state(chat).activeTurn?.responseParts.length);
    await dispatch(host, A, chat, { type: "chat/turnStarted", turnId: "dup", startedAt: new Date().toISOString(), message: { text: "x", origin: { kind: "user" } } });
    expect(A.rejected().length).toBe(1);
    await dispatch(host, A, chat, { type: "chat/pendingMessageSet", kind: "queued", id: "q1", message: { text: "after", origin: { kind: "user" } } });
    expect(host.state(chat).queuedMessages.length).toBe(1);
    await dispatch(host, A, chat, { type: "chat/turnCancelled", turnId: host.state(chat).activeTurn.id, duration: 0 });
    await until(() => host.state(chat).activeTurn?.message.text === "after"); // queued message became the next turn
    expect(host.state(chat).queuedMessages).toBeUndefined();
    await dispatch(host, A, chat, { type: "chat/turnCancelled", turnId: host.state(chat).activeTurn.id, duration: 0 });
  });

  test("invalid mode value is rejected; valid one reaches ACP and is reflected", async () => {
    const { host, A, S } = await setup();
    await dispatch(host, A, S, { type: "session/configChanged", config: { mode: "nope" } });
    expect(A.rejected().length).toBe(1);
    await dispatch(host, A, S, { type: "session/configChanged", config: { mode: "plan" } });
    expect(host.state(S).config.values.mode).toBe("plan");
  });

  test("restart rebuilds identical state from snapshots + log tail", async () => {
    const { host, A, chat, S, db } = await setup();
    const turnId = start(host, A, chat, "edit it");
    await until(() => pending(host, chat));
    await dispatch(host, A, chat, { type: "chat/toolCallConfirmed", turnId, toolCallId: "tc-edit", approved: true, confirmed: "user-action" });
    await until(() => host.state(chat).turns.length === 1);
    const want = JSON.stringify([host.state(chat), host.state(S)]);
    const seq = host.seq;
    host.close();
    hosts.pop();
    const again = new AhpHost({ dbPath: db, agent, snapshotEvery: 7 });
    hosts.push(again);
    expect(JSON.stringify([again.state(chat), again.state(S)])).toBe(want);
    expect(again.seq).toBe(seq);
  });

  test("reconnect replays only the missed tail, and says `missing` for unknown channels", async () => {
    const { host, A, B, chat, S } = await setup();
    const last = host.seq;
    start(host, A, chat, "slow");
    await until(() => host.state(chat).activeTurn?.responseParts.length);
    await dispatch(host, A, chat, { type: "chat/turnCancelled", turnId: host.state(chat).activeTurn.id, duration: 0 });
    const r = await call(host, B, "reconnect", { channel: "ahp-root://", clientId: "B", lastSeenServerSeq: last, subscriptions: [S, chat, "ahp-chat:/gone"] });
    expect(r.type).toBe("replay");
    expect(r.missing).toEqual(["ahp-chat:/gone"]);
    expect(r.actions[0].serverSeq).toBe(last + 1);
    expect(r.actions.every((a: any) => a.serverSeq > last)).toBe(true);
  });
});

// The mapping table, executable: every ACP update kind -> the AHP actions it produces.
describe("ACP -> AHP mapper", () => {
  const run = (updates: any[], opts: { perm?: any } = {}) => {
    const out: ChatAction[] = [];
    const side: string[] = [];
    const m = new TurnMapper("t1", (a) => out.push(a), (text) => ({ uri: `ahp-content:/${text.length}` }), (k) => side.push(k));
    for (const u of updates) m.update(u);
    if (opts.perm) m.permission(opts.perm);
    return { out: out as any[], side, m };
  };
  const text = (t: string) => ({ type: "text", text: t });

  test("agent_message_chunk: first chunk opens a markdown part, the rest are deltas", () => {
    const { out } = run([{ sessionUpdate: "agent_message_chunk", content: text("a") }, { sessionUpdate: "agent_message_chunk", content: text("b") }]);
    expect(out.map((a) => a.type)).toEqual(["chat/responsePart", "chat/delta"]);
    expect(out[0].part.kind).toBe("markdown");
    expect(out[1].partId).toBe(out[0].part.id);
  });
  test("agent_thought_chunk -> reasoning part + chat/reasoning; a tool call closes the text part", () => {
    const { out } = run([
      { sessionUpdate: "agent_thought_chunk", content: text("h") },
      { sessionUpdate: "agent_thought_chunk", content: text("m") },
      { sessionUpdate: "tool_call", toolCallId: "x", title: "T", kind: "read", status: "in_progress" },
      { sessionUpdate: "agent_message_chunk", content: text("after") },
    ]);
    expect(out.map((a) => a.type)).toEqual(["chat/responsePart", "chat/reasoning", "chat/toolCallStart", "chat/toolCallReady", "chat/responsePart"]);
  });
  test("tool_call pending -> start only (streaming); update in_progress -> ready(not-needed); completed -> complete", () => {
    const { out } = run([
      { sessionUpdate: "tool_call", toolCallId: "x", title: "Read", kind: "read", status: "pending", locations: [{ path: "a.ts", line: 3 }] },
      { sessionUpdate: "tool_call_update", toolCallId: "x", status: "in_progress" },
      { sessionUpdate: "tool_call_update", toolCallId: "x", status: "completed", content: [{ type: "content", content: text("body") }] },
    ]);
    expect(out.map((a) => a.type)).toEqual(["chat/toolCallStart", "chat/toolCallReady", "chat/toolCallComplete"]);
    expect((out[0] as any)._meta["iinc.locations"][0].path).toBe("a.ts"); // locations -> _meta (gap)
    expect((out[1] as any).confirmed).toBe("not-needed");
    expect(out[2].result.content[0]).toEqual({ type: "text", text: "body" });
  });
  test("tool_call_update with a diff -> fileEdit with before/after ContentRefs and +/- stats", () => {
    const { out } = run([
      { sessionUpdate: "tool_call", toolCallId: "e", title: "Edit", kind: "edit", status: "in_progress" },
      { sessionUpdate: "tool_call_update", toolCallId: "e", status: "completed", content: [{ type: "diff", path: "/a.ts", oldText: "a\nb\n", newText: "a\nc\nd\n" }] },
    ]);
    const fe = (out.at(-1) as any).result.content[0];
    expect(fe.type).toBe("fileEdit");
    expect(fe.before.uri).toBe("file:///a.ts");
    expect(fe.diff).toEqual({ added: 3, removed: 2 });
  });
  test("failed tool call -> complete with success:false", () => {
    const { out } = run([
      { sessionUpdate: "tool_call", toolCallId: "x", title: "Run", kind: "execute", status: "in_progress" },
      { sessionUpdate: "tool_call_update", toolCallId: "x", status: "failed" },
    ]);
    expect((out.at(-1) as any).result.success).toBe(false);
  });
  test("request_permission -> toolCallReady without `confirmed` (pending-confirmation) with approve/deny options", () => {
    const { out, m } = run(
      [{ sessionUpdate: "tool_call", toolCallId: "e", title: "Edit", kind: "edit", status: "pending" }],
      { perm: { toolCall: { toolCallId: "e", title: "Edit", kind: "edit" }, options: [
        { optionId: "ao", name: "Allow once", kind: "allow_once" }, { optionId: "aa", name: "Always", kind: "allow_always" },
        { optionId: "ro", name: "Deny", kind: "reject_once" }, { optionId: "ra", name: "Never", kind: "reject_always" } ] } },
    );
    const ready = out.at(-1) as any;
    expect(ready.confirmed).toBeUndefined();
    expect(ready.options.map((o: any) => [o.id, o.kind, o.group])).toEqual([["ao", "approve", 0], ["aa", "approve", 1], ["ro", "deny", 0], ["ra", "deny", 1]]);
    // reverse: confirmation -> ACP outcome
    expect(m.permissionOutcome("e", true, "aa")).toEqual({ outcome: "selected", optionId: "aa" });
    expect(m.permissionOutcome("e", true)).toEqual({ outcome: "selected", optionId: "ao" });
    expect(m.permissionOutcome("e", false)).toEqual({ outcome: "selected", optionId: "ro" });
  });
  test("plan -> pseudo tool call x-iinc-plan (content = checklist, _meta carries entries); finish() completes it", () => {
    const { out, m } = run([{ sessionUpdate: "plan", entries: [{ content: "a", status: "completed", priority: "high" }] }, { sessionUpdate: "plan", entries: [{ content: "a", status: "completed", priority: "high" }, { content: "b", status: "pending", priority: "low" }] }]);
    m.finish();
    expect(out.map((a) => a.type)).toEqual(["chat/toolCallStart", "chat/toolCallReady", "chat/toolCallContentChanged", "chat/toolCallContentChanged", "chat/toolCallComplete"]);
    expect((out[3] as any)._meta["iinc.plan"].length).toBe(2);
  });
  test("side-channel kinds are surfaced to the host, not turned into chat actions", () => {
    const { out, side } = run([
      { sessionUpdate: "available_commands_update", availableCommands: [] },
      { sessionUpdate: "current_mode_update", currentModeId: "plan" },
      { sessionUpdate: "config_option_update", configOptions: [] },
      { sessionUpdate: "usage_update", used: 1, size: 2 },
      { sessionUpdate: "user_message_chunk", content: text("replay") },
      { sessionUpdate: "something_new" },
    ]);
    expect(out.length).toBe(0);
    expect(side).toEqual(["available_commands_update", "current_mode_update", "config_option_update", "usage", "user_message_chunk", "unknown:something_new"]);
  });
  test("reverse: prompt blocks carry text + images + resource links; config comes from ACP modes/options", () => {
    const blocks = promptBlocks({
      text: "hi", origin: { kind: "user" } as any,
      attachments: [
        { type: "embeddedResource", label: "shot.png", data: "AAAA", contentType: "image/png" },
        { type: "resource", label: "a.ts", uri: "file:///a.ts" },
      ] as any,
    });
    expect(blocks).toEqual([{ type: "text", text: "hi" }, { type: "image", data: "AAAA", mimeType: "image/png" }, { type: "resource_link", uri: "file:///a.ts", name: "a.ts" }]);
    const cfg = configFromAcp({ currentModeId: "d", availableModes: [{ id: "d", name: "Ask" }, { id: "p", name: "Plan" }] }, [{ id: "model", name: "Model", type: "select", currentValue: "m1", options: [{ value: "m1", name: "M1" }] }]);
    expect(cfg.values).toEqual({ mode: "d", model: "m1" });
    expect((cfg.schema.properties.mode as any).enumLabels).toEqual(["Ask", "Plan"]);
  });
});
