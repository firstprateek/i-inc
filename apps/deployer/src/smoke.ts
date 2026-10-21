// The smoke test: the NEW release's daemon, started once on a spare localhost port in demo mode
// (the scripted agent, no sandboxes, no GitHub, no push) with a throwaway I_INC_HOME and HOME, so it
// can touch neither ~/.i-inc nor ~/.config/i-inc. It must report its own sha on /api/health and serve
// the web app and one built asset. Then it is stopped (only the process this started).
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock, Smoke, SmokeResult } from "./types.ts";

export interface SmokeChild {
  /** Exit code once the process has ended, else null. */
  exitCode(): number | null;
  /** The tail of what it printed. */
  output(): string;
  /** SIGTERM, then SIGKILL after a few seconds. Only this process. */
  stop(): Promise<void>;
}

export interface SmokeProcess {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface ProcessSmokeOptions {
  clock: Clock;
  /** Where a release lives. */
  releaseDir: (sha: string) => string;
  /** The bun binary. */
  bun: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  start?: (p: SmokeProcess) => SmokeChild;
  freePort?: () => Promise<number>;
  makeHome?: () => string;
  removeHome?: (dir: string) => void;
}

export class ProcessSmoke implements Smoke {
  constructor(private readonly o: ProcessSmokeOptions) {}

  async run(sha: string): Promise<SmokeResult> {
    const { clock } = this.o;
    const f = this.o.fetch ?? fetch;
    const timeoutMs = this.o.timeoutMs ?? 60_000;
    const port = await (this.o.freePort ?? freePort)();
    const home = (this.o.makeHome ?? (() => mkdtempSync(join(tmpdir(), "i-inc-smoke-"))))();
    const base = `http://127.0.0.1:${port}`;
    const dir = this.o.releaseDir(sha);
    const child = (this.o.start ?? startProcess)({
      cmd: this.o.bun,
      args: [join(dir, "apps/daemon/src/main.ts")],
      cwd: join(dir, "apps/daemon"),
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        I_INC_HOME: home,
        I_INC_DEMO: "1",
        HOST: "127.0.0.1",
        PORT: String(port),
        I_INC_HOSTS: "",
        I_INC_VERSION: "",
      },
    });
    try {
      const deadline = clock.now() + timeoutMs;
      let health: { ok?: boolean; version?: string } | undefined;
      for (;;) {
        const code = child.exitCode();
        if (code !== null)
          return { ok: false, reason: `the new daemon exited with ${code}: ${tail(child.output())}` };
        health = await get(f, `${base}/api/health`).then((r) =>
          r?.status === 200 ? safeJson(r.body) : undefined,
        );
        if (health) break;
        if (clock.now() >= deadline) {
          return {
            ok: false,
            reason: `/api/health did not answer in ${Math.round(timeoutMs / 1000)} s: ${tail(child.output())}`,
          };
        }
        await clock.sleep(500);
      }
      if (health.ok !== true) return { ok: false, reason: "/api/health said ok:false" };
      if (health.version !== sha) {
        return {
          ok: false,
          reason: `/api/health reported version ${String(health.version)}, not ${sha.slice(0, 7)}`,
        };
      }
      const auth = await get(f, `${base}/api/auth`);
      if (auth?.status !== 200)
        return { ok: false, reason: `/api/auth answered ${auth?.status ?? "nothing"}` };
      const root = await get(f, `${base}/`);
      if (root?.status !== 200) return { ok: false, reason: `GET / answered ${root?.status ?? "nothing"}` };
      const asset = /(?:src|href)="(\/assets\/[^"]+)"/.exec(root.body)?.[1];
      if (!asset)
        return {
          ok: false,
          reason: "the web app's index.html references no built asset (was apps/web built?)",
        };
      const a = await get(f, `${base}${asset}`);
      if (a?.status !== 200)
        return { ok: false, reason: `built asset ${asset} answered ${a?.status ?? "nothing"}` };
      return { ok: true };
    } finally {
      await child.stop();
      (this.o.removeHome ?? ((d) => rmSync(d, { recursive: true, force: true })))(home);
    }
  }
}

const tail = (s: string) => s.trim().split("\n").slice(-4).join(" | ").slice(-400);

function safeJson(body: string): { ok?: boolean; version?: string } | undefined {
  try {
    return JSON.parse(body) as { ok?: boolean; version?: string };
  } catch {
    return undefined;
  }
}

async function get(f: typeof fetch, url: string): Promise<{ status: number; body: string } | undefined> {
  try {
    const res = await f(url, { signal: AbortSignal.timeout(5_000) });
    return { status: res.status, body: await res.text() };
  } catch {
    return undefined;
  }
}

/** Asks the OS for a free localhost port. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export function startProcess(p: SmokeProcess): SmokeChild {
  let out = "";
  const child: ChildProcess = spawn(p.cmd, p.args, {
    cwd: p.cwd,
    env: p.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const take = (b: Buffer) => {
    out = (out + b.toString("utf8")).slice(-4096);
  };
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
  child.on("error", (err) => take(Buffer.from(String(err))));
  let code: number | null = null;
  const ended = new Promise<void>((resolve) => {
    child.on("close", (c, signal) => {
      code = c ?? (signal ? 1 : 0);
      resolve();
    });
    child.on("error", () => {
      code = code ?? 127;
      resolve();
    });
  });
  return {
    exitCode: () => code,
    output: () => out,
    async stop() {
      if (code !== null) return;
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await ended;
      clearTimeout(timer);
    },
  };
}
