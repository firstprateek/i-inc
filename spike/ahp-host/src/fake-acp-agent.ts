// A scripted ACP agent over stdio (newline-delimited JSON-RPC), standing in for claude-code-acp /
// codex-acp. It speaks just enough ACP to exercise every session/update kind i.inc will see.
//
// Prompt scripts (chosen by the prompt text):
//   "slow ..."  streams chunks slowly until session/cancel arrives, then ends with stopReason "cancelled"
//   anything else: thought chunk, message chunks, a read tool call, a plan, an edit tool call that asks
//   for permission (allow_once / allow_always / reject_once / reject_always), then the outcome.
import { createInterface } from "node:readline";

type Json = Record<string, unknown>;
const out = (m: Json) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let nextId = 1000;
const pending = new Map<number, (m: Json) => void>();
const request = (method: string, params: Json) =>
  new Promise<Json>((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    out({ id, method, params });
  });

const modes = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Always ask", description: "Ask before every edit" },
    { id: "acceptEdits", name: "Accept edits" },
    { id: "plan", name: "Plan only" },
    { id: "bypassPermissions", name: "Bypass permissions" },
  ],
};
const configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "fake-1",
    options: [
      { value: "fake-1", name: "Fake One" },
      { value: "fake-2", name: "Fake Two" },
    ],
  },
];

const cancelled = new Set<string>();
let currentMode = modes.currentModeId;
const update = (sessionId: string, u: Json) => out({ method: "session/update", params: { sessionId, update: u } });

async function prompt(sessionId: string, blocks: Json[]): Promise<Json> {
  const text = blocks
    .filter((b) => b.type === "text")
    .map((b) => String(b.text))
    .join(" ");
  const images = blocks.filter((b) => b.type === "image").length;
  if (text.startsWith("slow")) {
    for (let i = 0; i < 200 && !cancelled.has(sessionId); i++) {
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `tick${i} ` } });
      await sleep(50);
    }
    const was = cancelled.delete(sessionId);
    return { stopReason: was ? "cancelled" : "end_turn" };
  }
  update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking about it. " } });
  await sleep(10);
  update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Let me look at the file." } });
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: `Hello! You said: ${text}${images ? ` (+${images} image)` : ""}. ` },
  });
  await sleep(10);
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I'll read then edit. " } });
  // A read tool: pending -> in_progress -> completed, with content and locations
  update(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "tc-read",
    title: "Read src/app.ts",
    kind: "read",
    status: "pending",
    rawInput: { path: "src/app.ts" },
    locations: [{ path: "src/app.ts", line: 1 }],
  });
  update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "tc-read", status: "in_progress" });
  update(sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-read",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "export const answer = 41;\n" } }],
  });
  update(sessionId, {
    sessionUpdate: "plan",
    entries: [
      { content: "Read the file", priority: "high", status: "completed" },
      { content: "Fix the constant", priority: "high", status: "in_progress" },
      { content: "Run the tests", priority: "medium", status: "pending" },
    ],
  });
  update(sessionId, {
    sessionUpdate: "available_commands_update",
    availableCommands: [{ name: "compact", description: "Compact the conversation", input: { hint: "focus" } }],
  });
  // An edit that needs permission (unless the mode bypasses it)
  update(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "tc-edit",
    title: "Edit src/app.ts",
    kind: "edit",
    status: "pending",
    rawInput: { path: "src/app.ts", old: "41", new: "42" },
    locations: [{ path: "src/app.ts", line: 1 }],
  });
  let allowed = currentMode === "bypassPermissions" || currentMode === "acceptEdits";
  if (!allowed) {
    const res = await request("session/request_permission", {
      sessionId,
      toolCall: {
        toolCallId: "tc-edit",
        title: "Edit src/app.ts",
        kind: "edit",
        rawInput: { path: "src/app.ts" },
        content: [{ type: "diff", path: "src/app.ts", oldText: "export const answer = 41;\n", newText: "export const answer = 42;\n" }],
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
        { optionId: "reject-once", name: "Deny", kind: "reject_once" },
        { optionId: "reject-always", name: "Always deny", kind: "reject_always" },
      ],
    });
    const outcome = (res.result as Json | undefined)?.outcome as Json | undefined;
    console.error(`[fake-acp] permission answered: ${JSON.stringify(outcome)}`);
    if (!outcome || outcome.outcome === "cancelled") return { stopReason: "cancelled" };
    allowed = String(outcome.optionId).startsWith("allow");
  }
  if (allowed) {
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "tc-edit", status: "in_progress" });
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-edit",
      status: "completed",
      title: "Edited src/app.ts",
      content: [{ type: "diff", path: "src/app.ts", oldText: "export const answer = 41;\n", newText: "export const answer = 42;\n" }],
    });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done: answer is now 42." } });
  } else {
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "tc-edit", status: "failed" });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Understood, I left the file alone." } });
  }
  update(sessionId, { sessionUpdate: "usage_update", used: 1234, size: 200000 });
  return { stopReason: "end_turn", _meta: { usage: { inputTokens: 1200, outputTokens: 34 } } };
}

async function handle(m: Json) {
  const id = m.id as number | undefined;
  const params = (m.params ?? {}) as Json;
  switch (m.method) {
    case "initialize":
      return out({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true } },
          authMethods: [],
        },
      });
    case "session/new": {
      const sessionId = `acp-${Math.random().toString(36).slice(2, 8)}`;
      out({ id, result: { sessionId, modes: { ...modes, currentModeId: currentMode }, configOptions } });
      update(sessionId, { sessionUpdate: "current_mode_update", currentModeId: currentMode });
      return;
    }
    case "session/load": {
      console.error(`[fake-acp] session/load ${String(params.sessionId)}`);
      out({ id, result: { modes: { ...modes, currentModeId: currentMode }, configOptions } });
      return;
    }
    case "session/set_mode":
      console.error(`[fake-acp] set_mode ${String(params.modeId)}`);
      currentMode = String(params.modeId);
      out({ id, result: {} });
      update(String(params.sessionId), { sessionUpdate: "current_mode_update", currentModeId: currentMode });
      return;
    case "session/set_config_option": {
      out({ id, result: { configOptions } });
      update(String(params.sessionId), { sessionUpdate: "config_option_update", configOptions });
      return;
    }
    case "session/prompt": {
      const sessionId = String(params.sessionId);
      const result = await prompt(sessionId, (params.prompt ?? []) as Json[]);
      return out({ id, result });
    }
    case "session/cancel":
      console.error(`[fake-acp] received session/cancel for ${String(params.sessionId)}`);
      cancelled.add(String(params.sessionId));
      return;
    default:
      if (id !== undefined) out({ id, error: { code: -32601, message: `unknown method ${String(m.method)}` } });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let m: Json;
  try {
    m = JSON.parse(line) as Json;
  } catch {
    return;
  }
  if (m.id !== undefined && !m.method) {
    pending.get(m.id as number)?.(m);
    pending.delete(m.id as number);
    return;
  }
  void handle(m);
});
