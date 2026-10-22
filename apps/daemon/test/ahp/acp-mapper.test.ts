// The ACP <-> AHP mapper, case by case (docs/design/ahp-spike.md has the table these come from).
import { describe, expect, it } from "vitest";
import { configFromAcp, mapToolContent, promptBlocks, TurnMapper } from "../../src/ahp/acp-mapper.ts";
import type { ChatAction } from "../../src/ahp/wire.ts";
import type { Any } from "./support.ts";

function mapper() {
  const out: Any[] = [];
  const sides: [string, Any][] = [];
  const blobs: Any[] = [];
  const m = new TurnMapper({
    turnId: "t",
    emit: (a: ChatAction) => {
      out.push(a);
      return true;
    },
    put: (data, mime) => {
      blobs.push({ data, mime });
      return {
        uri: `ahp-content:/${blobs.length}`,
        sizeHint: data.length,
        contentType: mime ?? "text/plain",
      };
    },
    side: (k, u) => sides.push([k, u]),
  });
  return { m, out, sides, blobs, types: () => out.map((a) => a.type) };
}

describe("text", () => {
  it("opens a markdown part with the first chunk and deltas the rest; a tool call closes it", () => {
    const { m, out, types } = mapper();
    m.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } });
    m.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } });
    m.update({
      sessionUpdate: "tool_call",
      toolCallId: "x",
      title: "Run ls",
      kind: "execute",
      status: "in_progress",
    });
    m.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } });
    expect(types()).toEqual([
      "chat/responsePart",
      "chat/delta",
      "chat/toolCallStart",
      "chat/toolCallReady",
      "chat/responsePart",
    ]);
    expect(out[0].part).toEqual({ kind: "markdown", id: "t:md1", content: "Hel" });
    expect(out[1]).toMatchObject({ partId: "t:md1", content: "lo" });
    expect(out[4].part.id).not.toBe("t:md1");
    expect(out.every((a) => a.turnId === "t")).toBe(true);
  });

  it("maps thoughts to reasoning parts, and keeps reasoning and text apart", () => {
    const { m, out, types } = mapper();
    m.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } });
    m.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "m" } });
    m.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
    m.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "again" } });
    expect(types()).toEqual([
      "chat/responsePart",
      "chat/reasoning",
      "chat/responsePart",
      "chat/responsePart",
    ]);
    expect(out[0].part.kind).toBe("reasoning");
    expect(out[3].part.kind).toBe("reasoning");
  });

  it("drops what a markdown part can't hold, saying so once through the side channel, and ignores replayed user messages", () => {
    const { m, out, sides } = mapper();
    m.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", data: "x", mimeType: "image/png" },
    });
    m.update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "old" } });
    expect(out).toEqual([]);
    expect(sides.map(([k]) => k)).toEqual(["dropped:agent_message_chunk:image"]);
  });
});

describe("a tool call announced in the state it is in", () => {
  const initial = (status: string, extra: Any = {}) => ({
    sessionUpdate: "tool_call",
    toolCallId: "c",
    title: "Run tests",
    kind: "execute",
    status,
    rawInput: { command: "pnpm test" },
    content: [{ type: "content", content: { type: "text", text: "12 passed" } }],
    ...extra,
  });

  it("completed: start, ready, complete with its content: not skipped, nothing lost", () => {
    const { m, out, types } = mapper();
    m.update(initial("completed", { locations: [{ path: "a.ts" }] }));
    expect(types()).toEqual(["chat/toolCallStart", "chat/toolCallReady", "chat/toolCallComplete"]);
    expect(out[1]).toMatchObject({ confirmed: "not-needed", toolInput: '{"command":"pnpm test"}' });
    expect(out[2].result).toEqual({
      success: true,
      pastTenseMessage: "Run tests",
      content: [{ type: "text", text: "12 passed" }],
    });
    expect(out[2]._meta).toEqual({ "iinc.locations": [{ path: "a.ts" }] });
    // a late update for the finished call changes nothing
    m.update({ sessionUpdate: "tool_call_update", toolCallId: "c", status: "completed" });
    expect(types()).toHaveLength(3);
  });

  it("failed: complete with success false and an error, content kept", () => {
    const { m, out, types } = mapper();
    m.update(initial("failed"));
    expect(types()).toEqual(["chat/toolCallStart", "chat/toolCallReady", "chat/toolCallComplete"]);
    expect(out[2].result).toMatchObject({
      success: false,
      error: { message: "Run tests failed" },
      content: [{ type: "text", text: "12 passed" }],
    });
  });

  it("in_progress: start, ready, the content so far; pending: only the start", () => {
    const a = mapper();
    a.m.update(initial("in_progress"));
    expect(a.types()).toEqual(["chat/toolCallStart", "chat/toolCallReady", "chat/toolCallContentChanged"]);
    const b = mapper();
    b.m.update(initial("pending"));
    expect(b.types()).toEqual(["chat/toolCallStart"]);
  });

  it("is a finished card in the chat, with its output, once the turn is over", async () => {
    // through the official reducers: what the thread shows
    const { reduce } = await import("../../src/ahp/wire.ts");
    const { m, out } = mapper();
    m.update(initial("completed"));
    let c = {
      kind: "chat",
      state: {
        resource: "ahp-chat:/x",
        title: "t",
        status: 1,
        modifiedAt: "2026-10-21T00:00:00.000Z",
        turns: [],
        activeTurn: {
          id: "t",
          startedAt: "2026-10-21T00:00:00.000Z",
          message: { text: "go", origin: { kind: "user" } },
          responseParts: [],
        },
      },
    } as Any;
    for (const a of out) c = reduce(c, a);
    const call = c.state.activeTurn.responseParts.find((p: Any) => p.kind === "toolCall").toolCall;
    expect(call.status).toBe("completed");
    expect(call.content).toEqual([{ type: "text", text: "12 passed" }]);
  });
});

describe("tool calls", () => {
  it("runs pending, in progress, completed: start, ready (not needed), complete with output", () => {
    const { m, out } = mapper();
    m.update({
      sessionUpdate: "tool_call",
      toolCallId: "r",
      title: "Read a.ts",
      kind: "read",
      status: "pending",
      rawInput: { path: "a.ts" },
      locations: [{ path: "a.ts" }],
    });
    m.update({ sessionUpdate: "tool_call_update", toolCallId: "r", status: "in_progress" });
    m.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "r",
      status: "in_progress",
      content: [{ type: "content", content: { type: "text", text: "so far" } }],
    });
    m.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "r",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "all of it" } }],
    });
    expect(out.map((a) => a.type)).toEqual([
      "chat/toolCallStart",
      "chat/toolCallReady",
      "chat/toolCallContentChanged",
      "chat/toolCallComplete",
    ]);
    expect(out[0]).toMatchObject({
      toolName: "read",
      displayName: "Read a.ts",
      _meta: { "iinc.locations": [{ path: "a.ts" }] },
    });
    expect(out[1]).toMatchObject({
      confirmed: "not-needed",
      toolInput: '{"path":"a.ts"}',
      invocationMessage: "Read a.ts",
    });
    expect(out[3].result).toEqual({
      success: true,
      pastTenseMessage: "Read a.ts",
      content: [{ type: "text", text: "all of it" }],
    });
  });

  it("starts a call that is already running in one go, content included; announces one the agent skipped", () => {
    const { m, out } = mapper();
    m.update({
      sessionUpdate: "tool_call",
      toolCallId: "a",
      title: "Run ls",
      kind: "execute",
      status: "in_progress",
      content: [{ type: "content", content: { type: "text", text: "x" } }],
    });
    expect(out.map((x) => x.type)).toEqual([
      "chat/toolCallStart",
      "chat/toolCallReady",
      "chat/toolCallContentChanged",
    ]);
    m.update({ sessionUpdate: "tool_call_update", toolCallId: "b", status: "completed", title: "Surprise" });
    expect(out.slice(3).map((x) => x.type)).toEqual([
      "chat/toolCallStart",
      "chat/toolCallReady",
      "chat/toolCallComplete",
    ]);
    expect(out.at(-1).result.pastTenseMessage).toBe("Surprise");
  });

  it("reports a failure, and ignores updates after the end", () => {
    const { m, out } = mapper();
    m.update({
      sessionUpdate: "tool_call",
      toolCallId: "f",
      title: "Run bad",
      kind: "execute",
      status: "in_progress",
    });
    m.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "f",
      status: "failed",
      content: [{ type: "content", content: { type: "text", text: "boom" } }],
    });
    m.update({ sessionUpdate: "tool_call_update", toolCallId: "f", status: "completed" });
    expect(out.filter((a) => a.type === "chat/toolCallComplete")).toHaveLength(1);
    expect(out.at(-1).result).toMatchObject({
      success: false,
      error: { message: "Run bad failed" },
      content: [{ type: "text", text: "boom" }],
    });
  });

  it("turns a permission request into a pending confirmation with options and the diff, and answers it by option", () => {
    const { m, out } = mapper();
    m.update({
      sessionUpdate: "tool_call",
      toolCallId: "e",
      title: "Edit a.ts",
      kind: "edit",
      status: "pending",
    });
    m.permission({
      sessionId: "s",
      toolCall: {
        toolCallId: "e",
        title: "Edit a.ts",
        kind: "edit",
        rawInput: { f: 1 },
        content: [{ type: "diff", path: "/repo/a.ts", oldText: "a\n", newText: "b\nc\n" }],
      },
      options: [
        { optionId: "ao", name: "Allow once", kind: "allow_once" },
        { optionId: "aa", name: "Always allow", kind: "allow_always" },
        { optionId: "ro", name: "Deny", kind: "reject_once" },
        { optionId: "ra", name: "Always deny", kind: "reject_always" },
      ],
    });
    const ready = out.at(-1);
    expect(ready).toMatchObject({
      type: "chat/toolCallReady",
      confirmationTitle: "Edit a.ts",
      toolInput: '{"f":1}',
    });
    expect(ready.confirmed).toBeUndefined(); // no `confirmed`: the reducer makes it pending-confirmation
    expect(ready.options.map((o: Any) => [o.id, o.kind, o.group])).toEqual([
      ["ao", "approve", 0],
      ["aa", "approve", 1],
      ["ro", "deny", 0],
      ["ra", "deny", 1],
    ]);
    expect(ready.edits.items[0]).toMatchObject({
      after: { uri: "file:///repo/a.ts" },
      diff: { added: 2, removed: 1 },
    });
    expect(m.permissionOutcome("e", true, "aa")).toEqual({ outcome: "selected", optionId: "aa" });
    expect(m.permissionOutcome("e", true)).toEqual({ outcome: "selected", optionId: "ao" });
    expect(m.permissionOutcome("e", false)).toEqual({ outcome: "selected", optionId: "ro" });
    expect(m.permissionOutcome("e", true, "ra")).toEqual({ outcome: "selected", optionId: "ra" }); // the owner's choice stands
    expect(m.permissionOutcome("e", true, "nonsense")).toEqual({ outcome: "selected", optionId: "ao" });
    expect(m.permissionOutcome("unknown", true)).toEqual({ outcome: "cancelled" });
    // denied: the call is over, so the agent's later "failed" adds nothing
    m.confirmed("e", false);
    const n = out.length;
    m.update({ sessionUpdate: "tool_call_update", toolCallId: "e", status: "failed" });
    expect(out.length).toBe(n);
  });

  it("announces a call the agent only asks permission for", () => {
    const { m, out } = mapper();
    m.permission({
      toolCall: { toolCallId: "n", title: "Run x", kind: "execute" },
      options: [{ optionId: "ao", name: "Allow", kind: "allow_once" }],
    });
    expect(out.map((a) => a.type)).toEqual(["chat/toolCallStart", "chat/toolCallReady"]);
  });

  it("keeps the plan as a pseudo tool call that is closed when the turn finishes", () => {
    const { m, out } = mapper();
    m.update({ sessionUpdate: "plan", entries: [{ content: "A", status: "pending", priority: "high" }] });
    m.update({
      sessionUpdate: "plan",
      entries: [
        { content: "A", status: "completed", priority: "high" },
        { content: "B", status: "pending", priority: "low" },
      ],
    });
    m.finish();
    m.finish();
    expect(out.map((a) => a.type)).toEqual([
      "chat/toolCallStart",
      "chat/toolCallReady",
      "chat/toolCallContentChanged",
      "chat/toolCallContentChanged",
      "chat/toolCallComplete",
    ]);
    expect(out[0]).toMatchObject({ toolName: "x-iinc-plan", toolCallId: "t:plan" });
    expect(out[3].content[0].text).toBe("- [x] A\n- [ ] B");
    expect(out[3]._meta["iinc.plan"]).toHaveLength(2);
  });

  it("sends modes, config, commands, usage and the unknown to the side channel", () => {
    const { m, out, sides } = mapper();
    for (const u of [
      "current_mode_update",
      "config_option_update",
      "available_commands_update",
      "usage_update",
      "session_info_update",
      "brand_new_thing",
    ]) {
      m.update({ sessionUpdate: u });
    }
    expect(out).toEqual([]);
    expect(sides.map(([k]) => k)).toEqual([
      "current_mode_update",
      "config_option_update",
      "available_commands_update",
      "usage",
      "session_info_update",
      "unknown:brand_new_thing",
    ]);
  });
});

describe("tool content", () => {
  it("maps text, images (kept as content), links, new-file diffs and terminals", () => {
    const blobs: Any[] = [];
    const put = (data: string | Uint8Array, mime?: string) => {
      blobs.push({ data, mime });
      return {
        uri: `ahp-content:/${blobs.length}`,
        sizeHint: data.length,
        contentType: mime ?? "text/plain",
      };
    };
    const out = mapToolContent(
      [
        { type: "content", content: { type: "text", text: "hi" } },
        {
          type: "content",
          content: { type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" },
        },
        { type: "content", content: { type: "resource_link", name: "doc", uri: "https://x/y" } },
        { type: "diff", path: "new.ts", newText: "one\ntwo\n" },
        { type: "terminal", terminalId: "t1" },
        { type: "something-else" },
      ],
      put,
    );
    expect(out[0]).toEqual({ type: "text", text: "hi" });
    expect(out[1]).toMatchObject({ type: "resource", uri: "ahp-content:/1", contentType: "image/png" });
    expect(Buffer.from(blobs[0].data).toString()).toBe("png");
    expect(out[2]).toEqual({ type: "text", text: "doc: https://x/y" });
    expect(out[3]).toMatchObject({
      type: "fileEdit",
      after: { uri: "file:///new.ts" },
      diff: { added: 2, removed: 0 },
    });
    expect(out[3]?.before).toBeUndefined();
    expect(out[4]).toEqual({ type: "text", text: "[terminal t1]" });
    expect(out).toHaveLength(5);
  });

  it("cuts a huge diff side instead of storing megabytes", () => {
    let kept = "";
    mapToolContent([{ type: "diff", path: "/big", oldText: "", newText: "x".repeat(2_000_000) }], (d) => {
      kept = String(d);
      return { uri: "ahp-content:/1" };
    });
    expect(kept.length).toBeLessThan(1_100_000);
    expect(kept).toContain("[…truncated]");
  });
});

describe("the prompt", () => {
  const msg = (attachments?: Any[]) =>
    ({ text: "hi", origin: { kind: "user" }, ...(attachments ? { attachments } : {}) }) as never;
  it("is just the text with no attachments", () => {
    expect(promptBlocks(msg())).toEqual([{ type: "text", text: "hi" }]);
  });
  it("reads text files inline when the agent takes no embedded content, and says when it can't read one", () => {
    const blocks = promptBlocks(
      msg([
        {
          type: "embeddedResource",
          label: "a.txt",
          data: Buffer.from("hello").toString("base64"),
          contentType: "text/plain",
        },
        { type: "embeddedResource", label: "b.zip", data: "AAAA", contentType: "application/zip" },
        { type: "simple", label: "ctx", modelRepresentation: "extra context" },
        { type: "simple", label: "plain" },
      ]),
      {},
    );
    expect(blocks).toEqual([
      { type: "text", text: "hi" },
      { type: "text", text: '<attachment name="a.txt">\nhello\n</attachment>' },
      { type: "text", text: "[The user attached b.zip (application/zip), which this agent can't read.]" },
      { type: "text", text: "extra context" },
    ]);
  });
});

describe("the agent's modes as config", () => {
  it("makes `mode` from the session modes and a property from each select option", () => {
    const cfg = configFromAcp(
      {
        currentModeId: "b",
        availableModes: [
          { id: "a", name: "Ask", description: "asks" },
          { id: "b", name: "Bypass" },
        ],
      },
      [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "m1",
          options: [
            { value: "m1", name: "One" },
            { value: "m2", name: "Two" },
          ],
        },
        { id: "flag", name: "Flag", type: "boolean", currentValue: true },
        { id: "mode", name: "Mode", type: "select", currentValue: "x", options: [{ value: "x" }] },
      ],
    );
    expect(Object.keys(cfg.schema.properties)).toEqual(["mode", "model"]);
    expect(cfg.schema.properties.mode).toMatchObject({
      enum: ["a", "b"],
      enumLabels: ["Ask", "Bypass"],
      sessionMutable: true,
    });
    expect(cfg.values).toEqual({ mode: "b", model: "m1" });
    expect(cfg.schema.properties.model?.enumLabels).toEqual(["One", "Two"]);
  });

  it("flattens grouped options and handles an agent with no modes", () => {
    const cfg = configFromAcp(undefined, [
      {
        id: "effort",
        name: "Effort",
        type: "select",
        currentValue: "hi",
        options: [
          {
            group: "levels",
            options: [
              { value: "lo", name: "Low" },
              { value: "hi", name: "High" },
            ],
          },
        ],
      },
    ]);
    expect(cfg.schema.properties.effort?.enum).toEqual(["lo", "hi"]);
    expect(configFromAcp(undefined, undefined)).toEqual({
      schema: { type: "object", properties: {} },
      values: {},
    });
  });
});

describe("locations", () => {
  const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

  it("keeps a tool call's paths and lines, redacts credentials in them, and bounds them", () => {
    const { m, out } = mapper();
    m.update({
      sessionUpdate: "tool_call",
      toolCallId: "r1",
      title: "Read",
      kind: "read",
      status: "pending",
      locations: [
        { path: "src/a.ts", line: 3, extra: "dropped" },
        { path: `https://user:${TOKEN}@host/x/${TOKEN}/file.ts` },
        { path: "x".repeat(2000) },
        { nope: 1 },
        ...Array.from({ length: 40 }, (_, i) => ({ path: `f${i}` })),
      ],
    });
    const start = out.find((a) => a.type === "chat/toolCallStart");
    const locs = start._meta["iinc.locations"] as { path: string; line?: number }[];
    expect(locs).toHaveLength(20);
    expect(locs[0]).toEqual({ path: "src/a.ts", line: 3 });
    expect(JSON.stringify(locs)).not.toContain(TOKEN);
    expect(locs[1]?.path).toContain("[redacted]");
    expect(locs[2]?.path.length).toBe(500);
    m.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "r1",
      status: "completed",
      locations: [{ path: `/work/${TOKEN}` }],
    });
    const done = out.find((a) => a.type === "chat/toolCallComplete");
    expect(JSON.stringify(done._meta)).not.toContain(TOKEN);
  });
});
