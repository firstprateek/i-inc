// The running daemon, seen from outside: restart it through launchd and ask its /api/health.
import type { Shell } from "./shell.ts";
import type { DaemonControl, Health } from "./types.ts";

export class LaunchdDaemon implements DaemonControl {
  constructor(
    private readonly o: {
      shell: Shell;
      uid: number;
      label: string;
      /** "http://127.0.0.1:7420" */
      url: string;
      fetch?: typeof fetch;
    },
  ) {}

  async restart(): Promise<void> {
    const r = await this.o.shell("launchctl", ["kickstart", "-k", `gui/${this.o.uid}/${this.o.label}`], {
      timeoutMs: 30_000,
    });
    if (r.code !== 0) throw new Error(`launchctl kickstart failed (exit ${r.code}): ${r.output.trim()}`);
  }

  async health(): Promise<Health | null> {
    return probeHealth(this.o.url, this.o.fetch);
  }

  async launchdState(): Promise<"running" | "not-running" | "unknown"> {
    const r = await this.o.shell("launchctl", ["print", `gui/${this.o.uid}/${this.o.label}`], {
      timeoutMs: 15_000,
    });
    return parseLaunchdState(r.code, r.output);
  }
}

/** GET <base>/api/health, or null if it doesn't answer with the expected shape. */
export async function probeHealth(base: string, f: typeof fetch = fetch): Promise<Health | null> {
  try {
    const res = await f(`${base}/api/health`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<Health>;
    if (typeof body.version !== "string" || typeof body.busy !== "boolean") return null;
    return {
      ok: body.ok === true,
      version: body.version,
      busy: body.busy,
      startedAt: typeof body.startedAt === "number" ? body.startedAt : 0,
    };
  } catch {
    return null;
  }
}

/**
 * `launchctl print gui/<uid>/<label>` prints `state = running` for a live service and something else
 * (`not running`, `waiting`, `spawn scheduled`) for one that is down or waiting to respawn after a crash.
 * A service that is not loaded at all is unknown: restarting it would fail too.
 */
export function parseLaunchdState(code: number, output: string): "running" | "not-running" | "unknown" {
  if (code !== 0) return "unknown";
  const state = /^\s*state = (.+)$/m.exec(output)?.[1]?.trim();
  if (!state) return "unknown";
  return state === "running" ? "running" : "not-running";
}
