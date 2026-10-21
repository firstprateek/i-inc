import { describe, expect, it } from "vitest";
import {
  attachmentOf,
  cancelTurn,
  checkOutgoing,
  confirmTool,
  LIMITS,
  pendingMessage,
  turnStarted,
} from "../../src/conversations/actions.ts";
import {
  bypassMode,
  changedFiles,
  commandsOf,
  firstPending,
  groupConversations,
  latestPlan,
  matchCommands,
  modePicker,
  optionKind,
  otherPickers,
  relativeTime,
  slashQuery,
  sortedOptions,
  statusText,
  toolCategory,
  toolDetail,
  toolEdits,
  toolInputText,
  usageTotals,
  visible,
} from "../../src/conversations/model.ts";

// biome-ignore lint/suspicious/noExplicitAny: scripted protocol state.
type Any = any;

const conv = (over: Any = {}): Any => ({
  id: "aaaaaaaa",
  employeeId: "ada",
  project: null,
  branch: null,
  title: "t",
  mode: null,
  engineId: "opus",
  createdAt: 0,
  archivedAt: null,
  ahpSession: "s",
  ahpChat: "c",
  status: 1,
  needsYou: false,
  running: false,
  modifiedAt: 0,
  ...over,
});

describe("the list", () => {
  it("groups Needs you, Running and Recent, newest first, and skips empty groups", () => {
    const g = groupConversations([
      conv({ id: "1", modifiedAt: 1 }),
      conv({ id: "2", modifiedAt: 5, running: true, status: 8 }),
      conv({ id: "3", modifiedAt: 3, needsYou: true, status: 24 }),
      conv({ id: "4", modifiedAt: 9 }),
    ]);
    expect(g.map((x) => [x.group, x.items.map((c) => c.id)])).toEqual([
      ["needs", ["3"]],
      ["running", ["2"]],
      ["recent", ["4", "1"]],
    ]);
    expect(groupConversations([conv()]).map((x) => x.group)).toEqual(["recent"]);
  });
  it("reads the status bits: only the full input-needed pair is Needs you, and the read flag changes nothing", () => {
    const g = (status: number) => groupConversations([conv({ status })])[0]?.group;
    expect(g(1)).toBe("recent");
    expect(g(1 | 32)).toBe("recent");
    expect(g(2)).toBe("recent");
    expect(g(8)).toBe("running");
    expect(g(8 | 32)).toBe("running");
    expect(g(24)).toBe("needs");
    expect(g(24 | 32)).toBe("needs");
    expect(statusText(conv({ status: 24 }))).toBe("Needs you");
    expect(statusText(conv({ status: 8 }))).toBe("Running");
    expect(statusText(conv({ status: 2 }))).toBe("Error");
    expect(statusText(conv({ status: 1, archivedAt: 5 }))).toBe("Archived");
  });
  it("says how long ago", () => {
    const now = 10_000_000;
    expect(relativeTime(now - 5000, now)).toBe("now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d");
  });
});

describe("tool calls", () => {
  const call = (over: Any = {}): Any => ({
    toolCallId: "t",
    toolName: "read",
    displayName: "Read a",
    status: "completed",
    success: true,
    pastTenseMessage: "Read a",
    confirmed: "not-needed",
    ...over,
  });
  it("names the kind and the detail", () => {
    expect(toolCategory(call({ toolName: "execute" }))).toBe("run");
    expect(toolCategory(call({ toolName: "x-iinc-plan" }))).toBe("plan");
    expect(toolCategory(call({ toolName: "mystery" }))).toBe("other");
    expect(toolDetail(call({ toolInput: JSON.stringify({ path: "src/a.ts" }) }))).toBe("src/a.ts");
    expect(
      toolInputText(call({ toolName: "execute", toolInput: JSON.stringify({ command: "ls -la" }) })),
    ).toBe("ls -la");
    expect(toolDetail(call({ _meta: { "iinc.locations": [{ path: "x.ts", line: 4 }] } }))).toBe("x.ts:4");
  });
  it("finds edits while pending and after", () => {
    const edit = {
      after: { uri: "file:///a", content: { uri: "ahp-content:/1" } },
      diff: { added: 1, removed: 0 },
    };
    expect(toolEdits(call({ status: "pending-confirmation", edits: { items: [edit] } }))).toEqual([edit]);
    expect(
      toolEdits(
        call({
          content: [
            { type: "fileEdit", ...edit },
            { type: "text", text: "x" },
          ],
        }),
      ),
    ).toHaveLength(1);
  });
  it("orders the agent's options and says what each means", () => {
    const o = [
      { id: "d", label: "Deny", kind: "deny", group: 0 },
      { id: "a", label: "Always allow", kind: "approve", group: 1 },
      { id: "o", label: "Allow once", kind: "approve", group: 0 },
    ];
    expect(sortedOptions(o as Any).map((x) => x.id)).toEqual(["o", "a", "d"]);
    expect(o.map((x) => optionKind(x as Any))).toEqual(["deny", "always", "once"]);
  });
});

describe("characters that can fool the eye", () => {
  it("shows bidi, zero-width and control characters visibly", () => {
    expect(visible("src/\u202egnp.exe")).toBe("src/⟨U+202E⟩gnp.exe");
    expect(visible("a\u200bb\u2066c\ufeffd\u0007")).toBe("a⟨U+200B⟩b⟨U+2066⟩c⟨U+FEFF⟩d⟨U+0007⟩");
    expect(visible("line\n\ttab")).toBe("line\n\ttab");
    expect(visible("plain ascii and ünïcode and 日本語")).toBe("plain ascii and ünïcode and 日本語");
    expect(visible("\u2028")).toBe("⟨U+2028⟩");
  });
  it("lets emoji joiners through in a title, never in a path", () => {
    const family = "\u{1F468}\u200d\u{1F469}";
    expect(visible(family, true)).toBe(family);
    expect(visible(family)).toContain("⟨U+200D⟩");
  });
  it("applies to paths, details, commands and the plan the model reads out", () => {
    const call: Any = {
      toolCallId: "t",
      toolName: "execute",
      displayName: "Run",
      status: "pending-confirmation",
      invocationMessage: "Run \u202ex",
      toolInput: JSON.stringify({ command: "rm \u202e-rf /" }),
    };
    expect(toolInputText(call)).toBe("rm ⟨U+202E⟩-rf /");
    expect(
      toolDetail({ ...call, toolName: "read", toolInput: JSON.stringify({ path: "src/\u202egnp.exe" }) }),
    ).toBe("src/⟨U+202E⟩gnp.exe");
    expect(
      changedFiles({
        turns: [
          {
            id: "1",
            responseParts: [
              {
                kind: "toolCall",
                toolCall: {
                  toolCallId: "e",
                  status: "completed",
                  success: true,
                  content: [
                    { type: "fileEdit", after: { uri: "file:///x/\u202egnp.exe", content: { uri: "u" } } },
                  ],
                },
              },
            ],
          },
        ],
      } as Any)[0]?.path,
    ).toBe("x/⟨U+202E⟩gnp.exe");
    expect(
      latestPlan({
        turns: [
          {
            id: "1",
            responseParts: [
              {
                kind: "toolCall",
                toolCall: {
                  toolCallId: "p",
                  toolName: "x-iinc-plan",
                  _meta: { "iinc.plan": [{ content: "do \u202ethis", status: "pending" }] },
                },
              },
            ],
          },
        ],
      } as Any)?.[0]?.content,
    ).toBe("do ⟨U+202E⟩this");
  });
});

describe("the thread's state", () => {
  const plan = (entries: Any[]) => ({
    kind: "toolCall",
    toolCall: { toolCallId: "p", toolName: "x-iinc-plan", _meta: { "iinc.plan": entries } },
  });
  it("takes the latest plan, from the active turn first", () => {
    const chat: Any = {
      turns: [{ id: "1", responseParts: [plan([{ content: "old", status: "completed" }])] }],
      activeTurn: { id: "2", responseParts: [plan([{ content: "new", status: "in_progress" }])] },
    };
    expect(latestPlan(chat)?.map((e) => e.content)).toEqual(["new"]);
    expect(latestPlan({ turns: [], activeTurn: undefined } as Any)).toBeUndefined();
  });
  it("lists the files changed, the latest edit of each, with the first before and the last after", () => {
    const edit = (
      uri: string,
      before: string | undefined,
      after: string,
      added: number,
      removed: number,
    ) => ({
      kind: "toolCall",
      toolCall: {
        toolCallId: after,
        status: "completed",
        success: true,
        content: [
          {
            type: "fileEdit",
            ...(before ? { before: { uri, content: { uri: before } } } : {}),
            after: { uri, content: { uri: after } },
            diff: { added, removed },
          },
        ],
      },
    });
    const chat: Any = {
      turns: [
        {
          id: "1",
          responseParts: [
            edit("file:///home/employee/work/conv-ab12cd34/src/a.ts", "b1", "a1", 2, 1),
            edit("file:///x/b.ts", undefined, "n", 3, 0),
            edit("file:///home/employee/work/conv-ab12cd34/src/a.ts", "b2", "a2", 1, 1),
          ],
        },
      ],
    };
    const files = changedFiles(chat);
    expect(files.map((f) => [f.path, f.added, f.removed])).toEqual([
      ["src/a.ts", 3, 2],
      ["x/b.ts", 3, 0],
    ]);
    expect(files[0]?.edit.before?.content.uri).toBe("b1");
    expect(files[0]?.edit.after?.content.uri).toBe("a2");
  });
  it("sums usage and finds what waits for the owner", () => {
    const chat: Any = {
      turns: [{ id: "1", usage: { inputTokens: 100, outputTokens: 5 }, responseParts: [] }],
      activeTurn: {
        id: "2",
        usage: { inputTokens: 50, outputTokens: 1, model: "m" },
        responseParts: [{ kind: "toolCall", toolCall: { toolCallId: "tc", status: "pending-confirmation" } }],
      },
    };
    expect(usageTotals(chat)).toMatchObject({ input: 150, output: 6, turns: 2, model: "m" });
    expect(firstPending(chat)).toEqual({ turnId: "2", id: "tc" });
    expect(firstPending({ turns: [] } as Any)).toBeUndefined();
  });
});

describe("the session's config", () => {
  const session: Any = {
    config: {
      schema: {
        properties: {
          mode: {
            type: "string",
            title: "Mode",
            sessionMutable: true,
            enum: ["default", "bypassPermissions"],
            enumLabels: ["Always ask", "Bypass permissions"],
          },
          model: {
            type: "string",
            title: "Model",
            sessionMutable: true,
            enum: ["a", "b"],
            enumLabels: ["gpt-5-codex", "other"],
          },
          fixed: { type: "string", title: "Fixed", sessionMutable: false, enum: ["x"] },
        },
      },
      values: { mode: "bypassPermissions", model: "b" },
    },
    _meta: {
      "iinc.commands": [
        { name: "compact", description: "Compact", input: { hint: "focus" } },
        { name: "review" },
        { nope: 1 },
      ],
    },
  };
  it("lists the agent's own modes and models by the agent's names", () => {
    const m = modePicker(session);
    expect(m?.choices.map((c) => c.label)).toEqual(["Always ask", "Bypass permissions"]);
    expect(m?.value).toBe("bypassPermissions");
    expect(bypassMode(m)?.value).toBe("bypassPermissions");
    expect(otherPickers(session).map((p) => [p.key, p.title, p.value])).toEqual([["model", "Model", "b"]]);
    expect(modePicker({} as Any)).toBeUndefined();
  });
  it("offers slash commands as you type after a /", () => {
    const cmds = commandsOf(session);
    expect(cmds.map((c) => c.name)).toEqual(["compact", "review"]);
    expect(slashQuery("hello /co", 9)).toEqual({ word: "co", start: 6 });
    expect(slashQuery("/", 1)).toEqual({ word: "", start: 0 });
    expect(slashQuery("path/to", 7)).toBeUndefined();
    expect(slashQuery("no slash", 8)).toBeUndefined();
    expect(matchCommands(cmds, "co").map((c) => c.name)).toEqual(["compact"]);
    expect(matchCommands(cmds, "").map((c) => c.name)).toEqual(["compact", "review"]);
  });
});

describe("the actions it sends", () => {
  it("builds the shapes the host accepts", () => {
    const t = turnStarted("hi", [], "t1", new Date("2026-10-21T10:00:00Z")) as Any;
    expect(t).toMatchObject({
      type: "chat/turnStarted",
      turnId: "t1",
      startedAt: "2026-10-21T10:00:00.000Z",
      message: { text: "hi", origin: { kind: "user" } },
    });
    expect(pendingMessage("steering", "x", [], "m1")).toMatchObject({
      type: "chat/pendingMessageSet",
      kind: "steering",
      id: "m1",
    });
    expect(pendingMessage("queued", "x") as Any).toMatchObject({ kind: "queued" });
    expect(cancelTurn("t1", "2026-10-21T10:00:00Z", Date.parse("2026-10-21T10:00:05Z"))).toMatchObject({
      type: "chat/turnCancelled",
      turnId: "t1",
      duration: 5000,
    });
    expect(
      confirmTool("t1", "c1", { id: "allow-once", label: "Allow once", kind: "approve", group: 0 } as Any),
    ).toEqual({
      type: "chat/toolCallConfirmed",
      turnId: "t1",
      toolCallId: "c1",
      approved: true,
      confirmed: "user-action",
      selectedOptionId: "allow-once",
    });
    expect(confirmTool("t1", "c1", { id: "no", label: "Deny", kind: "deny", group: 0 } as Any)).toEqual({
      type: "chat/toolCallConfirmed",
      turnId: "t1",
      toolCallId: "c1",
      approved: false,
      reason: "denied",
      selectedOptionId: "no",
    });
    expect(confirmTool("t1", "c1", { approve: true })).toMatchObject({
      approved: true,
      confirmed: "user-action",
    });
  });
  it("turns an image into an embedded attachment", async () => {
    const a = (await attachmentOf(
      new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" }),
    )) as Any;
    expect(a).toEqual({
      type: "embeddedResource",
      label: "shot.png",
      contentType: "image/png",
      data: "iVBORw==",
    });
  });
});

describe("what the host would refuse is refused here, with a reason", () => {
  it("accepts an ordinary message and says no to an oversized one", () => {
    expect(checkOutgoing("hello", [])).toBeNull();
    expect(checkOutgoing("x".repeat(LIMITS.messageChars), [])).toBeNull();
    expect(checkOutgoing("x".repeat(LIMITS.messageChars + 10), [])).toMatch(
      /10 characters over the limit \(256,000\)/,
    );
  });
  it("keeps the images in one message under what a frame can carry", () => {
    expect(checkOutgoing("", [{ size: 5 * 1048576 }, { size: 5 * 1048576 }])).toBeNull();
    expect(checkOutgoing("", [{ size: 9 * 1048576 }, { size: 9 * 1048576 }])).toMatch(
      /18\.0 MB together; a message takes at most 12 MB/,
    );
    expect(
      checkOutgoing(
        "",
        Array.from({ length: 7 }, () => ({ size: 1 })),
      ),
    ).toMatch(/at most 6/);
  });
  it("catches text that is small in characters but big once escaped", () => {
    expect(checkOutgoing("\u0001".repeat(200_000), [])).toMatch(/too large/);
  });
});
