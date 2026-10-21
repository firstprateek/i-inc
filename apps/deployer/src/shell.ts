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
    const child = spawn(cmd, args, {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const take = (b: Buffer) => {
      output = (output + b.toString("utf8")).slice(-TAIL);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : undefined;
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, output: `${cmd}: ${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, output, timedOut });
    });
  });
