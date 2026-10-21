// The ACP client against a scripted ACP server, speaking the messages M1 recorded (docs/m1-findings.md,
// step 5), and the Apple container provider against a recorded command line.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Engine, Id, SessionRequest } from "@i-inc/core";
import { describe, expect, it } from "vitest";
import {
  AcpAgent,
  type AgentProcess,
  extractRateLimit,
  type LaunchRequest,
  resetFromText,
  type UsageReport,
} from "../src/acp.ts";
import { machineScript } from "../src/harness.ts";
import { AppleMachines, defaultMachineSettings, machineLaunch, workDir } from "../src/machines.ts";
import type { AccountRateLimit } from "../src/registry.ts";

// The defaults, without the walls' marker, which exists only on the mini (a test below covers it).
const { wallsMarker: _, ...noWalls } = defaultMachineSettings;

type Json = Record<string, unknown>;
type Script = (method: string, params: Json, reply: (m: Json) => void, id: number | undefined) => void;

const claude: Engine = {
  id: "opus",
  harness: "claude-code",
  model: "Claude Opus",
  accountId: "claude-pro",
  local: false,
};

const codex: Engine = {
  id: "codex-engine",
  harness: "codex",
  model: "gpt-5-codex",
  accountId: "openai-chatgpt",
  local: false,
};

/** A fake ACP server: `script` answers each request; `sent` records what the client wrote. */
function server(script: Script) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const sent: Json[] = [];
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
      sent.push(m);
      const id = m.id as number | undefined;
      const reply = (r: Json) => stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...r })}\n`);
      script(String(m.method ?? ""), (m.params ?? {}) as Json, reply, "method" in m ? id : undefined);
    }
  });
  const launches: LaunchRequest[] = [];
  const proc: AgentProcess = { stdin, stdout, stderr, kill: () => exit(null), exited };
  return { proc, sent, launches, exit: (code: number) => exit(code) };
}

const update = (sessionUpdate: string, rest: Json = {}) => ({
  method: "session/update",
  params: { sessionId: "s1", update: { sessionUpdate, ...rest } },
});

/** The happy path M1 saw from Claude's adapter, with `onPrompt` deciding how the prompt ends. */
function claudeLike(onPrompt: (reply: (m: Json) => void, id: number) => void): Script {
  return (method, params, reply, id) => {
    if (method === "initialize")
      reply({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    if (method === "session/new") {
      expect(params.cwd).toBe("/home/employee/work/inc-42");
      reply({
        id,
        result: {
          sessionId: "s1",
          modes: {
            currentModeId: "default",
            availableModes: ["default", "acceptEdits", "plan", "bypassPermissions"].map((m) => ({ id: m })),
          },
        },
      });
    }
    if (method === "session/set_mode") reply({ id, result: {} });
    if (method === "session/prompt" && id !== undefined) onPrompt(reply, id);
  };
}

function request(over: Partial<SessionRequest> = {}): SessionRequest {
  return {
    ticket: {
      id: "42",
      title: "Refunds",
      project: "Duet",
      type: "fix",
      effort: "medium",
      doneWhen: [],
      assignee: "ada",
    },
    stage: "build",
    duty: "build",
    employee: {
      id: "ada",
      name: "Ada",
      role: "Senior Engineer",
      duties: ["build"],
      engines: { default: "opus", fallbacks: [] },
      switchRules: { outOfTokens: { action: "wait" }, onStuck: "fail", checksFailedBeforeSwitch: 3 },
    } as unknown as SessionRequest["employee"],
    engine: claude,
    brief: "Ticket #42: do the thing",
    ...over,
  };
}

function agent(
  s: ReturnType<typeof server>,
  usage: UsageReport[] = [],
  rateLimits: { accountId: string; limit: AccountRateLimit }[] = [],
) {
  return new AcpAgent({
    launch: (r) => {
      s.launches.push(r);
      return s.proc;
    },
    credentials: (e) => (e.harness === "claude-code" ? { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" } : {}),
    cwdFor: (id) => `/home/employee/work/inc-${id}`,
    onUsage: (u) => usage.push(u),
    onRateLimit: (accountId, limit) => rateLimits.push({ accountId, limit }),
    now: () => 1_000,
    cancelGraceMs: 50,
  });
}

describe("an ACP session", () => {
  it("opens a session in the worktree, switches to bypass, approves permissions, and returns the reply", async () => {
    const s = server(
      claudeLike((reply, id) => {
        reply(update("agent_message_chunk", { content: { type: "text", text: "Fixed " } }));
        reply({
          id: 900,
          method: "session/request_permission",
          params: {
            options: [
              { kind: "allow_once", optionId: "once" },
              { kind: "allow_always", optionId: "always" },
            ],
          },
        });
        reply({ id: 901, method: "fs/read_text_file", params: { path: "/etc/hosts" } });
        reply(update("agent_message_chunk", { content: { type: "text", text: "the sign." } }));
        setTimeout(() => reply({ id, result: { stopReason: "end_turn" } }), 5);
      }),
    );
    const out = await agent(s).run(request());
    expect(out).toEqual({ kind: "done", output: "Fixed the sign." });
    expect(s.launches[0]?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" });
    expect(s.sent.find((m) => m.method === "session/set_mode")?.params).toEqual({
      sessionId: "s1",
      modeId: "bypassPermissions",
    });
    // Lenient inside the machine, walled outside it.
    expect(s.sent.find((m) => m.id === 900)).toMatchObject({
      result: { outcome: { outcome: "selected", optionId: "always" } },
    });
    expect(s.sent.find((m) => m.id === 901)).toMatchObject({ error: { code: -32601 } });
    const init = s.sent.find((m) => m.method === "initialize")?.params as Json;
    expect(init.clientCapabilities).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    });
  });

  it("returns only the final answer, not the narration before the last tool call", async () => {
    const s = server(
      claudeLike((reply, id) => {
        reply(update("agent_message_chunk", { content: { type: "text", text: "Now I'm writing it." } }));
        reply(update("tool_call", { toolCallId: "t1", title: "Edit README.md", status: "pending" }));
        reply(update("agent_message_chunk", { content: { type: "text", text: "The report." } }));
        setTimeout(() => reply({ id, result: { stopReason: "end_turn" } }), 5);
      }),
    );
    expect(await agent(s).run(request())).toEqual({ kind: "done", output: "The report." });
  });

  it("keeps the answer when a tool call follows it, and calls an empty answer stuck", async () => {
    const trailing = server(
      claudeLike((reply, id) => {
        reply(update("agent_message_chunk", { content: { type: "text", text: "The report." } }));
        reply(update("tool_call", { toolCallId: "t2", title: "TodoWrite", status: "pending" }));
        setTimeout(() => reply({ id, result: { stopReason: "end_turn" } }), 5);
      }),
    );
    expect(await agent(trailing).run(request())).toEqual({ kind: "done", output: "The report." });
    const silent = server(
      claudeLike((reply, id) => setTimeout(() => reply({ id, result: { stopReason: "end_turn" } }), 5)),
    );
    expect(await agent(silent).run(request())).toMatchObject({ kind: "stuck" });
  });

  it("retries a transient error a few times, then calls it stuck; a full disk isn't a quota", async () => {
    const failing = (text: string) =>
      claudeLike((reply, id) => setTimeout(() => reply({ id, error: { code: -32603, message: text } }), 5));
    const transient = "Failed to refresh OAuth token. This is usually transient; retry in a minute";
    // One agent, a fresh server for each try, as the daemon launches one per session.
    const a = new AcpAgent({
      launch: () => server(failing(transient)).proc,
      credentials: () => ({}),
      cwdFor: (id) => `/home/employee/work/inc-${id}`,
      now: () => 1_000,
    });
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) outcomes.push((await a.run(request())).kind);
    expect(outcomes).toEqual(["out-of-tokens", "out-of-tokens", "out-of-tokens", "stuck"]);
    expect((await agent(server(failing("ENOSPC: Disk quota exceeded"))).run(request())).kind).toBe("stuck");
  });

  it("forgets a ticket's retry count when the retrying stops, even by an urgent message", async () => {
    const transient = "Failed to refresh OAuth token. This is usually transient; retry in a minute";
    let pendingPrompt: number | undefined;
    let mode: "fail" | "hang" = "fail";
    const a = new AcpAgent({
      launch: () =>
        server((method, params, reply, id) => {
          if (mode === "fail") {
            claudeLike((rep, i) =>
              setTimeout(() => rep({ id: i, error: { code: -32603, message: transient } }), 5),
            )(method, params, reply, id);
            return;
          }
          claudeLike(() => {})(method, params, reply, id);
          if (method === "session/prompt") pendingPrompt = id;
          if (method === "session/cancel") reply({ id: pendingPrompt, result: { stopReason: "cancelled" } });
        }).proc,
      credentials: () => ({}),
      cwdFor: (id) => `/home/employee/work/inc-${id}`,
      now: () => 1_000,
      cancelGraceMs: 50,
    });
    expect((await a.run(request())).kind).toBe("out-of-tokens");
    // While it is retrying, the count is kept, so the retries are bounded.
    expect(a.footprint()).toEqual({ transient: 1 });

    // The next session ends another way: the count must not outlive the retrying.
    mode = "hang";
    const controller = new AbortController();
    const run = a.run(request({ signal: controller.signal }));
    while (pendingPrompt === undefined) await new Promise((r) => setTimeout(r, 1));
    controller.abort("the owner sent an urgent message");
    expect((await run).kind).toBe("interrupted");
    expect(a.footprint()).toEqual({ transient: 0 });
  });

  it("reads Claude's rate limits, and pauses until the reset when the account is out", async () => {
    const usage: UsageReport[] = [];
    const rateLimits: { accountId: string; limit: AccountRateLimit }[] = [];
    const s = server(
      claudeLike((reply, id) => {
        reply(
          update("usage_update", {
            used: 10,
            size: 100,
            _meta: {
              "_claude/rateLimit": {
                status: "rejected",
                rateLimitType: "five_hour",
                resetsAt: 1_790_600_000,
                unifiedWindows: {
                  five_hour: { utilization: 1, resetsAt: 1_790_600_000 },
                  seven_day: { utilization: 0.46, resetsAt: 1_791_000_000 },
                },
              },
            },
          }),
        );
        reply({ id, error: { code: -32603, message: "Claude AI usage limit reached" } });
      }),
    );
    expect(await agent(s, usage, rateLimits).run(request())).toEqual({
      kind: "out-of-tokens",
      resetsAt: 1_790_600_000_000,
    });
    expect(usage[0]).toEqual({
      accountId: "claude-pro",
      status: "rejected",
      resetsAt: 1_790_600_000_000,
      windows: [
        { name: "five_hour", utilization: 1, resetsAt: 1_790_600_000_000 },
        { name: "seven_day", utilization: 0.46, resetsAt: 1_791_000_000_000 },
      ],
    });
    expect(rateLimits).toEqual([
      {
        accountId: "claude-pro",
        limit: {
          status: "rejected",
          resetsAt: 1_790_600_000_000,
          fiveHourUtilization: 1,
          sevenDayUtilization: 0.46,
          updatedAt: 1_000,
        },
      },
    ]);
  });

  it("sets the configured Codex model, requested effort, and full-access mode before prompting", async () => {
    const activeOptions = [
      {
        id: "model",
        category: "model",
        type: "select",
        currentValue: codex.model,
        options: [{ value: codex.model, name: "GPT-5 Codex" }],
      },
      {
        id: "reasoning_effort",
        category: "thought_level",
        type: "select",
        currentValue: "low",
        options: ["low", "medium", "high"].map((value) => ({ value, name: value })),
      },
      {
        id: "mode",
        category: "mode",
        type: "select",
        currentValue: "workspace-write",
        options: [
          { value: "read-only", name: "Read only" },
          { value: "workspace-write", name: "Workspace write" },
          { value: "agent-full-access", name: "Full access" },
        ],
      },
    ];
    const s = server((method, _params, reply, id) => {
      if (method === "initialize") reply({ id, result: { protocolVersion: 1, agentCapabilities: {} } });
      if (method === "session/new") {
        reply({
          id,
          result: {
            sessionId: "s1",
            configOptions: activeOptions.map((option) => ({ ...option, currentValue: "other" })),
          },
        });
      }
      if (method === "session/set_config_option") {
        const configId = String((_params as Json).configId);
        const value = String((_params as Json).value);
        if (configId === "model") reply({ id, result: { configOptions: activeOptions } });
        else
          reply({
            id,
            result: { configOptions: activeOptions.map((option) => ({ ...option, currentValue: value })) },
          });
      }
      if (method === "session/prompt") {
        reply(update("agent_message_chunk", { content: { type: "text", text: "Codex report." } }));
        reply(update("tool_call", { toolCallId: "edit-1", title: "Edit report.md", status: "pending" }));
        reply(update("tool_call_update", { toolCallId: "edit-1", status: "completed" }));
        setTimeout(() => reply({ id, result: { stopReason: "end_turn" } }), 5);
      }
    });
    const transcript: NonNullable<SessionRequest["onTranscriptItem"]> extends (item: infer T) => void
      ? T[]
      : never[] = [];
    const result = await agent(s).run(
      request({ engine: codex, onTranscriptItem: (item) => transcript.push(item) }),
    );

    expect(result).toEqual({ kind: "done", output: "Codex report." });
    expect(
      s.sent
        .filter((message) => message.method === "session/set_config_option")
        .map((message) => message.params),
    ).toEqual([
      { sessionId: "s1", configId: "model", value: codex.model },
      { sessionId: "s1", configId: "reasoning_effort", value: "medium" },
      { sessionId: "s1", configId: "mode", value: "agent-full-access" },
    ]);
    expect(s.sent.find((message) => message.method === "session/prompt")).toBeDefined();
    expect(transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "text", text: "Codex report." }),
        expect.objectContaining({ kind: "tool", id: "edit-1", status: "pending" }),
        expect.objectContaining({ kind: "tool", id: "edit-1", status: "completed" }),
      ]),
    );
  });

  it("fails clearly when Codex doesn't advertise the configured model or effort", async () => {
    const options = [
      {
        id: "model",
        category: "model",
        type: "select",
        currentValue: "default",
        options: [{ value: "other", name: "Other" }],
      },
      {
        id: "reasoning_effort",
        category: "thought_level",
        type: "select",
        currentValue: "low",
        options: [{ value: "low", name: "Low" }],
      },
      {
        id: "mode",
        category: "mode",
        type: "select",
        currentValue: "workspace-write",
        options: [{ value: "agent-full-access", name: "Full access" }],
      },
    ];
    const s = server((method, _params, reply, id) => {
      if (method === "initialize") reply({ id, result: { protocolVersion: 1 } });
      if (method === "session/new") reply({ id, result: { sessionId: "s1", configOptions: options } });
    });
    expect(await agent(s).run(request({ engine: codex }))).toEqual({
      kind: "stuck",
      reason: "Codex ACP doesn't offer the configured model gpt-5-codex",
      startup: true,
    });
    expect(s.sent.some((message) => message.method === "session/prompt")).toBe(false);

    const effortServer = server((method, params, reply, id) => {
      if (method === "initialize") reply({ id, result: { protocolVersion: 1 } });
      if (method === "session/new")
        reply({
          id,
          result: {
            sessionId: "s1",
            configOptions: [
              {
                id: "model",
                category: "model",
                type: "select",
                currentValue: "other",
                options: [{ value: codex.model, name: codex.model }],
              },
              {
                id: "reasoning_effort",
                category: "thought_level",
                type: "select",
                currentValue: "low",
                options: [{ value: "low", name: "Low" }],
              },
              {
                id: "mode",
                category: "mode",
                type: "select",
                currentValue: "agent-full-access",
                options: [{ value: "agent-full-access", name: "Full access" }],
              },
            ],
          },
        });
      if (method === "session/set_config_option" && params.configId === "model")
        reply({
          id,
          result: {
            configOptions: [
              {
                id: "model",
                category: "model",
                type: "select",
                currentValue: codex.model,
                options: [{ value: codex.model, name: codex.model }],
              },
              {
                id: "reasoning_effort",
                category: "thought_level",
                type: "select",
                currentValue: "low",
                options: [{ value: "low", name: "Low" }],
              },
              {
                id: "mode",
                category: "mode",
                type: "select",
                currentValue: "agent-full-access",
                options: [{ value: "agent-full-access", name: "Full access" }],
              },
            ],
          },
        });
    });
    expect(await agent(effortServer).run(request({ engine: codex }))).toEqual({
      kind: "stuck",
      reason: "Codex ACP doesn't offer the configured medium reasoning effort",
      startup: true,
    });
    expect(effortServer.sent.some((message) => message.method === "session/prompt")).toBe(false);
  });

  it("fails closed when Codex rejects a required ACP config selection", async () => {
    const s = server((method, _params, reply, id) => {
      if (method === "initialize") reply({ id, result: { protocolVersion: 1 } });
      if (method === "session/new")
        reply({
          id,
          result: {
            sessionId: "s1",
            configOptions: [
              {
                id: "model",
                category: "model",
                type: "select",
                currentValue: "other",
                options: [{ value: codex.model, name: codex.model }],
              },
              {
                id: "reasoning_effort",
                category: "thought_level",
                type: "select",
                currentValue: "medium",
                options: [{ value: "medium", name: "Medium" }],
              },
              {
                id: "mode",
                category: "mode",
                type: "select",
                currentValue: "agent-full-access",
                options: [{ value: "agent-full-access", name: "Full access" }],
              },
            ],
          },
        });
      if (method === "session/set_config_option")
        reply({ id, error: { code: -32602, message: "model selection rejected" } });
    });
    expect(await agent(s).run(request({ engine: codex }))).toEqual({
      kind: "stuck",
      reason: "Codex ACP couldn't select model gpt-5-codex: model selection rejected",
      startup: true,
    });
    expect(s.sent.some((message) => message.method === "session/prompt")).toBe(false);
  });

  it("redacts tokens and control characters from upstream config errors and caps them at 200 characters", async () => {
    const noisy = `bad\u0007 token ghp_abc123SECRET and Bearer eyJhbGci.tail and sk-live-xyz\nsecond line ${"z".repeat(400)}`;
    const s = server((method, _params, reply, id) => {
      if (method === "initialize") reply({ id, result: { protocolVersion: 1 } });
      if (method === "session/new")
        reply({
          id,
          result: {
            sessionId: "s1",
            configOptions: [
              {
                id: "model",
                category: "model",
                type: "select",
                currentValue: "other",
                options: [{ value: codex.model, name: codex.model }],
              },
            ],
          },
        });
      if (method === "session/set_config_option") reply({ id, error: { code: -32602, message: noisy } });
    });
    const out = await agent(s).run(request({ engine: codex }));
    expect(out.kind).toBe("stuck");
    const reason = out.kind === "stuck" ? out.reason : "";
    expect(reason).toContain(
      "Codex ACP couldn't select model gpt-5-codex: bad token [redacted] and [redacted] and [redacted] second line z",
    );
    expect(reason).not.toMatch(/ghp_|eyJhbGci|sk-live/);
    expect(reason).not.toContain("\u0007");
    expect(reason).not.toContain("\n");
    // the upstream part alone is at most 200 characters
    expect(reason.length).toBeLessThanOrEqual("Codex ACP couldn't select model gpt-5-codex: ".length + 200);
  });

  it("reports Codex sign-in failure as actionable and maps usage-limit errors to fallback outcomes", async () => {
    const auth = server((method, _params, reply, id) => {
      if (method === "initialize")
        reply({ id, result: { protocolVersion: 1, authMethods: [{ id: "chatgpt" }] } });
      if (method === "session/new")
        reply({ id, error: { code: -32000, message: "Authentication required" } });
    });
    expect(await agent(auth).run(request({ engine: codex }))).toEqual({
      kind: "stuck",
      reason: "codex needs a sign-in in Ada's machine",
      startup: true,
    });

    const limited = server((method, _params, reply, id) => {
      if (method === "initialize") reply({ id, result: { protocolVersion: 1 } });
      if (method === "session/new")
        reply({
          id,
          result: {
            sessionId: "s1",
            configOptions: [
              {
                id: "model",
                category: "model",
                type: "select",
                currentValue: codex.model,
                options: [{ value: codex.model, name: codex.model }],
              },
              {
                id: "reasoning_effort",
                category: "thought_level",
                type: "select",
                currentValue: "medium",
                options: [{ value: "medium", name: "Medium" }],
              },
              {
                id: "mode",
                category: "mode",
                type: "select",
                currentValue: "agent-full-access",
                options: [{ value: "agent-full-access", name: "Full access" }],
              },
            ],
          },
        });
      if (method === "session/prompt")
        reply({
          id,
          error: { code: -32603, message: "usageLimitExceeded: subscription usage limit reached" },
        });
    });
    const rateLimits: { accountId: string; limit: AccountRateLimit }[] = [];
    const out = await agent(limited, [], rateLimits).run(request({ engine: codex }));
    expect(out).toMatchObject({ kind: "out-of-tokens", resetsAt: 3_601_000 });
    expect(rateLimits).toEqual([
      { accountId: codex.accountId, limit: { status: "rejected", resetsAt: 3_601_000, updatedAt: 1_000 } },
    ]);
  });

  it("treats a limit error with no reset time (Antigravity) as out of tokens for an hour and emits onRateLimit", async () => {
    const s = server(
      claudeLike((reply, id) => reply({ id, error: { code: -32603, message: "429 RESOURCE_EXHAUSTED" } })),
    );
    const rateLimits: { accountId: Id; limit: AccountRateLimit }[] = [];
    expect(await agent(s, undefined, rateLimits).run(request())).toEqual({
      kind: "out-of-tokens",
      resetsAt: 1_000 + 3_600_000,
    });
    expect(rateLimits).toEqual([
      {
        accountId: "claude-pro",
        limit: {
          status: "rejected",
          resetsAt: 1_000 + 3_600_000,
          updatedAt: 1_000,
        },
      },
    ]);
  });

  it("cancels the session for an urgent message", async () => {
    const s = server((method, _params, reply, id) => {
      claudeLike(() => {})(method, _params, reply, id);
      if (method === "session/prompt") pendingPrompt = id;
      if (method === "session/cancel") reply({ id: pendingPrompt, result: { stopReason: "cancelled" } });
    });
    let pendingPrompt: number | undefined;
    const controller = new AbortController();
    const run = agent(s).run(request({ signal: controller.signal }));
    while (pendingPrompt === undefined) await new Promise((r) => setTimeout(r, 1));
    controller.abort("the owner sent an urgent message");
    expect(await run).toEqual({ kind: "interrupted", reason: "the owner sent an urgent message" });
  });

  it("says a sign-in is needed rather than waiting for one", async () => {
    const s = server((method, _p, reply, id) => {
      if (method === "initialize")
        reply({ id, result: { protocolVersion: 1, authMethods: [{ id: "oauth-personal" }] } });
      if (method === "session/new")
        reply({ id, error: { code: -32000, message: "Authentication required" } });
    });
    const out = await agent(s).run(request({ engine: { ...claude, harness: "antigravity" } }));
    expect(out).toEqual({
      kind: "stuck",
      reason: "antigravity needs a sign-in in Ada's machine",
      startup: true,
    });
  });

  it("is stuck, not hung, when the agent dies mid-session", async () => {
    const s = server(claudeLike(() => setTimeout(() => s.exit(1), 5)));
    expect(await agent(s).run(request())).toEqual({
      kind: "stuck",
      reason: "the agent exited (1) mid-session",
    });
  });
});

describe("a ticket's agent and the daemon's end", () => {
  it("looks for an agent an earlier daemon left in the ticket's folder before it starts one, and ends its sessions when the daemon stops", async () => {
    const order: string[] = [];
    let pending = false;
    const s = server((method, params, reply, id) => {
      claudeLike(() => {
        pending = true;
      })(method, params, reply, id);
    });
    const a = new AcpAgent({
      launch: (r) => {
        order.push("launch");
        s.launches.push(r);
        return s.proc;
      },
      reap: async (employee, o) => {
        order.push(`reap ${employee} ${o?.cwd ?? "-"}${o?.all ? " all" : ""}`);
        return [];
      },
      credentials: () => ({}),
      cwdFor: (id) => `/home/employee/work/inc-${id}`,
      now: () => 1_000,
    });
    const running = a.run(request());
    while (!pending) await new Promise((r) => setTimeout(r, 1));
    expect(order).toEqual(["reap ada /home/employee/work/inc-42", "launch"]);

    await a.shutdown(30);
    expect(s.proc.stdin.writableEnded).toBe(true);
    expect(order).toEqual(["reap ada /home/employee/work/inc-42", "launch", "reap ada - all"]);
    // the session that was running ends as stuck, not hung, and nothing new starts
    expect(await running).toMatchObject({ kind: "stuck" });
    expect(await a.run(request())).toEqual({
      kind: "stuck",
      reason: "the daemon is stopping",
      startup: true,
    });
    expect(order).toHaveLength(3);
  });
});

describe("Apple container machines", () => {
  const boot = ["machine", "run", "-n", "inc-ada", "--", "true"];
  // What container 1.4.1 prints for a missing machine.
  const notFound =
    'Error: failed to boot container machine (cause: "notFound: "container machine with ID inc-ada not found"")';

  it("makes a missing machine with no home mount and fixed resources, boots it, then stops it", async () => {
    const calls: string[][] = [];
    const m = new AppleMachines(
      noWalls,
      async (_bin, args) => {
        calls.push(args);
        if (args[1] === "run" && calls.length === 1) throw new Error(notFound);
        // The new machine's first boot fails, as it does now and then on the mini.
        if (args[1] === "run" && calls.length === 3) throw new Error("Operation not supported by device");
        return "";
      },
      async () => {},
    );
    await m.ensureUp("ada");
    await m.ensureUp("ada");
    expect(calls).toEqual([
      boot,
      [
        "machine",
        "create",
        "--name",
        "inc-ada",
        "--cpus",
        "6",
        "--memory",
        "12G",
        "--home-mount",
        "none",
        "local/i-inc-employee:latest",
      ],
      boot,
      boot,
    ]);
    await m.stop("ada");
    expect(calls.at(-1)).toEqual(["machine", "stop", "inc-ada"]);
    expect(m.running()).toEqual([]);
  });

  it("boots an existing machine with `machine run`, since there is no `machine start`", async () => {
    const calls: string[][] = [];
    const m = new AppleMachines(noWalls, async (_bin, args) => {
      calls.push(args);
      return "";
    });
    await m.ensureUp("ada");
    expect(calls).toEqual([boot]);
    expect(m.running()).toEqual(["ada"]);
  });

  it("passes on other failures instead of making a new machine", async () => {
    const m = new AppleMachines(noWalls, async () => {
      throw new Error("XPC connection error: the container service isn't running");
    });
    await expect(m.ensureUp("ada")).rejects.toThrow("container service");
    expect(m.running()).toEqual([]);
  });

  it("passes the credential with -e, so it's in no command line", () => {
    const seen: { bin: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const fakeChild = () =>
      Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true,
      }) as unknown as ChildProcessWithoutNullStreams;
    const launch = machineLaunch(
      { bin: "/usr/local/bin/container", image: "x", user: "employee", cpus: 1, memory: "1G" },
      (bin, args, env) => {
        seen.push({ bin, args, env });
        return fakeChild();
      },
    );
    // A value a login shell would split or interpret is fine: it never passes through one.
    const token = "sk-token; curl evil $(x)";
    launch({
      employeeId: "ada",
      engine: claude,
      cwd: "/home/employee/work/inc-1",
      env: { CLAUDE_CODE_OAUTH_TOKEN: token },
    });
    const [call] = seen;
    expect(call?.args).toEqual([
      "machine",
      "run",
      "-i",
      "-u",
      "employee",
      "-n",
      "inc-ada",
      "-e",
      "I_INC_CWD",
      "-e",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "-e",
      "I_INC_AGENT",
      "--",
      "acp-claude",
    ]);
    // each launch has a token the launcher notes in the sandbox, so a leftover agent can be found (reaper.ts)
    expect(call?.env.I_INC_AGENT).toMatch(/^[0-9a-f]{16}$/);
    expect(call?.args.join(" ")).not.toContain("sk-token");
    expect(call?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(token);
    expect(call?.env.I_INC_CWD).toBe("/home/employee/work/inc-1");
  });

  it("starts Codex with the dedicated ACP launcher", () => {
    const seen: string[][] = [];
    const launch = machineLaunch(noWalls, (_bin, args) => {
      seen.push(args);
      return Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true,
      }) as unknown as ChildProcessWithoutNullStreams;
    });
    launch({
      employeeId: "ada",
      engine: { ...claude, id: "codex", harness: "codex" },
      cwd: "/home/employee/work/inc-1",
      env: {},
    });
    expect(seen[0]?.at(-1)).toBe("acp-codex");
  });

  it("refuses a variable name that isn't one, and an employee id that isn't one", () => {
    const launch = machineLaunch(noWalls, () => {
      throw new Error("never started");
    });
    expect(() => launch({ employeeId: "ada", engine: claude, cwd: "/w", env: { "A=B": "x" } })).toThrow(
      "can't pass A=B into a machine",
    );
    expect(() => launch({ employeeId: "../x", engine: claude, cwd: "/w", env: {} })).toThrow(
      "not an employee id",
    );
  });

  it("keeps each ticket's work in the employee's home", () => {
    expect(workDir("t7")).toBe("/home/employee/work/inc-t7");
    expect(() => workDir("../t7")).toThrow("not a ticket id");
  });
});

describe("the walls", () => {
  it("keep every machine down while their marker is missing", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "inc-walls-")), "i-inc-walls.ok");
    const s = { bin: "container", image: "x", user: "employee", cpus: 1, memory: "1G", wallsMarker: marker };
    const exec: string[][] = [];
    const machines = new AppleMachines(s, async (_bin, args) => {
      exec.push(args);
      return "";
    });
    await expect(machines.ensureUp("ada")).rejects.toThrow("the walls aren't up");
    expect(() =>
      machineLaunch(s, () => {
        throw new Error("never started");
      })({ employeeId: "ada", engine: claude, cwd: "/w", env: {} }),
    ).toThrow("the walls aren't up");
    await expect(machineScript(s)("ada", "true")).rejects.toThrow("the walls aren't up");
    expect(exec).toEqual([]);

    writeFileSync(marker, "");
    await machines.ensureUp("ada");
    expect(exec).toHaveLength(1);
  });
});

describe("limits named in error messages", () => {
  const at = (iso: string) => Date.parse(iso);
  it("reads when Claude's session limit resets", () => {
    const now = at("2026-09-29T00:50:25Z");
    expect(resetFromText("You've hit your session limit · resets 3:30am (UTC)", now)).toBe(
      at("2026-09-29T03:30:00Z"),
    );
    expect(resetFromText("resets 12am (UTC)", at("2026-09-29T22:00:00Z"))).toBe(at("2026-09-30T00:00:00Z"));
    expect(resetFromText("resets 12pm (UTC)", now)).toBe(at("2026-09-29T12:00:00Z"));
    // Read right at the reset, or just after: due now, so a retry in a few minutes, not tomorrow.
    const justAfter = at("2026-09-29T03:30:20Z");
    expect(resetFromText("resets 3:30am (UTC)", justAfter)).toBe(justAfter + 5 * 60_000);
    expect(resetFromText("resets Oct 1, 3am (UTC)", at("2026-10-01T03:00:10Z"))).toBe(
      at("2026-10-01T03:05:10Z"),
    );
    // Another zone isn't read as UTC.
    expect(resetFromText("resets 3:30am (America/New_York)", now)).toBeNull();
    expect(resetFromText("weekly limit · resets Oct 3, 9pm (UTC)", now)).toBe(at("2026-10-03T21:00:00Z"));
    expect(resetFromText("rate limited, try later", now)).toBeNull();
  });
});

describe("extractRateLimit", () => {
  it("extracts rate limit info with seconds timestamp and snake_case windows", () => {
    const raw = {
      status: "allowed",
      resetsAt: 1_790_600_000,
      unifiedWindows: {
        five_hour: { utilization: 0.25, resetsAt: 1_790_600_000 },
        seven_day: { utilization: 0.75, resetsAt: 1_791_000_000 },
      },
    };
    expect(extractRateLimit(raw, 5_000)).toEqual({
      status: "allowed",
      resetsAt: 1_790_600_000_000,
      fiveHourUtilization: 0.25,
      sevenDayUtilization: 0.75,
      updatedAt: 5_000,
    });
  });

  it("handles camelCase windows and ISO string resetsAt", () => {
    const raw = {
      status: "allowed",
      resetsAt: "2026-10-17T20:00:00Z",
      unifiedWindows: {
        fiveHour: { utilization: 0.8 },
        sevenDay: { utilization: 0.5 },
      },
    };
    expect(extractRateLimit(raw, 10_000)).toEqual({
      status: "allowed",
      resetsAt: Date.parse("2026-10-17T20:00:00Z"),
      fiveHourUtilization: 0.8,
      sevenDayUtilization: 0.5,
      updatedAt: 10_000,
    });
  });

  it("falls back to window resetsAt if top-level resetsAt is missing", () => {
    const raw = {
      unifiedWindows: {
        five_hour: { utilization: 0.9, resetsAt: 1_790_600_000 },
      },
    };
    expect(extractRateLimit(raw, 2_000)).toEqual({
      resetsAt: 1_790_600_000_000,
      fiveHourUtilization: 0.9,
      updatedAt: 2_000,
    });
  });

  it("handles missing fields gracefully", () => {
    expect(extractRateLimit({}, 1_000)).toEqual({
      updatedAt: 1_000,
    });
  });
});

describe("the walls' marker", () => {
  it("counts only while the walls job keeps it fresh, and the daemon can stop every machine", async () => {
    const { utimesSync } = await import("node:fs");
    const { wallsUp } = await import("../src/machines.ts");
    const marker = join(mkdtempSync(join(tmpdir(), "inc-walls-")), "i-inc-walls.ok");
    const s = { ...noWalls, wallsMarker: marker };
    expect(wallsUp(s)).toBe(false);
    writeFileSync(marker, "");
    expect(wallsUp(s)).toBe(true);
    const old = (Date.now() - 5 * 60_000) / 1000;
    utimesSync(marker, old, old);
    expect(wallsUp(s)).toBe(false);

    const calls: string[][] = [];
    const listing = [
      "NAME     CREATED              IP             CPUS  MEMORY  DISK  STATE    DEFAULT",
      "m1-test  2026-09-27 16:10:08  192.168.64.13  4     6G      5.3G  running  *",
      "inc-ada  2026-09-28 20:46:19  192.168.64.22  4     6G      3.6G  running",
      "inc-kit  2026-09-28 20:46:19  -              4     6G      3.6G  stopped",
    ].join("\n");
    const m = new AppleMachines(noWalls, async (_bin, args) => {
      calls.push(args);
      return args[1] === "ls" ? listing : "";
    });
    expect(await m.stopAll()).toEqual(["inc-ada"]);
    expect(calls.at(-1)).toEqual(["machine", "stop", "inc-ada"]);
  });
});

describe("a team's sandbox", () => {
  it("is one machine for the whole team, sized for it, and stops only when nobody is working in it", async () => {
    const calls: string[][] = [];
    const team = {
      ...noWalls,
      machineFor: () => "inc-engineering",
      sizeFor: () => ({ cpus: 6, memory: "12G" }),
    };
    const m = new AppleMachines(
      team,
      async (_bin, args) => {
        calls.push(args);
        if (args[1] === "run" && calls.length === 1)
          throw new Error("Error: notFound: machine inc-engineering");
        return "";
      },
      async () => {},
    );
    await m.ensureUp("ada");
    await m.ensureUp("kit");
    expect(calls.map((c) => c.slice(0, 2).join(" "))).toEqual([
      "machine run",
      "machine create",
      "machine run",
    ]);
    expect(calls[1]).toContain("inc-engineering");
    await m.stop("ada");
    expect(calls).toHaveLength(3);
    await m.stop("kit");
    expect(calls.at(-1)).toEqual(["machine", "stop", "inc-engineering"]);
  });
});
