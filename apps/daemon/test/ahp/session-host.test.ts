// The session host against a scripted ACP agent in a fake sandbox: a conversation from creation to
// suspend and resume, permissions, images, cancel, modes, the cap, the sandbox launch, and crashes.
import { describe, expect, it } from "vitest";
import { ActionType, ROOT, SessionStatus, ToolCallStatus, TurnState } from "../../src/ahp/wire.ts";
import { defaultMachineSettings, machineLaunch } from "../../src/machines.ts";
import { FakeSandbox } from "./fake-acp.ts";
import { pendingCall, sessionRig, tools, until } from "./session-rig.ts";
import { type Any, type TestClient, turnStarted } from "./support.ts";

const confirm = (turnId: string, toolCallId: string, approved: boolean, optionId: string) =>
  approved
    ? {
        type: ActionType.ChatToolCallConfirmed,
        turnId,
        toolCallId,
        approved: true,
        confirmed: "user-action",
        selectedOptionId: optionId,
      }
    : {
        type: ActionType.ChatToolCallConfirmed,
        turnId,
        toolCallId,
        approved: false,
        reason: "denied",
        selectedOptionId: optionId,
      };

describe("creating a conversation", () => {
  it("prepares the working copy, starts the agent in it, and takes the agent's own modes as config, in bypass mode", async () => {
    const t = await sessionRig();
    const { session, chat } = await t.create("c1", { project: "Duet" });
    // the working copy first, then the agent in it, with its credential and ports by environment
    expect(t.copies).toHaveLength(1);
    expect(t.copies[0]).toMatchObject({
      id: "c1",
      employeeId: "ada",
      project: "Duet",
      branch: "conv/c1",
      cwd: "/home/employee/work/conv-c1",
      team: "engineering",
    });
    expect(t.sandbox.launches[0]).toMatchObject({
      employeeId: "ada",
      cwd: "/home/employee/work/conv-c1",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-secret", I_INC_PORTS: "20000-20099" },
    });
    expect(t.sandbox.launches[0]?.engine.id).toBe("opus");
    const a = t.sandbox.last;
    expect(a.requests("initialize")[0]?.params).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    expect(a.requests("session/new")[0]?.params).toEqual({
      cwd: "/home/employee/work/conv-c1",
      mcpServers: [],
    });
    // default mode: the agent's bypass mode, switched to before the first message
    expect(a.requests("session/set_mode")[0]?.params.modeId).toBe("bypassPermissions");
    const cfg = t.host.sessionState(session)?.config;
    expect(cfg?.values.mode).toBe("bypassPermissions");
    expect(cfg?.schema.properties.mode?.enumLabels).toEqual([
      "Always ask",
      "Accept edits",
      "Plan only",
      "Bypass permissions",
    ]);
    expect(cfg?.schema.properties.mode?.enum).toEqual([
      "default",
      "acceptEdits",
      "plan",
      "bypassPermissions",
    ]);
    expect(t.host.sessionState(session)?._meta).toMatchObject({ "iinc.cwd": "/home/employee/work/conv-c1" });
    // the agent's session id is kept with the chat, so it survives a restart
    expect(t.host.channelMeta(chat).acpSessionId).toBe([...a.sessions.keys()][0]);
  });

  it("creates in the mode asked for", async () => {
    const t = await sessionRig();
    const { session } = await t.create("c1", { mode: "plan" });
    expect(t.sandbox.last.requests("session/set_mode")[0]?.params.modeId).toBe("plan");
    expect(t.host.sessionState(session)?.config?.values.mode).toBe("plan");
  });

  it("fails clearly, and leaves no agent behind, when it can't start", async () => {
    const t = await sessionRig();
    t.sandbox.options = { authRequired: true };
    await expect(t.create()).rejects.toThrow(/needs a sign-in in the engineering sandbox/);
    expect(t.sandbox.live).toHaveLength(0);
    t.sandbox.options = { initFails: true };
    await expect(t.create("c2")).rejects.toThrow(/didn't start: the adapter crashed on start/);
    t.sandbox.options = {};
    t.sandbox.failLaunch = new Error("the walls aren't up");
    await expect(t.create("c3")).rejects.toThrow(/walls/);
    t.sandbox.failLaunch = undefined;
    expect(t.host.sessions()).toHaveLength(0);
    // and a conversation that is not one is refused
    await expect(t.host.createSession({ provider: "opus" })).rejects.toThrow(/not a conversation/);
    await expect(
      t.host.createSession({
        provider: "opus",
        meta: { "iinc.conversation": "x", "iinc.employee": "ada" },
        config: { mode: "yolo" },
      }),
    ).rejects.toThrow(/not a valid mode/);
    // the agent that had opened for it is let go, and its slot is free
    expect(t.sandbox.live).toHaveLength(0);
    expect(t.sessions.status()).toEqual([]);
  });

  it("times out an agent that never answers initialize", async () => {
    const t = await sessionRig({ host: { startTimeoutMs: 60 } });
    t.sandbox.options = { hang: true };
    await expect(t.create()).rejects.toThrow(/timed out/);
    expect(t.sandbox.live).toHaveLength(0);
  });
});

describe("a turn, mapped from ACP", () => {
  it("streams reasoning, text, tool calls with output and diffs, the plan and usage; redacts secrets", async () => {
    const t = await sessionRig();
    const c = await t.create();
    const a = await t.client(c);
    const id = await t.say(a, c.chat, "fix the answer");
    const turn = t.host.chatState(c.chat)?.turns[0] as Any;
    expect(turn.state).toBe(TurnState.Complete);
    const kinds = turn.responseParts.map((p: Any) => p.kind + (p.toolCall ? `:${p.toolCall.toolName}` : ""));
    expect(kinds).toEqual([
      "reasoning",
      "markdown",
      "toolCall:read",
      "toolCall:x-iinc-plan",
      "toolCall:edit",
      "markdown",
    ]);
    expect(turn.responseParts[0].content).toBe("Thinking about it. Let me look at the file."); // chunks merged by deltas
    expect(turn.responseParts[1].content).toBe("Hello! You said: fix the answer. I'll read then edit. ");
    expect(turn.responseParts.at(-1).content).toBe("Done: answer is now 42.");
    const calls = tools(turn);
    expect(calls["tc-read"]).toMatchObject({
      status: ToolCallStatus.Completed,
      displayName: "Read src/app.ts",
      toolInput: '{"path":"src/app.ts"}',
      _meta: { "iinc.locations": [{ path: "src/app.ts", line: 1 }] },
    });
    // tool output arrives whole and is redacted
    expect(calls["tc-read"].content[0].text).toContain("export const answer = 41;");
    expect(JSON.stringify(calls["tc-read"])).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(JSON.stringify(t.db.all("SELECT action FROM ahp_actions"))).not.toContain(
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    );
    // the plan: a checklist and the entries in _meta
    expect(calls[`${id}:plan`]).toMatchObject({
      status: ToolCallStatus.Completed,
      toolName: "x-iinc-plan",
      _meta: {
        "iinc.plan": [
          { content: "Read the file", status: "completed" },
          { content: "Fix the constant", status: "in_progress" },
        ],
      },
    });
    expect(calls[`${id}:plan`].content[0].text).toBe("- [x] Read the file\n- [ ] Fix the constant");
    // the edit: a file edit whose before and after live behind content URIs
    const edit = calls["tc-edit"].content[0];
    expect(edit).toMatchObject({ type: "fileEdit", diff: { added: 1, removed: 1 } });
    const after = await a.call("resourceRead", { channel: ROOT, uri: edit.after.content.uri });
    expect(after.data).toBe("export const answer = 42;\n");
    expect((await a.call("resourceRead", { channel: ROOT, uri: edit.before.content.uri })).data).toBe(
      "export const answer = 41;\n",
    );
    // usage, from the prompt result and the context meter
    expect(turn.usage).toMatchObject({
      inputTokens: 1200,
      outputTokens: 34,
      model: "Claude Opus",
      _meta: { contextUsed: 1234, contextSize: 200000 },
    });
    // slash commands land in the session's _meta and are completable
    expect(t.host.sessionState(c.session)?._meta?.["iinc.commands"]).toEqual([
      { name: "compact", description: "Compact the conversation", input: { hint: "focus" } },
    ]);
    const comp = await a.call("completions", {
      channel: c.chat,
      kind: "userMessage",
      text: "please /com",
      offset: 11,
    });
    expect(comp.items[0]).toMatchObject({ insertText: "/compact", rangeStart: 7, rangeEnd: 11 });
    // Claude's usage windows go to the account meters
    expect(t.limits.at(0)).toMatchObject({ accountId: "claude-pro", limit: { fiveHourUtilization: 0.42 } });
    expect(t.usage.at(0)).toMatchObject({ accountId: "claude-pro" });
    // an update nobody knows is logged once and otherwise ignored
    await t.say(a, c.chat, "again");
    expect(t.logs.filter((l) => l.includes("unknown:some_future_update"))).toHaveLength(1);
    expect(t.host.chatState(c.chat)?.turns).toHaveLength(2);
  });

  it("shows each part live to a second client, ending in the same state", async () => {
    const t = await sessionRig();
    const c = await t.create();
    const a = await t.client(c, "a");
    const b = await t.client(c, "b");
    await t.say(a, c.chat, "go");
    expect(b.state(c.chat)).toEqual(JSON.parse(JSON.stringify(t.host.chatState(c.chat))));
    expect(b.state<Any>(c.session).config.values.mode).toBe("bypassPermissions");
  });
});

describe("permissions, answered by the owner", () => {
  async function asking() {
    const t = await sessionRig();
    const c = await t.create();
    const a = await t.client(c, "a");
    const b = await t.client(c, "b");
    // the owner picks "Always ask"
    a.dispatch(c.session, { type: ActionType.SessionConfigChanged, config: { mode: "default" } });
    await until(() => t.sandbox.last.mode === "default");
    const turnId = "t1";
    a.dispatch(c.chat, turnStarted("edit it", turnId));
    await until(() => pendingCall(t.host.chatState(c.chat)));
    return { t, c, a, b, turnId };
  }

  it("surfaces the agent's request as a card with its options and the diff, and the session needs you", async () => {
    const { t, c, b } = await asking();
    const call = pendingCall(t.host.chatState(c.chat)) as Any;
    expect(call).toMatchObject({ toolCallId: "tc-edit", confirmationTitle: "Edit src/app.ts" });
    expect(call.options).toEqual([
      { id: "allow-once", label: "Allow once", kind: "approve", group: 0 },
      { id: "allow-always", label: "Always allow", kind: "approve", group: 1 },
      { id: "reject-once", label: "Deny", kind: "deny", group: 0 },
      { id: "reject-always", label: "Always deny", kind: "deny", group: 1 },
    ]);
    expect(call.edits.items[0]).toMatchObject({
      after: { uri: "file:///src/app.ts" },
      diff: { added: 1, removed: 1 },
    }); // relative path made a file URI
    expect(t.host.sessionState(c.session)?.inputNeeded?.[0]).toMatchObject({
      kind: "toolConfirmation",
      chat: c.chat,
    });
    expect(t.host.summary(c.session)?.status).toBe(SessionStatus.InputNeeded);
    expect(
      b
        .state<Any>(c.chat)
        .activeTurn.responseParts.some((p: Any) => p.toolCall?.status === "pending-confirmation"),
    ).toBe(true);
    expect(t.sandbox.last.permissionAnswers).toEqual([]); // nobody was auto-allowed
  });

  it("maps the owner's choice onto the ACP option, and the first answer wins between two clients", async () => {
    const { t, c, a, b, turnId } = await asking();
    a.dispatch(c.chat, confirm(turnId, "tc-edit", true, "allow-always"));
    b.dispatch(c.chat, confirm(turnId, "tc-edit", false, "reject-once"));
    await until(() => t.host.chatState(c.chat)?.turns.length === 1);
    expect(t.sandbox.last.permissionAnswers).toEqual([{ outcome: "selected", optionId: "allow-always" }]);
    expect(b.rejections()).toHaveLength(1);
    const turn = t.host.chatState(c.chat)?.turns[0] as Any;
    expect(tools(turn)["tc-edit"]).toMatchObject({
      status: ToolCallStatus.Completed,
      selectedOption: { id: "allow-always" },
    });
    expect(turn.responseParts.at(-1).content).toBe("Done: answer is now 42.");
    expect(t.host.sessionState(c.session)?.inputNeeded).toBeUndefined();
  });

  it("tells the agent when the owner says no, and the agent carries on", async () => {
    const { t, c, a, turnId } = await asking();
    a.dispatch(c.chat, confirm(turnId, "tc-edit", false, "reject-once"));
    await until(() => t.host.chatState(c.chat)?.turns.length === 1);
    expect(t.sandbox.last.permissionAnswers).toEqual([{ outcome: "selected", optionId: "reject-once" }]);
    const turn = t.host.chatState(c.chat)?.turns[0] as Any;
    expect(tools(turn)["tc-edit"]).toMatchObject({ status: ToolCallStatus.Cancelled, reason: "denied" });
    expect(turn.responseParts.at(-1).content).toBe("Understood, I left the file alone.");
    expect(turn.state).toBe(TurnState.Complete);
  });

  it("answers `cancelled` to a waiting request when the turn is cancelled, and the card goes", async () => {
    const { t, c, a, turnId } = await asking();
    a.dispatch(c.chat, { type: ActionType.ChatTurnCancelled, turnId, duration: 0 });
    await until(() => t.sandbox.last.permissionAnswers.length === 1);
    expect(t.sandbox.last.permissionAnswers[0]).toEqual({ outcome: "cancelled" });
    expect(t.sandbox.last.cancels).toBe(1);
    await t.host.idle();
    const turn = t.host.chatState(c.chat)?.turns[0] as Any;
    expect(turn.state).toBe(TurnState.Cancelled);
    expect(tools(turn)["tc-edit"].status).toBe(ToolCallStatus.Cancelled);
    expect(t.host.sessionState(c.session)?.inputNeeded).toBeUndefined();
  });
});

describe("prompts with images", () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(9000, 3),
  ]);
  const attachment = {
    type: "embeddedResource",
    label: "shot.png",
    data: png.toString("base64"),
    contentType: "image/png",
  };

  it("sends text and the image as ACP blocks, keeping the bytes out of the log", async () => {
    const t = await sessionRig();
    const c = await t.create();
    const a = await t.client(c);
    await t.say(a, c.chat, "what is this?", { attachments: [attachment] });
    const blocks = t.sandbox.last.prompts[0]?.blocks as Any[];
    expect(blocks[0]).toEqual({ type: "text", text: "what is this?" });
    expect(blocks[1]).toEqual({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
    expect(JSON.stringify(t.db.all("SELECT action FROM ahp_actions"))).not.toContain(png.toString("base64"));
    expect(
      t.host.chatState(c.chat)?.turns[0]?.responseParts.some((p: Any) => p.content?.includes("(+1 image)")),
    ).toBe(true);
  });

  it("says so, rather than failing, when the agent can't see images; sends files as resources", async () => {
    const t = await sessionRig();
    t.sandbox.options = { image: false };
    const c = await t.create();
    const a = await t.client(c);
    const file = {
      type: "embeddedResource",
      label: "notes.md",
      data: Buffer.from("# notes").toString("base64"),
      contentType: "text/markdown",
    };
    await t.say(a, c.chat, "plain look", {
      attachments: [
        attachment,
        file,
        { type: "resource", label: "spec", uri: "file:///repo/docs/spec.md", contentType: "text/markdown" },
      ],
    });
    const blocks = t.sandbox.last.prompts[0]?.blocks as Any[];
    expect(blocks.map((b) => b.type)).toEqual(["text", "text", "resource", "resource_link"]);
    expect(blocks[1].text).toMatch(/can't see images/);
    expect(blocks[2].resource).toMatchObject({
      uri: "attachment:///notes.md",
      mimeType: "text/markdown",
      text: "# notes",
    });
    expect(blocks[3]).toMatchObject({ uri: "file:///repo/docs/spec.md", name: "spec" });
  });
});

describe("cancel, modes", () => {
  it("cancels a running tool: session/cancel goes to the agent, the turn ends at once, the agent lives on", async () => {
    const t = await sessionRig();
    const c = await t.create();
    const a = await t.client(c);
    a.dispatch(c.chat, turnStarted("hang on a tool", "t1"));
    await until(
      () => tools(t.host.chatState(c.chat)?.activeTurn)["tc-hang"]?.status === ToolCallStatus.Running,
    );
    a.dispatch(c.chat, { type: ActionType.ChatTurnCancelled, turnId: "t1", duration: 0 });
    expect(t.host.chatState(c.chat)?.turns[0]?.state).toBe(TurnState.Cancelled); // at once
    await until(() => t.sandbox.last.cancels === 1);
    expect(tools(t.host.chatState(c.chat)?.turns[0])["tc-hang"].status).toBe(ToolCallStatus.Cancelled);
    await t.host.idle();
    // same agent process takes the next message: nothing was killed
    await t.say(a, c.chat, "plain hello");
    expect(t.sandbox.agents).toHaveLength(1);
    expect(t.host.chatState(c.chat)?.turns[1]?.state).toBe(TurnState.Complete);
  });

  it("kills an agent that ignores session/cancel, and starts it again for the next message", async () => {
    const t = await sessionRig({ host: { cancelGraceMs: 40 } });
    const c = await t.create();
    const a = await t.client(c);
    const first = t.sandbox.last;
    a.dispatch(c.chat, turnStarted("stubborn agent", "t1"));
    await until(() => first.prompts.length === 1);
    a.dispatch(c.chat, { type: ActionType.ChatTurnCancelled, turnId: "t1", duration: 0 });
    expect(t.host.chatState(c.chat)?.turns[0]?.state).toBe(TurnState.Cancelled);
    await until(() => first.exitCode !== undefined, 2000, "the kill");
    await t.host.idle();
    await t.say(a, c.chat, "plain back again");
    expect(t.sandbox.agents).toHaveLength(2);
    expect(t.host.chatState(c.chat)?.turns[1]?.state).toBe(TurnState.Complete);
  });

  it("drops a cancel that comes before the prompt went out, without sending the prompt", async () => {
    const t = await sessionRig();
    const c = await t.create();
    const a = await t.client(c);
    a.dispatch(c.chat, turnStarted("slow work", "t1"));
    a.dispatch(c.chat, { type: ActionType.ChatTurnCancelled, turnId: "t1", duration: 0 });
    await t.host.idle();
    expect(t.sandbox.last.prompts).toHaveLength(0);
    expect(t.host.chatState(c.chat)?.turns[0]?.state).toBe(TurnState.Cancelled);
  });

  it("switches mode on request, tells the agent, follows the agent's own change, and puts the old mode back when refused", async () => {
    const t = await sessionRig();
    const c = await t.create();
    const a = await t.client(c);
    a.dispatch(c.session, { type: ActionType.SessionConfigChanged, config: { mode: "plan" } });
    await until(() => t.sandbox.last.mode === "plan");
    expect(t.host.sessionState(c.session)?.config?.values.mode).toBe("plan");
    // the agent changes mode itself (it exits plan mode): the session follows, nothing is sent back
    const sets = t.sandbox.last.requests("session/set_mode").length;
    const id = [...t.sandbox.last.sessions.keys()][0] as string;
    t.sandbox.last.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: id, update: { sessionUpdate: "current_mode_update", currentModeId: "acceptEdits" } } })}\n`,
    );
    await until(() => t.host.sessionState(c.session)?.config?.values.mode === "acceptEdits");
    expect(t.sandbox.last.requests("session/set_mode")).toHaveLength(sets);
    // a mode the agent refuses is rolled back (the schema allows it, the agent does not)
    const fakeSession = t.sandbox.last.sessions.get(id);
    if (fakeSession) fakeSession.mode = "acceptEdits";
    const refusing = t.sandbox.last;
    refusing.stdin.removeAllListeners("data");
    refusing.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const m = JSON.parse(line);
        if (m.method === "session/set_mode")
          refusing.stdout.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "not today" } })}\n`,
          );
      }
    });
    a.dispatch(c.session, { type: ActionType.SessionConfigChanged, config: { mode: "default" } });
    await until(() => t.host.sessionState(c.session)?.config?.values.mode === "acceptEdits");
    expect(a.state<Any>(c.session).config.values.mode).toBe("acceptEdits");
  });
});

describe("idle suspend and resume", () => {
  it("suspends an idle conversation (process stopped, state kept) and wakes it with session/load, replay ignored", async () => {
    const t = await sessionRig();
    t.sandbox.options = { loadSession: true };
    const c = await t.create();
    const a = await t.client(c);
    await t.say(a, c.chat, "plain one");
    a.dispatch(c.session, { type: ActionType.SessionConfigChanged, config: { mode: "plan" } });
    await until(() => t.sandbox.last.mode === "plan");
    const first = t.sandbox.last;
    const acpId = [...first.sessions.keys()][0] as string;
    t.time.now += 14 * 60_000;
    t.sessions.sweep();
    expect(first.exitCode).toBeUndefined(); // 14 minutes: not yet
    t.time.now += 2 * 60_000;
    t.sessions.sweep();
    await until(() => first.exitCode !== undefined, 3000, "suspend");
    expect(t.host.chatState(c.chat)?.turns).toHaveLength(1); // everything kept
    expect(t.host.chatState(c.chat)?.turns[0]?.state).toBe(TurnState.Complete);
    expect(t.sessions.status()[0]).toMatchObject({ live: false, busy: false });
    expect(t.logs.some((l) => l.includes("suspending") && l.includes("idle"))).toBe(true);
    expect(t.host.chatState(c.chat)?.turns.at(-1)?.state).not.toBe(TurnState.Error); // a suspend is not a failure

    await t.say(a, c.chat, "plain two");
    const second = t.sandbox.last;
    expect(second).not.toBe(first);
    expect(second.requests("session/load")[0]?.params).toEqual({
      sessionId: acpId,
      cwd: "/home/employee/work/conv-c1",
      mcpServers: [],
    });
    expect(second.requests("session/new")).toHaveLength(0);
    // the history the adapter replays while loading is not shown twice
    expect(JSON.stringify(t.host.chatState(c.chat))).not.toContain("an old answer");
    // the owner's mode comes back on the new process
    expect(second.requests("session/set_mode").at(-1)?.params.modeId).toBe("plan");
    // and the prompt is just the message, no brief
    expect(second.prompts[0]?.blocks).toEqual([{ type: "text", text: "plain two" }]);
    expect(t.host.chatState(c.chat)?.turns).toHaveLength(2);
  });

  it("wakes on a blank agent with a continuation brief when the adapter can't load sessions", async () => {
    const t = await sessionRig();
    const c = await t.create();
    const a = await t.client(c);
    await t.say(a, c.chat, "plain remember the code word: kumquat");
    const first = t.sandbox.last;
    t.time.now += 20 * 60_000;
    t.sessions.sweep();
    await until(() => first.exitCode !== undefined);
    await t.say(a, c.chat, "plain what was the code word?");
    const second = t.sandbox.last;
    expect(second.requests("session/load")).toHaveLength(0);
    expect(second.requests("session/new")).toHaveLength(1);
    const brief = String(second.prompts[0]?.blocks[0]?.text);
    expect(brief).toMatch(/resuming a conversation/);
    expect(brief).toContain("Owner: plain remember the code word: kumquat");
    expect(brief).toContain("You: You said: plain remember the code word: kumquat");
    expect(brief).toContain("The owner's new message:\nplain what was the code word?");
    // the new agent session id replaces the old one, and the next turn needs no brief
    expect(t.host.channelMeta(c.chat).acpSessionId).toBe([...second.sessions.keys()][0]);
    await t.say(a, c.chat, "plain thanks");
    expect(second.prompts[1]?.blocks[0]?.text).toBe("plain thanks");
  });

  it("resumes after a daemon restart from what the database remembers", async () => {
    const t = await sessionRig();
    t.sandbox.options = { loadSession: true };
    const c = await t.create("c9", { project: "Duet" });
    const a = await t.client(c);
    await t.say(a, c.chat, "plain before the restart");
    const acpId = t.host.channelMeta(c.chat).acpSessionId;
    t.sessions.stop();
    const two = await t.restart();
    const b = await two.client(c, "after");
    await two.say(b, c.chat, "plain after the restart");
    const agent = two.sandbox.last;
    expect(agent.requests("session/load")[0]?.params.sessionId).toBe(acpId);
    expect(agent.requests("session/load")[0]?.params.cwd).toBe("/home/employee/work/conv-c9");
    expect(two.copies.at(-1)).toMatchObject({ id: "c9", project: "Duet", branch: "conv/c9" }); // the working copy is checked again
    expect(two.host.chatState(c.chat)?.turns.map((x) => x.message.text)).toEqual([
      "plain before the restart",
      "plain after the restart",
    ]);
  });

  it("suspends an archived conversation at the next sweep, however recently it was used", async () => {
    const t = await sessionRig();
    const c = await t.create();
    const a = await t.client(c);
    await t.say(a, c.chat, "plain hi");
    a.dispatch(c.session, { type: ActionType.SessionIsArchivedChanged, isArchived: true });
    t.sessions.sweep();
    await until(() => t.sandbox.last.exitCode !== undefined);
    expect(t.sessions.status()[0]?.live).toBe(false);
  });
});

describe("the cap of live conversations per team", () => {
  it("makes room by suspending the least recently used idle conversation", async () => {
    const t = await sessionRig();
    const cs = [];
    for (const id of ["a", "b", "c"]) {
      cs.push(await t.create(id));
      t.time.now += 1000;
    }
    expect(t.sandbox.live).toHaveLength(3);
    const d = await t.create("d");
    await until(() => t.sandbox.live.length === 3, 2000, "the oldest to stop"); // its stdin closes, then it exits
    expect(t.sandbox.agents[0]?.exitCode).toBeDefined(); // "a", the oldest
    expect(t.sandbox.agents[1]?.exitCode).toBeUndefined();
    // another team has its own three
    const other = await t.create("z", { employee: "zed" });
    expect(t.sandbox.live).toHaveLength(4);
    expect(d.session).toBeTruthy();
    expect(other.session).toBeTruthy();
    // the evicted one wakes when its owner writes (and now evicts the next oldest)
    const evicted = cs[0] as { session: string; chat: string };
    const client = await t.client(evicted);
    await t.say(client, evicted.chat, "plain still there?");
    expect(t.host.chatState(evicted.chat)?.turns[0]?.state).toBe(TurnState.Complete);
    expect(t.sandbox.live).toHaveLength(4);
  });

  it("won't create a conversation when every slot is busy, and says why", async () => {
    const t = await sessionRig();
    const busy: { id: string; c: { session: string; chat: string }; cl: TestClient }[] = [];
    for (const id of ["a", "b", "c"]) {
      const c = await t.create(id);
      const cl = await t.client(c);
      cl.dispatch(c.chat, turnStarted("slow work", `t-${id}`));
      busy.push({ id, c, cl });
    }
    await until(() => busy.every(({ c }) => t.host.chatState(c.chat)?.activeTurn));
    await expect(t.create("d")).rejects.toThrow(
      /Waiting for a free slot: 3 of 3 conversations are running in the engineering sandbox/,
    );
    for (const { id, c, cl } of busy)
      cl.dispatch(c.chat, { type: ActionType.ChatTurnCancelled, turnId: `t-${id}`, duration: 0 });
    await t.host.idle();
  });

  it("queues a message for a sleeping conversation, with the reason in the chat, until a slot frees", async () => {
    const t = await sessionRig();
    const sleeper = await t.create("s");
    const sc = await t.client(sleeper);
    t.time.now += 20 * 60_000;
    t.sessions.sweep(); // the sleeper is suspended
    await until(() => t.sandbox.agents[0]?.exitCode !== undefined);
    const busy: { id: string; c: { session: string; chat: string }; cl: TestClient }[] = [];
    for (const id of ["a", "b", "c"]) {
      const c = await t.create(id);
      const cl = await t.client(c);
      cl.dispatch(c.chat, turnStarted("slow work", `t-${id}`));
      busy.push({ id, c, cl });
    }
    await until(() => busy.every(({ c }) => t.host.chatState(c.chat)?.activeTurn));
    sc.dispatch(sleeper.chat, turnStarted("plain wake up", "w1"));
    await until(() => t.host.chatState(sleeper.chat)?.activeTurn?.responseParts.length);
    const waiting = t.host.chatState(sleeper.chat)?.activeTurn as Any;
    const reason = "Waiting for a free slot: 3 of 3 conversations are running in the engineering sandbox.";
    expect(waiting.responseParts[0]).toMatchObject({ kind: "systemNotification", content: reason });
    expect(t.host.chatState(sleeper.chat)?.activity).toBe(reason);
    expect(sc.state<Any>(sleeper.chat).activeTurn.responseParts[0].content).toBe(reason); // visible to the client
    expect(t.sandbox.live).toHaveLength(3);
    // one of the busy conversations finishes: its slot goes to the waiting one
    const first = busy[0] as (typeof busy)[number];
    first.cl.dispatch(first.c.chat, {
      type: ActionType.ChatTurnCancelled,
      turnId: `t-${first.id}`,
      duration: 0,
    });
    await until(() => t.host.chatState(sleeper.chat)?.turns.length === 1, 6000, "the queued turn");
    expect(t.host.chatState(sleeper.chat)?.activity).toBeUndefined();
    expect(t.host.chatState(sleeper.chat)?.turns[0]?.state).toBe(TurnState.Complete);
    for (const { id, c, cl } of busy.slice(1))
      cl.dispatch(c.chat, { type: ActionType.ChatTurnCancelled, turnId: `t-${id}`, duration: 0 });
    await t.host.idle();
  });

  it("a waiting turn that is cancelled leaves the queue and never takes a slot", async () => {
    const t = await sessionRig({ host: { perTeamCap: 1 } });
    const s = await t.create("s");
    const cs = await t.client(s);
    t.time.now += 20 * 60_000;
    t.sessions.sweep();
    await until(() => t.sandbox.agents[0]?.exitCode !== undefined);
    const b = await t.create("b");
    const cb = await t.client(b);
    cb.dispatch(b.chat, turnStarted("slow work", "tb"));
    await until(() => t.host.chatState(b.chat)?.activeTurn);
    cs.dispatch(s.chat, turnStarted("plain hi", "w"));
    await until(() => t.host.chatState(s.chat)?.activeTurn?.responseParts.length);
    cs.dispatch(s.chat, { type: ActionType.ChatTurnCancelled, turnId: "w", duration: 0 });
    await until(() => t.host.chatState(s.chat)?.turns.length === 1);
    cb.dispatch(b.chat, { type: ActionType.ChatTurnCancelled, turnId: "tb", duration: 0 });
    await t.host.idle();
    expect(t.sandbox.agents).toHaveLength(2); // s, then b: nothing was started for the cancelled turn
    expect(t.host.chatState(s.chat)?.turns[0]?.state).toBe(TurnState.Cancelled);
  });
});

describe("the queue and the slots, again", () => {
  it("hands a slot to a waiting message when the conversation holding it simply finishes (cap 1)", async () => {
    const t = await sessionRig({ host: { perTeamCap: 1 } });
    const s = await t.create("s");
    const cs = await t.client(s);
    t.time.now += 20 * 60_000;
    t.sessions.sweep();
    await until(() => t.sandbox.agents[0]?.exitCode !== undefined);
    const b = await t.create("b");
    const cb = await t.client(b);
    cb.dispatch(b.chat, turnStarted("gate work", "tb"));
    await until(() => t.sandbox.last.prompts.length === 1);
    cs.dispatch(s.chat, turnStarted("plain wake", "w"));
    await until(() => t.host.chatState(s.chat)?.activeTurn?.responseParts.length);
    // b ends on its own, nobody cancels and no sweep runs
    t.sandbox.last.gateOpen = true;
    await until(() => t.host.chatState(s.chat)?.turns.length === 1, 3000, "the waiting message to run");
    expect(t.host.chatState(s.chat)?.turns[0]?.state).toBe(TurnState.Complete);
    expect(t.host.chatState(b.chat)?.turns[0]?.state).toBe(TurnState.Complete);
  });

  it("the sweep also wakes a waiter whose slot is free", async () => {
    const t = await sessionRig({ host: { perTeamCap: 1 } });
    const s = await t.create("s");
    const cs = await t.client(s);
    t.time.now += 20 * 60_000;
    t.sessions.sweep();
    await until(() => t.sandbox.agents[0]?.exitCode !== undefined);
    const b = await t.create("b");
    const cb = await t.client(b);
    cb.dispatch(b.chat, turnStarted("gate work", "tb"));
    await until(() => t.sandbox.last.prompts.length === 1);
    cs.dispatch(s.chat, turnStarted("plain wake", "w"));
    await until(() => t.host.chatState(s.chat)?.activeTurn?.responseParts.length);
    t.sessions.testDropWakeups(); // lose every wake-up: only the sweep can save it
    t.sandbox.last.gateOpen = true;
    await until(() => t.host.chatState(b.chat)?.turns.length === 1);
    t.time.now += 1000;
    t.sessions.sweep();
    await until(() => t.host.chatState(s.chat)?.turns.length === 1, 3000, "the sweep to wake it");
  });

  it("does not evict a conversation that is still starting (a 4th create can't take its slot)", async () => {
    const t = await sessionRig({ host: { perTeamCap: 1, startTimeoutMs: 400 } });
    t.sandbox.options = { hang: true };
    const first = t.create("a").catch((e) => e);
    await until(() => t.sandbox.agents.length === 1);
    t.sandbox.options = {};
    await expect(t.create("b")).rejects.toThrow(/Waiting for a free slot: 1 of 1/);
    expect(t.sandbox.agents).toHaveLength(1); // b never launched, a was not killed
    expect(t.sandbox.agents[0]?.exitCode).toBeUndefined();
    expect(String(await first)).toMatch(/timed out/);
  });

  it("a message cancelled while the working copy is prepared never launches an agent or holds a slot", async () => {
    let release!: () => void;
    const prep = new Promise<void>((r) => {
      release = r;
    });
    let slow = false;
    const t = await sessionRig({
      host: {
        workingCopy: async () => {
          if (slow) await prep;
        },
      },
    });
    const c = await t.create("c1");
    const a = await t.client(c);
    t.time.now += 20 * 60_000;
    t.sessions.sweep();
    await until(() => t.sandbox.agents[0]?.exitCode !== undefined);
    slow = true;
    a.dispatch(c.chat, turnStarted("plain hi", "t1"));
    await until(() => t.host.chatState(c.chat)?.activeTurn);
    a.dispatch(c.chat, { type: ActionType.ChatTurnCancelled, turnId: "t1", duration: 0 });
    release();
    await t.host.idle();
    expect(t.sandbox.agents).toHaveLength(1); // no second launch
    expect(t.sessions.status()[0]).toMatchObject({ live: false });
    // the slot is free: three other conversations fit in a cap of 3
    for (const id of ["x", "y", "z"]) await t.create(id);
    expect(t.sandbox.live).toHaveLength(3);
  });
});

describe("mapper and brief details", () => {
  it("merges arguments that arrive after the call started into its tool input", async () => {
    const t = await sessionRig();
    const c = await t.create();
    const a = await t.client(c);
    await t.say(a, c.chat, "lateinput please");
    const call = tools(t.host.chatState(c.chat)?.turns[0])["tc-li"];
    expect(call).toMatchObject({ status: ToolCallStatus.Completed, toolInput: '{"command":"ls -la"}' });
  });

  it("answers the first of two requests with one permission id `cancelled` instead of orphaning it", async () => {
    const t = await sessionRig();
    const c = await t.create();
    const a = await t.client(c);
    a.dispatch(c.session, { type: ActionType.SessionConfigChanged, config: { mode: "default" } });
    await until(() => t.sandbox.last.mode === "default");
    a.dispatch(c.chat, turnStarted("dup request", "t1"));
    await until(
      () => t.sandbox.last.received.filter((m) => m.method === undefined && m.id >= 1000).length === 1,
    );
    await until(() => t.sandbox.last.permissionAnswers.length === 1, 2000, "the first to be cancelled");
    expect(t.sandbox.last.permissionAnswers[0]).toEqual({ n: 1, outcome: "cancelled" });
    // only the second is waiting; the owner sees one card, and answering it settles the turn
    expect(pendingCall(t.host.chatState(c.chat))).toMatchObject({ confirmationTitle: "Edit x (2)" });
    expect(t.host.sessionState(c.session)?.inputNeeded).toHaveLength(1);
    a.dispatch(c.chat, confirm("t1", "tc-dup", true, "allow-once"));
    await t.host.idle();
    expect(t.sandbox.last.permissionAnswers[1]).toEqual({
      n: 2,
      outcome: "selected",
      optionId: "allow-once",
    });
    expect(t.host.chatState(c.chat)?.turns[0]?.state).toBe(TurnState.Complete);
  });

  it("runs a steering message as the next turn, ahead of the queue, without interrupting the one running (what the docs say)", async () => {
    const t = await sessionRig();
    const c = await t.create();
    const a = await t.client(c);
    a.dispatch(c.chat, turnStarted("slow work", "t1"));
    await until(() => t.sandbox.last.prompts.length === 1, 2000, "the first prompt");
    const pending = (kind: string, id: string, text: string) =>
      a.dispatch(c.chat, {
        type: ActionType.ChatPendingMessageSet,
        kind,
        id,
        message: { text, origin: { kind: "user" } },
      });
    pending("queued", "q1", "plain queued");
    pending("steering", "s1", "plain steer");
    await new Promise((r) => setTimeout(r, 120));
    // nothing was injected into the running turn: no cancel, no second prompt, the turn is still going
    expect(t.sandbox.last.received.some((m) => m.method === "session/cancel")).toBe(false);
    expect(t.sandbox.last.prompts).toHaveLength(1);
    expect(t.host.chatState(c.chat)?.activeTurn?.id).toBe("t1");
    expect(t.host.chatState(c.chat)?.steeringMessage?.id).toBe("s1");
    // Stop interrupts it, and the steering message is the next prompt, then the queued one
    a.dispatch(c.chat, { type: ActionType.ChatTurnCancelled, turnId: "t1", duration: 0 });
    await until(() => t.sandbox.last.prompts.length === 3, 4000, "both pending messages to run");
    const text = (i: number) => JSON.stringify(t.sandbox.last.prompts[i]?.blocks);
    expect(text(1)).toContain("plain steer");
    expect(text(2)).toContain("plain queued");
  });

  it("takes the agent's title for an unnamed conversation, and never over the owner's", async () => {
    const t = await sessionRig();
    const c = await t.create();
    const a = await t.client(c);
    // no message yet, so the title is still the default
    a.dispatch(c.chat, turnStarted("retitle me", "t1"));
    await t.host.idle();
    // the first message already named it
    expect(t.host.sessionState(c.session)?.title).toBe("retitle me");
    expect(t.host.sessionState(c.session)?.title).not.toBe("Agent's own title");
    const d = await t.create("c2");
    t.host.emit(d.session, { type: ActionType.SessionTitleChanged, title: "New conversation" });
    const b = await t.client(d);
    // an agent that titles before the first message lands (unnamed): taken
    t.sandbox.last.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: [...t.sandbox.last.sessions.keys()][0], update: { sessionUpdate: "session_info_update", title: "Agent's own title" } } })}\n`,
    );
    await until(() => t.host.sessionState(d.session)?.title === "Agent's own title");
    // the owner renames; the agent's next title is ignored
    b.dispatch(d.session, { type: ActionType.SessionTitleChanged, title: "Mine" });
    t.sandbox.last.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: [...t.sandbox.last.sessions.keys()][0], update: { sessionUpdate: "session_info_update", title: "Another" } } })}\n`,
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(t.host.sessionState(d.session)?.title).toBe("Mine");
  });

  it("redacts tokens in diffs (the content, not just the preview) and leaves ordinary code alone", async () => {
    const t = await sessionRig();
    const c = await t.create();
    const a = await t.client(c);
    await t.say(a, c.chat, "secretdiff now");
    const edit = tools(t.host.chatState(c.chat)?.turns[0])["tc-sd"].content[0];
    const after = (await a.call("resourceRead", { channel: ROOT, uri: edit.after.content.uri }))
      .data as string;
    expect(after).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(after).toContain("TOKEN=[redacted]");
    expect(after).toContain("NAME=keep_this_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6"); // not mangled like the full redactor would
  });

  it("puts only the last six turns in a continuation brief, with secrets redacted from both sides", async () => {
    const t = await sessionRig();
    const c = await t.create();
    const a = await t.client(c);
    for (let i = 0; i < 8; i++) {
      await t.say(
        a,
        c.chat,
        i === 3 ? "plain turn3 ghp_abcdefghijklmnopqrstuvwxyz0123456789" : `plain turn${i}`,
      );
    }
    t.time.now += 20 * 60_000;
    t.sessions.sweep();
    await until(() => t.sandbox.last.exitCode !== undefined);
    await t.say(a, c.chat, "plain and now?");
    const brief = String(t.sandbox.last.prompts[0]?.blocks[0]?.text);
    expect(brief).not.toContain("Owner: plain turn0");
    expect(brief).not.toContain("Owner: plain turn1");
    for (const i of [2, 4, 5, 6, 7]) expect(brief).toContain(`Owner: plain turn${i}`);
    expect(brief.match(/^Owner: /gm)).toHaveLength(6);
    expect(brief).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789"); // the owner's, and the agent's echo of it
    expect(brief).toContain("[redacted]");
  });

  it("ignores what a session/load replays, including old rate-limit reports", async () => {
    const t = await sessionRig();
    t.sandbox.options = { loadSession: true };
    const c = await t.create();
    const a = await t.client(c);
    await t.say(a, c.chat, "plain one");
    t.time.now += 20 * 60_000;
    t.sessions.sweep();
    await until(() => t.sandbox.last.exitCode !== undefined);
    const before = t.limits.length;
    await t.say(a, c.chat, "plain two");
    expect(t.sandbox.last.requests("session/load")).toHaveLength(1);
    expect(t.limits.slice(before).some((l) => l.limit.status === "rejected")).toBe(false);
    expect(t.usage.some((u) => u.status === "rejected")).toBe(false);
    expect(JSON.stringify(t.host.chatState(c.chat))).not.toContain("an old answer");
  });
});

describe("the sandbox", () => {
  const settings = { ...defaultMachineSettings, machineFor: () => "inc-engineering" };
  const { wallsMarker: _w, ...noWalls } = settings;

  it("launches with `container machine run` into the team's sandbox, passing credentials by environment only", async () => {
    const sandbox = new FakeSandbox();
    const seen: { bin: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const t = await sessionRig({ sandbox, host: { launch: machineLaunch(noWalls, sandbox.spawn(seen)) } });
    await t.create("c1", { employee: "ada" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.bin).toBe("/usr/local/bin/container");
    expect(seen[0]?.args).toEqual([
      "machine",
      "run",
      "-i",
      "-u",
      "employee",
      "-n",
      "inc-engineering",
      "-e",
      "I_INC_CWD",
      "-e",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "-e",
      "I_INC_PORTS",
      "-e",
      "I_INC_CONV",
      "-e",
      "I_INC_AGENT",
      "--",
      "acp-claude",
    ]);
    expect(seen[0]?.env.I_INC_AGENT).toMatch(/^[0-9a-f]{16}$/);
    expect(seen[0]?.args.join(" ")).not.toContain("sk-ant");
    expect(seen[0]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-secret");
    expect(seen[0]?.env.I_INC_CWD).toBe("/home/employee/work/conv-c1");
    // Codex gets its own launcher
    const codexRig = await sessionRig({
      sandbox,
      host: { launch: machineLaunch(noWalls, sandbox.spawn(seen)) },
    });
    codexRig.sandbox.options = { codex: true };
    await codexRig.create("c2", { provider: "codex" });
    expect(seen.at(-1)?.args.at(-1)).toBe("acp-codex");
  });

  it("starts nothing when the walls are down, and says so", async () => {
    const sandbox = new FakeSandbox();
    const seen: { bin: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const t = await sessionRig({
      sandbox,
      host: {
        launch: machineLaunch({ ...settings, wallsMarker: "/nonexistent/walls.ok" }, sandbox.spawn(seen)),
      },
    });
    await expect(t.create()).rejects.toThrow(/the walls aren't up/);
    expect(seen).toEqual([]);
    expect(t.host.sessions()).toHaveLength(0);
  });
});

describe("when the agent fails", () => {
  it("ends the turn with an error when the process dies mid-turn, and starts it again on the next message", async () => {
    const t = await sessionRig();
    const c = await t.create();
    const a = await t.client(c);
    await t.say(a, c.chat, "crash now");
    const turn = t.host.chatState(c.chat)?.turns[0] as Any;
    expect(turn.state).toBe(TurnState.Error);
    expect(turn.responseParts[0].content).toBe("About to "); // what it managed to say is kept
    const err = turn.responseParts.at(-1);
    expect(err).toMatchObject({ kind: "error", resumable: false, error: { errorType: "agent_exited" } });
    expect(err.error.message).toMatch(
      /stopped unexpectedly .*exited \(1\).*Send a message to start it again/,
    );
    expect(t.sandbox.agents[0]?.exitCode).toBe(1);
    expect(t.sessions.status()[0]?.live).toBe(false);
    // restartable
    await t.say(a, c.chat, "plain are you back?");
    expect(t.sandbox.agents).toHaveLength(2);
    expect(t.host.chatState(c.chat)?.turns[1]?.state).toBe(TurnState.Complete);
    // the slot went back when it died: the team still has room
    expect(t.sandbox.live).toHaveLength(1);
  });

  it("starts again after an agent killed while idle", async () => {
    const t = await sessionRig();
    const c = await t.create();
    const a = await t.client(c);
    t.sandbox.last.die(137);
    await until(() => t.sessions.status()[0]?.live === false);
    await t.say(a, c.chat, "plain hello again");
    expect(t.sandbox.agents).toHaveLength(2);
    expect(t.host.chatState(c.chat)?.turns[0]?.state).toBe(TurnState.Complete);
  });

  it("reports a sign-in problem, a start failure and a limit as errors the owner can read", async () => {
    const t = await sessionRig();
    const c = await t.create();
    const a = await t.client(c);
    // a rate limit: recorded on the account, with the reset
    await t.say(a, c.chat, "limit please");
    const limited = t.host.chatState(c.chat)?.turns[0]?.responseParts.at(-1) as Any;
    expect(limited.error.errorType).toBe("rate_limited");
    expect(limited.error.message).toContain("session limit");
    expect(limited.error.message).toMatch(/resets \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
    expect(t.limits.at(-1)).toMatchObject({ accountId: "claude-pro", limit: { status: "rejected" } });
    // the agent is gone and the sandbox needs a sign-in
    t.sandbox.last.die(1);
    await until(() => t.sessions.status()[0]?.live === false);
    t.sandbox.options = { authRequired: true };
    await t.say(a, c.chat, "plain hello");
    const signIn = t.host.chatState(c.chat)?.turns[1]?.responseParts.at(-1) as Any;
    expect(signIn.error).toMatchObject({ errorType: "needs_sign_in" });
    expect(signIn.error.message).toContain("needs a sign-in in the engineering sandbox");
    // the walls fall
    t.sandbox.options = {};
    t.sandbox.failLaunch = new Error("the walls aren't up");
    await t.say(a, c.chat, "plain hello");
    const walls = t.host.chatState(c.chat)?.turns[2]?.responseParts.at(-1) as Any;
    expect(walls.error).toMatchObject({ errorType: "agent_start_failed" });
    expect(walls.error.message).toContain("walls");
    // and it works again once they are up
    t.sandbox.failLaunch = undefined;
    await t.say(a, c.chat, "plain hello");
    expect(t.host.chatState(c.chat)?.turns[3]?.state).toBe(TurnState.Complete);
  });

  it("frees the slot of a conversation whose agent is gone", async () => {
    const t = await sessionRig();
    for (const id of ["a", "b", "c"]) await t.create(id);
    t.sandbox.agents[0]?.die(1);
    await until(() => t.sessions.status().filter((s) => s.live).length === 2);
    await t.create("d");
    expect(t.sandbox.live).toHaveLength(3);
    expect(t.sandbox.agents.filter((x) => x.exitCode !== undefined)).toHaveLength(1); // nobody else was suspended
  });
});

describe("Codex", () => {
  it("is set up through its config options: model, effort, and the full-access mode; later changes go the same way", async () => {
    const t = await sessionRig();
    t.sandbox.options = { codex: true };
    const c = await t.create("cx", { provider: "codex" });
    const a = t.sandbox.last;
    expect(a.requests("session/set_mode")).toHaveLength(0);
    const sets = a.requests("session/set_config_option").map((m) => [m.params.configId, m.params.value]);
    expect(sets).toEqual([
      ["model", "default"],
      ["reasoning_effort", "medium"],
      ["mode", "full-access"],
    ]);
    const cfg = t.host.sessionState(c.session)?.config;
    expect(Object.keys(cfg?.schema.properties ?? {})).toEqual(["model", "reasoning_effort", "mode"]);
    expect(cfg?.values).toMatchObject({ mode: "full-access", reasoning_effort: "medium" });
    expect(cfg?.schema.properties.mode?.enumLabels).toEqual(["Read-only", "Auto", "Full access"]);
    const client = await t.client(c);
    client.dispatch(c.session, { type: ActionType.SessionConfigChanged, config: { mode: "auto" } });
    await until(() => a.requests("session/set_config_option").some((m) => m.params.value === "auto"));
    await t.say(client, c.chat, "plain codex hello");
    expect(t.host.chatState(c.chat)?.turns[0]?.state).toBe(TurnState.Complete);
  });
});

describe("closing", () => {
  it("kills the agent and forgets the conversation when its session is disposed", async () => {
    const t = await sessionRig();
    const c = await t.create();
    const first = t.sandbox.last;
    await t.host.disposeSession(c.session);
    await until(() => first.exitCode !== undefined);
    expect(t.sessions.status()).toEqual([]);
    expect(t.host.sessions()).toEqual([]);
    // the slot is free again
    for (const id of ["a", "b", "c"]) await t.create(id);
    expect(t.sandbox.live).toHaveLength(3);
  });

  it("offers one provider per engine on the root channel", async () => {
    const t = await sessionRig();
    const a = await t.client(await t.create());
    expect(a.state<Any>(ROOT).agents.map((x: Any) => x.provider)).toEqual(["opus", "codex"]);
  });
});
