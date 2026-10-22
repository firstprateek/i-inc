// The machines' egress wall, from the daemon's side (spec §5 and §7).
//
// Closed unless opened. Apple container 1.4.1 puts every machine on the one `default` network
// (`machine create` has no --network option), so the walls can't tell a machine's kind by its
// network. The pf rules (tools/m1/pf/i-inc-machines.pf) let a machine out only if its address is in
// the table <open_machines>; every other address, including a personal assistant's sandbox, gets only
// DHCP and Ollama. The table is kept by tools/host/walls.sh as root:
//
//   1. the daemon reads each machine's address from `container machine ls` and writes the addresses of
//      the running machines that may reach the internet (every machine but a PA's sandbox) to
//      `declared` (/var/run/i-inc/open-machines);
//   2. walls.sh, at once (launchd watches the file) or within a minute, validates them, loads them
//      into the table, reads the table back from pf and writes it to `ack` (/var/run/i-inc-walls.open),
//      rewriting that file every minute;
//   3. nothing starts in a machine until its live address is where it should be in that file: in it for
//      an engineers' machine (or it has no internet), not in it for a PA's sandbox. That is checked before
//      every launch (`assertRunnable` in machines.ts), and `AppleMachines.watchHome` stops a PA's sandbox
//      whose address is in it.
//
// A PA's sandbox is also stripped of root (machines.ts): with sudo it could give itself an address that
// is in the table.
//
// Rollout: the daemon deploys itself, but the new rules arrive only when the owner runs
// `sudo sh tools/host/install-walls.sh`. Until `ack` exists, the walls are the old ones, and the
// daemon runs engineers' machines as it always did, and refuses PA sandboxes with a message that says to
// update the walls. Once it exists, the new rules are assumed to be loaded.
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** A PA's team is normally home-<id> (spec §5), so its machine is inc-home-<id>: always a home machine. */
export const HOME_MACHINE_PREFIX = "inc-home-";

export const isHomeMachine = (machine: string): boolean => machine.startsWith(HOME_MACHINE_PREFIX);

/** An address of the machines' network (192.168.64.0/24) that a machine can have: what walls.sh accepts. */
export const machineAddress = /^192\.168\.64\.(?:[2-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-4])$/;

export interface EgressWallSettings {
  /** Where the daemon lists the open machines' addresses for walls.sh (a folder walls.sh makes for the owner). */
  declared: string;
  /** Where walls.sh writes the addresses pf lets out, and rewrites every minute. */
  ack: string;
  /** How old the acknowledgement may be (walls.sh runs every minute). */
  ackMaxAgeMs: number;
  /** How long a machine may wait for its address to be acknowledged. */
  waitMs: number;
  /** How often to look while waiting. */
  pollMs: number;
}

export const defaultEgressWallSettings: EgressWallSettings = {
  declared: "/var/run/i-inc/open-machines",
  ack: "/var/run/i-inc-walls.open",
  ackMaxAgeMs: 120_000,
  waitMs: 90_000,
  pollMs: 2_000,
};

/** What the walls job says: no acknowledgement ever (the old walls), a stale one, or the addresses it lets out. */
export type WallState = { kind: "old" } | { kind: "stale" } | { kind: "ok"; open: Set<string> };

/** The wall isn't there (yet) for a machine: what the owner sees, and what a launch is refused with. */
export class WallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WallError";
  }
}

export const UPDATE_WALLS =
  "the walls need updating: run `sudo sh tools/host/install-walls.sh` on the Mac mini (docs/handoff.md, T66)";
const STALE_WALLS =
  "the walls job hasn't confirmed the walls in the last two minutes (see /var/log/i-inc-walls.log on the Mac mini)";

/** A machine as `machine ls` shows it, for the wall: `home` says whether it is a PA's sandbox. */
export interface WallRow {
  name: string;
  state: string;
  ip?: string;
  home: boolean;
}

export class EgressWall {
  constructor(
    readonly s: EgressWallSettings = defaultEgressWallSettings,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether the walls job has ever acknowledged (new walls), and what it holds. */
  state(): WallState {
    let age: number;
    try {
      age = this.now() - statSync(this.s.ack).mtimeMs;
    } catch {
      return { kind: "old" };
    }
    if (age >= this.s.ackMaxAgeMs) return { kind: "stale" };
    try {
      const open = new Set(
        readFileSync(this.s.ack, "utf8")
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
      );
      return { kind: "ok", open };
    } catch {
      return { kind: "stale" };
    }
  }

  /**
   * Whether the walls job's state alone rules a machine out: the old walls (no acknowledgement ever) rule out
   * a home machine, and a stale acknowledgement anything. Null otherwise.
   */
  stateProblem(machine: string, home: boolean): string | null {
    const st = this.state();
    if (st.kind === "old") return home ? `${machine} is a home machine, and ${UPDATE_WALLS}` : null;
    if (st.kind === "stale") return `nothing runs in ${machine}: ${STALE_WALLS}`;
    return null;
  }

  /**
   * Why a machine, found at this live address, may not have anything run in it, or null when it may.
   * With the old walls an engineers' machine always may (nothing else was ever checked) and a home
   * machine never.
   */
  problem(machine: string, home: boolean, row: Pick<WallRow, "state" | "ip"> | undefined): string | null {
    const early = this.stateProblem(machine, home);
    if (early) return early;
    const st = this.state();
    if (st.kind !== "ok") return null; // the old walls, for an engineers' machine
    if (row?.state !== "running") return `${machine} isn't running, so nothing is run in it`;
    if (!row.ip || !machineAddress.test(row.ip)) return `${machine} has no address on the machines' network`;
    if (home) {
      return st.open.has(row.ip)
        ? `the walls let ${machine}'s address (${row.ip}) out, so nothing runs in it`
        : null;
    }
    return st.open.has(row.ip)
      ? null
      : `${machine} (${row.ip}) isn't let out by the walls yet, so nothing runs in it`;
  }

  /** Writes the open machines' addresses where walls.sh reads them. Only addresses of the network are written. */
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
    const tmp = join(dirname(this.s.declared), `.open-machines.${process.pid}.tmp`);
    try {
      writeFileSync(tmp, body, { mode: 0o644 });
      renameSync(tmp, this.s.declared);
    } catch (err) {
      throw new WallError(
        `can't write ${this.s.declared} (${err instanceof Error ? err.message : String(err)}), so the walls can't be told about the machines: ${UPDATE_WALLS}`,
      );
    }
  }

  /** The addresses to declare: the running machines that may reach the internet. */
  static open(rows: WallRow[]): string[] {
    return rows.filter((r) => !r.home && r.state === "running" && r.ip).map((r) => r.ip as string);
  }

  /**
   * Declares the open machines, then waits until this machine's live address is where it should be in the
   * acknowledgement. Throws a WallError if it doesn't come, or can't. With the old walls it returns for an
   * engineers' machine at once and throws for a home one.
   */
  async verify(
    machine: string,
    home: boolean,
    rows: () => Promise<WallRow[]>,
    sleep: (ms: number) => Promise<void>,
  ): Promise<void> {
    const deadline = this.now() + this.s.waitMs;
    let declared = "";
    for (;;) {
      const all = await rows();
      const mine = all.find((r) => r.name === machine);
      const st = this.state();
      if (st.kind === "old") {
        const why = this.problem(machine, home, mine);
        if (why) throw new WallError(why);
        return;
      }
      if (st.kind === "stale") throw new WallError(`nothing runs in ${machine}: ${STALE_WALLS}`);
      if (mine?.state !== "running" || !mine.ip) {
        throw new WallError(`${machine} has no address on the machines' network, so it can't be walled`);
      }
      const addresses = EgressWall.open(all);
      if (addresses.join() !== declared) {
        this.declare(addresses);
        declared = addresses.join();
      }
      const why = this.problem(machine, home, mine);
      if (!why) return;
      if (this.now() >= deadline) {
        throw new WallError(
          `the walls didn't settle for ${machine} (${mine.ip}) within ${Math.round(this.s.waitMs / 1000)} s: ${why}`,
        );
      }
      await sleep(this.s.pollMs);
    }
  }

  /**
   * One look at the machines, for the daemon's watch: declares the open machines and returns the running home
   * machines whose address the walls have let out for longer than `graceMs` (the caller stops them).
   */
  watch(rows: WallRow[], graceMs: number): string[] {
    const leaking = this.leaking;
    const st = this.state();
    if (st.kind === "old") return [];
    try {
      this.declare(EgressWall.open(rows));
    } catch {
      // The walls job isn't there to tell: nothing is let out, and the daemon's checks refuse launches.
    }
    const stop: string[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      if (!r.home || r.state !== "running") continue;
      seen.add(r.name);
      if (st.kind === "ok" && r.ip && st.open.has(r.ip)) {
        const since = leaking.get(r.name) ?? this.now();
        leaking.set(r.name, since);
        if (this.now() - since >= graceMs) stop.push(r.name);
      } else {
        leaking.delete(r.name);
      }
    }
    for (const name of [...leaking.keys()]) if (!seen.has(name)) leaking.delete(name);
    return stop;
  }

  /** When a running home machine was first seen with its address let out. */
  private readonly leaking = new Map<string, number>();
}
