// A scripted ACP agent, in process (streams, no child process), standing in for claude-code-acp and
// codex-acp. It speaks enough ACP to exercise every session/update kind i.inc maps. The prompt text
// picks what it does:
//   "slow ..."   streams ticks until session/cancel arrives, then ends cancelled
//   "hang ..."   starts a tool call and waits for session/cancel
//   "crash ..."  says a few words, then the process dies
//   "limit ..."  fails the prompt with Claude's session-limit message
//   "plain ..."  one reply, no tools
//   anything else: thoughts, text, a read tool, a plan, commands, an edit that asks for permission
//                  unless the mode skips that, usage, and the end.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Engine, Id } from "@i-inc/core";
import type { AgentProcess, Launch, LaunchRequest } from "../../src/acp.ts";
import type { Any } from "./support.ts";

type Json = Record<string, Any>;

const modes = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Always ask", description: "Ask before every edit" },
    { id: "acceptEdits", name: "Accept edits" },
    { id: "plan", name: "Plan only" },
    { id: "bypassPermissions", name: "Bypass permissions" },
  ],
};

export interface FakeOptions {
  loadSession?: boolean;
  image?: boolean;
  /** Codex style: modes, model and effort are config options and there are no ACP modes. */
  codex?: boolean;
  /** Answer `session/new` with the authentication-required error. */
  authRequired?: boolean;
  /** Answer `initialize` with an error. */
  initFails?: boolean;
  /** Stay silent on `initialize` (a sandbox that never comes up). */
  hang?: boolean;
  /** Carry on when stdin closes (an agent that does not take the end of its input as the end). */
  ignoreEof?: boolean;
}

export class FakeAcpAgent {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** Every message the host wrote, in order. */
  readonly received: Json[] = [];
  readonly prompts: { sessionId: string; blocks: Json[] }[] = [];
  readonly sessions = new Map<string, { mode: string; options: Json[] }>();
  exitCode: number | null | undefined;
  private exit!: (code: number | null) => void;
  readonly exited = new Promise<number | null>((r) => {
    this.exit = r;
  });
  private buf = "";
  private nextId = 1000;
  private readonly waiting = new Map<number, (m: Json) => void>();
  private readonly cancelled = new Set<string>();
  /** Answers the agent got to its permission requests. */
  readonly permissionAnswers: Json[] = [];
  private seq = 0;
  gateOpen = false;

  constructor(readonly opts: FakeOptions = {}) {
    this.stdin.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString();
      for (let i = this.buf.indexOf("\n"); i >= 0; i = this.buf.indexOf("\n")) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        const m = JSON.parse(line) as Json;
        this.received.push(m);
        if (m.id !== undefined && !m.method) {
          this.waiting.get(m.id)?.(m);
          this.waiting.delete(m.id);
        } else void this.handle(m);
      }
    });
    this.stdin.on("end", () => {
      if (!this.opts.ignoreEof) this.die(0);
    });
  }

  private out(m: Json): void {
    if (this.exitCode === undefined) this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  }
  private update(sessionId: string, u: Json, _meta?: Json): void {
    this.out({
      method: "session/update",
      params: { sessionId, update: { ...u, ...(_meta ? { _meta } : {}) } },
    });
  }
  private ask(method: string, params: Json): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.out({ id, method, params });
    });
  }
  private sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** The process ends (killed, crashed, or its stdin closed). */
  die(code: number | null): void {
    if (this.exitCode !== undefined) return;
    this.exitCode = code ?? null;
    this.stdout.end();
    this.exit(code);
  }
  kill(): void {
    this.die(null);
  }

  get mode(): string | undefined {
    return [...this.sessions.values()][0]?.mode;
  }
  get cancels(): number {
    return this.received.filter((m) => m.method === "session/cancel").length;
  }
  requests(method: string): Json[] {
    return this.received.filter((m) => m.method === method);
  }

  private options(): Json[] {
    return [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "other",
        options: [
          { value: "default", name: "gpt-5-codex" },
          { value: "other", name: "other" },
        ],
      },
      {
        id: "reasoning_effort",
        name: "Reasoning effort",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [
          { value: "low", name: "low" },
          { value: "medium", name: "medium" },
          { value: "high", name: "high" },
        ],
      },
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "read-only",
        options: [
          { value: "read-only", name: "Read-only" },
          { value: "auto", name: "Auto" },
          { value: "full-access", name: "Full access" },
        ],
      },
    ];
  }

  private async prompt(sessionId: string, blocks: Json[]): Promise<Json> {
    this.prompts.push({ sessionId, blocks });
    const s = this.sessions.get(sessionId);
    const text = blocks
      .filter((b) => b.type === "text")
      .map((b) => String(b.text))
      .join(" ");
    // "@@read <path>" anywhere in a prompt makes the agent open that file first (a tool call that
    // names it in its locations), then carry on as usual: how the brain's reads are seen.
    // "@@readb64 <base64 of the path>" does the same without the path showing in the text.
    const reads = [
      ...[...text.matchAll(/@@read (\S+)/g)].map((m) => m[1] as string),
      ...[...text.matchAll(/@@readb64 (\S+)/g)].map((m) => Buffer.from(m[1] as string, "base64").toString()),
    ];
    for (const [n, path] of reads.entries()) {
      const toolCallId = `tc-readfile-${n}`;
      this.update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId,
        title: `Read ${path}`,
        kind: "read",
        status: "pending",
        rawInput: { path },
        locations: [{ path }],
      });
      this.update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed" });
    }
    const said = text.split("The owner's new message:").pop()?.trim() ?? text;
    const images = blocks.filter((b) => b.type === "image").length;
    if (said.startsWith("slow")) {
      for (let i = 0; i < 400 && !this.cancelled.has(sessionId); i++) {
        this.update(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `tick${i} ` },
        });
        await this.sleep(10);
      }
      return { stopReason: this.cancelled.delete(sessionId) ? "cancelled" : "end_turn" };
    }
    if (said.startsWith("hang")) {
      this.update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-hang",
        title: "Run sleep 999",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "sleep 999" },
      });
      while (!this.cancelled.has(sessionId) && this.exitCode === undefined) await this.sleep(5);
      this.cancelled.delete(sessionId);
      return { stopReason: "cancelled" };
    }
    if (said.startsWith("lateinput")) {
      this.update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-li",
        title: "Run command",
        kind: "execute",
        status: "pending",
      });
      this.update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-li",
        status: "in_progress",
      });
      this.update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-li",
        rawInput: { command: "ls -la" },
      });
      this.update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "tc-li", status: "completed" });
      return { stopReason: "end_turn" };
    }
    if (said.startsWith("dup")) {
      // the same permission id asked twice at once
      this.update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-dup",
        title: "Edit x",
        kind: "edit",
        status: "pending",
      });
      const req = (n: number) =>
        this.ask("session/request_permission", {
          sessionId,
          toolCall: { toolCallId: "tc-dup", title: `Edit x (${n})`, kind: "edit" },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Deny", kind: "reject_once" },
          ],
        }).then((r) => this.permissionAnswers.push({ n, ...(r.result?.outcome as Json) }));
      await Promise.all([req(1), this.sleep(10).then(() => req(2))]);
      return { stopReason: "end_turn" };
    }
    if (said.startsWith("retitle")) {
      this.update(sessionId, { sessionUpdate: "session_info_update", title: "Agent's own title" });
      this.update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
      return { stopReason: "end_turn" };
    }
    if (said.startsWith("secretdiff")) {
      this.update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-sd",
        title: "Edit .env",
        kind: "edit",
        status: "in_progress",
      });
      this.update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-sd",
        status: "completed",
        content: [
          {
            type: "diff",
            path: "/repo/.env",
            oldText: "TOKEN=\n",
            newText:
              "TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\nNAME=keep_this_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6\n" +
              "PGP=-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: GnuPG v2\n\nlQOYBGJhbXcBCADd8jM4pgpbodyline\n-----END PGP PRIVATE KEY BLOCK-----\n" +
              "URL=https://deploy.example.com/hook?pwd=hunter2queryvalue&x=1\n" +
              "GIT=https://deploy:p@sswordwithat@example.com/repo.git\n" +
              "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n",
          },
        ],
      });
      return { stopReason: "end_turn" };
    }
    if (said.startsWith("gate")) {
      // works until the test lets it finish, then ends normally
      while (!this.gateOpen && this.exitCode === undefined) await this.sleep(3);
      this.update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "gate done" },
      });
      return { stopReason: "end_turn" };
    }
    if (said.startsWith("stubborn")) {
      // ignores session/cancel for good
      while (this.exitCode === undefined) await this.sleep(5);
      return {};
    }
    if (said.startsWith("crash")) {
      this.update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "About to " },
      });
      await this.sleep(5);
      this.die(1);
      return {};
    }
    if (said.startsWith("limit")) {
      throw Object.assign(new Error("You've hit your session limit · resets 3:30am (UTC)"), { rpc: -32603 });
    }
    if (said.startsWith("plain")) {
      this.update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `You said: ${said}${images ? ` (+${images} image)` : ""}` },
      });
      return { stopReason: "end_turn" };
    }
    this.update(sessionId, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Thinking about it. " },
    });
    this.update(sessionId, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Let me look at the file." },
    });
    this.update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `Hello! You said: ${said}${images ? ` (+${images} image)` : ""}. ` },
    });
    this.update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "I'll read then edit. " },
    });
    this.update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "tc-read",
      title: "Read src/app.ts",
      kind: "read",
      status: "pending",
      rawInput: { path: "src/app.ts" },
      locations: [{ path: "src/app.ts", line: 1 }],
    });
    this.update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-read",
      status: "in_progress",
    });
    this.update(
      sessionId,
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-read",
        status: "completed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "export const answer = 41;\ntoken ghp_abcdefghijklmnopqrstuvwxyz0123456789\n",
            },
          },
        ],
      },
      {
        "_claude/rateLimit": {
          status: "allowed",
          unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 1_900_000_000 } },
        },
      },
    );
    this.update(sessionId, {
      sessionUpdate: "plan",
      entries: [
        { content: "Read the file", priority: "high", status: "completed" },
        { content: "Fix the constant", priority: "high", status: "in_progress" },
      ],
    });
    this.update(sessionId, {
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "compact", description: "Compact the conversation", input: { hint: "focus" } },
      ],
    });
    this.update(sessionId, { sessionUpdate: "some_future_update", whatever: 1 });
    this.update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "tc-edit",
      title: "Edit src/app.ts",
      kind: "edit",
      status: "pending",
      rawInput: { path: "src/app.ts" },
      locations: [{ path: "src/app.ts", line: 1 }],
    });
    const mode = s?.mode;
    let allowed =
      mode === "bypassPermissions" || mode === "acceptEdits" || mode === "full-access" || mode === "auto";
    if (!allowed) {
      const res = await this.ask("session/request_permission", {
        sessionId,
        toolCall: {
          toolCallId: "tc-edit",
          title: "Edit src/app.ts",
          kind: "edit",
          rawInput: { path: "src/app.ts" },
          content: [
            {
              type: "diff",
              path: "src/app.ts",
              oldText: "export const answer = 41;\n",
              newText: "export const answer = 42;\n",
            },
          ],
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
          { optionId: "reject-once", name: "Deny", kind: "reject_once" },
          { optionId: "reject-always", name: "Always deny", kind: "reject_always" },
        ],
      });
      const outcome = res.result?.outcome as Json | undefined;
      this.permissionAnswers.push(outcome ?? {});
      if (!outcome || outcome.outcome === "cancelled") return { stopReason: "cancelled" };
      allowed = String(outcome.optionId).startsWith("allow");
    }
    if (allowed) {
      this.update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-edit",
        status: "in_progress",
      });
      this.update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-edit",
        status: "completed",
        title: "Edited src/app.ts",
        content: [
          {
            type: "diff",
            path: "src/app.ts",
            oldText: "export const answer = 41;\n",
            newText: "export const answer = 42;\n",
          },
        ],
      });
      this.update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Done: answer is now 42." },
      });
    } else {
      this.update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "tc-edit", status: "failed" });
      this.update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Understood, I left the file alone." },
      });
    }
    this.update(sessionId, { sessionUpdate: "usage_update", used: 1234, size: 200000 });
    return { stopReason: "end_turn", _meta: { usage: { inputTokens: 1200, outputTokens: 34 } } };
  }

  private async handle(m: Json): Promise<void> {
    const id = m.id as number | undefined;
    const p = (m.params ?? {}) as Json;
    const reply = (result: Json) => this.out({ id, result });
    switch (m.method) {
      case "initialize":
        if (this.opts.hang) return;
        if (this.opts.initFails)
          return this.out({ id, error: { code: -32603, message: "the adapter crashed on start" } });
        return reply({
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: this.opts.loadSession ?? false,
            promptCapabilities: { image: this.opts.image ?? true, embeddedContext: true },
          },
          authMethods: [],
        });
      case "session/new": {
        if (this.opts.authRequired)
          return this.out({ id, error: { code: -32000, message: "Authentication required" } });
        const sessionId = `acp-${++this.seq}-${Math.random().toString(36).slice(2, 6)}`;
        const options = this.opts.codex ? this.options() : [];
        this.sessions.set(sessionId, { mode: this.opts.codex ? "read-only" : "default", options });
        return reply({
          sessionId,
          ...(this.opts.codex ? { configOptions: options } : { modes }),
        });
      }
      case "session/load": {
        const sessionId = String(p.sessionId);
        if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, { mode: "default", options: [] });
        // Adapters replay the history before answering: the host must not show it twice.
        this.update(sessionId, {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "an old question" },
        });
        this.update(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "an old answer" },
        });
        // an old report of a limit hit last week: history, not news
        this.update(
          sessionId,
          { sessionUpdate: "usage_update", used: 1, size: 2 },
          { "_claude/rateLimit": { status: "rejected", resetsAt: 1_700_000_000 } },
        );
        return reply({ modes: { ...modes, currentModeId: this.sessions.get(sessionId)?.mode ?? "default" } });
      }
      case "session/set_mode": {
        const s = this.sessions.get(String(p.sessionId));
        if (!s || !modes.availableModes.some((x) => x.id === p.modeId)) {
          return this.out({ id, error: { code: -32602, message: `no mode ${String(p.modeId)}` } });
        }
        s.mode = String(p.modeId);
        reply({});
        this.update(String(p.sessionId), { sessionUpdate: "current_mode_update", currentModeId: s.mode });
        return;
      }
      case "session/set_config_option": {
        const s = this.sessions.get(String(p.sessionId));
        const opt = s?.options.find((o) => o.id === p.configId);
        if (!s || !opt)
          return this.out({ id, error: { code: -32602, message: `no option ${String(p.configId)}` } });
        opt.currentValue = p.value;
        if (opt.id === "mode") s.mode = String(p.value);
        reply({ configOptions: s.options });
        return;
      }
      case "session/prompt": {
        try {
          const result = await this.prompt(String(p.sessionId), (p.prompt ?? []) as Json[]);
          if (this.exitCode === undefined) reply(result);
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
      kill: () => this.kill(),
      exited: this.exited,
    };
  }
}

/** A sandbox that starts a fake agent for every launch, and remembers them. */
export class FakeSandbox {
  readonly agents: FakeAcpAgent[] = [];
  readonly launches: LaunchRequest[] = [];
  options: FakeOptions = {};
  /** Throw from the launch itself (the walls are down). */
  failLaunch: Error | undefined;

  readonly launch: Launch = (r) => {
    if (this.failLaunch) throw this.failLaunch;
    this.launches.push(r);
    const a = new FakeAcpAgent(this.options);
    this.agents.push(a);
    return a.asProcess();
  };

  get live(): FakeAcpAgent[] {
    return this.agents.filter((a) => a.exitCode === undefined);
  }
  get last(): FakeAcpAgent {
    const a = this.agents.at(-1);
    if (!a) throw new Error("no agent was launched");
    return a;
  }

  /** The `container` CLI's spawn, for `machineLaunch`: it starts a fake agent and records the command. */
  spawn(seen: { bin: string; args: string[]; env: NodeJS.ProcessEnv }[] = []) {
    return (bin: string, args: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams => {
      seen.push({ bin, args, env });
      const a = new FakeAcpAgent(this.options);
      this.agents.push(a);
      const child = Object.assign(new EventEmitter(), {
        stdin: a.stdin,
        stdout: a.stdout,
        stderr: a.stderr,
        kill: () => {
          a.kill();
          return true;
        },
      });
      void a.exited.then((code) => child.emit("exit", code));
      return child as unknown as ChildProcessWithoutNullStreams;
    };
  }
}

export const claude: Engine = {
  id: "opus",
  harness: "claude-code",
  model: "Claude Opus",
  accountId: "claude-pro",
  local: false,
};
export const codex: Engine = {
  id: "codex",
  harness: "codex",
  model: "gpt-5-codex",
  accountId: "openai-chatgpt",
  local: false,
};
export type EngineId = Id;
export type { Any };
