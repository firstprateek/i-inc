// Runs a command and captures the tail of its output.
import { spawn } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface RunResult {
  code: number;
  /** The last 4 KB of stdout and stderr together. */
  output: string;
  timedOut: boolean;
}

export type Shell = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

const TAIL = 4096;

export const run: Shell = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    // Its own process group, so a timeout can stop the whole tree (pnpm, vite, node...), not just the
    // direct child: a grandchild holding the pipes would otherwise keep us waiting.
    const child = spawn(cmd, args, {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {}
      }
    };
    const take = (b: Buffer) => {
      output = (output + b.toString("utf8")).slice(-TAIL);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (hardKill) clearTimeout(hardKill);
      // Whatever is left in the group (a grandchild that outlived the child) goes too.
      killGroup("SIGKILL");
      resolve(result);
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killGroup("SIGTERM");
          hardKill = setTimeout(() => killGroup("SIGKILL"), 2_000);
          // Do not wait for pipes a stubborn grandchild may still hold open.
          setTimeout(() => finish({ code: 1, output, timedOut }), 3_000);
        }, opts.timeoutMs)
      : undefined;
    child.on("error", (err) => finish({ code: 127, output: `${cmd}: ${err.message}`, timedOut }));
    child.on("close", (code) => finish({ code: code ?? 1, output, timedOut }));
  });

export interface FullResult {
  code: number;
  /** All of stdout, up to `maxBytes`; stderr is never mixed into it. */
  stdout: string;
  /** The last 4 KB of stderr. */
  stderr: string;
  /** Stdout was longer than `maxBytes`: what is here is not all of it. */
  truncated: boolean;
  timedOut: boolean;
}

export type FullShell = (
  cmd: string,
  args: string[],
  opts?: RunOptions & { maxBytes?: number },
) => Promise<FullResult>;

/**
 * Runs a command and reads its stdout whole, for output that must be read in full (a list of commits or file
 * names): `run` keeps only a 4 KB tail of both streams together, which would drop the start of a long list.
 */
export const runFull: FullShell = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const max = opts.maxBytes ?? 8 * 1024 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    const child = spawn(cmd, args, {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(chunks).toString("utf8"),
        stderr: stderr.slice(-TAIL),
        truncated,
        timedOut,
      });
    };
    child.stdout.on("data", (b: Buffer) => {
      if (truncated) return;
      size += b.length;
      if (size > max) {
        truncated = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(b);
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr = (stderr + b.toString("utf8")).slice(-TAIL);
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : undefined;
    child.on("error", (err) => {
      stderr = `${cmd}: ${err.message}`;
      finish(127);
    });
    child.on("close", (code) => finish(truncated || timedOut ? 1 : (code ?? 1)));
  });
