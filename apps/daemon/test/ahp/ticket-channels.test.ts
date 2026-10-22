// Open the session (T69): a ticket stage's agent session as a read-only AHP chat. A scripted ACP server drives the
// real AcpAgent through the daemon's real pipeline; the test reads the host the way a client would.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Agent, SessionOutcome, SessionRequest } from "@i-inc/core";
import { FakeAgent } from "@i-inc/core/testing";
import { describe, expect, it } from "vitest";
import { AcpAgent, type AgentProcess } from "../../src/acp.ts";
import {
  MAX_STAGE_PARTS,
  MAX_TOOL_TEXT,
  shownBrief,
  stageChatUri,
  TAIL_PARTS,
  ticketSessionUri,
} from "../../src/ahp/ticket-channels.ts";
import {
  ActionType,
  ResponsePartKind,
  ROOT,
  ToolCallConfirmationReason,
  ToolCallStatus,
} from "../../src/ahp/wire.ts";
import { refunds, testApp } from "../setup.ts";
import { type Any, turnStarted } from "./support.ts";

type Json = Record<string, Any>;
type Script = (method: string, params: Json, reply: (m: Json) => void, id: number | undefined) => void;

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

function server(script: Script) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let exit: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((r) => {
    exit = r;
  });
  let buf = "";
  stdin.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const m = JSON.parse(buf.slice(0, i)) as Json;
      buf = buf.slice(i + 1);
      const id = m.id as number | undefined;
      const reply = (r: Json) => stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...r })}\n`);
      script(String(m.method ?? ""), (m.params ?? {}) as Json, reply, "method" in m ? id : undefined);
    }
  });
  const proc: AgentProcess = { stdin, stdout, stderr, kill: () => exit(null), exited };
  return proc;
}

const update = (sessionUpdate: string, rest: Json = {}) => ({
  method: "session/update",
  params: { sessionId: "s1", update: { sessionUpdate, ...rest } },
});

/** What a plan stage looks like from Claude's adapter: a plan, some thinking, a read, an edit with a diff, an answer. */
const stageScript: Script = (method, _params, reply, id) => {
  if (method === "initialize")
    reply({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  if (method === "session/new")
    reply({
      id,
      result: {
        sessionId: "s1",
        modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "bypassPermissions" }] },
      },
    });
  if (method === "session/set_mode") reply({ id, result: {} });
  if (method === "session/prompt" && id !== undefined) {
    reply(
      update("plan", {
        entries: [
          { content: "Find the sorter", status: "completed", priority: "high" },
          { content: "Fix refunds", status: "in_progress", priority: "high" },
        ],
      }),
    );
    reply(update("agent_thought_chunk", { content: { type: "text", text: "Refunds are negative cents." } }));
    reply(update("agent_message_chunk", { content: { type: "text", text: "Looking at the sorter. " } }));
    reply(
      update("tool_call", {
        toolCallId: "r1",
        title: "Read src/sort.ts",
        kind: "read",
        status: "pending",
        locations: [{ path: "src/sort.ts" }],
      }),
    );
    reply(
      update("tool_call_update", {
        toolCallId: "r1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: `const token = "${SECRET}";` } }],
      }),
    );
    reply(
      update("tool_call", {
        toolCallId: "e1",
        title: "Edit src/sort.ts",
        kind: "edit",
        status: "pending",
        rawInput: { path: "src/sort.ts", note: `use ${SECRET}` },
      }),
    );
    reply(
      update("tool_call_update", {
        toolCallId: "e1",
        status: "completed",
        content: [
          { type: "diff", path: "/work/src/sort.ts", oldText: "a\n", newText: `a\nb = "${SECRET}"\nc\n` },
        ],
      }),
    );
    reply(update("usage_update", { used: 1200, size: 200000 }));
    reply(update("agent_message_chunk", { content: { type: "text", text: "Approach: change the sorter." } }));
    setTimeout(
      () =>
        reply({
          id,
          result: { stopReason: "end_turn", _meta: { usage: { inputTokens: 900, outputTokens: 120 } } },
        }),
      5,
    );
  }
};

/** Plan stages go to the ACP agent over the scripted server; every other stage is the core's scripted fake. */
function stagedAgent(script: Script = stageScript) {
  const acp = new AcpAgent({
    launch: () => server(script),
    credentials: () => ({}),
    cwdFor: (id) => `/home/employee/work/inc-${id}`,
  });
  const fake = new FakeAgent();
  const router: Agent = {
    run: (req: SessionRequest): Promise<SessionOutcome> =>
      req.stage === "plan" ? acp.run(req) : fake.run(req),
  };
  return { agent: router, fake };
}

const until = async (cond: () => unknown, what = "condition", ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 4));
  }
};

async function ranTicket(path = ":memory:", dir?: string) {
  const { agent, fake } = stagedAgent();
  const app = await testApp(path, dir ?? mkdtempSync(join(tmpdir(), "i-inc-knowledge-")), { agent });
  const made = await app.call("POST", "/api/tickets", refunds);
  const id = made.body.ticket.id as string;
  app.daemon.run(id);
  await until(() => app.ahp.host.chatState(stageChatUri(1))?.turns.length === 1, "the plan stage's turn");
  await app.daemon.idle();
  return { app, id, fake };
}

/** A client on the host, subscribed to the root, a ticket's session and its first stage chat. */
async function watch(app: Awaited<ReturnType<typeof testApp>>, id: string, chatId = 1) {
  const { TestClient } = await import("./support.ts");
  const c = new TestClient(app.ahp.host);
  const session = ticketSessionUri(id);
  const chat = stageChatUri(chatId);
  await c.init([ROOT, session, chat]);
  return { c, session, chat };
}

const turnOf = (app: Awaited<ReturnType<typeof testApp>>, chat = stageChatUri(1)) =>
  app.ahp.host.chatState(chat)?.turns[0] as Any;

describe("a stage run as a read-only chat", () => {
  it("makes the ticket's session and a chat for the stage, with the brief as the turn and the work as its parts", async () => {
    const { app, id } = await ranTicket();
    const host = app.ahp.host;
    const session = host.sessionState(ticketSessionUri(id)) as Any;
    expect(session._meta).toMatchObject({ readOnly: true, "iinc.ticket": id });
    // The title names the ticket and the stage (the latest stage, as the ticket moves on).
    expect(session.title).toMatch(new RegExp(`^#${id} Refunds are counted as spending · `));
    const chat = host.chatState(stageChatUri(1)) as Any;
    expect(chat.interactivity).toBe("read-only");
    expect(chat._meta).toMatchObject({
      readOnly: true,
      "iinc.ticket": id,
      "iinc.stage": "plan",
      "iinc.employee": "ada",
      "iinc.engine": "opus",
    });
    expect(chat.title).toBe(`#${id} Refunds are counted as spending · plan`);

    const turn = turnOf(app);
    expect(turn.state).toBe("complete");
    expect(turn.message.text).toContain(`#${id}`); // the brief, not a user's words
    const kinds = turn.responseParts.map((p: Any) => p.kind);
    expect(kinds).toContain(ResponsePartKind.Reasoning);
    expect(kinds).toContain(ResponsePartKind.Markdown);
    const tools = turn.responseParts.filter((p: Any) => p.kind === ResponsePartKind.ToolCall);
    // the plan (a pseudo tool call, as in a conversation), a read and an edit with its diff
    expect(tools.map((p: Any) => p.toolCall.toolName ?? p.toolCall.displayName)).toEqual(
      expect.arrayContaining(["x-iinc-plan", "read", "edit"]),
    );
    const plan = tools.find((p: Any) => p.toolCall.toolName === "x-iinc-plan");
    expect(plan.toolCall.status).toBe(ToolCallStatus.Completed);
    expect(
      plan.toolCall._meta?.["iinc.plan"] ?? plan.toolCall.result?._meta?.["iinc.plan"] ?? "plan",
    ).toBeTruthy();
    const edit = tools.find((p: Any) => p.toolCall.toolName === "edit");
    expect(edit.toolCall.status).toBe(ToolCallStatus.Completed);
    expect(edit.toolCall.confirmed).toBe(ToolCallConfirmationReason.NotNeeded);
    expect(JSON.stringify(edit.toolCall.content)).toContain("fileEdit");
    // usage: the prompt's token counts and the context window
    expect(turn.usage).toMatchObject({ inputTokens: 900, outputTokens: 120, model: "Claude Opus" });
    expect(turn.usage._meta).toMatchObject({ contextUsed: 1200, contextSize: 200000 });
    // the streamed text, joined
    const text = turn.responseParts
      .filter((p: Any) => p.kind === ResponsePartKind.Markdown)
      .map((p: Any) => p.content);
    expect(text.join("")).toContain("Approach: change the sorter.");
    // the historical record is untouched: the ticket page's transcript still has the stage
    const sessions = await app.call("GET", `/api/tickets/${id}/sessions`);
    expect(sessions.body.sessions[0]).toMatchObject({
      id: 1,
      stage: "plan",
      channel: { chat: stageChatUri(1) },
    });
    expect(sessions.body.sessions[0].items.length).toBeGreaterThan(0);
  });

  it("is found by listSessions, with the ticket and stage in the title", async () => {
    const { app, id } = await ranTicket();
    const { c } = await watch(app, id);
    const list = await c.call("listSessions", {});
    const mine = list.items.find((s: Any) => s.resource === ticketSessionUri(id));
    expect(mine.title).toMatch(new RegExp(`^#${id} Refunds are counted as spending · \\w+`));
    expect(mine._meta).toMatchObject({ readOnly: true });
  });

  it("is read-only: every client action is refused, nothing is logged, and the stage is not disturbed", async () => {
    const { app, id } = await ranTicket();
    const { c, session, chat } = await watch(app, id);
    const before = app.ahp.host.serverSeq;
    const sentences = [
      [chat, turnStarted("hello", "t-x")],
      [
        chat,
        {
          type: ActionType.ChatPendingMessageSet,
          kind: "steering",
          id: "p1",
          message: { text: "x", origin: { kind: "user" } },
        },
      ],
      [
        chat,
        {
          type: ActionType.ChatToolCallConfirmed,
          turnId: "stage-1",
          toolCallId: "e1",
          approved: true,
          confirmed: "user-action",
        },
      ],
      [chat, { type: ActionType.ChatTurnCancelled, turnId: "stage-1" }],
      [chat, { type: ActionType.ChatIsArchivedChanged, isArchived: true }],
      [chat, { type: ActionType.ChatDraftChanged }],
      [session, { type: ActionType.SessionTitleChanged, title: "mine" }],
      [session, { type: ActionType.SessionIsArchivedChanged, isArchived: true }],
      [session, { type: ActionType.SessionConfigChanged, config: { mode: "x" } }],
    ] as [string, Json][];
    for (const [channel, action] of sentences) c.dispatch(channel, action);
    const rejected = c.rejections();
    expect(rejected).toHaveLength(sentences.length);
    for (const r of rejected) expect(r.rejectionReason).toMatch(/read-only view of a ticket stage/);
    expect(app.ahp.host.serverSeq).toBe(before);
    expect(app.ahp.host.chatState(chat)?.title).toContain("· plan");
    expect(app.ahp.host.sessionState(session)?.title).not.toBe("mine");
    // the commands that make or remove things are refused too
    const extra = await c.rpc("createChat", { channel: session, chat: "ahp-chat:/mine" });
    expect((extra.error as Any)?.message).toMatch(/read-only/);
    const drop = await c.rpc("disposeChat", { channel: chat });
    expect((drop.error as Any)?.message).toMatch(/read-only/);
    const gone = await c.rpc("disposeSession", { channel: session });
    expect((gone.error as Any)?.message).toMatch(/read-only/);
    expect(app.ahp.host.hasChannel(chat)).toBe(true);
    // and it did not turn into a conversation
    expect((await app.call("GET", "/api/conversations")).body.conversations).toEqual([]);
  });

  it("redacts credentials in what the agent said, read and wrote, and in the diffs", async () => {
    const { app } = await ranTicket();
    const host = app.ahp.host;
    const chat = JSON.stringify(host.chatState(stageChatUri(1)));
    expect(chat).not.toContain(SECRET);
    expect(chat).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    // not in the log, and not in the diff's content blobs either
    const rows = JSON.stringify(
      app.db.all("SELECT action FROM ahp_actions WHERE channel = ?", stageChatUri(1)),
    );
    expect(rows).not.toContain(SECRET);
    const blobs = app.db.all<{ data: Uint8Array }>("SELECT data FROM ahp_blobs");
    expect(blobs.length).toBeGreaterThan(0);
    for (const b of blobs) expect(Buffer.from(b.data).toString("utf8")).not.toContain(SECRET);
    expect(chat).toContain("[redacted]");
  });

  it("replays after a restart: the same state from the store, and a client that was away catches up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-inc-ticket-channels-"));
    const path = join(dir, "daemon.db");
    const { app, id } = await ranTicket(path, join(dir, "knowledge"));
    const { c, session, chat } = await watch(app, id);
    const state = JSON.stringify(app.ahp.host.chatState(chat));
    const titleBefore = app.ahp.host.sessionState(session)?.title;
    app.ahp.host.close();

    // A new daemon over the same database.
    const again = await testApp(path, join(dir, "knowledge"));
    const host = again.ahp.host;
    expect(JSON.stringify(host.chatState(chat))).toBe(state);
    expect(host.sessionState(session)?.title).toBe(titleBefore);
    expect(host.isReadOnly(chat)).toBe(true);
    // a client subscribes to the finished stage and replays it from the store, no agent involved
    const { TestClient } = await import("./support.ts");
    const fresh = new TestClient(host);
    await fresh.init([ROOT]);
    const sub = await fresh.subscribe(chat);
    expect(sub.snapshot.state.turns[0].state).toBe("complete");
    expect(JSON.stringify(sub.snapshot.state.turns[0].responseParts)).toContain(
      "Approach: change the sorter.",
    );
    expect(c.lastSeq).toBeGreaterThan(0);
    // it is still read-only
    fresh.dispatch(chat, turnStarted("again", "t-y"));
    expect(fresh.rejections()).toHaveLength(1);
    // the transcript's own link to it
    const sessions = await again.call("GET", `/api/tickets/${id}/sessions`);
    expect(sessions.body.sessions[0].channel).toEqual({ session, chat });
  });

  it("catches a client up after a restart from the log: the actions it missed, applied to what it held", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-inc-ticket-channels-"));
    const path = join(dir, "daemon.db");
    const app = await testApp(path, join(dir, "knowledge"));
    const feed = app.ahp.tickets.begin({
      ticketId: "7",
      ticketTitle: "Live",
      stage: "build",
      sessionId: 9,
      employeeId: "ada",
      engineId: "opus",
      model: "m",
      brief: "do it",
      startedAt: app.clock.now(),
    });
    feed.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "First. " } });
    const { TestClient } = await import("./support.ts");
    const chat = stageChatUri(9);
    const watcher = new TestClient(app.ahp.host);
    await watcher.init([ROOT, ticketSessionUri("7"), chat]);
    const held = new Map([...watcher.states].map(([k, v]) => [k, structuredClone(v)]));
    const heldSeq = watcher.lastSeq;
    // the stage goes on while the watcher is away
    feed.update({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Run tests",
      kind: "execute",
      status: "completed",
    });
    feed.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Second." } });
    feed.end({ kind: "done", output: "ok" });
    const final = JSON.stringify(app.ahp.host.chatState(chat));
    app.ahp.host.close();

    const again = await testApp(path, join(dir, "knowledge"));
    const back = new TestClient(again.ahp.host);
    (back as Any).states = held;
    const r = await back.reconnect(heldSeq, [ticketSessionUri("7"), chat]);
    expect(r.type).toBe("replay");
    expect(r.actions.length).toBeGreaterThan(2);
    expect(JSON.stringify(back.state(chat))).toBe(final);
  });

  it("ends a stage that was running when the daemon stopped, in words that fit a watcher", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-inc-ticket-channels-"));
    const path = join(dir, "daemon.db");
    const hang: Script = (method, _p, reply, id) => {
      stageScript(method, _p, reply, id === undefined ? id : id);
      if (method === "session/prompt") {
        // never ends: the daemon is stopped mid-stage
      }
    };
    const stuck: Script = (method, p, reply, id) => {
      if (method === "session/prompt") {
        reply(update("agent_message_chunk", { content: { type: "text", text: "Working…" } }));
        return; // no answer
      }
      hang(method, p, reply, id);
    };
    const { agent } = stagedAgent(stuck);
    const app = await testApp(path, join(dir, "knowledge"), { agent });
    const made = await app.call("POST", "/api/tickets", refunds);
    app.daemon.run(made.body.ticket.id);
    await until(() => app.ahp.host.hasActiveTurn(stageChatUri(1)), "the stage to be running");
    // the chat is watched live while it runs
    expect(app.ahp.host.chatState(stageChatUri(1))?.status).toBeGreaterThan(0);
    app.ahp.host.close(); // as if the daemon died: nothing ended the turn
    const again = await testApp(path, join(dir, "knowledge"));
    const turn = again.ahp.host.chatState(stageChatUri(1))?.turns[0] as Any;
    expect(turn.state).toBe("error");
    expect(JSON.stringify(turn)).toContain("The ticket carries on in a new session");
    expect(JSON.stringify(turn)).not.toContain("Send a message");
  });
});

describe("a stage that is not ACP", () => {
  it("is watchable too: the scripted transcript items become the same parts", async () => {
    const app = await testApp();
    app.agent.on(
      { stage: "plan" },
      {
        kind: "done",
        output: "Approach: do it.",
        items: [
          { kind: "text", text: "Reading the code. ", at: 1 },
          { kind: "tool", id: "g1", title: "grep sort", status: "completed", text: "src/sort.ts:3", at: 2 },
          { kind: "text", text: "Approach: do it.", at: 3 },
        ],
      },
    );
    const made = await app.call("POST", "/api/tickets", refunds);
    app.daemon.run(made.body.ticket.id);
    await until(() => app.ahp.host.chatState(stageChatUri(1))?.turns.length === 1, "the turn");
    const turn = turnOf(app);
    expect(turn.state).toBe("complete");
    expect(turn.responseParts.map((p: Any) => p.kind)).toContain(ResponsePartKind.ToolCall);
    expect(JSON.stringify(turn.responseParts)).toContain("Approach: do it.");
    expect(JSON.stringify(turn.responseParts)).toContain("grep sort");
  });

  it("shows an answer-only stage's answer, and a failed one's reason", async () => {
    const app = await testApp();
    const made = await app.call("POST", "/api/tickets", refunds);
    app.daemon.run(made.body.ticket.id);
    await until(() => app.ahp.host.chatState(stageChatUri(1))?.turns.length === 1, "the turn");
    const turn = turnOf(app);
    expect(turn.state).toBe("complete");
    expect(JSON.stringify(turn.responseParts)).toContain("Approach:");

    const stuckApp = await testApp();
    stuckApp.agent.on({ stage: "plan" }, { kind: "stuck", reason: `couldn't go on; token ${SECRET}` });
    const m2 = await stuckApp.call("POST", "/api/tickets", refunds);
    stuckApp.daemon.run(m2.body.ticket.id);
    await until(() => stuckApp.ahp.host.chatState(stageChatUri(1))?.turns.length === 1, "the turn");
    const t2 = turnOf(stuckApp);
    expect(t2.state).toBe("error");
    expect(JSON.stringify(t2)).toContain("couldn't go on");
    expect(JSON.stringify(t2)).not.toContain(SECRET);
  });

  it("makes no view for a launch that never got going", async () => {
    const app = await testApp();
    const feed = app.ahp.tickets.begin({
      ticketId: "3",
      ticketTitle: "Never starts",
      stage: "build",
      sessionId: 12,
      employeeId: "ada",
      engineId: "opus",
      model: "m",
      brief: "b",
      startedAt: app.clock.now(),
    });
    feed.end({ kind: "stuck", reason: "claude-code needs a sign-in", startup: true });
    expect(app.ahp.host.hasChannel(stageChatUri(12))).toBe(false);
    expect(app.ahp.host.hasChannel(ticketSessionUri("3"))).toBe(false);
    expect(app.ahp.tickets.footprint()).toEqual({ feeds: 0 });
    // the daemon stopping before the agent said anything is the same
    const stopping = app.ahp.tickets.begin({
      ticketId: "3",
      ticketTitle: "Never starts",
      stage: "build",
      sessionId: 13,
      employeeId: "ada",
      engineId: "opus",
      model: "m",
      brief: "b",
      startedAt: app.clock.now(),
    });
    stopping.end({ kind: "stopping" });
    expect(app.ahp.host.hasChannel(stageChatUri(13))).toBe(false);
  });
});

describe("bounds", () => {
  it("cuts the brief, and keeps a stage's steps to a cap with a note", async () => {
    const long = `${"A paragraph of the brief.\n\n".repeat(400)}tail`;
    const shown = shownBrief(long);
    expect(shown.length).toBeLessThan(4300);
    expect(shown).toContain("not shown here");
    expect(shown).not.toContain("tail");

    const app = await testApp();
    const feed = app.ahp.tickets.begin({
      ticketId: "9",
      ticketTitle: "Many steps",
      stage: "build",
      sessionId: 77,
      employeeId: "ada",
      engineId: "opus",
      model: "Claude Opus",
      brief: long,
      startedAt: app.clock.now(),
    });
    for (let i = 0; i < MAX_STAGE_PARTS + 200; i++) {
      feed.update({
        sessionUpdate: "tool_call",
        toolCallId: `c${i}`,
        title: `Read f${i}`,
        kind: "read",
        status: "completed",
      });
    }
    feed.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late words" } });
    feed.end({ kind: "done", output: "ok" });
    const turn = app.ahp.host.chatState(stageChatUri(77))?.turns[0] as Any;
    // the steps stop at the cap, and the last slots show how it came out: a count of what was left out, and the answer
    expect(turn.responseParts.length).toBeLessThanOrEqual(MAX_STAGE_PARTS + 3);
    const all = JSON.stringify(turn.responseParts);
    expect(all).toContain("stops adding new steps");
    expect(all).toContain(
      `${MAX_STAGE_PARTS + 200 + 1 - (MAX_STAGE_PARTS - TAIL_PARTS)} steps not shown here`,
    );
    expect(turn.responseParts.at(-1)).toMatchObject({ kind: "markdown", content: "ok" });
    expect(turn.state).toBe("complete");
    expect(turn.message.text.length).toBeLessThan(4300);
    expect(app.ahp.tickets.footprint()).toEqual({ feeds: 0 });
  });

  it("keeps a tool's result and input to 8 KB, with a marker, and leaves short ones alone", async () => {
    const app = await testApp();
    const feed = app.ahp.tickets.begin({
      ticketId: "9",
      ticketTitle: "Big output",
      stage: "build",
      sessionId: 61,
      employeeId: "ada",
      engineId: "opus",
      model: "m",
      brief: "b",
      startedAt: app.clock.now(),
    });
    const big = `${"line of output\n".repeat(5000)}`;
    feed.update({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Run tests",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: big },
    });
    feed.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: big } }],
    });
    feed.update({
      sessionUpdate: "tool_call",
      toolCallId: "t2",
      title: "Run short",
      kind: "execute",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "all green" } }],
    });
    feed.end({ kind: "done", output: "ok" });
    const parts = (turnOf(app, stageChatUri(61)) as Any).responseParts.filter(
      (p: Any) => p.kind === "toolCall",
    );
    const t1 = parts[0].toolCall;
    const out = t1.content[0].text as string;
    expect(out.length).toBeLessThan(MAX_TOOL_TEXT + 200);
    expect(out).toContain("truncated");
    expect((t1.toolInput as string).length).toBeLessThan(MAX_TOOL_TEXT + 400);
    expect(parts[1].toolCall.content[0].text).toBe("all green");
  });

  it("a view that breaks never fails the stage, and is not left running", async () => {
    const app = await testApp();
    const feed = app.ahp.tickets.begin({
      ticketId: "9",
      ticketTitle: "Breaks",
      stage: "build",
      sessionId: 5,
      employeeId: "ada",
      engineId: "opus",
      model: "m",
      brief: "b",
      startedAt: app.clock.now(),
    });
    feed.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } });
    const real = app.ahp.host.emit.bind(app.ahp.host);
    app.ahp.host.emit = () => {
      throw new Error("disk full");
    };
    expect(() =>
      feed.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "more" } }),
    ).not.toThrow();
    app.ahp.host.emit = real;
    expect(() => feed.end({ kind: "done", output: "ok" })).not.toThrow();
    expect(app.ahp.host.hasActiveTurn(stageChatUri(5))).toBe(false);
  });

  it("evicts idle stage chats like any chat: a hundred stages hold only the cap in memory", async () => {
    const app = await testApp();
    const host = app.ahp.host;
    const cap = host.limits.maxLoadedChats;
    for (let i = 1; i <= cap + 30; i++) {
      const feed = app.ahp.tickets.begin({
        ticketId: String(1000 + i),
        ticketTitle: "Many",
        stage: "build",
        sessionId: 500 + i,
        employeeId: "ada",
        engineId: "opus",
        model: "m",
        brief: "b",
        startedAt: app.clock.now(),
      });
      feed.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `stage ${i}` } });
      feed.end({ kind: "done", output: "ok" });
    }
    expect(host.loadedChats).toBeLessThanOrEqual(cap);
    // an evicted one comes back from the store when it is read
    expect(JSON.stringify(host.chatState(stageChatUri(501)))).toContain("stage 1");
  });
});

describe("retention", () => {
  it("lets go of a stage's view after the transcript compaction window, keeps the transcript, and drops an emptied session", async () => {
    const { app, id } = await ranTicket();
    const host = app.ahp.host;
    // a closed ticket: approve it so it is closed, then a month and a bit goes by
    await app.call("POST", `/api/tickets/${id}/decide`, { decision: "approve" });
    await app.daemon.idle();
    const chats = host.chatsOf(ticketSessionUri(id));
    expect(chats.length).toBeGreaterThan(0);
    const transcripts = (await app.call("GET", `/api/tickets/${id}/sessions`)).body.sessions.length;
    app.clock.advance(5 * 24 * 60);
    const early = await app.deps.storage?.maintainHost({ manual: true });
    expect(early?.ticketViews).toEqual({ chats: 0, sessions: 0 });
    expect(host.hasChannel(chats[0] as string)).toBe(true);

    app.clock.advance(30 * 24 * 60);
    const late = await app.deps.storage?.maintainHost({ manual: true });
    expect(late?.ticketViews?.chats).toBe(chats.length);
    expect(late?.ticketViews?.sessions).toBe(1);
    for (const chat of chats) expect(host.hasChannel(chat)).toBe(false);
    expect(host.hasChannel(ticketSessionUri(id))).toBe(false);
    expect(app.db.all("SELECT * FROM ahp_channels WHERE uri LIKE 'ahp-chat:/stage:%'")).toEqual([]);
    // the transcript remains, and says there is no view
    const after = (await app.call("GET", `/api/tickets/${id}/sessions`)).body.sessions;
    expect(after).toHaveLength(transcripts);
    expect(after[0].channel).toBeNull();
    expect(after[0].items.length).toBeGreaterThan(0);
  });

  it("has its own window, stageViewDays, which applies even when the transcripts' compaction is off", async () => {
    const { app, id } = await ranTicket();
    const host = app.ahp.host;
    await app.call("POST", `/api/tickets/${id}/decide`, { decision: "approve" });
    await app.daemon.idle();
    const chats = host.chatsOf(ticketSessionUri(id));
    expect(chats.length).toBeGreaterThan(0);
    const set = await app.call("PUT", "/api/storage/settings", {
      transcriptCompactDays: 0,
      stageViewDays: 60,
    });
    expect(set.status).toBe(200);
    expect(set.body.settings.stageViewDays).toBe(60);
    app.clock.advance(45 * 24 * 60);
    expect((await app.deps.storage?.maintainHost({ manual: true }))?.ticketViews).toEqual({
      chats: 0,
      sessions: 0,
    });
    app.clock.advance(20 * 24 * 60);
    const late = await app.deps.storage?.maintainHost({ manual: true });
    expect(late?.ticketViews?.chats).toBe(chats.length);
    for (const chat of chats) expect(host.hasChannel(chat)).toBe(false);
    expect((await app.call("PUT", "/api/storage/settings", { stageViewDays: 0 })).status).toBe(400);
  });

  it("lets go of the view of a stage whose transcript is gone, and never one that is running", async () => {
    const app = await testApp();
    const mk = (sessionId: number, ticketId: string) =>
      app.ahp.tickets.begin({
        ticketId,
        ticketTitle: "T",
        stage: "build",
        sessionId,
        employeeId: "ada",
        engineId: "opus",
        model: "m",
        brief: "b",
        startedAt: app.clock.now(),
      });
    const finished = mk(31, "31");
    finished.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
    finished.end({ kind: "done", output: "ok" });
    const running = mk(32, "32");
    running.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "busy" } });
    // neither has a transcript row: the finished one goes, the running one stays
    const r = await app.ahp.tickets.sweep({});
    expect(r.chats).toBe(1);
    expect(app.ahp.host.hasChannel(stageChatUri(31))).toBe(false);
    expect(app.ahp.host.hasChannel(stageChatUri(32))).toBe(true);
    running.end({ kind: "done", output: "ok" });
  });
});
