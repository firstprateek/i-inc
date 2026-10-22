// The home machines' egress wall, from the daemon's side (spec §5 and §7).
//
// A personal assistant works in a sandbox of its own (its team's, normally home-<id>), and that sandbox
// must reach nothing but Ollama on the host. Apple container 1.4.1 puts every machine on the one `default`
// network (`machine create` has no --network option), so the wall is a pf table of the machines'
// addresses, kept by tools/host/walls.sh as root (tools/m1/pf/i-inc-machines.pf):
//
//   1. the daemon reads a home machine's address from `container machine ls` and writes the
//      addresses of all home machines to `declared` (/var/run/i-inc/home-machines);
//   2. walls.sh, at once (launchd watches the file) or within a minute, validates them, loads them
//      into the table, reads the table back from pf and writes it to `ack` (/var/run/i-inc-walls.home),
//      rewriting that file every minute;
//   3. nothing starts in a home machine until its address is in a fresh `ack`: before every launch
//      (`assertCovered`), and a running home machine that stays out of it is stopped (`AppleMachines.watchHome`).
//
// Until step 2 has happened for a machine's current address, it is not walled, so step 3 is what makes
// the wall fail closed: no home data, no brain and no agent goes into the machine in that time.
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * A PA's team is normally home-<id> (spec §5), so its machine is inc-home-<id>. Any machine named so
 * counts as a home machine whatever is in it; a machine that holds a PA under another team name
 * counts too (MachineSettings.homeMachine).
 */
export const HOME_MACHINE_PREFIX = "inc-home-";

export const isHomeMachine = (machine: string): boolean => machine.startsWith(HOME_MACHINE_PREFIX);

/** An address of the machines' network (192.168.64.0/24) that a machine can have: what walls.sh accepts. */
export const machineAddress = /^192\.168\.64\.(?:[2-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-4])$/;

export interface HomeWallSettings {
  /** Where the daemon lists the home machines' addresses for walls.sh (a folder walls.sh makes for the owner). */
  declared: string;
  /** Where walls.sh writes the addresses pf holds as home machines, and rewrites every minute. */
  ack: string;
  /** How old the acknowledgement may be (walls.sh runs every minute). */
  ackMaxAgeMs: number;
  /** How long a machine may wait for its address to be acknowledged. */
  waitMs: number;
  /** How often to look while waiting. */
  pollMs: number;
}

export const defaultHomeWallSettings: HomeWallSettings = {
  declared: "/var/run/i-inc/home-machines",
  ack: "/var/run/i-inc-walls.home",
  ackMaxAgeMs: 120_000,
  waitMs: 90_000,
  pollMs: 2_000,
};

/** The home wall isn't there (yet) for a machine: what the owner sees, and what a launch is refused with. */
export class HomeWallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HomeWallError";
  }
}

const FIX = "run `sudo sh tools/host/install-walls.sh` on the Mac mini (docs/handoff.md, T66)";

export class HomeWall {
  /** The address each home machine had when it was last checked and found covered. */
  private readonly verified = new Map<string, string>();
  /** When a running home machine was first seen outside the acknowledgement. */
  private readonly uncovered = new Map<string, number>();

  constructor(
    readonly s: HomeWallSettings = defaultHomeWallSettings,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The addresses walls.sh says it holds, or null when the file is missing or older than
   * `ackMaxAgeMs` (the job has stopped, or isn't installed).
   */
  acknowledged(): Set<string> | null {
    try {
      const age = this.now() - statSync(this.s.ack).mtimeMs;
      if (age >= this.s.ackMaxAgeMs) return null;
      return new Set(
        readFileSync(this.s.ack, "utf8")
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
      );
    } catch {
      return null;
    }
  }

  /** Whether the acknowledgement file exists at all, old or not (a job that was never installed has none). */
  private ackExists(): boolean {
    try {
      statSync(this.s.ack);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Synchronous, for every launch: the machine's address was found covered, and the acknowledgement
   * still is fresh and still has it. Throws otherwise.
   */
  assertCovered(machine: string): void {
    const ip = this.verified.get(machine);
    if (!ip) {
      throw new HomeWallError(
        `${machine} is a home machine, and its wall hasn't been checked yet, so nothing runs in it (the daemon checks it when it starts the machine)`,
      );
    }
    const ack = this.acknowledged();
    if (!ack) {
      throw new HomeWallError(
        `the walls job hasn't confirmed the home wall in the last two minutes, so nothing runs in ${machine}: ${FIX}`,
      );
    }
    if (!ack.has(ip)) {
      this.verified.delete(machine);
      throw new HomeWallError(`the walls don't cover ${machine} (${ip}), so nothing runs in it`);
    }
  }

  /** Writes the home machines' addresses where walls.sh reads them. Only addresses of the network are written. */
  declare(addresses: string[]): void {
    const clean = [...new Set(addresses.filter((a) => machineAddress.test(a)))].sort();
    const body = clean.map((a) => `${a}\n`).join("");
    let current: string | undefined;
    try {
      current = readFileSync(this.s.declared, "utf8");
    } catch {
      current = undefined;
    }
    if (current === body) return;
    // Written beside the file and renamed over it, so walls.sh never reads half a list.
    const tmp = join(dirname(this.s.declared), `.home-machines.${process.pid}.tmp`);
    try {
      writeFileSync(tmp, body, { mode: 0o644 });
      renameSync(tmp, this.s.declared);
    } catch (err) {
      throw new HomeWallError(
        `can't write ${this.s.declared} (${err instanceof Error ? err.message : String(err)}), so the walls can't be told about the home machines: ${FIX}`,
      );
    }
  }

  /** Forget a machine (it stopped): its address is free for another machine to take. */
  forget(machine: string): void {
    this.verified.delete(machine);
    this.uncovered.delete(machine);
  }

  /**
   * Declares the home machines, then waits for the acknowledgement of this one's address. Throws a
   * HomeWallError if it doesn't come, or can't, and the caller stops the machine.
   * `homes` is every home machine with its address (from `machine ls`), as the caller defines them.
   */
  async verify(
    machine: string,
    homes: () => Promise<{ name: string; state: string; ip?: string }[]>,
    sleep: (ms: number) => Promise<void>,
  ): Promise<void> {
    this.verified.delete(machine);
    const deadline = this.now() + this.s.waitMs;
    let declared = "";
    for (;;) {
      const rows = await homes();
      const mine = rows.find((r) => r.name === machine);
      if (mine?.state !== "running" || !mine.ip || !machineAddress.test(mine.ip)) {
        throw new HomeWallError(`${machine} has no address on the machines' network, so it can't be walled`);
      }
      const addresses = rows.filter((r) => r.state === "running" && r.ip).map((r) => r.ip as string);
      if (addresses.join() !== declared) {
        this.declare(addresses);
        declared = addresses.join();
      }
      const ack = this.acknowledged();
      if (ack?.has(mine.ip)) {
        this.verified.set(machine, mine.ip);
        this.uncovered.delete(machine);
        return;
      }
      // No acknowledgement file at all, or one that has gone stale: the job isn't running, and
      // waiting a minute and a half won't change that.
      if (!ack) {
        throw new HomeWallError(
          this.ackExists()
            ? `the walls job hasn't confirmed the home wall in the last two minutes, so ${machine} is stopped: ${FIX}`
            : `the walls job doesn't know about home machines yet, so ${machine} is stopped: ${FIX}`,
        );
      }
      if (this.now() >= deadline) {
        throw new HomeWallError(
          `the walls didn't cover ${machine} (${mine.ip}) within ${Math.round(this.s.waitMs / 1000)} s, so it is stopped: ${FIX}`,
        );
      }
      await sleep(this.s.pollMs);
    }
  }

  /**
   * What the daemon's watch does with one look at the home machines (the caller picks them out): records
   * covered ones, declares the addresses, and returns the running home machines that have been outside the acknowledgement for
   * longer than `graceMs` (the caller stops them).
   */
  watch(rows: { name: string; state: string; ip?: string }[], graceMs: number): string[] {
    const homes = rows;
    try {
      this.declare(homes.filter((r) => r.state === "running" && r.ip).map((r) => r.ip as string));
    } catch {
      // The walls job isn't there to tell: nothing is acknowledged, and the grace below runs out.
    }
    const ack = this.acknowledged();
    const stop: string[] = [];
    const seen = new Set<string>();
    for (const r of homes) {
      if (r.state !== "running") {
        this.forget(r.name);
        continue;
      }
      seen.add(r.name);
      if (r.ip && ack?.has(r.ip)) {
        this.verified.set(r.name, r.ip);
        this.uncovered.delete(r.name);
        continue;
      }
      this.verified.delete(r.name);
      const since = this.uncovered.get(r.name) ?? this.now();
      this.uncovered.set(r.name, since);
      if (this.now() - since >= graceMs) stop.push(r.name);
    }
    for (const name of [...this.uncovered.keys()]) if (!seen.has(name)) this.uncovered.delete(name);
    return stop;
  }
}
