// An `exec` for tests that hold a `container` stand-in of their own (a script on disk, a fake spawn) for the commands
// that start a client: it answers `machine ls` with the machines named as running, since nothing is run in a machine
// that `machine ls` doesn't show running (T75), and nothing else.
import type { Exec } from "../src/machines.ts";

export const runningListing = (...names: string[]): string =>
  [
    "NAME  CREATED  IP  CPUS  MEMORY  DISK  STATE  DEFAULT",
    ...names.map((n) => `${n}  2026-10-01 10:00:00  192.168.64.5  6  12G  3.6G  running`),
  ].join("\n");

/** `machine ls` shows `names` running (default: inc-ada); every other command succeeds with no output. */
export const upExec =
  (...names: string[]): Exec =>
  async (_bin, args) =>
    args[1] === "ls" ? runningListing(...(names.length ? names : ["inc-ada"])) : "";

/**
 * Wraps a test's `exec` so `machine ls` tells the truth about what it booted and stopped: a machine is listed
 * running once a `machine run -n M` has succeeded, until a `machine stop M` has. `ls` itself is answered here and
 * never reaches `inner`, so a test's own record of the calls is unchanged. (`AppleMachines` looks at `machine ls`
 * to see whether a machine it has recorded as up still is, T75.)
 */
export const tracking = (inner: Exec): Exec => {
  const up = new Set<string>();
  return async (bin, args, opts) => {
    if (args[0] === "machine" && args[1] === "ls") return runningListing(...up);
    const out = await inner(bin, args, opts);
    if (args[0] === "machine" && args[1] === "run") {
      const n = args[args.indexOf("-n") + 1];
      if (n) up.add(n);
    }
    if (args[0] === "machine" && args[1] === "stop" && args[2]) up.delete(args[2]);
    return out;
  };
};
