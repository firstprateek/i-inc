// The ACP client against a scripted ACP server, speaking the messages M1 recorded (docs/m1-findings.md,
// step 5), and the Apple container provider against a recorded command line.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Engine, SessionRequest } from "@i-inc/core";
import { describe, expect, it } from "vitest";
import {
  AcpAgent,
  type AgentProcess,
  type LaunchRequest,
  resetFromText,
  type UsageReport,
} from "../src/acp.ts";
import { machineScript } from "../src/harness.ts";
import { AppleMachines, defaultMachineSettings, machineLaunch, workDir } from "../src/machines.ts";

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

function agent(s: ReturnType<typeof server>, usage: UsageReport[] = []) {
  return new AcpAgent({
    launch: (r) => {
      s.launches.push(r);
      return s.proc;
    },
    credentials: (e) => (e.harness === "claude-code" ? { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" } : {}),
    cwdFor: (id) => `/home/employee/work/inc-${id}`,
    onUsage: (u) => usage.push(u),
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

  it("reads Claude's rate limits, and pauses until the reset when the account is out", async () => {
    const usage: UsageReport[] = [];
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
    expect(await agent(s, usage).run(request())).toEqual({
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
  });

  it("treats a limit error with no reset time (Antigravity) as out of tokens for an hour", async () => {
    const s = server(
      claudeLike((reply, id) => reply({ id, error: { code: -32603, message: "429 RESOURCE_EXHAUSTED" } })),
    );
    expect(await agent(s).run(request())).toEqual({ kind: "out-of-tokens", resetsAt: 1_000 + 3_600_000 });
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
    expect(out).toEqual({ kind: "stuck", reason: "antigravity needs a sign-in in Ada's machine" });
  });

  it("is stuck, not hung, when the agent dies mid-session", async () => {
    const s = server(claudeLike(() => setTimeout(() => s.exit(1), 5)));
    expect(await agent(s).run(request())).toEqual({
      kind: "stuck",
      reason: "the agent exited (1) mid-session",
    });
  });
});

describe("Apple container machines", () => {
  const boot = ["machine", "run", "-n", "inc-ada", "--", "true"];
  // What container 1.4.1 prints for a missing machine.
  const notFound =
    'Error: failed to boot container machine (cause: "notFound: "container machine with ID inc-ada not found"")';

  it("makes a missing machine with no home mount and fixed resources, boots it, then stops it", async () => {
    const calls: string[][] = [];
    const m = new AppleMachines(noWalls, async (_bin, args) => {
      calls.push(args);
      if (args[1] === "run" && calls.length === 1) throw new Error(notFound);
      // The new machine's first boot fails, as it does now and then on the mini.
      if (args[1] === "run" && calls.length === 3) throw new Error("Operation not supported by device");
      return "";
    });
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
        "4",
        "--memory",
        "6G",
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
    await expect(m.ensureUp("ada")).rejects.toThrow("container service isn't running");
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
      "--",
      "acp-claude",
    ]);
    expect(call?.args.join(" ")).not.toContain("sk-token");
    expect(call?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(token);
    expect(call?.env.I_INC_CWD).toBe("/home/employee/work/inc-1");
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
    expect(resetFromText("resets 12am (UTC)", now)).toBe(at("2026-09-30T00:00:00Z"));
    expect(resetFromText("weekly limit · resets Oct 3, 9pm (UTC)", now)).toBe(at("2026-10-03T21:00:00Z"));
    expect(resetFromText("rate limited, try later", now)).toBeNull();
  });
});
