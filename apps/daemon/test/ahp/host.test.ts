// AHP 1.0 conformance for what the host implements: the handshake, subscribe/snapshot/ordered actions,
// reconnect with replay, first confirmation wins, cancel, pending messages, chats, paging, validation.
import { describe, expect, it } from "vitest";
import {
  ActionType,
  PendingMessageKind,
  ResponsePartKind,
  ROOT,
  SessionStatus,
  ToolCallCancellationReason,
  ToolCallConfirmationReason,
  ToolCallStatus,
  TurnState,
} from "../../src/ahp/wire.ts";
import { type Any, gate, rig, turnStarted, userMessage } from "./support.ts";

const settle = () => new Promise<void>((r) => setTimeout(r, 0));
const confirm = (turnId: string, toolCallId: string, approved: boolean, optionId?: string) =>
  approved
    ? {
        type: ActionType.ChatToolCallConfirmed,
        turnId,
        toolCallId,
        approved: true,
        confirmed: ToolCallConfirmationReason.UserAction,
        ...(optionId ? { selectedOptionId: optionId } : {}),
      }
    : {
        type: ActionType.ChatToolCallConfirmed,
        turnId,
        toolCallId,
        approved: false,
        reason: ToolCallCancellationReason.Denied,
        ...(optionId ? { selectedOptionId: optionId } : {}),
      };

describe("handshake", () => {
  it("negotiates 1.0.0 and answers with the host-wide serverSeq and the root snapshot", async () => {
    const t = await rig();
    const c = t.client();
    const r = await c.init();
    expect(r.protocolVersion).toBe("1.0.0");
    expect(r.serverSeq).toBe(0);
    expect(r.snapshots[0].resource).toBe(ROOT);
    expect(r.snapshots[0].state.agents[0].provider).toBe("fake");
    expect(r.serverInfo.name).toBe("i-inc");
  });

  it("refuses a version it does not speak with -32005 and the supported list", async () => {
    const t = await rig();
    const c = t.client();
    const bad = await c.rpc("initialize", { channel: ROOT, protocolVersions: ["0.9.0"], clientId: "x" });
    expect(bad.error).toMatchObject({ code: -32005, data: { supportedVersions: ["1.0.0"] } });
    const future = await c.rpc("initialize", { channel: ROOT, protocolVersions: ["2.0.0"], clientId: "x" });
    expect(future.error).toMatchObject({ code: -32005 });
    const junk = await c.rpc("initialize", { channel: ROOT, protocolVersions: ["one"], clientId: "x" });
    expect(junk.error).toMatchObject({ code: -32602 });
    // offered a list, it picks 1.0.0
    const ok = await c.rpc("initialize", {
      channel: ROOT,
      protocolVersions: ["0.9.0", "1.0.0"],
      clientId: "x",
    });
    expect(ok.result).toMatchObject({ protocolVersion: "1.0.0" });
  });

  it("needs initialize first, answers ping early, and says so for an unknown method", async () => {
    const t = await rig();
    const c = t.client();
    expect((await c.rpc("ping", { channel: ROOT })).result).toBeNull();
    expect((await c.rpc("listSessions", { channel: ROOT })).error).toMatchObject({ code: -32600 });
    await c.init();
    expect((await c.rpc("frobnicate", {})).error).toMatchObject({ code: -32601 });
    // a malformed frame is a parse error with a null id, not a crash
    await t.host.receive(c.conn, "{nope");
    expect(c.socket.frames.at(-1)).toMatchObject({ id: null, error: { code: -32700 } });
    await t.host.receive(c.conn, JSON.stringify([1, 2]));
    expect(c.socket.frames.at(-1)).toMatchObject({ error: { code: -32600 } });
  });
});

describe("subscribe, snapshot and ordered actions", () => {
  it("gives a snapshot at fromSeq, then every later action in order, from one host-wide counter", async () => {
    const t = await rig();
    const { session, chat } = await t.session();
    const a = t.client();
    const b = t.client();
    await a.init([ROOT, session, chat]);
    await b.init([ROOT]);
    const snap = await b.subscribe(chat);
    expect(snap.snapshot.fromSeq).toBe(t.host.serverSeq);
    expect(snap.snapshot.state.turns).toEqual([]);

    const turnId = "t1";
    a.dispatch(chat, turnStarted("hi", turnId));
    await t.host.idle();
    const seen = a.actions().map((e) => e.serverSeq);
    expect(seen.length).toBeGreaterThan(3);
    expect(seen).toEqual([...seen].sort((x, y) => x - y));
    expect(new Set(seen).size).toBe(seen.length); // strictly increasing, never repeated
    // one counter for the whole host: the chat and the session channels interleave in it
    const channels = new Set(a.actions().map((e) => e.channel));
    expect(channels.has(chat) && channels.has(session)).toBe(true);
    // b only subscribed to the chat (and root): it sees the chat's actions, in the same order, none from the session
    expect(b.actions().every((e) => e.channel === chat)).toBe(true);
    expect(b.actions().map((e) => e.serverSeq)).toEqual(a.actions(chat).map((e) => e.serverSeq));
    expect(Math.min(...b.actions().map((e) => e.serverSeq))).toBeGreaterThan(snap.snapshot.fromSeq);
    // both mirrors, run through the official reducers, equal the host's state
    expect(b.state(chat)).toEqual(JSON.parse(JSON.stringify(t.host.chatState(chat))));
    expect(a.state(chat)).toEqual(b.state(chat));
    expect(t.host.chatState(chat)?.turns[0]?.state).toBe(TurnState.Complete);
  });

  it("stops sending after unsubscribe, and knows nothing of a channel that does not exist", async () => {
    const t = await rig();
    const { chat } = await t.session();
    const c = t.client();
    await c.init();
    await c.subscribe(chat);
    c.notify("unsubscribe", { channel: chat });
    const other = t.client();
    await other.init([ROOT, chat]);
    other.dispatch(chat, turnStarted("go"));
    await t.host.idle();
    expect(c.actions(chat)).toEqual([]);
    const missing = await c.rpc("subscribe", { channel: "ahp-chat:/nope" });
    expect(missing.error).toMatchObject({ code: -32001 });
  });

  it("lists sessions, newest activity first, with a status that follows the chat", async () => {
    const t = await rig();
    const one = await t.session();
    t.time.now += 5000;
    const two = await t.session();
    const c = t.client();
    await c.init();
    const list = (await c.call("listSessions", { channel: ROOT })).items;
    expect(list.map((s: Any) => s.resource)).toEqual([two.session, one.session]);
    expect(list[0].status & SessionStatus.Idle).toBeTruthy();
    expect(list[0].defaultChat).toBe(two.chat);
    const g = gate();
    t.backend.script = async () => {
      await g.promise;
      return { kind: "complete" };
    };
    c.dispatch(one.chat, turnStarted("work"));
    await settle();
    const running = (await c.call("listSessions", { channel: ROOT })).items.find(
      (s: Any) => s.resource === one.session,
    );
    expect(running.status & SessionStatus.InProgress).toBeTruthy();
    g.resolve();
    await t.host.idle();
    const paged = await c.call("listSessions", { channel: ROOT, limit: 1 });
    expect(paged.items).toHaveLength(1);
    expect(paged.nextCursor).toBe("1");
  });

  it("tells root subscribers about a new session and a changed summary", async () => {
    const t = await rig();
    const c = t.client();
    await c.init();
    const { chat, session } = await t.session();
    c.absorb();
    expect(c.notes.find((n) => n.method === "root/sessionAdded")).toBeTruthy();
    const other = t.client();
    await other.init([ROOT, chat]);
    other.dispatch(chat, turnStarted("hello"));
    await t.host.idle();
    c.absorb();
    const changed = c.notes.filter((n) => n.method === "root/sessionSummaryChanged");
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.at(-1)).toMatchObject({ params: { session } });
  });
});

describe("reconnect", () => {
  it("replays exactly what was missed, so the mirror ends equal to the host", async () => {
    const t = await rig();
    const { session, chat } = await t.session();
    const a = t.client("a");
    await a.init([ROOT, session, chat]);
    const b = t.client("b");
    await b.init([ROOT, session, chat]);
    a.dispatch(chat, turnStarted("first", "t1"));
    await t.host.idle();
    const seen = b.lastSeq;
    b.disconnect();
    a.dispatch(chat, turnStarted("second", "t2"));
    await t.host.idle();

    const b2 = t.client("b");
    const r = await b2.reconnect(seen, [ROOT, session, chat]);
    expect(r.type).toBe("replay");
    expect(r.missing).toEqual([]);
    const missed = a.actions().filter((e) => e.serverSeq > seen);
    expect(r.actions.map((e: Any) => e.serverSeq)).toEqual(missed.map((e) => e.serverSeq));
    expect(b2.lastSeq).toBe(t.host.serverSeq);
    // b2 never saw the first half (no snapshot): replay on top of its old state is what b held
    expect(b.state(chat)).toBeDefined();
    // and it is subscribed again: live actions arrive
    a.dispatch(chat, turnStarted("third", "t3"));
    await t.host.idle();
    expect(b2.actions(chat).some((e) => (e.action as Any).turnId === "t3")).toBe(true);
  });

  it("names the channels that are gone, and carries on for the rest", async () => {
    const t = await rig();
    const { chat } = await t.session();
    const c = t.client();
    const r = await c.reconnect(0, [ROOT, chat, "ahp-chat:/gone"]);
    expect(r.type).toBe("replay");
    expect(r.missing).toEqual(["ahp-chat:/gone"]);
  });

  it("answers with snapshots when the client is ahead of the host", async () => {
    const t = await rig();
    const { chat } = await t.session();
    const c = t.client();
    const r = await c.reconnect(10_000, [chat]);
    expect(r.type).toBe("snapshot");
    expect(r.snapshots[0].resource).toBe(chat);
  });

  it("answers with snapshots when the replay would be huge", async () => {
    const t = await rig({ limits: { maxReplayActions: 2 } });
    const { chat } = await t.session();
    const a = t.client();
    await a.init([ROOT, chat]);
    a.dispatch(chat, turnStarted("go"));
    await t.host.idle();
    const r = await t.client().reconnect(0, [chat]);
    expect(r.type).toBe("snapshot");
  });
});

describe("first confirmation wins", () => {
  async function pending() {
    const t = await rig();
    const { session, chat } = await t.session();
    const a = t.client("a");
    const b = t.client("b");
    await a.init([ROOT, session, chat]);
    await b.init([ROOT, session, chat]);
    const finished = gate();
    t.backend.script = async (run, be) => {
      const answer = await be.ask(run, "tc1");
      be.done(run, "tc1", answer.approved ? "deleted" : "skipped", answer.approved);
      finished.resolve();
      return { kind: "complete" };
    };
    a.dispatch(chat, turnStarted("clean", "t1"));
    await settle();
    return { t, session, chat, a, b, finished };
  }

  it("shows the card to both clients and in the session's inputNeeded roll-up", async () => {
    const { t, session, chat, a, b } = await pending();
    const call = (c: typeof a) =>
      c.state(chat).activeTurn.responseParts.find((p: Any) => p.kind === ResponsePartKind.ToolCall).toolCall;
    expect(call(a).status).toBe(ToolCallStatus.PendingConfirmation);
    expect(call(b).options.map((o: Any) => o.id)).toEqual([
      "allow-once",
      "allow-always",
      "reject-once",
      "reject-always",
    ]);
    const need = t.host.sessionState(session)?.inputNeeded ?? [];
    expect(need).toHaveLength(1);
    expect(need[0]).toMatchObject({ kind: "toolConfirmation", chat });
    expect(t.host.sessionState(session)?.status).toBe(SessionStatus.InputNeeded);
    expect(t.host.summary(session)?.status).toBe(SessionStatus.InputNeeded);
    b.dispatch(chat, confirm("t1", "tc1", true, "allow-once"));
    await t.host.idle();
    expect(t.host.sessionState(session)?.inputNeeded).toBeUndefined();
  });

  it("lets the first answer through and rejects the second with a reason, using no serverSeq", async () => {
    const { t, chat, a, b, finished } = await pending();
    a.dispatch(chat, confirm("t1", "tc1", true, "allow-once"));
    const seqAfterFirst = t.host.serverSeq;
    b.dispatch(chat, confirm("t1", "tc1", false, "reject-once"));
    expect(t.host.serverSeq).toBe(seqAfterFirst); // a rejection consumes nothing
    await finished.promise;
    await t.host.idle();
    expect(b.rejections()).toHaveLength(1);
    expect(b.rejections()[0]?.rejectionReason).toMatch(/someone answered/);
    expect(b.rejections()[0]?.serverSeq).toBe(seqAfterFirst);
    expect(a.rejections()).toEqual([]); // the winner hears nothing of it
    expect(t.backend.answers).toHaveLength(1);
    expect(t.backend.answers[0]).toMatchObject({
      toolCallId: "tc1",
      answer: { approved: true, selectedOptionId: "allow-once", selectedOption: { kind: "approve" } },
    });
  });

  it("holds when the two answers arrive at the same moment, whichever order", async () => {
    for (const first of ["a", "b"]) {
      const { t, chat, a, b, finished } = await pending();
      const [x, y] = first === "a" ? [a, b] : [b, a];
      x.dispatch(chat, confirm("t1", "tc1", false, "reject-once"));
      y.dispatch(chat, confirm("t1", "tc1", true, "allow-once"));
      await finished.promise;
      await t.host.idle();
      expect(t.backend.answers).toHaveLength(1);
      expect(t.backend.answers[0]?.answer.approved).toBe(false);
      expect(y.rejections()).toHaveLength(1);
      expect(x.rejections()).toHaveLength(0);
      const turn = t.host.chatState(chat)?.turns[0];
      const tc = turn?.responseParts.find((p) => p.kind === ResponsePartKind.ToolCall);
      // a denied call ends cancelled (the reducer), and the agent's own report cannot revive it
      expect(tc && "toolCall" in tc ? tc.toolCall.status : "").toBe(ToolCallStatus.Cancelled);
    }
  });

  it("refuses answers that are not allowed: another option's kind, a wrong turn, edited input", async () => {
    const { t, chat, a } = await pending();
    a.dispatch(chat, confirm("t1", "tc1", true, "reject-once"));
    a.dispatch(chat, confirm("t1", "tc1", true, "nonsense"));
    a.dispatch(chat, { ...confirm("t1", "tc1", true), confirmed: ToolCallConfirmationReason.NotNeeded });
    a.dispatch(chat, confirm("other", "tc1", true));
    a.dispatch(chat, { ...confirm("t1", "tc1", false), reason: "whatever" });
    expect(a.rejections().map((r) => r.rejectionReason)).toEqual([
      "the option and the answer disagree",
      "that is not one of the options",
      "confirmed must be user-action",
      expect.stringMatching(/not waiting/),
      "a denial needs a reason",
    ]);
    expect(t.backend.answers).toHaveLength(0);
    a.dispatch(chat, confirm("t1", "tc1", true, "allow-always"));
    await t.host.idle();
    expect(t.backend.answers[0]?.answer.selectedOptionId).toBe("allow-always");
  });
});

describe("cancel", () => {
  it("ends the turn at once for everyone, aborts the agent and drops its late updates", async () => {
    const t = await rig();
    const { session, chat } = await t.session();
    const a = t.client();
    const b = t.client();
    await a.init([ROOT, session, chat]);
    await b.init([ROOT, session, chat]);
    const aborted = gate<boolean>();
    let late = true;
    t.backend.script = async (run, be) => {
      be.text(run, "partial answer");
      run.signal.addEventListener("abort", () => aborted.resolve(true));
      await Promise.race([be.ask(run, "tc1"), aborted.promise]); // never answered: the cancel ends the wait
      return { kind: "cancelled" };
    };
    a.dispatch(chat, turnStarted("long job", "t1"));
    await settle();
    expect(t.host.sessionState(session)?.inputNeeded).toHaveLength(1);
    b.dispatch(chat, { type: ActionType.ChatTurnCancelled, turnId: "t1", duration: 0 });
    expect(await aborted.promise).toBe(true);
    const turn = t.host.chatState(chat)?.turns[0];
    expect(turn?.state).toBe(TurnState.Cancelled);
    expect(turn?.responseParts[0]).toMatchObject({
      kind: ResponsePartKind.Markdown,
      content: "partial answer",
    }); // partial text kept
    const tc = turn?.responseParts.find((p) => p.kind === ResponsePartKind.ToolCall);
    expect(tc && "toolCall" in tc ? tc.toolCall.status : "").toBe(ToolCallStatus.Cancelled); // the pending card is gone
    expect(t.host.sessionState(session)?.inputNeeded).toBeUndefined();
    expect(t.backend.cancelled).toHaveLength(1);
    expect(a.actions(chat).some((e) => e.action.type === ActionType.ChatTurnCancelled)).toBe(true);
    // the agent talking after the cancel changes nothing
    const run = t.backend.runs[0];
    late = run?.emit({ type: ActionType.ChatDelta, turnId: "t1", partId: "t1:md", content: " MORE" }) ?? true;
    expect(late).toBe(false);
    await t.host.idle();
    expect(t.host.chatState(chat)?.turns[0]?.responseParts[0]).toMatchObject({ content: "partial answer" });
  });

  it("rejects a cancel for a turn that is not the active one", async () => {
    const t = await rig();
    const { chat } = await t.session();
    const a = t.client();
    await a.init([ROOT, chat]);
    a.dispatch(chat, { type: ActionType.ChatTurnCancelled, turnId: "x", duration: 0 });
    expect(a.rejections()[0]?.rejectionReason).toBe("no such active turn");
  });
});

describe("turns and pending messages", () => {
  it("rejects a second turn while one runs, and queues it instead", async () => {
    const t = await rig();
    const { chat } = await t.session();
    const a = t.client();
    await a.init([ROOT, chat]);
    const g = gate();
    const order: string[] = [];
    t.backend.script = async (run) => {
      order.push(run.message.text);
      await g.promise;
      return { kind: "complete" };
    };
    a.dispatch(chat, turnStarted("one", "t1"));
    await settle();
    a.dispatch(chat, turnStarted("two", "t2"));
    expect(a.rejections()[0]?.rejectionReason).toMatch(/already running/);
    a.dispatch(chat, {
      type: ActionType.ChatPendingMessageSet,
      kind: PendingMessageKind.Queued,
      id: "q1",
      message: userMessage("two"),
    });
    a.dispatch(chat, {
      type: ActionType.ChatPendingMessageSet,
      kind: PendingMessageKind.Queued,
      id: "q2",
      message: userMessage("three"),
    });
    a.dispatch(chat, {
      type: ActionType.ChatPendingMessageSet,
      kind: PendingMessageKind.Steering,
      id: "s1",
      message: userMessage("steer"),
    });
    expect(t.host.chatState(chat)?.queuedMessages?.map((m) => m.id)).toEqual(["q1", "q2"]);
    expect(t.host.chatState(chat)?.steeringMessage?.id).toBe("s1");
    g.resolve();
    await t.host.idle();
    // steering goes first (no mid-turn injection in ACP), then the queue in order; each leaves the pending lists
    expect(order).toEqual(["one", "steer", "two", "three"]);
    const st = t.host.chatState(chat);
    expect(st?.turns.map((x) => x.message.text)).toEqual(["one", "steer", "two", "three"]);
    expect(st?.queuedMessages).toBeUndefined();
    expect(st?.steeringMessage).toBeUndefined();
  });

  it("starts a message set while idle straight away, and can reorder and remove queued ones", async () => {
    const t = await rig();
    const { chat } = await t.session();
    const a = t.client();
    await a.init([ROOT, chat]);
    const g = gate();
    t.backend.script = async (run) => {
      if (run.message.text === "hold") await g.promise;
      return { kind: "complete" };
    };
    a.dispatch(chat, {
      type: ActionType.ChatPendingMessageSet,
      kind: PendingMessageKind.Queued,
      id: "q0",
      message: userMessage("hold"),
    });
    await settle();
    expect(t.host.chatState(chat)?.activeTurn?.message.text).toBe("hold");
    for (const [id, text] of [
      ["q1", "b"],
      ["q2", "c"],
      ["q3", "d"],
    ] as const) {
      a.dispatch(chat, {
        type: ActionType.ChatPendingMessageSet,
        kind: PendingMessageKind.Queued,
        id,
        message: userMessage(text),
      });
    }
    a.dispatch(chat, { type: ActionType.ChatQueuedMessagesReordered, order: ["q3", "q1"] });
    a.dispatch(chat, {
      type: ActionType.ChatPendingMessageRemoved,
      kind: PendingMessageKind.Queued,
      id: "q1",
    });
    expect(t.host.chatState(chat)?.queuedMessages?.map((m) => m.id)).toEqual(["q3", "q2"]);
    g.resolve();
    await t.host.idle();
    expect(t.host.chatState(chat)?.turns.map((x) => x.message.text)).toEqual(["hold", "d", "c"]);
  });

  it("ends a turn in an error when the agent fails or throws, and the chat is usable again", async () => {
    const t = await rig();
    const { chat, session } = await t.session();
    const a = t.client();
    await a.init([ROOT, chat]);
    t.backend.script = async () => ({ kind: "error", errorType: "agent_exited", message: "exit 1" });
    a.dispatch(chat, turnStarted("a", "t1"));
    await t.host.idle();
    expect(t.host.chatState(chat)?.turns[0]?.state).toBe(TurnState.Error);
    expect(t.host.sessionState(session)?.chats[0]?.status).toBeDefined();
    t.backend.script = async () => {
      throw new Error("boom");
    };
    a.dispatch(chat, turnStarted("b", "t2"));
    await t.host.idle();
    const last = t.host.chatState(chat)?.turns[1];
    expect(last?.state).toBe(TurnState.Error);
    expect(JSON.stringify(last?.responseParts)).toContain("boom");
    t.backend.script = async () => ({ kind: "complete" });
    a.dispatch(chat, turnStarted("c", "t3"));
    await t.host.idle();
    expect(t.host.chatState(chat)?.turns[2]?.state).toBe(TurnState.Complete);
  });

  it("titles a new conversation from its first message, once", async () => {
    const t = await rig();
    const { chat, session } = await t.session();
    const a = t.client();
    await a.init([ROOT, chat]);
    a.dispatch(chat, turnStarted("Fix the refunds total\nand its tests", "t1"));
    await t.host.idle();
    expect(t.host.sessionState(session)?.title).toBe("Fix the refunds total");
    a.dispatch(chat, turnStarted("something else entirely", "t2"));
    await t.host.idle();
    expect(t.host.sessionState(session)?.title).toBe("Fix the refunds total");
  });
});

describe("validation of what clients send", () => {
  it("ignores actions for unknown channels, and rejects ones a client may not send", async () => {
    const t = await rig();
    const { chat, session } = await t.session();
    const a = t.client();
    await a.init([ROOT, chat, session]);
    a.dispatch("ahp-chat:/unknown", turnStarted("x"));
    expect(a.rejections()).toEqual([]);
    a.dispatch(chat, { type: ActionType.ChatDelta, turnId: "t", partId: "p", content: "forged" });
    a.dispatch(chat, { type: "chat/nonsense" });
    a.dispatch(chat, { type: ActionType.SessionTitleChanged, title: "wrong channel" });
    a.dispatch(chat, "not an object" as never);
    a.dispatch(chat, {
      type: ActionType.ChatToolCallComplete,
      turnId: "t",
      toolCallId: "x",
      result: { success: true, pastTenseMessage: "forged" },
    });
    a.dispatch(chat, { type: "chat/truncated" });
    expect(a.rejections().map((r) => r.rejectionReason)).toEqual([
      "chat/delta is not client-dispatchable",
      "chat/nonsense is not client-dispatchable",
      "session/titleChanged does not belong on a chat channel",
      "not an action",
      "chat/toolCallComplete is not supported by this host",
      "chat/truncated is not supported by this host",
    ]);
    expect(t.host.chatState(chat)?.turns).toEqual([]);
  });

  it("checks messages: the user origin, sizes, attachment count and image bytes", async () => {
    const t = await rig();
    const { chat } = await t.session();
    const a = t.client();
    await a.init([ROOT, chat]);
    const bad = (m: unknown, why: RegExp) => {
      const n = a.rejections().length;
      a.dispatch(chat, {
        type: ActionType.ChatTurnStarted,
        turnId: crypto.randomUUID(),
        startedAt: new Date().toISOString(),
        message: m,
      });
      expect(a.rejections()[n]?.rejectionReason).toMatch(why);
    };
    bad({ text: "x", origin: { kind: "agent" } }, /user origin/);
    bad({ origin: { kind: "user" } }, /needs text/);
    bad({ text: "x".repeat(200_001), origin: { kind: "user" } }, /at most 200000/);
    bad(
      { text: "x", origin: { kind: "user" }, attachments: Array(7).fill({ type: "simple", label: "l" }) },
      /at most 6/,
    );
    bad(
      {
        text: "x",
        origin: { kind: "user" },
        attachments: [{ type: "chat", label: "l", resource: "ahp-chat:/x" }],
      },
      /not supported/,
    );
    const notImage = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64");
    bad(
      {
        text: "x",
        origin: { kind: "user" },
        attachments: [
          { type: "embeddedResource", label: "x.svg", data: notImage, contentType: "image/svg+xml" },
        ],
      },
      /isn't a PNG/,
    );
    const big = Buffer.alloc(1024 * 1024 + 1, 65).toString("base64");
    bad(
      {
        text: "x",
        origin: { kind: "user" },
        attachments: [{ type: "embeddedResource", label: "big.txt", data: big, contentType: "text/plain" }],
      },
      /over 1 MB/,
    );
    a.dispatch(chat, {
      type: ActionType.ChatTurnStarted,
      turnId: "",
      startedAt: new Date().toISOString(),
      message: userMessage("x"),
    });
    a.dispatch(chat, {
      type: ActionType.ChatTurnStarted,
      turnId: "ok",
      startedAt: "yesterday-ish",
      message: userMessage("x"),
    });
    expect(
      a
        .rejections()
        .slice(-2)
        .map((r) => r.rejectionReason),
    ).toEqual(["turnId must be a short string", "startedAt must be a timestamp"]);
    expect(t.host.chatState(chat)?.activeTurn).toBeUndefined();
  });

  it("keeps big attachments out of the log: a content blob behind a URI, the agent gets the bytes", async () => {
    const t = await rig();
    const { chat } = await t.session();
    const a = t.client();
    await a.init([ROOT, chat]);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(9000, 7),
    ]);
    const data = png.toString("base64");
    let seen: Any;
    t.backend.script = async (run) => {
      seen = run.message.attachments;
      return { kind: "complete" };
    };
    a.dispatch(
      chat,
      turnStarted("look", "t1", {
        attachments: [{ type: "embeddedResource", label: "shot.png", data, contentType: "image/png" }],
      }),
    );
    await t.host.idle();
    // what the agent was handed: the image itself
    expect(seen[0]).toMatchObject({
      type: "embeddedResource",
      label: "shot.png",
      contentType: "image/png",
      data,
    });
    // what the log and every client's state hold: a reference, not 12 KB of base64
    const kept = t.host.chatState(chat)?.turns[0]?.message.attachments?.[0] as Any;
    expect(kept.type).toBe("resource");
    expect(kept.uri).toMatch(/^ahp-content:\/[0-9a-f]{32}$/);
    expect(JSON.stringify(t.db.all("SELECT action FROM ahp_actions"))).not.toContain(data);
    const read = await a.call("resourceRead", { channel: ROOT, uri: kept.uri });
    expect(read).toMatchObject({ encoding: "base64", contentType: "image/png" });
    expect(Buffer.from(read.data, "base64").equals(png)).toBe(true);
    expect(
      (await a.rpc("resourceRead", { channel: ROOT, uri: "ahp-content:/ffffffffffffffffffffffffffffffff" }))
        .error,
    ).toBeTruthy();
    expect((await a.rpc("resourceRead", { channel: ROOT, uri: "file:///etc/passwd" })).error).toBeTruthy();
  });
});

describe("session config", () => {
  it("takes the agent's modes as the schema, switches mode and tells the agent", async () => {
    const t = await rig();
    const { session } = await t.session();
    const a = t.client();
    await a.init([ROOT, session]);
    const cfg = t.host.sessionState(session)?.config;
    expect(cfg?.schema.properties.mode?.enumLabels).toEqual([
      "Always ask",
      "Accept edits",
      "Plan only",
      "Bypass permissions",
    ]);
    expect(cfg?.values.mode).toBe("bypass");
    a.dispatch(session, { type: ActionType.SessionConfigChanged, config: { mode: "plan" } });
    await settle();
    expect(t.host.sessionState(session)?.config?.values.mode).toBe("plan");
    expect(t.backend.configs).toEqual([{ mode: "plan" }]);
    expect(a.state<Any>(session).config.values.mode).toBe("plan");
  });

  it("rejects an unknown key, a value outside the enum and a value fixed at creation", async () => {
    const t = await rig();
    const { session } = await t.session();
    const a = t.client();
    await a.init([ROOT, session]);
    a.dispatch(session, { type: ActionType.SessionConfigChanged, config: { mode: "yolo" } });
    a.dispatch(session, { type: ActionType.SessionConfigChanged, config: { nope: 1 } });
    a.dispatch(session, { type: ActionType.SessionConfigChanged, config: { model: "b" } });
    expect(a.rejections().map((r) => r.rejectionReason)).toEqual([
      "yolo is not a valid mode",
      "unknown config nope",
      "model cannot be changed once the session has started",
    ]);
    expect(t.backend.configs).toEqual([]);
  });

  it("puts the old value back when the agent refuses the change", async () => {
    const t = await rig();
    const { session } = await t.session();
    const a = t.client();
    await a.init([ROOT, session]);
    t.backend.failSetConfig = new Error("no such mode");
    a.dispatch(session, { type: ActionType.SessionConfigChanged, config: { mode: "ask" } });
    await settle();
    await settle();
    expect(t.host.sessionState(session)?.config?.values.mode).toBe("bypass");
    expect(a.state<Any>(session).config.values.mode).toBe("bypass");
  });

  it("creates a session in the mode asked for, and refuses a mode the agent does not have", async () => {
    const t = await rig();
    const made = await t.host.createSession({ provider: "fake", config: { mode: "plan" } });
    expect(t.host.sessionState(made.session)?.config?.values.mode).toBe("plan");
    await expect(t.host.createSession({ provider: "fake", config: { mode: "yolo" } })).rejects.toThrow(
      /not a valid mode/,
    );
    await expect(t.host.createSession({ provider: "other" })).rejects.toThrow(/no agent for provider/);
    t.backend.failOpen = new Error("sandbox did not start");
    await expect(t.host.createSession({ provider: "fake" })).rejects.toThrow(/sandbox did not start/);
    // a failed creation leaves nothing behind
    expect(t.host.sessions()).toHaveLength(1);
  });
});

describe("chats", () => {
  it("adds and disposes extra chats for providers that allow them, never the default one", async () => {
    const t = await rig();
    t.backend.multipleChats = true;
    t.host.refreshAgents();
    const { session, chat } = await t.session();
    const a = t.client();
    await a.init([ROOT, session]);
    const second = "ahp-chat:/second";
    await a.call("createChat", { channel: session, chat: second });
    expect(t.host.sessionState(session)?.chats.map((c) => c.resource)).toEqual([chat, second]);
    expect(a.state<Any>(session).chats).toHaveLength(2);
    expect((await a.rpc("createChat", { channel: session, chat: second })).error).toMatchObject({
      code: -32010,
    });
    expect((await a.rpc("disposeChat", { channel: chat })).error).toMatchObject({ code: -32011 });
    await a.subscribe(second);
    await a.call("disposeChat", { channel: second });
    expect(t.host.sessionState(session)?.chats.map((c) => c.resource)).toEqual([chat]);
    expect(t.host.chatState(second)).toBeUndefined();
    expect(t.backend.closedChats).toEqual([second]);
    expect(t.db.all("SELECT * FROM ahp_channels WHERE uri = ?", second)).toEqual([]);
  });

  it("refuses a second chat when the provider has no multiple-chat capability", async () => {
    const t = await rig();
    const { session } = await t.session();
    const a = t.client();
    await a.init();
    const r = await a.rpc("createChat", { channel: session, chat: "ahp-chat:/x" });
    expect(r.error).toMatchObject({ code: -32602 });
  });

  it("disposes a session for good: channels, log and subscriptions", async () => {
    const t = await rig();
    const { session, chat } = await t.session();
    const a = t.client();
    await a.init([ROOT, session, chat]);
    a.dispatch(chat, turnStarted("hi"));
    await t.host.idle();
    const seq = t.host.serverSeq;
    await a.call("disposeSession", { channel: session });
    expect(t.host.sessions()).toEqual([]);
    expect(t.backend.closed).toEqual([session]);
    expect(t.db.all("SELECT * FROM ahp_actions WHERE channel IN (?, ?)", session, chat)).toEqual([]);
    expect(a.conn.subs.has(chat)).toBe(false);
    expect(a.notes.some((n) => n.method === "root/sessionRemoved")).toBe(true);
    // the counter does not go back when the newest rows belonged to the disposed session
    const next = await t.session();
    a.dispatch(next.chat, turnStarted("again"));
    expect(t.host.serverSeq).toBeGreaterThan(seq);
  });
});

describe("paging long chats", () => {
  async function longChat(turns: number) {
    const t = await rig({ limits: { turnsPage: 2 } });
    const { chat } = await t.session();
    const a = t.client();
    await a.init([ROOT, chat]);
    for (let i = 0; i < turns; i++) {
      a.dispatch(chat, turnStarted(`message ${i}`, `t${i}`));
      await t.host.idle();
    }
    return { t, chat, a };
  }

  it("windows the snapshot to the last turns and pages older ones in with fetchTurns", async () => {
    const { t, chat } = await longChat(7);
    const b = t.client();
    await b.init([ROOT]);
    const { snapshot } = await b.subscribe(chat, { turns: 2 });
    expect(snapshot.state.turns.map((x: Any) => x.id)).toEqual(["t5", "t6"]);
    expect(snapshot.state.turnsNextCursor).toBe("before:t5");
    await b.call("fetchTurns", { channel: chat, cursor: "before:t5" });
    expect(b.state<Any>(chat).turns.map((x: Any) => x.id)).toEqual(["t3", "t4", "t5", "t6"]);
    expect(b.state<Any>(chat).turnsNextCursor).toBe("before:t3");
    await b.call("fetchTurns", { channel: chat }); // no cursor: the next older page
    await b.call("fetchTurns", { channel: chat, cursor: "before:t1" });
    expect(b.state<Any>(chat).turns.map((x: Any) => x.id)).toEqual([
      "t0",
      "t1",
      "t2",
      "t3",
      "t4",
      "t5",
      "t6",
    ]);
    expect(b.state<Any>(chat).turnsNextCursor).toBeUndefined();
    expect(await b.call("fetchTurns", { channel: chat })).toBeNull(); // nothing older
    // the paging actions are for this client alone and use no serverSeq
    const loaded = b.envelopes.filter((e) => e.action.type === ActionType.ChatTurnsLoaded);
    expect(loaded).toHaveLength(3);
    expect(loaded.every((e) => e.serverSeq === t.host.serverSeq)).toBe(true);
  });

  it("rejects a cursor the client was not given, leaves other clients' windows alone, and keeps live actions flowing", async () => {
    const { t, chat, a } = await longChat(5);
    const b = t.client();
    await b.init([ROOT]);
    await b.subscribe(chat, { turns: 1 });
    expect((await b.rpc("fetchTurns", { channel: chat, cursor: "before:t0" })).error).toMatchObject({
      code: -32602,
    });
    expect((await b.rpc("fetchTurns", { channel: chat, cursor: "bogus" })).error).toMatchObject({
      code: -32602,
    });
    expect(a.state<Any>(chat).turns).toHaveLength(5); // a holds everything and was told nothing
    expect(a.envelopes.some((e) => e.action.type === ActionType.ChatTurnsLoaded)).toBe(false);
    a.dispatch(chat, turnStarted("live", "t5"));
    await t.host.idle();
    expect(b.state<Any>(chat).turns.map((x: Any) => x.id)).toEqual(["t4", "t5"]);
    const none = t.client();
    await none.init([ROOT]);
    expect((await none.rpc("fetchTurns", { channel: chat })).error).toBeTruthy(); // not subscribed
  });
});
