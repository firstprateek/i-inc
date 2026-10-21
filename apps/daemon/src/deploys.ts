// The deployer's record (tools: apps/deployer), seen from the daemon: the last deploys for
// GET /api/deploys (contract C21), a push notification when a new one failed, and the version this
// release reports on GET /api/health.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { Db } from "./db.ts";
import type { PushService } from "./push.ts";

export type DeployOutcome = "deployed" | "rolled-back" | "failed-build" | "failed-smoke" | "skipped-ci";

/** One line of ~/.i-inc/deploys.jsonl. */
export interface DeployEntry {
  at: number;
  sha: string;
  from: string | null;
  outcome: DeployOutcome;
  reason: string;
  durationMs: number;
}

const outcomes: readonly string[] = ["deployed", "rolled-back", "failed-build", "failed-smoke", "skipped-ci"];

function parse(line: string): DeployEntry | undefined {
  try {
    const e = JSON.parse(line) as Partial<DeployEntry>;
    if (
      typeof e.at !== "number" ||
      typeof e.sha !== "string" ||
      typeof e.outcome !== "string" ||
      !outcomes.includes(e.outcome)
    ) {
      return undefined;
    }
    return {
      at: e.at,
      sha: e.sha,
      from: typeof e.from === "string" ? e.from : null,
      outcome: e.outcome as DeployOutcome,
      reason: typeof e.reason === "string" ? e.reason.slice(0, 500) : "",
      durationMs: typeof e.durationMs === "number" ? e.durationMs : 0,
    };
  } catch {
    return undefined;
  }
}

/** The last `limit` deploys, newest first. A missing file or a damaged line is skipped. */
export function readDeploys(path: string | undefined, limit = 20): DeployEntry[] {
  if (!path || !existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: DeployEntry[] = [];
  for (const line of text.split("\n").reverse()) {
    if (!line.trim()) continue;
    const e = parse(line);
    if (e) out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

const failed: readonly DeployOutcome[] = ["rolled-back", "failed-build", "failed-smoke"];
const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "none");

/** Pushes once for each failed deploy it has not announced yet. Survives restarts (push_sent). */
export class DeployNotifier {
  constructor(
    private readonly o: {
      path: string | undefined;
      db: Db;
      push: PushService | undefined;
      now: () => number;
      log?: (m: string) => void;
      /** Failures older than this are history, not news (the first run after an install). */
      maxAgeMs?: number;
    },
  ) {}

  async check(): Promise<number> {
    if (!this.o.push) return 0;
    const maxAge = this.o.maxAgeMs ?? 6 * 3_600_000;
    let sent = 0;
    // Oldest first, so the notifications arrive in order.
    for (const e of readDeploys(this.o.path, 20).reverse()) {
      if (!failed.includes(e.outcome) || this.o.now() - e.at > maxAge) continue;
      const key = `deploy:${e.at}:${e.sha}`;
      const res = this.o.db.run(
        "INSERT INTO push_sent (key, at) VALUES (?, ?) ON CONFLICT (key) DO NOTHING",
        key,
        this.o.now(),
      );
      if ((res?.changes ?? 0) === 0) continue;
      const tail = e.outcome === "rolled-back" ? "rolled back" : `${short(e.from)} keeps running`;
      try {
        await this.o.push.send({
          title: `Deploy of ${short(e.sha)} failed`,
          body: `Deploy of ${short(e.sha)} failed: ${e.reason || e.outcome} — ${tail}`,
          url: "#/desk",
        });
        sent++;
      } catch (err) {
        this.o.log?.(`failed to send the push for ${key}: ${String(err)}`);
      }
    }
    return sent;
  }
}

/**
 * The sha this release runs: I_INC_VERSION if set (the deployer's releases are checkouts, so git knows),
 * else `git rev-parse HEAD` in `cwd`, else "unknown".
 */
export function resolveVersion(
  env: Record<string, string | undefined>,
  cwd: string,
  exec: (cmd: string, args: string[], cwd: string) => string = (cmd, args, dir) =>
    execFileSync(cmd, args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }),
): string {
  const fromEnv = env.I_INC_VERSION?.trim();
  if (fromEnv) return fromEnv;
  try {
    const sha = exec("git", ["rev-parse", "HEAD"], cwd).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : "unknown";
  } catch {
    return "unknown";
  }
}
