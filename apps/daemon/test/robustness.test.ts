// T63 audit, group 4: the daemon outlives its children. A write to a child that has exited, an
// unhandled rejection, a frozen machine or a silent agent must not end the process or hold a
// ticket (and with it a deploy) for ever. The waits use fake timers and event waits, not the clock.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { Engine, SessionRequest, Ticket } from "@i-inc/core";
import { fold } from "@i-inc/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACP_TIMED_OUT, AcpAgent, type AgentProcess } from "../src/acp.ts";
import { guards, isFatal, serverError } from "../src/guards.ts";
import { MachineHarness, machineScript, TIMED_OUT } from "../src/harness.ts";
import {
  AppleMachines,
  defaultMachineSettings,
  type Exec,
  execDefault,
  machineLaunch,
} from "../src/machines.ts";
import { describeMs, killGroup, stopTracked, trackedCount } from "../src/proc.ts";
import { defaultTimeoutSettings, defaultTimeoutsMs, timeoutsMs } from "../src/timeouts.ts";
import { refunds, testApp } from "./setup.ts";

const { wallsMarker: _, ...noWalls } = defaultMachineSettings;

/** An executable that stands in for the `container` CLI. */
function fakeBin(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "inc-bin-"));
  const bin = join(dir, "container");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterEach(() => {
  vi.useRealTimers();
});

describe("a write to a child that has already exited", () => {
  // 8 MB cannot sit in a pipe, so the write is still going when the child exits: EPIPE for certain.
  const big = "x".repeat(8 * 1024 * 1024);

  it("machineScript resolves with the child's exit code instead of crashing on EPIPE", async () => {
    const run = machineScript({ ...noWalls, bin: fakeBin("echo gone; exit 3") });
    const r = await run("ada", big);
    expect(r.code).toBe(3);
    expect(r.output).toContain("gone");
  });

  it("the machine provider's exec rejects with the command's error instead of crashing", async () => {
    const bin = fakeBin("echo no such machine >&2; exit 1");
    await expect(execDefault(bin, ["machine", "run"], { input: big })).rejects.toThrow("no such machine");
  });

  it("a launched agent's stdin is guarded, so a message after it exits is not fatal", async () => {
    const proc = await machineLaunch(noWalls, (_bin, _args) =>
      spawn("sh", ["-c", "exit 1"], { stdio: ["pipe", "pipe", "pipe"] }),
    )({
      employeeId: "ada",
      engine: { id: "opus", harness: "claude-code", model: "Opus", accountId: "a", local: false },
      cwd: "/w",
      env: {},
    });
    await proc.exited;
    proc.stdin.write(big);
    proc.stdin.end();
    // The error event is delivered a tick later; waiting for the stream to close proves it was handled.
    await new Promise((r) => proc.stdin.once("close", r));
  });

  it("an ACP session over a broken pipe ends as a startup failure, not an uncaught error", async () => {
    const stdin = new Writable({
      write(_chunk, _enc, cb) {
        cb(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      },
    });
    const proc: AgentProcess = {
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => {},
      exited: new Promise(() => {}),
    };
    const out = await agentOver(proc).run(request());
    expect(out).toMatchObject({ kind: "stuck", startup: true });
  });
});

describe("process-level handlers", () => {
  const rig = () => {
    const logs: string[] = [];
    const exits: number[] = [];
    let t = 0;
    const g = guards({
      log: (m) => logs.push(m),
      exit: (c) => exits.push(c),
      now: () => t,
      floodLimit: 3,
      windowMs: 1000,
    });
    return {
      g,
      logs,
      exits,
      at: (ms: number) => {
        t = ms;
      },
    };
  };

  it("log an unhandled rejection or an uncaught exception and carry on", () => {
    const { g, logs, exits } = rig();
    g.unhandledRejection(new Error("EPIPE: broken pipe, write"));
    g.uncaughtException(new Error("a timer callback threw"));
    expect(logs.join("\n")).toContain("EPIPE");
    expect(logs.join("\n")).toContain("a timer callback threw");
    expect(exits).toEqual([]);
  });

  it("a request whose handler throws gets plain JSON, not Bun's development page with paths", async () => {
    const logs: string[] = [];
    const res = serverError((m) => logs.push(m))(new Error("boom at /Users/padi/secret.ts"));
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "something went wrong on our side" });
    expect(logs.join("\n")).toContain("/Users/padi/secret.ts");
  });

  it("leave for a state they cannot work in", () => {
    const { g, exits } = rig();
    g.uncaughtException(
      Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" }),
    );
    g.unhandledRejection(Object.assign(new Error("spawn ENOMEM"), { code: "ENOMEM" }));
    expect(exits).toEqual([1, 1]);
    expect(isFatal(new Error("EPIPE"))).toBe(false);
    expect(isFatal(new Error("no engine opus"))).toBe(false);
  });

  it("leave when exceptions come in a flood, so a crash loop stays visible", () => {
    const { g, exits, at } = rig();
    for (let i = 0; i < 3; i++) {
      at(i * 100);
      g.uncaughtException(new Error("again"));
    }
    expect(exits).toEqual([]);
    at(350);
    g.uncaughtException(new Error("again"));
    expect(exits).toEqual([1]);
    // Spread out over time, the same number is not a flood.
    const calm = rig();
    for (let i = 0; i < 10; i++) {
      calm.at(i * 2000);
      calm.g.uncaughtException(new Error("rare"));
    }
    expect(calm.exits).toEqual([]);
  });
});

describe("machineScript timeout", () => {
  it("stops the script and its whole process group, and answers when the deadline passes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inc-timeout-"));
    const pidfile = join(dir, "pid");
    const bin = fakeBin(`sleep 300 &\necho $! > ${pidfile}\nwait`);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const done = machineScript({ ...noWalls, bin, timeouts: () => ({ scriptMs: 60_000 }) })("ada", "true");
    // Wait for the grandchild to exist (an event, not a delay), then let the deadline pass.
    await vi.waitFor(() => expect(existsSync(pidfile) && readFileSync(pidfile, "utf8").trim()).toBeTruthy());
    const pid = Number(readFileSync(pidfile, "utf8"));
    expect(alive(pid)).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    const r = await done;
    expect(r.code).toBe(TIMED_OUT);
    expect(r.output).toContain("timed out after 1 minute");
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
  });

  it("on shutdown, a script's group is stopped too, since a detached child outlives launchd's group kill", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inc-shutdown-"));
    const pidfile = join(dir, "pid");
    const bin = fakeBin(`sleep 300 &\necho $! > ${pidfile}\nwait`);
    const done = machineScript({ ...noWalls, bin })("ada", "true");
    await vi.waitFor(() => expect(existsSync(pidfile) && readFileSync(pidfile, "utf8").trim()).toBeTruthy());
    const pid = Number(readFileSync(pidfile, "utf8"));
    expect(trackedCount()).toBeGreaterThan(0);
    expect(stopTracked()).toBeGreaterThan(0);
    const r = await done;
    expect(r.code).not.toBe(0);
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
    await vi.waitFor(() => expect(trackedCount()).toBe(0));
  });

  it("gives the checks their own, longer limit", async () => {
    const seen: (number | undefined)[] = [];
    const h = new MachineHarness(
      { recipe: () => ["true"], worktree: () => "/w" },
      async (_e, _s, _env, opts) => {
        seen.push(opts?.timeoutMs);
        return { code: 0, output: "@@green\n" };
      },
    );
    const ticket = { id: "1", assignee: "ada", project: "p" } as Ticket;
    await h.runChecks(ticket);
    expect(seen).toEqual([defaultTimeoutsMs.checksMs]);
    const custom = new MachineHarness(
      { recipe: () => ["true"], worktree: () => "/w", timeouts: () => ({ checksMs: 5_000 }) },
      async (_e, _s, _env, opts) => {
        seen.push(opts?.timeoutMs);
        return { code: 0, output: "@@green\n" };
      },
    );
    await custom.runChecks(ticket);
    expect(seen).toEqual([defaultTimeoutsMs.checksMs, 5_000]);
  });

  it("reports a checks run that timed out as an unfinished run, not a pass", async () => {
    const h = new MachineHarness({ recipe: () => ["true"], worktree: () => "/w" }, async () => ({
      code: TIMED_OUT,
      output: "the script timed out after 30 minutes and was stopped",
    }));
    const r = await h.runChecks({ id: "1", assignee: "ada", project: "p" } as Ticket);
    expect(r.green).toBe(false);
    expect(r.failures[0]).toContain("timed out");
  });

  it("reads the output the child wrote right before it exited", async () => {
    const run = machineScript({
      ...noWalls,
      bin: fakeBin("i=0; while [ $i -lt 2000 ]; do echo line$i; i=$((i+1)); done; echo @@green"),
    });
    const r = await run("ada", "true");
    expect(r.output.trim().endsWith("@@green")).toBe(true);
  });
});

describe("`container` commands", () => {
  it("get a limit by default, and a call that names its own keeps it", async () => {
    const seen: (number | undefined)[] = [];
    const exec: Exec = async (_bin, args, opts) => {
      seen.push(opts?.timeoutMs);
      return args.includes("ls") ? "NAME CPUS MEMORY DISK STATE\ninc-ada 6 12G 20G running\n" : "";
    };
    const m = new AppleMachines(noWalls, exec);
    await m.ensureUp("ada");
    await m.runIn("inc-ada", "true", 1234).catch(() => {});
    expect(seen[0]).toBe(defaultTimeoutsMs.machineCommandMs);
    expect(seen).toContain(1234);
    const custom = new AppleMachines({ ...noWalls, timeouts: () => ({ machineCommandMs: 777 }) }, exec);
    seen.length = 0;
    await custom.ensureUp("kit");
    expect(seen).toEqual([777]);
  });

  it("a frozen command is stopped with its process group, and the call fails with why", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inc-exec-"));
    const pidfile = join(dir, "pid");
    const bin = fakeBin(`sleep 300 &\necho $! > ${pidfile}\nwait`);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const result = execDefault(bin, ["machine", "run", "-n", "inc-ada", "--", "true"], {
      timeoutMs: 300_000,
    }).then(
      () => "ok",
      (e: Error) => e.message,
    );
    await vi.waitFor(() => expect(existsSync(pidfile) && readFileSync(pidfile, "utf8").trim()).toBeTruthy());
    const pid = Number(readFileSync(pidfile, "utf8"));
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await result).toContain("timed out after 5 minutes");
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
  });

  it("signals a child by its group when it leads one, and by itself when it does not", () => {
    const calls: string[] = [];
    killGroup({ pid: undefined, kill: (s) => !!calls.push(`child ${String(s)}`) });
    expect(calls).toEqual(["child SIGKILL"]);
    expect(describeMs(600_000)).toBe("10 minutes");
    expect(describeMs(60_000)).toBe("1 minute");
    expect(describeMs(1_500)).toBe("2 seconds");
  });
});

describe("the timeouts are settings", () => {
  it("have defaults, a validated API, and apply as minutes", async () => {
    const app = await testApp();
    const got = await app.call("GET", "/api/timeouts");
    expect(got.body.settings).toEqual(defaultTimeoutSettings);
    expect(
      (await app.call("PUT", "/api/timeouts", { agentIdleMinutes: 45 })).body.settings.agentIdleMinutes,
    ).toBe(45);
    expect(timeoutsMs(app.deps.registry.settings().timeouts).agentIdleMs).toBe(45 * 60_000);
    expect((await app.call("PUT", "/api/timeouts", { agentIdleMinutes: 0 })).status).toBe(400);
    expect((await app.call("PUT", "/api/timeouts", { agentIdleMinutes: 1.5 })).status).toBe(400);
    expect((await app.call("PUT", "/api/timeouts", { nonsense: 5 })).status).toBe(400);
    expect(app.deps.registry.settings().timeouts).toEqual({ agentIdleMinutes: 45 });
  });
});

// ---- ACP: initialize, session/new and a silent prompt ------------------------------------------

type Json = Record<string, unknown>;
const claude: Engine = { id: "opus", harness: "claude-code", model: "Opus", accountId: "a", local: false };

function request(over: Partial<SessionRequest> = {}): SessionRequest {
  return {
    ticket: {
      id: "42",
      title: "T",
      project: "Duet",
      type: "fix",
      effort: "low",
      doneWhen: [],
      assignee: "ada",
    },
    stage: "build",
    duty: "build",
    employee: { id: "ada", name: "Ada" } as unknown as SessionRequest["employee"],
    engine: claude,
    brief: "do it",
    ...over,
  } as SessionRequest;
}

function agentOver(proc: AgentProcess, timeouts = {}) {
  return new AcpAgent({
    launch: () => proc,
    credentials: () => ({}),
    cwdFor: (id) => `/w/inc-${id}`,
    timeouts: () => timeouts,
    cancelGraceMs: 10,
  });
}

/** A scripted ACP server. `silent` names the methods it never answers. */
function server(silent: string[] = [], onPrompt?: (say: (m: Json) => void) => void) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const sent: Json[] = [];
  let exit: (c: number | null) => void = () => {};
  const exited = new Promise<number | null>((r) => {
    exit = r;
  });
  const killed: number[] = [];
  const say = (m: Json) => stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  let buf = "";
  stdin.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const m = JSON.parse(buf.slice(0, i)) as Json;
      buf = buf.slice(i + 1);
      sent.push(m);
      const method = String(m.method ?? "");
      if (silent.includes(method)) continue;
      if (method === "initialize") say({ id: m.id, result: { protocolVersion: 1 } });
      if (method === "session/new")
        say({ id: m.id, result: { sessionId: "s1", modes: { availableModes: [] } } });
      if (method === "session/prompt") onPrompt?.(say);
    }
  });
  const proc: AgentProcess = {
    stdin,
    stdout,
    stderr,
    kill: () => {
      killed.push(1);
      exit(null);
    },
    exited,
  };
  return { proc, sent, killed, say };
}

const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

describe("an ACP agent that goes quiet", () => {
  it("initialize that is never answered ends as a startup failure and kills the agent", async () => {
    const s = server(["initialize"]);
    fakeTimers();
    const out = agentOver(s.proc).run(request());
    await vi.waitFor(() => expect(s.sent.some((m) => m.method === "initialize")).toBe(true));
    await vi.advanceTimersByTimeAsync(defaultTimeoutsMs.agentStartMs);
    expect(await out).toMatchObject({
      kind: "stuck",
      startup: true,
      reason: expect.stringContaining("didn't start"),
    });
    expect(s.killed.length).toBeGreaterThan(0);
  });

  it("session/new that is never answered ends as a startup failure", async () => {
    const s = server(["session/new"]);
    fakeTimers();
    const out = agentOver(s.proc).run(request());
    await vi.waitFor(() => expect(s.sent.some((m) => m.method === "session/new")).toBe(true));
    await vi.advanceTimersByTimeAsync(defaultTimeoutsMs.agentStartMs);
    expect(await out).toMatchObject({
      kind: "stuck",
      startup: true,
      reason: expect.stringContaining("couldn't open a session"),
    });
    expect(s.killed.length).toBeGreaterThan(0);
  });

  it("a prompt that says nothing for the idle limit is cancelled, killed and counted as stuck", async () => {
    const s = server();
    fakeTimers();
    const out = agentOver(s.proc, { agentIdleMs: 10 * 60_000 }).run(request());
    await vi.waitFor(() => expect(s.sent.some((m) => m.method === "session/prompt")).toBe(true));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const r = await out;
    expect(r).toMatchObject({
      kind: "stuck",
      reason: expect.stringContaining("said nothing for 10 minutes"),
    });
    expect(r).not.toHaveProperty("startup");
    expect(s.sent.some((m) => m.method === "session/cancel")).toBe(true);
    expect(s.killed.length).toBeGreaterThan(0);
  });

  it("any word from the agent restarts the idle count, so a long working session is not cut short", async () => {
    const s = server();
    fakeTimers();
    const out = agentOver(s.proc, { agentIdleMs: 10 * 60_000 }).run(request());
    await vi.waitFor(() => expect(s.sent.some((m) => m.method === "session/prompt")).toBe(true));
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(8 * 60_000);
      s.say({
        method: "session/update",
        params: {
          sessionId: "s1",
          update: { sessionUpdate: "tool_call", toolCallId: `t${i}`, title: "pnpm test" },
        },
      });
    }
    expect(s.killed).toEqual([]);
    const id = s.sent.find((m) => m.method === "session/prompt")?.id;
    s.say({
      method: "session/update",
      params: {
        sessionId: "s1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
      },
    });
    s.say({ id, result: { stopReason: "end_turn" } });
    expect(await out).toEqual({ kind: "done", output: "done" });
    expect(ACP_TIMED_OUT).toBe(-32098);
  });

  it("a launch that fails is a startup problem the ticket waits out, not an error thrown every tick", async () => {
    const agent = new AcpAgent({
      launch: () => {
        throw new Error("the walls aren't up");
      },
      credentials: () => ({}),
      cwdFor: (id) => `/w/${id}`,
      now: () => 5_000,
      launchRetryMs: 60_000,
    });
    await expect(agent.run(request())).rejects.toMatchObject({
      name: "StartupError",
      retryAt: 65_000,
      message: expect.stringContaining("the walls aren't up"),
    });
  });
});

describe("a hang does not hold the daemon busy", () => {
  it("clears the busy signal when the agent's idle limit passes, and the ticket moves on", async () => {
    fakeTimers();
    const s = (() => server())();
    const sessions: ReturnType<typeof server>[] = [];
    const agent = new AcpAgent({
      launch: () => {
        const next = server();
        sessions.push(next);
        return next.proc;
      },
      credentials: () => ({}),
      cwdFor: (id) => `/w/inc-${id}`,
      timeouts: () => ({ agentIdleMs: 30 * 60_000 }),
      cancelGraceMs: 10,
    });
    void s;
    const app = await testApp(":memory:", undefined, { agent });
    await app.call("POST", "/api/tickets", { ...refunds, effort: "low" });
    await vi.waitFor(() => expect(sessions.length).toBeGreaterThan(0));
    expect(app.daemon.busy()).toBe(true);
    // Every session hangs; each is stopped after its idle limit, the switch rules run, and in the
    // end the ticket fails: nothing is left running, so a deploy no longer waits.
    for (let i = 0; i < 20 && app.daemon.busy(); i++) await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(app.daemon.busy()).toBe(false);
    const state = fold(await app.deps.store.read("1"));
    expect(state.status).toBe("failed");
    expect(state.failure?.reason).toContain("said nothing");
  });
});
