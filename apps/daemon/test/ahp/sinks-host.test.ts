// The WebSocket sink (r131): every frame the host sends goes through `redactLast` on the text main stored, and what
// is stored stays exactly what main stores. Canaries at each send path: broadcast, snapshot, windowed snapshot and
// fetchTurns, replay, a blob read, a summary; then the differential against main's wire, and the cost of a re-subscribe.
import { afterEach, describe, expect, it } from "vitest";
import type { TurnRun } from "../../src/ahp/backend.ts";
import { sanitizeAction } from "../../src/ahp/sanitize.ts";
import { ActionType, ROOT, ToolCallConfirmationReason, USER_ORIGIN } from "../../src/ahp/wire.ts";
import { sinkMemos, sinkRedactors, sinkStats } from "../../src/sinks.ts";
import { ALL, CANARIES, SHAPES, visible } from "../canaries.ts";
import { type Any, type Rig, rig, turnStarted } from "./support.ts";

const real = { ...sinkRedactors };
afterEach(() => {
  Object.assign(sinkRedactors, real);
  for (const m of Object.values(sinkMemos)) m.clear();
});

/** Main's wire: every sink an identity. */
const asMain = () => {
  sinkRedactors.last = (s) => s;
  sinkRedactors.prose = (s) => s;
  sinkRedactors.text = (s) => s;
  for (const m of Object.values(sinkMemos)) m.clear();
};

const SHAPE_TEXT = SHAPES.map((s) => s.text).join("\n");
const TOOL_INPUT = JSON.stringify({ command: `psql ${SHAPES[0]?.text}`, note: SHAPES[3]?.text, n: 3 });

/** An agent that says every canary: in a reply, a tool's input and result, and the conversation's title. */
async function scripted(t: Rig) {
  const emitted: Any[] = [];
  t.backend.script = async (run: TurnRun) => {
    const emit = (a: Any) => {
      emitted.push(a);
      run.emit(a);
    };
    emit({
      type: ActionType.ChatResponsePart,
      turnId: run.turnId,
      part: { kind: "markdown", id: `${run.turnId}:md`, content: ALL },
    });
    emit({
      type: ActionType.ChatToolCallStart,
      turnId: run.turnId,
      toolCallId: "tc1",
      toolName: "execute",
      displayName: "Run psql",
    });
    emit({
      type: ActionType.ChatToolCallReady,
      turnId: run.turnId,
      toolCallId: "tc1",
      invocationMessage: { markdown: `Run ${SHAPES[0]?.text}` },
      toolInput: TOOL_INPUT,
      confirmed: ToolCallConfirmationReason.NotNeeded,
    });
    emit({
      type: ActionType.ChatToolCallComplete,
      turnId: run.turnId,
      toolCallId: "tc1",
      result: { success: true, pastTenseMessage: "Ran", content: [{ type: "text", text: SHAPE_TEXT }] },
    });
    return { kind: "complete" };
  };
  const { session, chat } = await t.session();
  return { session, chat, emitted };
}

/** The text of every frame a client received. */
const framesOf = (c: { socket: { frames: unknown[] } }) => JSON.stringify(c.socket.frames);

describe("the WebSocket sink", () => {
  it("hides every canary live, in a snapshot, a windowed snapshot and its older turns, a replay and a summary", async () => {
    const t = await rig();
    const { session, chat } = await scripted(t);
    const live = t.client();
    await live.init([ROOT, session, chat]);
    live.dispatch(chat, turnStarted("first", "t1"));
    await t.host.idle();
    live.dispatch(chat, turnStarted("second", "t2"));
    await t.host.idle();
    // the agent names the conversation with a shape in it: a session action and a summary notification
    t.host.emit(session, {
      type: ActionType.SessionTitleChanged,
      title: `About ${SHAPES[0]?.text}`,
    } as never);
    await t.host.idle();
    expect(visible(framesOf(live))).toEqual([]);
    // the frames carried the text (with the canaries taken out), not nothing
    expect(framesOf(live)).toContain("[redacted]");

    const later = t.client();
    await later.init([ROOT]);
    await later.subscribe(chat);
    await later.subscribe(session);
    expect(visible(framesOf(later))).toEqual([]);

    const windowed = t.client();
    await windowed.init([ROOT]);
    await windowed.subscribe(chat, { turns: 1 });
    await windowed.call("fetchTurns", { channel: chat });
    expect(
      windowed.socket.frames.some((f: Any) => f.params?.action?.type === ActionType.ChatTurnsLoaded),
    ).toBe(true);
    expect(visible(framesOf(windowed))).toEqual([]);

    const back = t.client(live.clientId);
    const r = await back.reconnect(0, [ROOT, session, chat]);
    expect(r.type).toBe("replay");
    expect(visible(framesOf(back))).toEqual([]);

    const list = t.client();
    await list.init([ROOT]);
    await list.call("listSessions", { channel: ROOT });
    expect(visible(framesOf(list))).toEqual([]);
  });

  it("hides the canaries in a stored diff side, read as text or as base64", async () => {
    const t = await rig();
    const ref = t.host.putContent(`--- a\n+++ b\n+${SHAPE_TEXT}\n`, "text/plain");
    const c = t.client();
    await c.init();
    const asText = await c.call("resourceRead", { uri: ref.uri });
    expect(asText.data.split("\n").length).toBe(`--- a\n+++ b\n+${SHAPE_TEXT}\n`.split("\n").length);
    expect(visible(asText.data)).toEqual([]);
    const asBase64 = await c.call("resourceRead", { uri: ref.uri, encoding: "base64" });
    expect(visible(Buffer.from(asBase64.data, "base64").toString("utf8"))).toEqual([]);
    // the blob itself is as main keeps it
    const [row] = t.db.all<{ data: Uint8Array }>("SELECT data FROM ahp_blobs");
    expect(visible(Buffer.from(row?.data ?? new Uint8Array()).toString("utf8"), SHAPES)).toEqual(
      SHAPES.map((s) => s.name),
    );
  });

  it("leaves the owner's own message on a conversation, and hides the brief on a read-only stage view", async () => {
    const t = await rig();
    const { chat } = await scripted(t);
    const c = t.client();
    await c.init([ROOT, chat]);
    c.dispatch(chat, turnStarted(`my db is ${SHAPES[0]?.text}`, "t1"));
    await t.host.idle();
    const echoed = c.actions(chat).find((e) => e.action.type === ActionType.ChatTurnStarted);
    expect((echoed as Any).action.message.text).toBe(`my db is ${SHAPES[0]?.text}`);

    // a read-only view, named by the host (not by its uri): its "message" is the daemon's brief
    t.host.openReadOnlySession({ session: "ahp-session:/ro1", provider: "fake", title: "Ticket", meta: {} });
    t.host.addReadOnlyChat({
      session: "ahp-session:/ro1",
      chat: "ahp-chat:/ro1-build",
      title: "Build",
      meta: {},
    });
    const v = t.client();
    await v.init([ROOT, "ahp-chat:/ro1-build"]);
    t.host.emit("ahp-chat:/ro1-build", {
      type: ActionType.ChatTurnStarted,
      turnId: "b1",
      startedAt: new Date(0).toISOString(),
      message: { text: `Brief: ${SHAPE_TEXT}`, origin: USER_ORIGIN },
    } as never);
    await t.host.idle();
    expect(visible(framesOf(v), SHAPES)).toEqual([]);
    const fresh = t.client();
    await fresh.init([ROOT]);
    await fresh.subscribe("ahp-chat:/ro1-build");
    expect(visible(framesOf(fresh), SHAPES)).toEqual([]);
  });

  it("stores exactly what main stores: each action as sanitizeAction made it, in the log and in memory", async () => {
    const t = await rig();
    const { chat, emitted } = await scripted(t);
    const c = t.client();
    await c.init([ROOT, chat]);
    c.dispatch(chat, turnStarted("go", "t1"));
    await t.host.idle();
    const rows = t.db
      .all<{ action: string }>("SELECT action FROM ahp_actions WHERE channel = ? ORDER BY server_seq", chat)
      .map((r) => r.action);
    for (const a of emitted) expect(rows).toContain(JSON.stringify(sanitizeAction(a)));
    // so the shapes main lets through are still there at rest, and in the host's own state
    expect(visible(rows.join("\n"), SHAPES).length).toBeGreaterThan(0);
    expect(visible(JSON.stringify(t.host.chatState(chat)), SHAPES)).toEqual(visible(rows.join("\n"), SHAPES));
  });

  it("differential: what the sink shows is a subset of main's wire, and what is stored is the same", async () => {
    const run = async () => {
      const t = await rig();
      const { session, chat } = await scripted(t);
      const c = t.client("same-client");
      await c.init([ROOT, session, chat]);
      c.dispatch(chat, turnStarted("go", "t1"));
      await t.host.idle();
      const later = t.client("later");
      await later.init([ROOT]);
      await later.subscribe(chat);
      const rows = t.db
        .all<{ channel: string; action: string }>(
          "SELECT channel, action FROM ahp_actions ORDER BY server_seq",
        )
        .map(
          (r) => `${r.channel === chat ? "chat" : r.channel === session ? "session" : r.channel} ${r.action}`,
        )
        .join("\n");
      const same = rows
        .replaceAll(session, "S")
        .replaceAll(chat, "C")
        .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<time>");
      return { shown: visible(framesOf(c) + framesOf(later)), rows: same };
    };
    const ours = await run();
    asMain();
    const main = await run();
    for (const name of ours.shown) expect(main.shown).toContain(name);
    // main's wire shows shapes; ours shows none of them
    expect(main.shown.length).toBeGreaterThan(0);
    expect(ours.shown).toEqual([]);
    expect(ours.rows).toBe(main.rows);
  });

  it("re-subscribing to a chat it has already sent costs no redaction", async () => {
    const t = await rig();
    const { chat } = await scripted(t);
    const c = t.client();
    await c.init([ROOT, chat]);
    for (let i = 0; i < 5; i++) {
      c.dispatch(chat, turnStarted(`go ${i}`, `t${i}`));
      await t.host.idle();
    }
    const first = t.client();
    await first.init([ROOT]);
    await first.subscribe(chat);
    const before = sinkStats.last;
    const hits = sinkMemos.last.hits + sinkMemos.lastJson.hits;
    for (let i = 0; i < 3; i++) {
      const again = t.client();
      await again.init([ROOT]);
      await again.subscribe(chat);
      expect(visible(framesOf(again))).toEqual([]);
    }
    expect(sinkStats.last).toBe(before);
    expect(sinkMemos.last.hits + sinkMemos.lastJson.hits).toBeGreaterThan(hits);
  });

  it("sends a broadcast nobody is subscribed to through no sink at all", async () => {
    const t = await rig();
    const { chat } = await scripted(t);
    const before = sinkStats.last;
    t.host.emit(chat, {
      type: ActionType.ChatResponsePart,
      turnId: "x",
      part: { kind: "markdown", id: "p", content: CANARIES[13]?.text },
    } as never);
    expect(sinkStats.last).toBe(before);
  });
});
