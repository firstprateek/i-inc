// The deployer's decisions are made against these ports, so the whole cycle (CI, build, smoke test,
// drain, switch, health check, rollback) runs in tests against fakes. The real adapters are in
// ci.ts, releases.ts, smoke.ts, daemon.ts and store.ts.

export type Outcome =
  | "deployed"
  | "rolled-back"
  | "failed-build"
  | "failed-smoke"
  | "skipped-ci"
  | "skipped-ancestry";

/** One line of ~/.i-inc/deploys.jsonl (contract C21 in docs/coord.md). */
export interface DeployRecord {
  /** Epoch ms when the attempt ended. */
  at: number;
  sha: string;
  /** The release that was running when the attempt began; null if there was none. */
  from: string | null;
  outcome: Outcome;
  reason: string;
  durationMs: number;
}

/** What `GET /api/health` of the daemon says. */
export interface Health {
  ok: boolean;
  version: string;
  busy: boolean;
  startedAt: number;
}

export type CiResult =
  | { state: "success" }
  | { state: "failure"; reason: string }
  | { state: "pending"; reason: string }
  | { state: "rate-limited"; until: number }
  | { state: "error"; reason: string };

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface Remote {
  /** The SHA at the tip of origin's main. */
  head(): Promise<string>;
  /**
   * Whether `descendant` has `ancestor` in its history (`git merge-base --is-ancestor`), or null when
   * that cannot be told (the objects could not be fetched).
   */
  descends(ancestor: string, descendant: string): Promise<boolean | null>;
}

export interface Ci {
  check(sha: string): Promise<CiResult>;
}

export interface ReleaseInfo {
  sha: string;
  /** When it was last made current (or built), epoch ms. */
  usedAt: number;
}

export interface Releases {
  /** Complete (built) releases, newest first. */
  list(): Promise<ReleaseInfo[]>;
  /** The sha `current` points at, or null when there is no link yet. */
  current(): Promise<string | null>;
  has(sha: string): Promise<boolean>;
  /** Clones and checks out the sha, installs and builds. Throws with the reason on failure. */
  build(sha: string): Promise<void>;
  /** Atomically repoints `current`. */
  point(sha: string): Promise<void>;
  remove(sha: string): Promise<void>;
  /** Removes folders left by builds that never finished, except `keep`. */
  sweep(keep: string[]): Promise<string[]>;
}

export type SmokeResult = { ok: true } | { ok: false; reason: string };

export interface Smoke {
  /** Starts the release's daemon once on a spare port with demo data, probes it, stops it. */
  run(sha: string): Promise<SmokeResult>;
}

export interface DaemonControl {
  /** `launchctl kickstart -k gui/<uid>/inc.i.daemon`. Throws if it fails. */
  restart(): Promise<void>;
  /** The running daemon's /api/health, or null if it doesn't answer. */
  health(): Promise<Health | null>;
  /** What launchd says about `inc.i.daemon` (`launchctl print`): running, not running (down, waiting to respawn), or unknown. */
  launchdState(): Promise<"running" | "not-running" | "unknown">;
}

export interface InFlight {
  sha: string;
  from: string | null;
  phase: "build" | "drain" | "switch" | "rollback";
  startedAt: number;
  /** Why a rollback was started, so a restarted deployer can finish it with the same reason. */
  reason?: string;
}

export interface State {
  /** Commits that failed to deploy: never tried again. */
  bad: Record<string, { at: number; reason: string }>;
  /** Commits whose CI failed and that were already recorded as skipped-ci. */
  ciFailed: string[];
  /** Builds begun per commit, to stop a deployer that dies in the same place forever. */
  attempts: Record<string, number>;
  /** Commits built and smoke-tested, waiting for the daemon to drain. */
  ready: Record<string, { drainSince: number | null }>;
  /** Failures per commit that are not final yet: when to try again, and how many times it failed. */
  retry: Record<string, { failures: number; transients: number; nextAt: number }>;
  /** Commits whose history does not include the running release, already reported once. */
  ancestrySkipped: string[];
  /** Commits the owner allowed despite that (`--sha`). */
  allowRewrite: string[];
  /** Keys of records already written (sha:outcome:attempt start), so a restart never writes one twice. */
  recorded: string[];
  /** After a rollback by hand: main's tip at that moment. Nothing is deployed until main moves past it. */
  paused: { sha: string; at: number; to: string } | null;
  /** Releases that were actually switched to, oldest first; the last is the one running (or was). */
  history: string[];
  inFlight: InFlight | null;
}

export interface Store {
  state(): State;
  save(state: State): void;
  append(record: DeployRecord): void;
}

export interface Lock {
  /** False if another live deployer holds it. */
  acquire(): boolean;
  release(): void;
}

export interface Settings {
  /** How long the running daemon may stay busy before the deploy waits for the next cycle. */
  drainMaxMs: number;
  drainPollMs: number;
  /** Switch anyway after waiting this long (the --force-after option); unset: never. */
  forceAfterMs: number | undefined;
  /** A daemon that has not answered for this long no longer blocks a deploy: that is the recovery path. */
  downProceedMs: number;
  healthTimeoutMs: number;
  healthPollMs: number;
  keep: number;
  /** A build that dies this many times is marked bad. */
  maxAttempts: number;
}

export const defaultSettings: Settings = {
  drainMaxMs: 30 * 60_000,
  drainPollMs: 10_000,
  forceAfterMs: undefined,
  downProceedMs: 10 * 60_000,
  healthTimeoutMs: 90_000,
  healthPollMs: 2_000,
  keep: 5,
  maxAttempts: 3,
};
