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
