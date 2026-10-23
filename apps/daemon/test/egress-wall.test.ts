// The machines' egress wall, from the daemon's side (T66): closed unless opened. With a fake `container`
// and a fake walls job that does what tools/host/walls.sh does with the daemon's list, for the OLD walls (no
// acknowledgement ever: the daemon deploys itself before the owner installs the new walls) and the NEW ones.
import { type ChildProcessWithoutNullStreams, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { StartupError } from "@i-inc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EgressWall,
  type EgressWallSettings,
  isHomeMachine,
  machineAddress,
  UPDATE_WALLS,
  WallError,
} from "../src/egress-wall.ts";
import { machineScript } from "../src/harness.ts";
import {
  AppleMachines,
  assertRunnable,
  type Exec,
  type MachineSettings,
  machineLaunch,
  parseContainerListing,
  parseMachineListing,
  removeRootScript,
  rootProbeScript,
} from "../src/machines.ts";

let dir: string;
let wall: EgressWallSettings;
let settings: MachineSettings;
let clock: number;
const sleeps: number[] = [];
const sleep = async (ms: number) => {
  sleeps.push(ms);
  clock += ms;
};

let machines: Map<string, { ip: string; state: "running" | "stopped" }>;
/** Machines whose user can still get root (a new machine has the image's passwordless sudo). */
let rooted: Set<string>;
let calls: { args: string[]; input?: string | undefined }[];
/** The walls job: "new" acknowledges what the daemon declared, "old" never writes anything, "never" acknowledges nothing, "stale" is out of date. */
let walls: "new" | "old" | "never" | "stale";
let removeRootWorks: boolean;

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
  if (walls === "old") return;
  const declared = existsSync(wall.declared) ? readFileSync(wall.declared, "utf8").split("\n") : [];
  const held = walls === "new" ? declared.filter((l) => machineAddress.test(l)) : [];
  writeFileSync(wall.ack, held.map((a) => `${a}\n`).join(""));
  const at = (walls === "stale" ? clock - 10 * 60_000 : clock) / 1000;
  utimesSync(wall.ack, at, at);
}

/** `container ls`: the builder and a throwaway container are the owner's; an inc-… row must never count. */
let containers: string[];
const containerListing = () =>
  ["ID            IMAGE                          OS     ARCH   STATE    ADDR", ...containers].join("\n");
/** When set, the next `machine ls` answers with what it saw, then waits for this to resolve. */
let hold: { gate: Promise<void> } | undefined;

const exec: Exec = async (_bin, args, opts) => {
  calls.push({ args, input: opts?.input });
  if (args[0] === "ls") return containerListing();
  const sub = args[1];
  if (sub === "ls") {
    wallsJob(); // each look at the machines is a moment the walls job may run
    const seen = listing();
    if (hold) {
      const { gate } = hold;
      hold = undefined;
      await gate;
    }
    return seen;
  }
  if (sub === "create") {
    const name = args[args.indexOf("--name") + 1] as string;
    machines.set(name, { ip: "192.168.64.5", state: "running" });
    rooted.add(name);
    return "";
  }
  if (sub === "stop") {
    const m = machines.get(args[2] as string);
    if (m) m.state = "stopped";
    return "";
  }
  if (sub === "run") {
    const name = args[args.indexOf("-n") + 1] as string;
    if (opts?.input === rootProbeScript) return rooted.has(name) ? "@@root\n@@checked\n" : "@@checked\n";
    if (args[args.indexOf("-u") + 1] === "root") {
      if (removeRootWorks) rooted.delete(name);
      return "@@no-root\n";
    }
    if (args.includes("true")) {
      const m = machines.get(name);
      if (!m) throw new Error("notFound: machine not found");
      m.state = "running";
    }
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
const readDeclared = () => (existsSync(wall.declared) ? readFileSync(wall.declared, "utf8") : undefined);
const ranInMachine = () =>
  calls.filter((c) => c.args[1] === "run" && !c.args.includes("true") && c.input === undefined);
const created = () =>
  calls.filter((c) => c.args[1] === "create" || (c.args[1] === "run" && c.args.includes("true")));
const make = () => new AppleMachines(settings, exec, sleep, () => clock);
const engine = { id: "qwen", harness: "opencode", model: "q", accountId: "local", local: true } as const;
const request = (employeeId: string) => ({ employeeId, engine, cwd: "/home/employee/work/inc-1", env: {} });
const launchOf = (employeeId: string) => {
  const spawned: string[][] = [];
  const launch = machineLaunch(
    settings,
    (_b, args) => {
      spawned.push(args);
      return fakeChild();
    },
    exec,
  );
  return { run: () => launch(request(employeeId)), spawned };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "i-inc-egress-"));
  mkdirSync(join(dir, "i-inc"));
  clock = Date.now();
  sleeps.length = 0;
  calls = [];
  machines = new Map();
  rooted = new Set();
  containers = [];
  hold = undefined;
  walls = "new";
  removeRootWorks = true;
  wall = {
    declared: join(dir, "i-inc", "open-machines"),
    ack: join(dir, "i-inc-walls.open"),
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
    // The registry says which sandboxes hold a PA: Tam's under a team name of the owner's (Pip's is named so).
    homeMachine: (machine) => machine === "inc-errands",
    wall: new EgressWall(wall, () => clock),
  };
  machines.set("inc-ada", { ip: "192.168.64.8", state: "running" });
  wallsJob(); // the job has been running: a fresh acknowledgement
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the new walls", () => {
  describe("a PA's sandbox", () => {
    it("loses root before anything else runs in it, is kept out of the open list, and then runs", async () => {
      const m = make();
      await m.ensureUp(pa);
      const kinds = calls.map((c) =>
        c.args[1] === "run"
          ? c.args.includes("true")
            ? "boot"
            : c.args[c.args.indexOf("-u") + 1]
          : c.args[1],
      );
      // created and booted, then root is taken away (as root), then checked as the user: nothing runs before that
      expect(kinds.indexOf("create")).toBeLessThan(kinds.indexOf("root"));
      expect(kinds.indexOf("root")).toBeLessThan(kinds.indexOf("employee"));
      expect(calls.find((c) => c.args.includes("root"))?.input).toBe(removeRootScript("employee"));
      expect(rooted.has("inc-home-pip")).toBe(false);
      // The open list holds the engineers' machine, never the PA's.
      expect(readDeclared()).toBe("192.168.64.8\n");
      await expect(m.runIn("inc-home-pip", "true")).resolves.toBeDefined();
      const l = launchOf(pa);
      const proc = await l.run();
      expect(proc).toBeDefined();
      expect(l.spawned).toHaveLength(1);
    });

    it("is stopped, not run in, when taking root away does not work", async () => {
      removeRootWorks = false;
      const err = await make()
        .ensureUp(pa)
        .catch((e) => e);
      expect(err).toBeInstanceOf(StartupError);
      expect((err as StartupError).message).toContain("can still get root");
      expect(machines.get("inc-home-pip")?.state).toBe("stopped");
      expect(ranInMachine()).toEqual([]);
    });

    it("is refused at every launch once root comes back, and when it is not running", async () => {
      const m = make();
      await m.ensureUp(pa);
      rooted.add("inc-home-pip");
      await expect(launchOf(pa).run()).rejects.toThrow(/can still get root/);
      await expect(m.runIn("inc-home-pip", "true")).rejects.toThrow(/can still get root/);
      await expect(machineScript(settings, exec)(pa, "true")).rejects.toThrow(/can still get root/);
      await expect(m.deliverCallback("home-pip", "http://x")).rejects.toThrow(/can still get root/);
      rooted.delete("inc-home-pip");
      const home = machines.get("inc-home-pip");
      if (home) home.state = "stopped";
      await expect(launchOf(pa).run()).rejects.toThrow(/isn't running/);
    });

    it("is refused when the walls let its live address out (it restarted at an engineers' address)", async () => {
      const m = make();
      await m.ensureUp(pa);
      setIp("inc-home-pip", "192.168.64.8"); // ada's, which the walls let out
      await expect(launchOf(pa).run()).rejects.toThrow(/walls let inc-home-pip's address/);
      await expect(m.ensureUp(pa)).rejects.toBeInstanceOf(StartupError);
      expect(machines.get("inc-home-pip")?.state).toBe("stopped");
    });

    it("the address the machine really has is what is checked, not the one it had before", async () => {
      const m = make();
      await m.ensureUp(pa);
      setIp("inc-home-pip", "192.168.64.77"); // not let out: shut in, as an address nobody declared is
      await expect(machineScript(settings, exec)(pa, "true")).rejects.toThrow(/ENOENT/); // got to the (absent) container
    });

    it("is walled whatever its team is called, when the registry says it holds a PA", async () => {
      await make().ensureUp("tam");
      expect(rooted.has("inc-errands")).toBe(false);
      expect(readDeclared()).toBe("192.168.64.8\n");
    });

    it("makes nothing and says so when the acknowledgement is stale", async () => {
      walls = "stale";
      wallsJob();
      const err = await make()
        .ensureUp(pa)
        .catch((e) => e);
      expect(err).toBeInstanceOf(StartupError);
      expect(created()).toEqual([]);
    });
  });

  describe("an engineers' machine", () => {
    it("is declared, waited for until the walls let it out, and then runs", async () => {
      const m = make();
      await m.ensureUp("ada");
      expect(readDeclared()).toBe("192.168.64.8\n");
      expect(sleeps).toEqual([wall.pollMs]); // one wait, for the job to take the declaration
      const l = launchOf("ada");
      expect(await l.run()).toBeDefined();
    });

    it("waits for a machine that woke at a new address", async () => {
      const m = make();
      await m.ensureUp("ada");
      sleeps.length = 0;
      setIp("inc-ada", "192.168.64.20");
      await m.ensureUp("ada");
      expect(readDeclared()).toBe("192.168.64.20\n");
      expect(sleeps).toEqual([wall.pollMs]);
    });

    it("waits for the walls and gives up with a reason Setup can show when they never let it out", async () => {
      walls = "never";
      const m = make();
      const err = await m.ensureUp("ada").catch((e) => e);
      expect(err).toBeInstanceOf(StartupError);
      expect((err as StartupError).message).toContain("isn't let out by the walls yet");
      const status = await m.inspectSandbox("ada", { cpus: 6, memory: "12G" });
      expect(status.reason).toContain("isn't let out by the walls yet");
      expect(status.state).toBe("error");
      // The machine is left running: nothing was wrong with it.
      expect(machines.get("inc-ada")?.state).toBe("running");
      walls = "new";
      await expect(m.retrySandbox("ada", { cpus: 6, memory: "12G" })).resolves.toBeDefined();
      await expect(m.ensureUp("ada")).resolves.toBeUndefined();
    });

    it("is refused a launch into an address the walls have not let out", async () => {
      await make().ensureUp("ada");
      setIp("inc-ada", "192.168.64.31");
      await expect(launchOf("ada").run()).rejects.toThrow(/isn't let out by the walls yet/);
      await expect(machineScript(settings, exec)("ada", "true")).rejects.toThrow(/isn't let out/);
    });

    it("is not asked about root", async () => {
      rooted.add("inc-ada");
      await make().ensureUp("ada");
      expect(calls.some((c) => c.args.includes("root"))).toBe(false);
    });

    it("is refused when the acknowledgement is stale", async () => {
      walls = "stale";
      wallsJob();
      await expect(assertRunnable(settings, exec, "inc-ada")).rejects.toThrow(/last two minutes/);
    });
  });
});

describe("the old walls (the daemon is deployed, install-walls.sh has not been run)", () => {
  beforeEach(() => {
    walls = "old";
    rmSync(wall.ack, { force: true });
  });

  it("runs an engineers' machine exactly as before: no declaration, no extra look, a launch that answers at once", async () => {
    const m = make();
    await m.ensureUp("ada");
    await expect(m.runIn("inc-ada", "true")).resolves.toBeDefined();
    const l = launchOf("ada");
    const proc = l.run();
    expect(proc).not.toBeInstanceOf(Promise); // synchronous, as it always was
    expect(l.spawned).toHaveLength(1);
    expect(readDeclared()).toBeUndefined();
    await expect(machineScript(settings, exec)("ada", "true")).rejects.toThrow(/ENOENT/); // got through to the binary
    // The only looks at `machine ls` are the ones the old code made itself (runIn checks the machine runs).
    expect(calls.filter((c) => c.args[1] === "ls")).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(await m.watchHome()).toEqual([]);
  });

  it("refuses a PA's sandbox with a message that says to update the walls, and creates nothing", async () => {
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
    expect((err as StartupError).message).toContain("install-walls.sh");
    expect(created()).toEqual([]);
    // In the log, and in Setup > Sandboxes
    expect(logs.join("\n")).toContain("install-walls.sh");
    machines.set("inc-home-pip", { ip: "192.168.64.5", state: "running" });
    const status = await m.inspectSandbox("home-pip", { cpus: 2, memory: "4G" });
    expect(status.reason).toContain("install-walls.sh");
    // And any PA launch
    await expect(launchOf(pa).run()).rejects.toThrow(/install-walls\.sh/);
    await expect(m.runIn("inc-home-pip", "true")).rejects.toThrow(/install-walls\.sh/);
    await expect(machineScript(settings, exec)(pa, "true")).rejects.toThrow(/install-walls\.sh/);
    expect(UPDATE_WALLS).toContain("install-walls.sh");
  });

  it("refuses a PA's sandbox in a team of any name, and its retry", async () => {
    const m = make();
    await expect(m.ensureUp("tam")).rejects.toBeInstanceOf(StartupError);
    await m.retrySandbox("home-pip", { cpus: 2, memory: "4G" });
    expect(created()).toEqual([]);
  });

  it("switches over by itself once the new walls write their acknowledgement", async () => {
    const m = make();
    await m.ensureUp("ada");
    await expect(m.ensureUp(pa)).rejects.toBeInstanceOf(StartupError);
    // install-walls.sh runs; the job writes the acknowledgement
    walls = "new";
    wallsJob();
    // An engineers' machine is now checked: its address is not declared yet, so it waits for the daemon's declaration
    await m.ensureUp("ada");
    expect(readDeclared()).toBe("192.168.64.8\n");
    expect(launchOf("ada").run()).toBeInstanceOf(Promise);
    // and the PA's sandbox starts, without root
    await m.ensureUp(pa);
    expect(rooted.has("inc-home-pip")).toBe(false);
  });
});

describe("the watch (every thirty seconds)", () => {
  const grace = 90_000;

  it("declares the running engineers' machines, so a machine that woke is let out", async () => {
    const m = make();
    machines.set("inc-eng", { ip: "192.168.64.9", state: "running" });
    machines.set("inc-old", { ip: "192.168.64.10", state: "stopped" });
    await m.ensureUp(pa);
    expect(await m.watchHome(grace)).toEqual([]);
    expect(readDeclared()).toBe("192.168.64.8\n192.168.64.9\n");
  });

  it("stops a PA's sandbox whose address the walls let out, after the grace, and only that one", async () => {
    const m = make();
    await m.ensureUp(pa);
    setIp("inc-home-pip", "192.168.64.8");
    expect(await m.watchHome(grace)).toEqual([]);
    clock += grace - 1;
    expect(await m.watchHome(grace)).toEqual([]);
    clock += 1;
    expect(await m.watchHome(grace)).toEqual(["inc-home-pip"]);
    expect(machines.get("inc-home-pip")?.state).toBe("stopped");
    expect(machines.get("inc-ada")?.state).toBe("running");
  });

  it("takes root away again if it came back, and stops the sandbox if that does not work", async () => {
    const m = make();
    await m.ensureUp(pa);
    rooted.add("inc-home-pip");
    expect(await m.watchHome(grace)).toEqual([]);
    expect(rooted.has("inc-home-pip")).toBe(false);
    rooted.add("inc-home-pip");
    removeRootWorks = false;
    expect(await m.watchHome(grace)).toEqual(["inc-home-pip"]);
  });
});

describe("containers that are not machines (the image builder, container run)", () => {
  beforeEach(() => {
    containers = [
      "buildkit      ghcr.io/apple/container-builder-shim/builder:0.9.0  linux  arm64  running  192.168.64.3/24",
      "scratch       alpine:3.22                    linux  arm64  running  192.168.64.4/24",
      "stopped-one   alpine:3.22                    linux  arm64  stopped  -",
      "inc-home-pip  img                            linux  arm64  running  192.168.64.5/24",
    ];
  });

  it("are declared with the machines, so `container build` keeps its internet, and a PA's sandbox never is", async () => {
    const m = make();
    await m.ensureUp(pa); // the PA's sandbox is at .5, and so is an inc-… row in the container listing
    expect(readDeclared()).toBe("192.168.64.3\n192.168.64.4\n192.168.64.8\n");
    expect(readDeclared()).not.toContain("192.168.64.5");
    // The watch declares them again as they come and go
    containers = containers.filter((c) => !c.startsWith("scratch"));
    await m.watchHome();
    expect(readDeclared()).toBe("192.168.64.3\n192.168.64.8\n");
  });

  it("are not looked at for a launch's check, which only needs the machine's own address", async () => {
    await make().ensureUp("ada");
    calls.length = 0;
    await assertRunnable(settings, exec, "inc-ada");
    expect(calls.some((c) => c.args[0] === "ls")).toBe(false);
  });

  it("are read from the listing with or without a prefix length, and only while running", () => {
    expect(parseContainerListing(containerListing()).map((r) => [r.name, r.ip])).toEqual([
      ["container:buildkit", "192.168.64.3"],
      ["container:scratch", "192.168.64.4"],
    ]);
    expect(parseContainerListing("ID IMAGE\nbuilder is not running")).toEqual([]);
  });
});

describe("declaring is one look at a time", () => {
  it("a slow look taken before a machine booted can't be written over the look that has it", async () => {
    const m = make();
    await m.ensureUp(pa);
    // The watch starts looking; its snapshot is taken before the new machine exists and is held.
    let release: () => void = () => {};
    hold = { gate: new Promise<void>((r) => (release = r)) };
    const watching = m.watchHome();
    while (hold) await new Promise((r) => setTimeout(r, 0)); // its look has been taken and is parked
    // Meanwhile a machine boots and its address is declared (this waits its turn behind the watch).
    machines.set("inc-new", { ip: "192.168.64.40", state: "running" });
    const waking = settings.wall?.sync(
      async () => (await import("../src/machines.ts")).wallRows(settings, exec, true),
      true,
    );
    // Without a queue the new look would finish and be written before the held one is let go.
    await new Promise((r) => setTimeout(r, 30));
    release();
    await Promise.all([watching, waking]);
    expect(readDeclared()).toContain("192.168.64.40");
  });
});

describe("what the daemon declares", () => {
  it("writes only addresses of the machines' network, sorted, and rewrites nothing that is unchanged", () => {
    const w = new EgressWall(wall, () => clock);
    w.declare(["192.168.64.9", "10.0.0.1", "192.168.64.2", "192.168.64.1", "x; reboot", "192.168.64.9"]);
    expect(readFileSync(wall.declared, "utf8")).toBe("192.168.64.2\n192.168.64.9\n");
    w.declare(["192.168.64.2", "192.168.64.9"]);
    expect(readFileSync(wall.declared, "utf8")).toBe("192.168.64.2\n192.168.64.9\n");
  });

  it("fails clearly when the walls job's folder isn't there", () => {
    rmSync(join(dir, "i-inc"), { recursive: true });
    expect(() => new EgressWall(wall, () => clock).declare(["192.168.64.5"])).toThrow(WallError);
    expect(() => new EgressWall(wall, () => clock).declare(["192.168.64.5"])).toThrow(/install-walls\.sh/);
  });

  it("uses the address pattern walls.sh accepts", () => {
    const script = readFileSync(join(import.meta.dirname, "../../../tools/host/walls.sh"), "utf8");
    const awk = /\/\^(192\\\.168\\\.64\\\.\(.*?\)\$)\/ \{ print/.exec(script)?.[1];
    expect(awk).toBeDefined();
    expect(machineAddress.source.replace("^", "").replace("(?:", "(")).toBe(awk);
  });

  it("names machines the way the walls job's folder and files are named", () => {
    const script = readFileSync(join(import.meta.dirname, "../../../tools/host/walls.sh"), "utf8");
    expect(script).toContain("open-machines");
    expect(script).toContain("i-inc-walls.open");
    expect(isHomeMachine("inc-home-pip")).toBe(true);
    expect(isHomeMachine("inc-homer")).toBe(false);
  });
});

describe("the machine listing's address column", () => {
  it("is read for a running machine and absent for a stopped one", () => {
    machines = new Map([
      ["inc-home-pip", { ip: "192.168.64.5", state: "running" }],
      ["inc-eng", { ip: "192.168.64.7", state: "stopped" }],
    ]);
    const rows = parseMachineListing(listing());
    expect(rows[0]).toMatchObject({ name: "inc-home-pip", state: "running", ip: "192.168.64.5" });
    expect(rows[1]?.ip).toBeUndefined();
  });
});

describe("the script that takes root away", () => {
  it("removes the sudoers grant, the groups that are root in all but name, and leaves an empty file in its place", () => {
    const script = removeRootScript("employee");
    expect(script).toContain('rm -f "/etc/sudoers.d/$user"');
    expect(script).toContain("docker");
    expect(script).toContain("gpasswd -d");
    expect(script).toContain(': >"/etc/sudoers.d/$user"');
    expect(script).toContain("@@no-root");
    expect(rootProbeScript).toContain("sudo -n true");
  });

  // A real run of the script against a folder standing in for /etc, with a `chattr` and an `rm` that model the
  // immutable flag (a marker file; the flag also makes the file read-only, as it blocks writes).
  describe("run twice", () => {
    const run = (dir: string, script: string) => {
      const bin = join(dir, "bin");
      const sudoers = join(dir, "sudoers.d");
      const fake = (name: string, body: string) => {
        writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      };
      fake(
        "chattr",
        'flag="$1"; shift; for f in "$@"; do case "$flag" in +i) touch "$f.immutable"; chmod 444 "$f" ;; -i) rm_real -f "$f.immutable"; chmod 644 "$f" ;; esac; done',
      );
      fake("rm_real", 'exec /bin/rm "$@"');
      fake(
        "rm",
        'for a in "$@"; do case "$a" in -*) ;; *) if [ -e "$a.immutable" ]; then echo "rm: cannot remove \'$a\': Operation not permitted" >&2; exit 1; fi ;; esac; done; exec /bin/rm "$@"',
      );
      fake("getent", "exit 1");
      fake("gpasswd", "exit 0");
      fake("chown", "exit 0");
      const text = script.replaceAll("/etc/sudoers.d", sudoers).replaceAll("/etc/sudoers", join(dir, "sudoers"));
      return spawnSync("/bin/bash", ["-c", text], {
        env: { PATH: `${bin}:/usr/bin:/bin` },
        encoding: "utf8",
      });
    };
    const setup = () => {
      const dir = mkdtempSync(join(tmpdir(), "rm-root-"));
      mkdirSync(join(dir, "bin"));
      mkdirSync(join(dir, "sudoers.d"));
      writeFileSync(join(dir, "sudoers.d", "employee"), "employee ALL=(ALL) NOPASSWD:ALL\n");
      return dir;
    };

    it("succeeds on every run: the second run finds the file immutable and still clears it", () => {
      const dir = setup();
      try {
        for (const n of [1, 2, 3]) {
          const r = run(dir, removeRootScript("employee"));
          expect(r.stderr, `run ${n}`).toBe("");
          expect(r.stdout, `run ${n}`).toContain("@@no-root");
          expect(r.status, `run ${n}`).toBe(0);
          expect(existsSync(join(dir, "sudoers.d", "employee.immutable"))).toBe(true);
          expect(readFileSync(join(dir, "sudoers.d", "employee"), "utf8")).toBe("");
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("the fake is honest: without the chattr -i steps the second run fails", () => {
      const dir = setup();
      try {
        const old = removeRootScript("employee")
          .split("\n")
          .filter((l) => !l.startsWith("chattr -i"))
          .join("\n")
          .replaceAll('chattr -i "$f" 2>/dev/null || true; ', "");
        expect(run(dir, old).status).toBe(0);
        const second = run(dir, old);
        expect(second.status).not.toBe(0);
        expect(second.stderr).toContain("Operation not permitted");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
