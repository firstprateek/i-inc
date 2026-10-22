// The home machines' egress wall, from the daemon's side (T66): a personal assistant's sandbox
// (inc-home-<id>) is created, booted and run in only while the walls job has acknowledged its address,
// with a fake `container` and a fake walls job that does what tools/host/walls.sh does with the file.

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { StartupError } from "@i-inc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { machineScript } from "../src/harness.ts";
import { HomeWall, type HomeWallSettings, isHomeMachine, machineAddress } from "../src/home-wall.ts";
import {
  AppleMachines,
  type Exec,
  type MachineSettings,
  machineLaunch,
  parseMachineListing,
} from "../src/machines.ts";

let dir: string;
let wall: HomeWallSettings;
let settings: MachineSettings;
let clock: number;
const sleeps: number[] = [];
const sleep = async (ms: number) => {
  sleeps.push(ms);
  clock += ms;
};

/** What `container machine ls` knows: name -> { ip, state }. */
let machines: Map<string, { ip: string; state: "running" | "stopped" }>;
let calls: string[][];
/** The fake walls job: what it acknowledges when it runs (the real one is tools/host/walls.sh). */
let walls: "covers" | "never" | "absent" | "stale";

const listing = () =>
  [
    "NAME             CREATED              IP             CPUS  MEMORY  DISK  STATE    DEFAULT",
    ...[...machines].map(
      ([name, m]) =>
        `${name.padEnd(16)} 2026-10-21 10:00:00  ${(m.state === "running" ? m.ip : "-").padEnd(14)} 2     4G      3.6G  ${m.state}`,
    ),
  ].join("\n");

/** What walls.sh does: read the declared list, keep plain addresses, write the acknowledgement. */
function wallsJob() {
  if (walls === "absent") return;
  const declared = existsSync(wall.declared) ? readFileSync(wall.declared, "utf8").split("\n") : [];
  const held = walls === "covers" ? declared.filter((l) => machineAddress.test(l)) : [];
  writeFileSync(wall.ack, held.map((a) => `${a}\n`).join(""));
  const at = (walls === "stale" ? clock - 10 * 60_000 : clock) / 1000;
  utimesSync(wall.ack, at, at);
}

const exec: Exec = async (_bin, args) => {
  calls.push(args);
  const [, sub] = args;
  if (sub === "ls") {
    // Each look at the machines is a moment the walls job may run.
    wallsJob();
    return listing();
  }
  if (sub === "run" && args.includes("true")) {
    const name = args[args.indexOf("-n") + 1] as string;
    const m = machines.get(name);
    if (!m) throw new Error("notFound: machine not found");
    m.state = "running";
    return "";
  }
  if (sub === "create") {
    machines.set(args[args.indexOf("--name") + 1] as string, { ip: "192.168.64.5", state: "running" });
    return "";
  }
  if (sub === "stop") {
    const m = machines.get(args[2] as string);
    if (m) m.state = "stopped";
    return "";
  }
  return "";
};

const fakeChild = () =>
  Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  }) as unknown as ChildProcessWithoutNullStreams;

const pa = "pip";
const setIp = (name: string, ip: string) => {
  const m = machines.get(name);
  if (m) m.ip = ip;
};
const ran = () => calls.filter((c) => c[1] === "run" && !c.includes("true"));
const booted = () => calls.filter((c) => c[1] === "create" || (c[1] === "run" && c.includes("true")));
const make = () => new AppleMachines(settings, exec, sleep, () => clock);
const engine = { id: "qwen", harness: "opencode", model: "q", accountId: "local", local: true } as const;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "i-inc-homewall-"));
  mkdirSync(join(dir, "i-inc"));
  clock = Date.now();
  sleeps.length = 0;
  calls = [];
  machines = new Map();
  walls = "covers";
  wall = {
    declared: join(dir, "i-inc", "home-machines"),
    ack: join(dir, "i-inc-walls.home"),
    ackMaxAgeMs: 120_000,
    waitMs: 20_000,
    pollMs: 2_000,
  };
  settings = {
    bin: "container",
    image: "img",
    user: "employee",
    cpus: 6,
    memory: "12G",
    machineFor: (id) => (id === pa ? "inc-home-pip" : id === "tam" ? "inc-errands" : `inc-${id}`),
    // The registry says which sandboxes hold a PA: Pip's, and Tam's under a team name of the owner's.
    homeMachine: (machine) => machine === "inc-errands",
    homeWall: new HomeWall(wall, () => clock),
  };
  wallsJob(); // the job has been running: a fresh, empty acknowledgement
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("a home machine's wall", () => {
  it("creates the machine, declares its address, and runs nothing until the walls acknowledge it", async () => {
    const m = make();
    await m.ensureUp(pa);
    expect(readFileSync(wall.declared, "utf8")).toBe("192.168.64.5\n");
    // The job acknowledged at the next look, after the declaration: one wait.
    expect(sleeps).toEqual([wall.pollMs]);
    // Now a script, an agent and a callback may run in it.
    await expect(m.runIn("inc-home-pip", "true")).resolves.toBeDefined();
    const spawned: string[][] = [];
    const launch = machineLaunch(settings, (_b, args) => {
      spawned.push(args);
      return fakeChild();
    });
    launch({ employeeId: pa, engine, cwd: "/home/employee/work/inc-1", env: {} });
    expect(spawned).toHaveLength(1);
    // The script runner gets past the wall to the (absent) `container` binary.
    await expect(machineScript(settings)(pa, "true")).rejects.toThrow(/ENOENT/);
  });

  it("waits for a slow acknowledgement, looking again every poll", async () => {
    walls = "never";
    machines.set("inc-home-pip", { ip: "192.168.64.5", state: "stopped" });
    const slow: Exec = async (bin, args) => {
      const out = await exec(bin, args);
      // The job catches up after the third look at the machines.
      if (args[1] === "ls" && calls.filter((c) => c[1] === "ls").length === 3) walls = "covers";
      return out;
    };
    const m = new AppleMachines(settings, slow, sleep, () => clock);
    await m.ensureUp(pa);
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps.every((ms) => ms === wall.pollMs)).toBe(true);
    expect(() => settings.homeWall?.assertCovered("inc-home-pip")).not.toThrow();
  });

  it("stops the machine and refuses everything when its address is never acknowledged", async () => {
    walls = "never";
    const logs: string[] = [];
    const m = new AppleMachines(
      settings,
      exec,
      sleep,
      () => clock,
      (l) => logs.push(l),
    );
    const err = await m.ensureUp(pa).catch((e) => e);
    expect(err).toBeInstanceOf(StartupError);
    expect((err as StartupError).message).toContain("didn't cover inc-home-pip (192.168.64.5)");
    expect((err as StartupError).retryAt).toBeGreaterThan(clock);
    expect(calls.some((c) => c[1] === "stop" && c[2] === "inc-home-pip")).toBe(true);
    expect(machines.get("inc-home-pip")?.state).toBe("stopped");
    expect(logs.join("\n")).toContain("[sandbox:inc-home-pip]");
    // Nothing runs in it: not an agent, not a script, not a callback.
    await expect(m.runIn("inc-home-pip", "true")).rejects.toThrow();
    await expect(m.deliverCallback("home-pip", "http://x")).rejects.toThrow(/home machine/);
    expect(() =>
      machineLaunch(settings, () => fakeChild())({ employeeId: pa, engine, cwd: "/w", env: {} }),
    ).toThrow(/home machine/);
    await expect(machineScript(settings)(pa, "true")).rejects.toThrow(/home machine/);
    expect(ran()).toEqual([]);
  });

  it("makes nothing at all when the walls job has never acknowledged a home wall", async () => {
    walls = "absent";
    rmSync(wall.ack, { force: true });
    const err = await make()
      .ensureUp(pa)
      .catch((e) => e);
    expect(err).toBeInstanceOf(StartupError);
    expect((err as StartupError).message).toContain("sudo sh tools/host/install-walls.sh");
    expect(booted()).toEqual([]); // no create, no boot
    expect(machines.size).toBe(0);
  });

  it("makes nothing when the acknowledgement is stale (the walls job has stopped)", async () => {
    const old = (clock - 10 * 60_000) / 1000;
    utimesSync(wall.ack, old, old);
    walls = "absent"; // the job doesn't refresh it
    const err = await make()
      .ensureUp(pa)
      .catch((e) => e);
    expect(err).toBeInstanceOf(StartupError);
    expect(booted()).toEqual([]);
  });

  it("stops a machine, rather than waiting, when the job stops acknowledging while it boots", async () => {
    walls = "stale";
    const err = await make()
      .ensureUp(pa)
      .catch((e) => e);
    // The preflight saw a fresh file; the job then went quiet: the stale file is refused at once.
    expect(err).toBeInstanceOf(StartupError);
    expect(sleeps).toEqual([]);
    expect(machines.get("inc-home-pip")?.state).toBe("stopped");
  });

  it("checks again when the machine is already up: a restarted machine with a new address is stopped", async () => {
    const m = make();
    await m.ensureUp(pa);
    walls = "covers";
    // The machine restarts with another address while the walls job holds only the old one.
    setIp("inc-home-pip", "192.168.64.9");
    const hold = walls;
    walls = "never";
    const err = await m.ensureUp(pa).catch((e) => e);
    expect(walls).not.toBe(hold);
    expect(err).toBeInstanceOf(StartupError);
    expect(machines.get("inc-home-pip")?.state).toBe("stopped");
    expect(() => settings.homeWall?.assertCovered("inc-home-pip")).toThrow();
  });

  it("refuses a launch once the acknowledgement no longer holds the address", async () => {
    const m = make();
    await m.ensureUp(pa);
    writeFileSync(wall.ack, "192.168.64.77\n");
    expect(() =>
      machineLaunch(settings, () => fakeChild())({ employeeId: pa, engine, cwd: "/w", env: {} }),
    ).toThrow(/don't cover inc-home-pip/);
  });

  it("refuses a launch once the acknowledgement goes stale", async () => {
    const m = make();
    await m.ensureUp(pa);
    const old = (clock - 10 * 60_000) / 1000;
    utimesSync(wall.ack, old, old);
    await expect(m.runIn("inc-home-pip", "true")).rejects.toThrow(/last two minutes/);
  });

  it("is refused outright with no home wall configured", async () => {
    const { homeWall: _, ...without } = settings;
    const err = await new AppleMachines(without, exec, sleep, () => clock).ensureUp(pa).catch((e) => e);
    expect(err).toBeInstanceOf(StartupError);
    expect(booted()).toEqual([]);
    expect(() =>
      machineLaunch(without, () => fakeChild())({ employeeId: pa, engine, cwd: "/w", env: {} }),
    ).toThrow(/no home wall/);
  });
});

describe("the sandbox a PA has", () => {
  it("is walled whatever its team is called, when the registry says it holds a PA", async () => {
    const m = make();
    await m.ensureUp("tam");
    expect(readFileSync(wall.declared, "utf8")).toBe("192.168.64.5\n");
    expect(() => settings.homeWall?.assertCovered("inc-errands")).not.toThrow();
    walls = "never";
    setIp("inc-errands", "192.168.64.9");
    await expect(make().ensureUp("tam")).rejects.toBeInstanceOf(StartupError);
    expect(machines.get("inc-errands")?.state).toBe("stopped");
  });

  it("is walled by its name alone, inc-home-…, even with no registry to ask", async () => {
    const { homeMachine: _, ...nameOnly } = settings;
    await new AppleMachines(nameOnly, exec, sleep, () => clock).ensureUp(pa);
    expect(readFileSync(wall.declared, "utf8")).toBe("192.168.64.5\n");
  });
});

describe("other machines are left as they were", () => {
  it("need no wall: nothing is declared, and nothing waits", async () => {
    const m = make();
    await m.ensureUp("ada").catch(() => {}); // creates inc-ada through the fake
    expect(existsSync(wall.declared)).toBe(false);
    expect(sleeps).toEqual([]);
    await expect(m.runIn("inc-ada", "true")).resolves.toBeDefined();
    walls = "never";
    await expect(m.runIn("inc-ada", "true")).resolves.toBeDefined();
  });

  it("an engineer's machine is not a home machine", () => {
    expect(isHomeMachine("inc-home-pip")).toBe(true);
    expect(isHomeMachine("inc-engineering")).toBe(false);
    expect(isHomeMachine("inc-homer")).toBe(false);
  });
});

describe("the watch over running home machines", () => {
  const grace = 90_000;

  it("declares the running ones and keeps the covered ones", async () => {
    machines.set("inc-home-pip", { ip: "192.168.64.5", state: "running" });
    machines.set("inc-home-ann", { ip: "192.168.64.6", state: "stopped" });
    machines.set("inc-eng", { ip: "192.168.64.7", state: "running" });
    const m = make();
    expect(await m.watchHome(grace)).toEqual([]);
    expect(readFileSync(wall.declared, "utf8")).toBe("192.168.64.5\n");
    // The next look finds the job's acknowledgement, and the machine may run.
    expect(await m.watchHome(grace)).toEqual([]);
    expect(() => settings.homeWall?.assertCovered("inc-home-pip")).not.toThrow();
  });

  it("stops a home machine that stays outside the walls past the grace, and only that one", async () => {
    walls = "never";
    machines.set("inc-home-pip", { ip: "192.168.64.5", state: "running" });
    machines.set("inc-eng", { ip: "192.168.64.7", state: "running" });
    const m = make();
    expect(await m.watchHome(grace)).toEqual([]);
    clock += grace - 1;
    expect(await m.watchHome(grace)).toEqual([]);
    clock += 1;
    expect(await m.watchHome(grace)).toEqual(["inc-home-pip"]);
    expect(machines.get("inc-home-pip")?.state).toBe("stopped");
    expect(machines.get("inc-eng")?.state).toBe("running");
  });

  it("stops it when the walls job has gone and no acknowledgement can come", async () => {
    walls = "absent";
    rmSync(wall.ack, { force: true });
    rmSync(join(dir, "i-inc"), { recursive: true }); // no folder to declare in either
    machines.set("inc-home-pip", { ip: "192.168.64.5", state: "running" });
    const m = make();
    await m.watchHome(grace);
    clock += grace;
    expect(await m.watchHome(grace)).toEqual(["inc-home-pip"]);
  });
});

describe("what the daemon declares", () => {
  it("writes only addresses of the machines' network, sorted, and rewrites nothing that is unchanged", () => {
    const w = new HomeWall(wall, () => clock);
    w.declare(["192.168.64.9", "10.0.0.1", "192.168.64.2", "192.168.64.1", "x; reboot", "192.168.64.9"]);
    expect(readFileSync(wall.declared, "utf8")).toBe("192.168.64.2\n192.168.64.9\n");
    writeFileSync(wall.declared, "192.168.64.2\n192.168.64.9\n");
    const at = 1;
    utimesSync(wall.declared, at, at);
    w.declare(["192.168.64.2", "192.168.64.9"]);
    expect(readFileSync(wall.declared, "utf8")).toBe("192.168.64.2\n192.168.64.9\n");
  });

  it("fails clearly when the walls job's folder isn't there", () => {
    rmSync(join(dir, "i-inc"), { recursive: true });
    expect(() => new HomeWall(wall, () => clock).declare(["192.168.64.5"])).toThrow(/install-walls\.sh/);
  });

  it("the machines' address pattern is the one walls.sh accepts", () => {
    const script = readFileSync(join(import.meta.dirname, "../../../tools/host/walls.sh"), "utf8");
    const awk = /\/\^(192\\\.168\\\.64\\\.\(.*?\)\$)\/ \{ print/.exec(script)?.[1];
    expect(awk).toBeDefined();
    expect(machineAddress.source.replace("^", "").replace("(?:", "(")).toBe(awk);
  });
});

describe("the machine listing's address column", () => {
  it("is read for a running machine and absent for a stopped one", () => {
    const rows = parseMachineListing(listingOf());
    expect(rows).toEqual([
      expect.objectContaining({ name: "inc-home-pip", state: "running", ip: "192.168.64.5" }),
      expect.objectContaining({ name: "inc-eng", state: "stopped" }),
    ]);
    expect(rows[1]?.ip).toBeUndefined();
  });
  function listingOf() {
    machines = new Map([
      ["inc-home-pip", { ip: "192.168.64.5", state: "running" }],
      ["inc-eng", { ip: "192.168.64.7", state: "stopped" }],
    ]);
    return listing();
  }
});
