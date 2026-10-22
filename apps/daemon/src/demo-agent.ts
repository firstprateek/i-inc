// The scripted agent behind conversations in demo mode (I_INC_DEMO=1): a small ACP agent that runs inside the
// daemon process, over streams, with no sandbox, no network and no tokens. It answers the way a coding agent
// does so the Conversations screen has something real to show: a thought, a reply that streams in pieces, a
// read, a plan, and an edit that asks for the owner's permission unless the mode lets edits through.
import { PassThrough } from "node:stream";
import type { AgentProcess, Launch } from "./acp.ts";

type Json = Record<string, unknown>;

/**
 * The modes the demo agent offers. The host starts a conversation in the agent's bypass mode (like a real
 * agent's), which is also what the New conversation screen says it will do. Edits ask in "Ask before edits"; and
 * so that the permission card can be seen in any mode, the demo agent always asks before running its test command.
 */
const MODES = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Ask before edits", description: "Ask before every edit" },
    { id: "acceptEdits", name: "Accept edits", description: "Edit files without asking" },
    { id: "plan", name: "Plan only", description: "Read and plan; change nothing" },
    { id: "bypassPermissions", name: "Bypass permissions", description: "Never ask" },
  ],
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One demo agent process. */
export class DemoAgent {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private exitCode: number | null | undefined;
  private finish!: (code: number | null) => void;
  readonly exited = new Promise<number | null>((r) => {
    this.finish = r;
  });
  private buf = "";
  private nextId = 1000;
  private seq = 0;
  private readonly waiting = new Map<number, (m: Json) => void>();
  private readonly cancelled = new Set<string>();
  private readonly modes = new Map<string, string>();

  constructor() {
    this.stdin.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString();
      for (let i = this.buf.indexOf("\n"); i >= 0; i = this.buf.indexOf("\n")) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        let m: Json;
        try {
          m = JSON.parse(line) as Json;
        } catch {
          continue;
        }
        if (typeof m.id === "number" && !m.method) {
          this.waiting.get(m.id)?.(m);
          this.waiting.delete(m.id);
        } else void this.handle(m);
      }
    });
    this.stdin.on("end", () => this.die(0));
  }

  private out(m: Json): void {
    if (this.exitCode === undefined) this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  }

  private update(sessionId: string, u: Json): void {
    this.out({ method: "session/update", params: { sessionId, update: u } });
  }

  private ask(method: string, params: Json): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.out({ id, method, params });
    });
  }

  die(code: number | null): void {
    if (this.exitCode !== undefined) return;
    this.exitCode = code;
    this.stdout.end();
    this.finish(code);
  }

  /** Streams text the way a model does: a few words at a time. */
  private async say(sessionId: string, kind: "agent_message_chunk" | "agent_thought_chunk", text: string) {
    for (const piece of text.match(/\S+\s*/g) ?? []) {
      if (this.cancelled.has(sessionId)) return;
      this.update(sessionId, { sessionUpdate: kind, content: { type: "text", text: piece } });
      await sleep(kind === "agent_thought_chunk" ? 25 : 40);
    }
  }

  private async prompt(sessionId: string, blocks: Json[]): Promise<Json> {
    const text = blocks
      .filter((b) => b.type === "text")
      .map((b) => String(b.text))
      .join(" ");
    const said = (text.split("The owner's new message:").pop() ?? text).trim().replace(/\s+/g, " ");
    const quoted = said.length > 80 ? `${said.slice(0, 77)}...` : said;
    await this.say(
      sessionId,
      "agent_thought_chunk",
      "The owner wants a change. Let me find where it lives before touching anything.",
    );
    await this.say(sessionId, "agent_message_chunk", `Got it: "${quoted}". I'll start by reading the code. `);
    this.update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "demo-read",
      title: "Read src/format.ts",
      kind: "read",
      status: "pending",
      rawInput: { path: "src/format.ts" },
      locations: [{ path: "src/format.ts", line: 1 }],
    });
    await sleep(250);
    this.update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "demo-read",
      status: "completed",
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: 'export function money(cents: number): string {\n  return "$" + cents / 100;\n}\n',
          },
        },
      ],
    });
    this.update(sessionId, {
      sessionUpdate: "plan",
      entries: [
        { content: "Read the formatter", priority: "high", status: "completed" },
        { content: "Show two decimals and the minus sign", priority: "high", status: "in_progress" },
        { content: "Run the tests", priority: "medium", status: "pending" },
      ],
    });
    await this.say(
      sessionId,
      "agent_message_chunk",
      "`money()` drops the cents and puts the minus sign after the dollar sign. I'll fix both. ",
    );
    this.update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "demo-edit",
      title: "Edit src/format.ts",
      kind: "edit",
      status: "pending",
      rawInput: { path: "src/format.ts" },
      locations: [{ path: "src/format.ts", line: 1 }],
    });
    const diff = {
      type: "diff",
      path: "src/format.ts",
      oldText: 'export function money(cents: number): string {\n  return "$" + cents / 100;\n}\n',
      newText:
        'export function money(cents: number): string {\n  const sign = cents < 0 ? "-" : "";\n  return sign + "$" + (Math.abs(cents) / 100).toFixed(2);\n}\n',
    };
    const mode = this.modes.get(sessionId);
    let allowed = mode === "acceptEdits" || mode === "bypassPermissions";
    if (mode === "plan") {
      this.update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "demo-edit",
        status: "failed",
      });
      await this.say(sessionId, "agent_message_chunk", "I'm in plan mode, so I left the file alone.");
      return { stopReason: "end_turn" };
    }
    if (!allowed) {
      const res = await this.ask("session/request_permission", {
        sessionId,
        toolCall: {
          toolCallId: "demo-edit",
          title: "Edit src/format.ts",
          kind: "edit",
          rawInput: { path: "src/format.ts" },
          content: [diff],
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
          { optionId: "reject-once", name: "Deny", kind: "reject_once" },
        ],
      });
      const outcome = (res.result as Json | undefined)?.outcome as Json | undefined;
      if (!outcome || outcome.outcome === "cancelled" || this.cancelled.has(sessionId))
        return { stopReason: "cancelled" };
      allowed = String(outcome.optionId).startsWith("allow");
    }
    if (allowed) {
      this.update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "demo-edit",
        status: "in_progress",
      });
      await sleep(200);
      this.update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "demo-edit",
        status: "completed",
        title: "Edited src/format.ts",
        content: [diff],
      });
      await this.say(sessionId, "agent_message_chunk", "Edited. Now I'll run the tests. ");
      this.update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "demo-run",
        title: "Run pnpm test",
        kind: "execute",
        status: "pending",
        rawInput: { command: "pnpm test" },
      });
      // Demo only: asked in every mode, so there is always a permission card to see.
      const res = await this.ask("session/request_permission", {
        sessionId,
        toolCall: {
          toolCallId: "demo-run",
          title: "Run pnpm test",
          kind: "execute",
          rawInput: { command: "pnpm test" },
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
          { optionId: "reject-once", name: "Deny", kind: "reject_once" },
        ],
      });
      const outcome = (res.result as Json | undefined)?.outcome as Json | undefined;
      if (!outcome || outcome.outcome === "cancelled" || this.cancelled.has(sessionId))
        return { stopReason: "cancelled" };
      if (String(outcome.optionId).startsWith("allow")) {
        this.update(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "demo-run",
          status: "in_progress",
        });
        await sleep(300);
        this.update(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "demo-run",
          status: "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: "Test Files  3 passed\n     Tests  41 passed\n" },
            },
          ],
        });
        await this.say(
          sessionId,
          "agent_message_chunk",
          "Done. `money(-1250)` now gives `-$12.50` and the tests pass. This is the demo agent, so nothing was really changed.",
        );
      } else {
        this.update(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "demo-run",
          status: "failed",
        });
        await this.say(sessionId, "agent_message_chunk", "Understood, I did not run the tests.");
      }
    } else {
      this.update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "demo-edit",
        status: "failed",
      });
      await this.say(sessionId, "agent_message_chunk", "Understood, I left the file alone.");
    }
    this.update(sessionId, { sessionUpdate: "usage_update", used: 2400, size: 200000 });
    return { stopReason: "end_turn", _meta: { usage: { inputTokens: 2100, outputTokens: 300 } } };
  }

  private async handle(m: Json): Promise<void> {
    const id = m.id as number | undefined;
    const p = (m.params ?? {}) as Json;
    const reply = (result: Json) => this.out({ id, result });
    switch (m.method) {
      case "initialize":
        return reply({
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: true, embeddedContext: true },
          },
          authMethods: [],
        });
      case "session/new": {
        const sessionId = `demo-${++this.seq}-${Math.random().toString(36).slice(2, 6)}`;
        this.modes.set(sessionId, MODES.currentModeId);
        return reply({ sessionId, modes: MODES });
      }
      case "session/set_mode": {
        const sessionId = String(p.sessionId);
        if (!MODES.availableModes.some((x) => x.id === p.modeId))
          return this.out({ id, error: { code: -32602, message: `no mode ${String(p.modeId)}` } });
        this.modes.set(sessionId, String(p.modeId));
        reply({});
        this.update(sessionId, { sessionUpdate: "current_mode_update", currentModeId: String(p.modeId) });
        return;
      }
      case "session/prompt": {
        const sessionId = String(p.sessionId);
        this.cancelled.delete(sessionId);
        try {
          const result = await this.prompt(sessionId, (p.prompt ?? []) as Json[]);
          if (this.cancelled.delete(sessionId)) reply({ stopReason: "cancelled" });
          else reply(result);
        } catch (e) {
          this.out({ id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
        }
        return;
      }
      case "session/cancel":
        this.cancelled.add(String(p.sessionId));
        return;
      default:
        if (id !== undefined)
          this.out({ id, error: { code: -32601, message: `unknown method ${String(m.method)}` } });
    }
  }

  asProcess(): AgentProcess {
    return {
      stdin: this.stdin,
      stdout: this.stdout,
      stderr: this.stderr,
      kill: () => this.die(null),
      exited: this.exited,
    };
  }
}

/** The launch for demo mode: every conversation gets a fresh demo agent. */
export const demoLaunch: Launch = () => new DemoAgent().asProcess();
