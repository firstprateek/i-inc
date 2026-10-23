// T75: one queue per machine. A model of Apple `container` 1.4.1's fault (a `machine stop` and a `machine
// run -n` for one machine at the same moment leave the API server holding its hostname, and every later boot
// fails until the service restarts), and proofs that no interleaving of the daemon's commands can do it.

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Engine } from "@i-inc/core";
import { describe, expect, it } from "vitest";
import { machineScript } from "../src/harness.ts";
import { HISTORY_LEN, MachineBusy, MachineNotRunning, MachineQueue, queueFor } from "../src/machine-queue.ts";
import {
  AppleMachines,
  classifyBootFailure,
  defaultMachineSettings,
  type Exec,
  type MachineSettings,
  machineLaunch,
} from "../src/machines.ts";
import { forgetSweepState, reaper, reapMachines } from "../src/reaper.ts";

const { wallsMarker: _, ...noWalls } = defaultMachineSettings;

/** Lets promise chains run: queue hand-offs take a few microtask turns. */
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

interface Gate {
  /** Resolves once a matching command has started (and is held). */
  reached: Promise<void>;
  /** Lets the held command go on. */
  open: () => void;
}

interface Cmd {
  kind: "ls" | "boot" | "script" | "session" | "stop";
  machine: string;
  /** For a script: its text. */
  input?: string;
}

/**
 * Apple `container` as the live runs on the owner's mini showed it. A machine is stopped or running. A `machine run`
 * on a stopped machine boots it. A `stop` and a `run` for one machine at the same moment (their intervals overlap)
 * leave `stuck` on it, and from then on every boot fails with `hostname(s) already exist` until `restartService()`.
 * (Live, a stop beside a run that was already attached was fine; this model is stricter on purpose, since the
 * queue must make any overlap impossible.)
 */
class AppleFake {
  readonly machines = new Map<string, { state: "running" | "stopped"; stuck: boolean }>();
  /** Every command issued, in order, as `kind:machine[:tag]`. */
  readonly log: string[] = [];
  /** Each time a stop and a run for one machine were both under way. */
  readonly overlaps: string[] = [];
  /** Machines a script (not a boot) started. */
  readonly implicitBoots: string[] = [];
  readonly live = new Map<string, { stops: number; runs: number }>();
  /** The clients started through `spawn`, newest last. */
  readonly children: Ended[] = [];
  private readonly gates: { match: (c: Cmd) => boolean; reached: () => void; open: Promise<void> }[] = [];

  add(name: string, state: "running" | "stopped" = "stopped"): this {
    this.machines.set(name, { state, stuck: false });
    return this;
  }

  /** The machine dies on its own (a crash, `container system stop`, a stop by hand): no daemon command did it. */
  crash(name: string): void {
    const m = this.machines.get(name);
    if (m) m.state = "stopped";
  }

  /** The next boot fails with this message. */
  failNextBoot(message: string): void {
    this.bootFailure = message;
  }

  private bootFailure: string | undefined;

  /** The fault itself, as if a stop and a run had met. */
  stick(name: string): void {
    const m = this.machines.get(name);
    if (m) m.stuck = true;
  }

  restartService(): void {
    for (const m of this.machines.values()) {
      m.stuck = false;
      m.state = "stopped";
    }
  }

  /** Holds the next command that matches until `open()`. */
  hold(match: (c: Cmd) => boolean): Gate {
    let reached!: () => void;
    let open!: () => void;
    const g = {
      match,
      reached: () => reached(),
      open: new Promise<void>((r) => {
        open = r;
      }),
    };
    this.gates.push(g);
    return {
      reached: new Promise<void>((r) => {
        reached = r;
      }),
      open,
    };
  }

  private cmdOf(args: string[], input?: string): Cmd {
    if (args[0] === "machine" && args[1] === "ls") return { kind: "ls", machine: "" };
    if (args[1] === "stop") return { kind: "stop", machine: args[2] as string };
    const machine = args[args.indexOf("-n") + 1] as string;
    if (args.includes("-i")) {
      const launcher = args.at(-1) ?? "";
      return launcher.startsWith("acp-")
        ? { kind: "session", machine }
        : { kind: "script", machine, ...(input !== undefined ? { input } : {}) };
    }
    return { kind: "boot", machine };
  }

  private readonly stateAtStart = new Map<Cmd, "running" | "stopped">();

  private async around(cmd: Cmd, body: () => Promise<string>): Promise<string> {
    this.log.push(`${cmd.kind}:${cmd.machine}${cmd.input ? `:${cmd.input.trim()}` : ""}`);
    const live = this.live.get(cmd.machine) ?? { stops: 0, runs: 0 };
    this.live.set(cmd.machine, live);
    const m = this.machines.get(cmd.machine);
    // A run that found the machine up is attached to it; only one that found it down boots it.
    if (m && !this.stateAtStart.has(cmd)) this.stateAtStart.set(cmd, m.state);
    if (cmd.kind === "stop") live.stops++;
    else live.runs++;
    if (m && live.stops > 0 && live.runs > 0) {
      this.overlaps.push(cmd.machine);
      m.stuck = true;
    }
    try {
      const g = this.gates.findIndex((x) => x.match(cmd));
      if (g >= 0) {
        const [gate] = this.gates.splice(g, 1);
        gate?.reached();
        await gate?.open;
      }
      await Promise.resolve();
      return await body();
    } finally {
      if (cmd.kind === "stop") live.stops--;
      else live.runs--;
    }
  }

  private listing(): string {
    return [
      "NAME  CREATED  IP  CPUS  MEMORY  DISK  STATE  DEFAULT",
      ...[...this.machines].map(
        ([n, m]) => `${n}  2026-10-01 10:00:00  192.168.64.5  6  12G  3.6G  ${m.state}`,
      ),
    ].join("\n");
  }

  /** `container machine run` of any kind, once the client has started. */
  private run(cmd: Cmd, name: string): void {
    const m = this.machines.get(name);
    if (!m) throw new Error(`notFound: ${name}`);
    if (cmd.kind === "boot" && this.bootFailure) {
      const message = this.bootFailure;
      this.bootFailure = undefined;
      throw new Error(message);
    }
    if (this.stateAtStart.get(cmd) === "running") return; // attached to a machine that was up
    if (m.state === "stopped") {
      if (m.stuck) throw new Error(`hostname(s) already exist: ["${name}.machine."]`);
      m.state = "running";
      if (cmd.kind !== "boot") this.implicitBoots.push(name);
    }
  }

  readonly exec: Exec = async (_bin, args, opts) => {
    const cmd = this.cmdOf(args, opts?.input);
    return this.around(cmd, async () => {
      if (cmd.kind === "ls") return this.listing();
      if (cmd.kind === "stop") {
        const m = this.machines.get(cmd.machine);
        if (m) m.state = "stopped";
        return "";
      }
      this.run(cmd, cmd.machine);
      return "";
    });
  };

  /** The `spawn` for scripts and sessions: the client of a `machine run` that lives until `end()`. */
  readonly spawn = (_bin: string, args: string[]): ChildProcessWithoutNullStreams => {
    const stdin = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      end: () => {},
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      killed: false,
      kill: () => {
        child.killed = true;
        return true;
      },
    });
    const finish = () => {
      child.emit("exit", 0);
      child.emit("close", 0);
    };
    let input = "";
    stdin.on("data", (d) => {
      input += d;
    });
    const session = (args.at(-1) ?? "").startsWith("acp-");
    const started = (async () => {
      if (session) {
        const cmd = this.cmdOf(args);
        this.log.push(`session:${cmd.machine}`);
        const live = this.live.get(cmd.machine) ?? { stops: 0, runs: 0 };
        this.live.set(cmd.machine, live);
        live.runs++;
        if (live.stops > 0) this.overlaps.push(cmd.machine);
        (child as unknown as { end: () => void }).end = () => {
          live.runs--;
          finish();
        };
        return;
      }
      await new Promise<void>((r) => stdin.on("end", r));
      await this.exec(_bin, args, { input }).then(
        () => {
          child.stdout.write("done\n");
          finish();
        },
        (err: Error) => {
          child.stderr.write(`${err.message}\n`);
          child.emit("exit", 1);
          child.emit("close", 1);
        },
      );
    })();
    void started;
    this.children.push(child as unknown as Ended);
    return child as unknown as ChildProcessWithoutNullStreams;
  };
}

type Ended = ChildProcessWithoutNullStreams & { end: () => void; killed: boolean };

const engine = { id: "e", harness: "claude-code" } as unknown as Engine;

/** A queue whose stop-wait timers fire only when the test says so. */
function manualQueue(log?: (m: string) => void) {
  const timers: { ms: number; fire: () => void; live: boolean }[] = [];
  const queue = new MachineQueue({
    leaseWaitMs: 30_000,
    timer: (ms, fire) => {
      const t = { ms, fire, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
    ...(log ? { log } : {}),
  });
  return {
    queue,
    timers,
    fireAll: () => {
      for (const t of timers.filter((x) => x.live)) t.fire();
    },
  };
}

function rig(opts: { shared?: boolean; running?: boolean; log?: (m: string) => void } = {}) {
  const fake = new AppleFake().add(
    opts.shared ? "inc-team" : "inc-ada",
    opts.running ? "running" : "stopped",
  );
  const mq = manualQueue(opts.log);
  const s: MachineSettings = {
    ...noWalls,
    queue: mq.queue,
    ...(opts.shared ? { machineFor: () => "inc-team" } : {}),
  };
  const machine = opts.shared ? "inc-team" : "inc-ada";
  const machines = new AppleMachines(s, fake.exec, async () => {}, undefined, opts.log);
  const chore = machineScript(s, fake.exec, undefined, fake.spawn);
  const work = machineScript(s, fake.exec, (id) => machines.ensureUp(id), fake.spawn);
  const launch = machineLaunch(s, fake.spawn, fake.exec);
  return { fake, s, machines, chore, work, launch, machine, ...mq };
}

describe("the model of Apple container", () => {
  it("a concurrent stop and run sticks the hostname; stop, wait, boot does not", async () => {
    const fake = new AppleFake().add("inc-ada", "running");
    const bin = "container";
    await fake.exec(bin, ["machine", "stop", "inc-ada"]);
    await fake.exec(bin, ["machine", "run", "-n", "inc-ada", "--", "true"]);
    expect(fake.machines.get("inc-ada")).toEqual({ state: "running", stuck: false });
    expect(fake.overlaps).toEqual([]);

    // the bug: both at once
    await Promise.all([
      fake.exec(bin, ["machine", "stop", "inc-ada"]),
      fake.exec(bin, ["machine", "run", "-i", "-u", "employee", "-n", "inc-ada", "--", "bash", "-s"], {
        input: "echo",
      }),
    ]);
    expect(fake.overlaps).toEqual(["inc-ada"]);
    // every later boot fails the way the mini's did, until the service restarts
    await expect(fake.exec(bin, ["machine", "run", "-n", "inc-ada", "--", "true"])).rejects.toThrow(
      /hostname\(s\) already exist/,
    );
    expect(classifyBootFailure(new Error('hostname(s) already exist: ["inc-ada.machine."]')).kind).toBe(
      "stale-hostname",
    );
    fake.restartService();
    await fake.exec(bin, ["machine", "run", "-n", "inc-ada", "--", "true"]);
    expect(fake.machines.get("inc-ada")?.state).toBe("running");
  });

  it("without the queue, an idle stop beside a brain collect breaks the next boot (the failure being fixed)", async () => {
    const fake = new AppleFake().add("inc-ada", "running");
    const bin = "container";
    await Promise.all([
      fake.exec(bin, ["machine", "stop", "inc-ada"]),
      fake.exec(bin, ["machine", "run", "-i", "-u", "employee", "-n", "inc-ada", "--", "bash", "-s"], {
        input: "collect",
      }),
    ]);
    const m = new AppleMachines(noWalls, fake.exec, async () => {});
    await expect(m.ensureUp("ada")).rejects.toThrow();
    expect(fake.machines.get("inc-ada")?.stuck).toBe(true);
  });
});

describe("the queue itself", () => {
  it("runs uses together, a serial hold alone among serials, and a stop alone", async () => {
    const q = new MachineQueue();
    const order: string[] = [];
    const gate = (): { p: Promise<void>; go: () => void } => {
      let go!: () => void;
      return {
        p: new Promise<void>((r) => {
          go = r;
        }),
        go,
      };
    };
    const a = gate();
    const b = gate();
    const c = gate();
    const u1 = q.use("m", "u1", async () => {
      order.push("u1 start");
      await a.p;
      order.push("u1 end");
    });
    const u2 = q.use("m", "u2", async () => {
      order.push("u2 start");
      await b.p;
      order.push("u2 end");
    });
    const st = q.stop("m", "stop", async () => {
      order.push("stop");
      await c.p;
    });
    const u3 = q.use("m", "u3", async () => {
      order.push("u3");
    });
    await settle();
    // both uses started together; the stop waits for them, and u3 waits behind the stop
    expect(order).toEqual(["u1 start", "u2 start"]);
    a.go();
    await settle();
    expect(order).toEqual(["u1 start", "u2 start", "u1 end"]);
    b.go();
    await settle();
    expect(order).toEqual(["u1 start", "u2 start", "u1 end", "u2 end", "stop"]);
    c.go();
    await Promise.all([u1, u2, st, u3]);
    expect(order.at(-1)).toBe("u3");
    expect(q.idle).toBe(true);
  });

  it("serial holds run one at a time, beside uses", async () => {
    const q = new MachineQueue();
    const order: string[] = [];
    let go1!: () => void;
    const s1 = q.serial("m", "s1", async () => {
      order.push("s1 start");
      await new Promise<void>((r) => {
        go1 = r;
      });
      order.push("s1 end");
    });
    const s2 = q.serial("m", "s2", async () => {
      order.push("s2");
    });
    const u = q.use("m", "u", async () => {
      order.push("u");
    });
    await settle();
    // s2 is first in line behind s1, and u is behind s2 (first come, first served)
    expect(order).toEqual(["s1 start"]);
    go1();
    await Promise.all([s1, s2, u]);
    expect(order).toEqual(["s1 start", "s1 end", "s2", "u"]);
  });

  it("keeps the last five operations of a machine, with their timestamps and how they ended", async () => {
    let t = 1_000;
    const q = new MachineQueue({ now: () => t++ });
    for (let i = 0; i < 7; i++) await q.use("m", `op${i}`, async () => {});
    await q
      .serial("m", "bad", async () => {
        throw new Error("boom");
      })
      .catch(() => {});
    const h = q.history("m");
    expect(h).toHaveLength(HISTORY_LEN);
    expect(h.map((o) => o.label)).toEqual(["op3", "op4", "op5", "op6", "bad"]);
    expect(h.at(-1)?.result).toBe("boom");
    expect(h.every((o) => typeof o.at === "number" && typeof o.endedAt === "number")).toBe(true);
    expect(q.describeHistory("m")).toContain("serial(bad)");
    expect(q.describeHistory("nothing")).toBe("none");
  });

  it("gives each settings object one queue, shared by what is built from it", () => {
    const s = { ...noWalls };
    expect(queueFor(s)).toBe(queueFor(s));
    expect(queueFor({ ...noWalls })).not.toBe(queueFor(s));
  });
});

describe("a stop and any other command for one machine never overlap", () => {
  it("a sleepIdle stop vs a brain collect, in either order", async () => {
    const r = rig();
    await r.machines.ensureUp("ada");
    expect(r.fake.machines.get(r.machine)?.state).toBe("running");

    // the collect is under way when the idle stop comes
    const collect = r.fake.hold((c) => c.kind === "script");
    const done = r.chore("ada", "collect");
    await collect.reached;
    const stopping = r.machines.stop("ada");
    await settle();
    expect(r.fake.log.filter((l) => l.startsWith("stop:"))).toEqual([]); // waits for the collect to end
    collect.open();
    expect((await done).code).toBe(0);
    await stopping;
    expect(r.fake.log.at(-1)).toBe("stop:inc-ada");
    expect(r.fake.overlaps).toEqual([]);

    // and the stop is under way when the next collect comes: the collect is held back, then finds the machine down
    await r.machines.ensureUp("ada");
    const hold = r.fake.hold((c) => c.kind === "stop");
    const stop2 = r.machines.stop("ada");
    await hold.reached;
    const logBefore = r.fake.log.length;
    const late = r.chore("ada", "collect again").then(
      () => "ran",
      (e: unknown) => (e instanceof MachineNotRunning ? "skipped" : String(e)),
    );
    await settle();
    expect(r.fake.log.length).toBe(logBefore); // nothing was issued beside the stop
    hold.open();
    await stop2;
    expect(await late).toBe("skipped");
    expect(r.fake.overlaps).toEqual([]);
    expect(r.fake.implicitBoots).toEqual([]);
    // the hostname is not stuck: the next boot works
    await r.machines.ensureUp("ada");
    expect(r.fake.machines.get(r.machine)).toEqual({ state: "running", stuck: false });
  });

  it("a reaper sweep vs a stop", async () => {
    const r = rig();
    await r.machines.ensureUp("ada");
    forgetSweepState();
    const sweep = r.fake.hold((c) => c.kind === "script");
    const swept = reapMachines(r.machines, undefined, { all: true });
    await sweep.reached;
    const stopping = r.machines.stop("ada");
    await settle();
    expect(r.fake.log.filter((l) => l.startsWith("stop:"))).toEqual([]);
    sweep.open();
    await Promise.all([swept, stopping]);
    expect(r.fake.overlaps).toEqual([]);

    // a sweep that starts while a stop is under way finds the machine down and leaves it alone
    await r.machines.ensureUp("ada");
    const hold = r.fake.hold((c) => c.kind === "stop");
    const stop2 = r.machines.stop("ada");
    await hold.reached;
    const lateSweep = reapMachines(r.machines, undefined, { all: true });
    await settle();
    hold.open();
    await Promise.all([lateSweep, stop2]);
    expect(r.fake.overlaps).toEqual([]);
    expect(r.fake.implicitBoots).toEqual([]);
    expect(r.fake.log.filter((l) => l.startsWith("script:")).length).toBe(1);
  });

  it("a conversation's boot vs an idle stop, on a sandbox two employees share", async () => {
    const r = rig({ shared: true });
    await r.machines.ensureUp("ada");

    // the idle stop for ada is under way when bob's conversation asks for the sandbox: bob waits, then boots it
    const hold = r.fake.hold((c) => c.kind === "stop");
    const idle = r.machines.stop("ada");
    await hold.reached;
    const conversation = r.machines.ensureUp("bob");
    await settle();
    expect(r.fake.log.filter((l) => l.startsWith("boot:")).length).toBe(1); // only ada's first boot so far
    hold.open();
    await Promise.all([idle, conversation]);
    expect(r.fake.overlaps).toEqual([]);
    expect(r.fake.machines.get("inc-team")).toEqual({ state: "running", stuck: false });
    expect(r.machines.running()).toEqual(["bob"]);

    // bob's conversation comes first: ada's stop finds him there and leaves the machine running
    const before = r.fake.log.filter((l) => l.startsWith("stop:")).length;
    await r.machines.ensureUp("ada");
    await r.machines.stop("ada");
    expect(r.fake.log.filter((l) => l.startsWith("stop:")).length).toBe(before);
    expect(r.fake.machines.get("inc-team")?.state).toBe("running");
  });

  it("shutdown vs an in-flight script: the machine is not stopped under it, nor after it", async () => {
    const r = rig();
    await r.machines.ensureUp("ada");
    const script = r.fake.hold((c) => c.kind === "script");
    const inFlight = r.chore("ada", "collect");
    await script.reached;

    // a stop is already waiting for the script when the daemon is told to leave
    const waiting = r.machines.stop("ada");
    await settle();
    r.machines.closeQueue();
    await expect(waiting).rejects.toBeInstanceOf(MachineBusy);
    // and nothing asks for a stop after that: neither one employee's, nor the walls' down-stop
    await expect(r.machines.stop("ada")).rejects.toBeInstanceOf(MachineBusy);
    expect(await r.machines.stopAll()).toEqual([]);
    script.open();
    expect((await inFlight).code).toBe(0);
    // the sweep at shutdown still runs, and the machine is left up for the next daemon to adopt
    forgetSweepState();
    await reapMachines(r.machines, undefined, { all: true });
    expect(r.fake.log.filter((l) => l.startsWith("stop:"))).toEqual([]);
    expect(r.fake.overlaps).toEqual([]);
    expect(r.fake.machines.get(r.machine)?.state).toBe("running");
    expect(r.machines.running()).toEqual(["ada"]);
  });

  it("startup: adoption and the first chores are queued behind a stop", async () => {
    const r = rig({ running: true }); // left running by the last daemon
    const sweep = r.fake.hold((c) => c.kind === "script");
    const resign = r.machines.runIn(r.machine, "sign out");
    await sweep.reached;
    const adopting = r.machines.adopt(["ada"]); // serial: beside the script, not through it
    expect(await adopting).toEqual(["ada"]);
    const idle = r.machines.stop("ada"); // the first tick's idle pass
    await settle();
    expect(r.fake.log.filter((l) => l.startsWith("stop:"))).toEqual([]);
    sweep.open();
    await Promise.all([resign, idle]);
    expect(r.fake.overlaps).toEqual([]);
  });
});

describe("no implicit boots", () => {
  it("no chore starts a stopped machine", async () => {
    const r = rig();
    const asked: string[] = [];
    // every chore the daemon has, against a machine that is stopped
    const results = await Promise.allSettled([
      r.chore("ada", "brain collect"),
      r.machines.runIn(r.machine, "storage clean"),
      r.machines.deliverCallback("ada", "http://localhost/cb"),
      r.machines.updateLauncher(r.machine),
      r.machines.inspectSandbox("ada", { cpus: 6, memory: "12G" }),
      reapMachines(r.machines),
      reaper(r.chore, (m) => asked.push(m))("ada"),
      r.chore("ada", "sign out", {}, { machine: r.machine }),
    ]);
    expect(results.map((x) => x.status)).toEqual([
      "rejected",
      "rejected",
      "rejected",
      "fulfilled",
      "fulfilled",
      "fulfilled",
      "fulfilled",
      "rejected",
    ]);
    for (const i of [0, 1, 2, 7]) {
      expect((results[i] as PromiseRejectedResult).reason).toBeInstanceOf(MachineNotRunning);
    }
    expect((results[3] as PromiseFulfilledResult<string>).value).toBe("skipped");
    expect(asked).toEqual([]); // a stopped machine has no leftover agent, and the reaper says nothing
    expect(r.fake.log.filter((l) => l.startsWith("script:") || l.startsWith("boot:"))).toEqual([]);
    expect(r.fake.implicitBoots).toEqual([]);
    expect(r.fake.machines.get(r.machine)?.state).toBe("stopped");
  });

  it("a launch does not start a stopped machine either", async () => {
    const r = rig();
    await expect(r.launch({ employeeId: "ada", engine, cwd: "/w", env: {} })).rejects.toBeInstanceOf(
      MachineNotRunning,
    );
    expect(r.fake.log.filter((l) => l.startsWith("session:"))).toEqual([]);
    expect(r.queue.leases(r.machine)).toBe(0);
  });

  it("work that needs the machine brings it up explicitly, through the queue, and then runs", async () => {
    const r = rig();
    const out = await r.work("ada", "run the checks");
    expect(out.code).toBe(0);
    expect(r.fake.log.filter((l) => l !== "ls:")).toEqual(["boot:inc-ada", "script:inc-ada:run the checks"]);
    expect(r.fake.implicitBoots).toEqual([]); // the boot was ensureUp's, not the script's
    expect(r.machines.running()).toEqual(["ada"]);
    // a machine the employee does not own is not booted for them
    r.fake.add("inc-old");
    await expect(r.work("ada", "x", {}, { machine: "inc-old" })).rejects.toBeInstanceOf(MachineNotRunning);
    expect(r.fake.machines.get("inc-old")?.state).toBe("stopped");
  });
});

describe("leases", () => {
  it("a running session blocks the idle stop; the stop gives up after its wait, without killing anything", async () => {
    const logs: string[] = [];
    const r = rig({ log: (m) => logs.push(m) });
    await r.machines.ensureUp("ada");
    await r.launch({ employeeId: "ada", engine, cwd: "/w", env: {} });
    const session = r.fake.children.at(-1) as Ended;
    expect(r.queue.leases(r.machine)).toBe(1);

    const stopping = r.machines.stop("ada");
    const outcome = stopping.then(
      () => "stopped",
      (e: unknown) => (e instanceof MachineBusy ? "busy" : String(e)),
    );
    await settle();
    expect(r.fake.log.filter((l) => l.startsWith("stop:"))).toEqual([]);
    // new work waits behind the waiting stop (first come, first served), so the stop is not starved
    let lateRan = false;
    const late = r.chore("ada", "late chore").then(() => {
      lateRan = true;
    });
    await settle();
    expect(lateRan).toBe(false);

    // the wait runs out (the timer is the test's)
    expect(r.timers.filter((t) => t.live).map((t) => t.ms)).toEqual([30_000]);
    r.fireAll();
    expect(await outcome).toBe("busy");
    expect(logs.some((l) => /not stopped: 1 lease/.test(l))).toBe(true);
    // nothing was stopped or killed, and the employee is still recorded as working in it
    expect(r.fake.log.filter((l) => l.startsWith("stop:"))).toEqual([]);
    expect(session.killed).toBe(false);
    expect(r.fake.machines.get(r.machine)?.state).toBe("running");
    expect(r.machines.running()).toEqual(["ada"]);
    await late; // the held-back chore ran once the stop gave up
    expect(lateRan).toBe(true);

    // when the session ends, the next idle pass stops it
    session.end();
    await settle();
    expect(r.queue.leases(r.machine)).toBe(0);
    await r.machines.stop("ada");
    expect(r.fake.log.filter((l) => l.startsWith("stop:"))).toEqual(["stop:inc-ada"]);
    expect(r.fake.overlaps).toEqual([]);
  });

  it("the stop goes ahead as soon as the last lease ends, before its wait is over", async () => {
    const r = rig();
    await r.machines.ensureUp("ada");
    await r.launch({ employeeId: "ada", engine, cwd: "/w", env: {} });
    const session = r.fake.children.at(-1) as Ended;
    const stopping = r.machines.stop("ada");
    await settle();
    session.end();
    await stopping;
    expect(r.fake.log.filter((l) => l.startsWith("stop:"))).toEqual(["stop:inc-ada"]);
    expect(r.timers.filter((t) => t.live)).toEqual([]); // its timer was cancelled
    expect(r.fake.overlaps).toEqual([]);
  });

  it("the container service's restart waits for the queue to be empty", async () => {
    const r = rig();
    await r.machines.ensureUp("ada");
    expect(r.queue.idle).toBe(true);
    await r.launch({ employeeId: "ada", engine, cwd: "/w", env: {} });
    const session = r.fake.children.at(-1) as Ended;
    expect(r.queue.idle).toBe(false);
    session.end();
    await settle();
    expect(r.queue.idle).toBe(true);
  });
});

describe("a stuck hostname is logged with the machine's last queue operations", () => {
  it("names the last five operations, with their times, when a boot hits a stale hostname", async () => {
    const logs: string[] = [];
    const r = rig({ log: (m) => logs.push(m) });
    await r.machines.ensureUp("ada");
    await r.machines.stop("ada");
    await r.chore("ada", "x").catch(() => {});
    r.fake.stick(r.machine); // however it came about
    await expect(r.machines.ensureUp("ada")).rejects.toThrow();
    const line = logs.find((l) => l.includes("STALE HOSTNAME"));
    expect(line).toBeDefined();
    expect(line).toContain("inc-ada");
    expect(line).toContain(`last ${HISTORY_LEN} queue operations`);
    // ensureUp (its own hold, still under way), the stop, the release before it, and the earlier boot
    expect(line).toMatch(/serial\(ensureUp\) started \d\d:\d\d:\d\d\.\d{3}/);
    expect(line).toMatch(/stop\(idle\) started \d\d:\d\d:\d\d\.\d{3}, ended \d\d:\d\d:\d\d\.\d{3} ok/);
    expect((line?.match(/started/g) ?? []).length).toBeLessThanOrEqual(HISTORY_LEN);
  });
});

describe("a machine stopped out of band", () => {
  it("is booted again by the next start, instead of being trusted as up for ever", async () => {
    const logs: string[] = [];
    const r = rig({ log: (m) => logs.push(m) });
    await r.machines.ensureUp("ada");
    r.fake.crash(r.machine); // `container system stop`, a crash, a stop by hand
    // before the fix: the stale record made ensureUp return, and every script failed with "isn't running"
    await expect(r.chore("ada", "x")).rejects.toBeInstanceOf(MachineNotRunning);
    await r.machines.ensureUp("ada");
    expect(r.fake.machines.get(r.machine)?.state).toBe("running");
    expect(r.fake.log.filter((l) => l.startsWith("boot:"))).toHaveLength(2);
    expect((await r.chore("ada", "y")).code).toBe(0);
    expect(r.machines.running()).toEqual(["ada"]);
    expect(logs.some((l) => /not running \(stopped out of band\)/.test(l))).toBe(true);
    // and work that needs the machine brings it up by itself the same way
    r.fake.crash(r.machine);
    expect((await r.work("ada", "z")).code).toBe(0);
    expect(r.fake.implicitBoots).toEqual([]);
  });
});

describe("the boot recovery's stop", () => {
  it("is not issued while a script or session holds a lease on the machine", async () => {
    const r = rig({ running: true });
    await r.launch({ employeeId: "ada", engine, cwd: "/w", env: {} }); // a session, though nothing recorded the machine as up
    r.fake.failNextBoot("boom");
    await expect(r.machines.ensureUp("ada")).resolves.toBeUndefined(); // the retry's boot works
    expect(r.fake.log.filter((l) => l.startsWith("stop:"))).toEqual([]);
    expect(r.fake.overlaps).toEqual([]);
  });

  it("is issued, as before, when nothing holds a lease", async () => {
    const r = rig();
    r.fake.failNextBoot("boom");
    await r.machines.ensureUp("ada");
    expect(r.fake.log.filter((l) => l.startsWith("stop:"))).toEqual(["stop:inc-ada"]);
  });
});

describe("a machine the walls refused, at shutdown", () => {
  it("is still stopped, through the queue; any other stop is not", async () => {
    const q = new MachineQueue();
    const order: string[] = [];
    let end!: () => void;
    const busy = q.use("m", "script", () => new Promise<void>((r) => (end = r)));
    const forced = q.stop("m", "walls refused it", async () => void order.push("forced"), {
      whenClosed: true,
    });
    const plain = q.stop("m", "idle", async () => void order.push("plain"));
    await settle();
    q.close();
    await expect(plain).rejects.toBeInstanceOf(MachineBusy); // the waiting one gave up
    expect(order).toEqual([]);
    end();
    await Promise.all([busy, forced]);
    expect(order).toEqual(["forced"]); // after the script, not beside it
    await expect(q.stop("m", "later", async () => {})).rejects.toBeInstanceOf(MachineBusy);
    await q.stop("m", "refused later", async () => void order.push("forced 2"), { whenClosed: true });
    expect(order).toEqual(["forced", "forced 2"]);
  });

  it("is stopped by ensureUp even though the daemon is leaving", async () => {
    const r = rig();
    await r.machines.ensureUp("ada");
    r.machines.closeQueue();
    (r.machines as unknown as { stopAfter: Set<string> }).stopAfter.add(r.machine); // what a refused boot leaves
    await r.machines.ensureUp("ada");
    expect(r.fake.log.filter((l) => l.startsWith("stop:"))).toEqual(["stop:inc-ada"]);
  });
});

describe("leased", () => {
  it("says whether a script or session runs in the employee's machine", async () => {
    const r = rig();
    await r.machines.ensureUp("ada");
    expect(r.machines.leased("ada")).toBe(false);
    await r.launch({ employeeId: "ada", engine, cwd: "/w", env: {} });
    expect(r.machines.leased("ada")).toBe(true);
    r.fake.children.at(-1)?.end();
    await settle();
    expect(r.machines.leased("ada")).toBe(false);
  });
});
