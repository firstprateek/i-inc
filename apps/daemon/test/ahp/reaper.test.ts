// Agents that outlive the daemon. Real processes, the real launcher snippet (images/employee/acp-env.sh)
// and the real sweep script, with a temporary folder standing in for the sandbox's home: a daemon
// that is killed leaves an agent that ignores the end of its stdin, and the one that replaces it must
// find that agent and stop it, leaving exactly one.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Launch } from "../../src/acp.ts";
import { type MachineSettings, machineLaunch } from "../../src/machines.ts";
import {
  forgetLiveAgents,
  forgetSweepState,
  liveAgentIds,
  type Reap,
  type RunInMachine,
  reaper,
  reapMachines,
  SWEEP_SCRIPT,
} from "../../src/reaper.ts";
import { sessionRig, until } from "./session-rig.ts";
import { turnStarted } from "./support.ts";

const here = new URL(".", import.meta.url).pathname;
const acpEnv = join(here, "../../../../images/employee/acp-env.sh");
const agentJs = join(here, "stubborn-agent.mjs");
const noWalls = { bin: "container", image: "x", user: "employee", cpus: 1, memory: "1G" } as MachineSettings;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let home: string;
const spawned: ChildProcess[] = [];
const children = (): number[] => spawned.flatMap((c) => (c.pid ? [c.pid] : []));

/** The sandbox: starting the launcher is `sh -c '. acp-env.sh; exec <agent>'` with HOME in a temp folder. */
function sandbox(stubborn: "eof" | "term" = "eof") {
  const stdins: ChildProcess["stdin"][] = [];
  const spawnAgent = (_bin: string, _args: string[], env: NodeJS.ProcessEnv) => {
    const child = spawn("sh", ["-c", `. "${acpEnv}"; exec "${process.execPath}" "${agentJs}"`], {
      env: { ...env, HOME: home, STUBBORN: stubborn },
      stdio: ["pipe", "pipe", "pipe"],
    });
    spawned.push(child);
    stdins.push(child.stdin);
    return child;
  };
  const run: RunInMachine = (_employee, script, env = {}) =>
    new Promise((resolve) => {
      const p = spawn("bash", ["-s"], { env: { ...process.env, HOME: home, ...env } });
      let output = "";
      p.stdout.on("data", (d) => {
        output += d;
      });
      p.on("close", (code) => resolve({ code: code ?? 0, output }));
      p.stdin.end(script);
    });
  const notes = (): { token: string; pid: number; start: string; cwd: string }[] => {
    const d = join(home, ".inc-agents");
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter((f) => f.endsWith(".pid"))
      .map((f) => {
        const [pid, start, cwd] = readFileSync(join(d, f), "utf8").trim().split("|");
        return { token: f.slice(0, -4), pid: Number(pid), start: start ?? "", cwd: cwd ?? "" };
      });
  };
  return {
    // The sandbox's /home/employee/work/... is a folder inside the temporary home.
    launch: ((r) => machineLaunch(noWalls, spawnAgent as never)({ ...r, cwd: join(home, r.cwd) })) as Launch,
    reap: ((employee, o) => reaper(run)(employee, o?.cwd ? { ...o, cwd: join(home, o.cwd) } : o)) as Reap,
    run,
    notes,
    /** What kill -9 on the daemon does to an agent: its stdin pipe closes. */
    daemonDies: () => {
      for (const s of stdins) s?.destroy();
    },
  };
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "inc-sandbox-")));
  mkdirSync(join(home, "work"), { recursive: true });
});
afterEach(() => {
  for (const pid of children()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone already
    }
  }
  spawned.length = 0;
  forgetLiveAgents();
  forgetSweepState();
  rmSync(home, { recursive: true, force: true });
});

describe("an agent the daemon left behind", () => {
  it("is stopped by the restarted daemon, which then has exactly one agent for the conversation", async () => {
    const sb = sandbox();
    const first = await sessionRig({
      host: { launch: sb.launch, reap: sb.reap, startTimeoutMs: 5000 },
    });
    const c = await first.create("c1");
    const client = await first.client(c);
    await first.say(client, c.chat, "hello");
    const [orphan] = sb.notes();
    expect(orphan).toBeDefined();
    expect(alive(orphan?.pid as number)).toBe(true);
    // The old daemon is killed with -9: nothing runs, the agent's stdin closes, and it carries on.
    sb.daemonDies();
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(orphan?.pid as number)).toBe(true);
    forgetLiveAgents(); // a new process knows no agents

    const second = await first.restart({ launch: sb.launch, reap: sb.reap, startTimeoutMs: 5000 });
    const client2 = await second.client(c);
    await second.say(client2, c.chat, "are you still there?");
    await until(() => !alive(orphan?.pid as number), 4000, "the orphan to be stopped");
    const notes = sb.notes();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.pid).not.toBe(orphan?.pid);
    expect(alive(notes[0]?.pid as number)).toBe(true);
    // exactly one agent process is left running in the whole sandbox
    expect(children().filter(alive)).toHaveLength(1);
    expect(liveAgentIds()).toHaveLength(1);
  });

  it("is found by the startup sweep of every machine that is up, and one that ignores SIGTERM is killed", async () => {
    const sb = sandbox("term");
    const first = await sessionRig({ host: { launch: sb.launch, startTimeoutMs: 5000 } });
    const c = await first.create("c1");
    const client = await first.client(c);
    await first.say(client, c.chat, "hello");
    const [orphan] = sb.notes();
    sb.daemonDies();
    forgetLiveAgents();
    const machines = {
      listMachines: async () => [
        { name: "inc-engineering", state: "running" },
        { name: "inc-design", state: "stopped" },
        { name: "buildkit", state: "running" },
      ],
      runIn: async (name: string, script: string) => {
        expect(name).toBe("inc-engineering"); // only a machine that is up, and one of ours
        return (await sb.run("x", script)).output;
      },
    };
    const logs: string[] = [];
    expect(await reapMachines(machines, (m) => logs.push(m))).toBe(1);
    expect(alive(orphan?.pid as number)).toBe(false);
    expect(sb.notes()).toEqual([]);
    expect(logs.join("\n")).toContain("left running");
  }, 15_000);

  it("is never confused with another process: a note whose start time differs is stale, and nothing is stopped by name", async () => {
    const sb = sandbox();
    const first = await sessionRig({ host: { launch: sb.launch, startTimeoutMs: 5000 } });
    const c = await first.create("c1");
    await first.say(await first.client(c), c.chat, "hello");
    const [note] = sb.notes();
    forgetLiveAgents();
    // the pid now belongs to a different process: same pid, other start time
    writeFileSync(
      join(home, ".inc-agents", `${note?.token}.pid`),
      `${note?.pid}|Thu Jan 1 00:00:00 1970|${note?.cwd}\n`,
    );
    // another process, not launched through us, with a note nobody wrote
    const bystander = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    spawned.push(bystander);
    const out = await sb.run("x", (await import("../../src/reaper.ts")).SWEEP_SCRIPT);
    expect(out.output).not.toContain("@@reaped");
    expect(alive(note?.pid as number)).toBe(true);
    expect(alive(bystander.pid as number)).toBe(true);
    expect(sb.notes()).toEqual([]); // the stale note is gone
  });

  it("leaves the agents this daemon started alone, and another conversation's too when a folder is named", async () => {
    const sb = sandbox();
    const rig = await sessionRig({ host: { launch: sb.launch, reap: sb.reap, startTimeoutMs: 5000 } });
    const a = await rig.create("c1");
    const b = await rig.create("c2");
    await rig.say(await rig.client(a), a.chat, "hello");
    await rig.say(await rig.client(b), b.chat, "hello");
    expect(sb.notes()).toHaveLength(2);
    // this daemon's own: kept, whatever folder is asked for
    expect(await reaper(sb.run)("ada")).toEqual([]);
    expect(await reaper(sb.run)("ada", { cwd: sb.notes()[0]?.cwd as string })).toEqual([]);
    expect(children().filter(alive)).toHaveLength(2);
    // when the daemon is going down it takes all of them
    expect(await reaper(sb.run)("ada", { all: true })).toHaveLength(2);
    await until(() => children().filter(alive).length === 0, 4000, "both agents to stop");
  });

  it("is also an input of the launcher: no token, no note", () => {
    const out = execFileSync("sh", ["-c", `. "${acpEnv}"; ls "$HOME/.inc-agents" 2>/dev/null | wc -l`], {
      env: { PATH: process.env.PATH ?? "", HOME: home, I_INC_CWD: join(home, "work", "x") },
    });
    expect(Number(out.toString().trim())).toBe(0);
    const bad = execFileSync("sh", ["-c", `. "${acpEnv}"; ls "$HOME/.inc-agents" 2>/dev/null | wc -l`], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        I_INC_CWD: join(home, "work", "x"),
        I_INC_AGENT: "../../evil",
      },
    });
    expect(Number(bad.toString().trim())).toBe(0);
  });
});

describe("what the sweep will and will not touch", () => {
  it("ignores a note whose name is not a launch token, so a pattern in a file name can't reach a live agent", async () => {
    const sb = sandbox();
    const rig = await sessionRig({ host: { launch: sb.launch, reap: sb.reap, startTimeoutMs: 5000 } });
    const c = await rig.create("c1");
    await rig.say(await rig.client(c), c.chat, "hello");
    const [real] = sb.notes();
    const live = real as { token: string; pid: number; start: string; cwd: string };
    // notes that point at the live agent's pid and start time, under names that are not tokens: a glob
    // that would match every token as a pattern, a short one, upper case, too long, and one with a dot
    const names = ["[0-9a-f]*", ".*", "abc", "ABCDEF0123456789AB", "a".repeat(65), `${live.token}.x`];
    for (const name of names) {
      writeFileSync(join(home, ".inc-agents", `${name}.pid`), `${live.pid}|${live.start}|${live.cwd}\n`);
    }
    // the real note is kept (this daemon holds its token): only the odd names stand between the agent and the sweep
    const out = await sb.run("x", SWEEP_SCRIPT, { I_INC_KEEP: live.token });
    expect(out.output).not.toContain("@@reaped");
    expect(alive(live.pid)).toBe(true);
    // the real note is still honoured when it is not kept; the odd ones are neither used nor removed
    const reaped = await sb.run("x", SWEEP_SCRIPT, { I_INC_KEEP: "" });
    expect(reaped.output).toContain(`@@reaped ${live.pid} `);
    await until(() => !alive(live.pid), 4000, "the agent to stop");
    for (const name of names) expect(existsSync(join(home, ".inc-agents", `${name}.pid`))).toBe(true);
  });

  it("takes every agent at once, however many ignore SIGTERM, and only in machines that are up", async () => {
    const sb = sandbox("term");
    const first = await sessionRig({ host: { launch: sb.launch, startTimeoutMs: 5000 } });
    const made = [await first.create("c1"), await first.create("c2"), await first.create("c3")];
    for (const c of made) await first.say(await first.client(c), c.chat, "hello");
    const pids = sb.notes().map((n) => n.pid);
    expect(pids).toHaveLength(3);
    const asked: string[] = [];
    const machines = {
      listMachines: async () => [
        { name: "inc-engineering", state: "running" },
        { name: "inc-design", state: "stopped" },
      ],
      runIn: async (name: string, script: string) => {
        asked.push(name);
        return (await sb.run("x", script)).output;
      },
    };
    const t0 = Date.now();
    expect(await reapMachines(machines, undefined, { all: true })).toBe(3);
    const took = Date.now() - t0;
    // three agents that ignore SIGTERM, one after another, would be nine seconds of waiting
    expect(took).toBeLessThan(7000);
    for (const pid of pids) expect(alive(pid)).toBe(false);
    expect(asked).toEqual(["inc-engineering"]); // a stopped machine is never started to be looked at
  }, 20_000);

  it("holds launches back until the startup sweep has finished", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const machines = {
      listMachines: async () => [{ name: "inc-engineering", state: "running" }],
      runIn: async () => {
        order.push("startup sweep begins");
        await gate;
        order.push("startup sweep ends");
        return "";
      },
    };
    const sweeping = reapMachines(machines);
    const launch = reaper(async () => {
      order.push("launch sweep");
      return { code: 0, output: "" };
    })("ada", { cwd: "/home/employee/work/conv-x" });
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual(["startup sweep begins"]); // the launch is waiting
    release();
    await sweeping;
    await launch;
    expect(order).toEqual(["startup sweep begins", "startup sweep ends", "launch sweep"]);
  });
});

describe("the daemon stopping (SIGTERM, a deploy)", () => {
  it("cancels the running turn, closes every agent's stdin, and kills one that ignores it", async () => {
    const calls: { employee: string; all?: boolean | undefined }[] = [];
    const reap: Reap = async (employee, o) => {
      calls.push({ employee, all: o?.all });
      return [];
    };
    const rig = await sessionRig({ host: { reap } });
    rig.sandbox.options = { ignoreEof: true };
    const a = await rig.create("c1", { employee: "ada" });
    const b = await rig.create("c2", { employee: "kit" });
    const ca = await rig.client(a);
    await rig.say(ca, a.chat, "plain hello");
    await rig.say(await rig.client(b), b.chat, "plain hello");
    ca.dispatch(a.chat, turnStarted("slow forever", "t-slow"));
    await until(() => rig.sandbox.agents[0]?.prompts.length === 2, 4000, "the slow turn to start");
    // one sweep per launch (the second turn of the first conversation reuses its agent)
    expect(calls).toEqual([
      { employee: "ada", all: undefined },
      { employee: "kit", all: undefined },
    ]);
    calls.length = 0;

    await rig.sessions.shutdown(150);

    const [one, two] = rig.sandbox.agents;
    expect(one?.received.some((m) => m.method === "session/cancel")).toBe(true); // asked politely first
    expect(two?.received.some((m) => m.method === "session/cancel")).toBe(false); // nothing was running there
    expect(one?.stdin.writableEnded).toBe(true);
    expect(two?.stdin.writableEnded).toBe(true);
    expect(rig.sandbox.live).toHaveLength(0); // neither took the end of its input as the end: both were killed
    // the sandboxes are swept by the caller, once, by machine (reapMachines): not here, one employee at a time
    expect(calls).toEqual([]);
    // the turn that was running was cancelled by the agent itself, not left hanging
    await until(() => !rig.host.chatState(a.chat)?.activeTurn, 2000, "the turn to end");
    expect(rig.host.chatState(a.chat)?.turns.at(-1)?.state).toBe("cancelled");
    // and nothing starts again
    const late = await rig.create("c3").catch((e: Error) => e);
    expect(late).toBeInstanceOf(Error);
  }, 15_000);
});
