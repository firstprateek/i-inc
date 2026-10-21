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
