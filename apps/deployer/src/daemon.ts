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
