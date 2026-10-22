// Child processes without the ways they take the daemon down (T63, audit group 4).
import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";

/**
 * Stops a child and whatever it started, by signalling its process group. The child must have been
 * spawned `detached` to lead one; without that, or when the group is already gone, it signals only
 * the child.
 */
export function killGroup(
  child: Pick<ChildProcess, "pid" | "kill">,
  signal: NodeJS.Signals = "SIGKILL",
): void {
  const pid = child.pid;
  if (pid !== undefined && pid > 1) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Not a group leader, or already gone: fall through to the child itself.
    }
  }
  try {
    child.kill(signal);
  } catch {}
}

/**
 * Asks a child's process group to stop (SIGTERM), then kills it if it is still there after `graceMs`.
 * The kill is skipped once the child has exited, so a recycled pid is never signalled.
 */
export function stopGroup(
  child: Pick<ChildProcess, "pid" | "kill" | "exitCode" | "signalCode">,
  graceMs = 3000,
): void {
  killGroup(child, "SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) killGroup(child, "SIGKILL");
  }, graceMs);
  timer.unref?.();
}

/**
 * Makes a child's stdin safe to write to. A write to a process that has already exited fails with
 * EPIPE, which Node reports as an 'error' event on the stream; with no listener that is an uncaught
 * exception, and on Bun 1.4.2 it ends the daemon. The error is handed to `onError` and nothing more:
 * the child's exit is what the caller already waits for.
 */
export function guardStdin(stdin: Writable | null | undefined, onError?: (err: Error) => void): void {
  stdin?.on("error", (err: Error) => onError?.(err));
}

/** Words for how long something ran, for a timeout's message: "10 minutes", "90 seconds". */
export function describeMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms >= 120_000 && ms % 60_000 === 0) return `${ms / 60_000} minutes`;
  if (ms >= 60_000 && ms % 60_000 === 0) return "1 minute";
  return `${Math.round(ms / 1000)} seconds`;
}
