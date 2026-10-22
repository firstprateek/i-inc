// Fakes for every port of the deployer, and a world that wires them together the way launchd, git and
// GitHub behave: restarting the daemon makes it serve whatever `current` points at.
import { Deployer } from "../src/deployer.ts";
import { emptyState } from "../src/store.ts";
import {
  type Ci,
  type CiResult,
  type Clock,
  type DaemonControl,
  type DeployRecord,
  defaultSettings,
  type Health,
  type Lock,
  type ReleaseInfo,
  type Releases,
  type Remote,
  type Review,
  type ReviewResult,
  type Settings,
  type Smoke,
  type SmokeResult,
  type State,
  type Store,
} from "../src/types.ts";

export const sha = (n: number) => n.toString(16).padStart(7, "0") + "b".repeat(33);
const tag = (s: string | null | undefined) => s?.slice(5, 7);

export class FakeClock implements Clock {
  t = 1_700_000_000_000;
  slept = 0;
  now() {
    return this.t;
  }
  async sleep(ms: number) {
    this.t += ms;
    this.slept += ms;
  }
}

export class MemStore implements Store {
  s: State = emptyState();
  records: DeployRecord[] = [];
  state(): State {
    return structuredClone(this.s);
  }
  save(state: State) {
    this.s = structuredClone(state);
  }
  append(record: DeployRecord) {
    this.records.push(structuredClone(record));
  }
}

export class MemLock implements Lock {
  static holder: object | null = null;
  acquire() {
    if (MemLock.holder && MemLock.holder !== this) return false;
    MemLock.holder = this;
    return true;
  }
  release() {
    if (MemLock.holder === this) MemLock.holder = null;
  }
}

export class World {
  clock = new FakeClock();
  store = new MemStore();
  calls: string[] = [];
  logs: string[] = [];

  /** origin/main */
  head = sha(1);
  /** ls-remote fails (no network). */
  headFails = false;
  ci: Record<string, CiResult> = {};
  ciCalls = 0;
  buildFails: Record<string, string> = {};
  builds: string[] = [];
  smokeFails: Record<string, string> = {};
  built = new Map<string, number>(); // sha -> usedAt
  cur: string | null = sha(1);
  usedCounter = 1;
  /** What the daemon does after a restart with a given release current. */
  daemonMode: Record<string, "healthy" | "down" | "wrong-version" | "kickstart-fails"> = {};
  /** The version the daemon serves now; null = not running. */
  serving: string | null = sha(1);
  busyUntil = 0;
  unreachable = false;
  launchdOverride: "running" | "not-running" | "unknown" | undefined;

  settings: Settings = { ...defaultSettings };

  constructor() {
    this.built.set(sha(1), 1);
  }

  /** descends(current, head): true unless a test says the history was rewritten (false) or unknown (null). */
  descendsAnswer: Record<string, boolean | null> = {};
  remote: Remote = {
    head: async () => {
      if (this.headFails) throw new Error("git ls-remote failed: Could not resolve host");
      return this.head;
    },
    descends: async (_ancestor, descendant) =>
      descendant in this.descendsAnswer ? (this.descendsAnswer[descendant] ?? null) : true,
    range: async () => ({ shas: [], truncated: false }),
    changedFiles: async () => ["apps/x.ts"],
  };

  /** What the review says about a candidate main tip; absent: every commit came through review. */
  reviewAnswer: Record<string, ReviewResult> = {};
  reviewCalls: string[] = [];
  reviewPort: Review = {
    check: async (_current, candidate) => {
      this.reviewCalls.push(candidate);
      return this.reviewAnswer[candidate] ?? { state: "ok" };
    },
  };

  ciPort: Ci = {
    check: async (s) => {
      this.ciCalls++;
      return this.ci[s] ?? { state: "pending", reason: "no check run yet" };
    },
  };

  releases: Releases = {
    list: async (): Promise<ReleaseInfo[]> =>
      [...this.built].map(([s, usedAt]) => ({ sha: s, usedAt })).sort((a, b) => b.usedAt - a.usedAt),
    current: async () => this.cur,
    has: async (s) => this.built.has(s),
    build: async (s) => {
      this.calls.push(`build ${tag(s)}`);
      this.builds.push(s);
      const fail = this.buildFails[s];
      if (fail) throw new Error(fail);
      this.built.set(s, ++this.usedCounter);
    },
    point: async (s) => {
      if (!this.built.has(s)) throw new Error(`no release ${s}`);
      this.calls.push(`point ${tag(s)}`);
      this.cur = s;
      this.built.set(s, ++this.usedCounter);
    },
    remove: async (s) => {
      if (s === this.cur) throw new Error("refusing to remove current");
      if (this.built.delete(s)) this.calls.push(`remove ${tag(s)}`);
    },
    sweep: async () => [],
  };

  smokePort: Smoke = {
    run: async (s): Promise<SmokeResult> => {
      this.calls.push(`smoke ${tag(s)}`);
      const reason = this.smokeFails[s];
      return reason ? { ok: false, reason } : { ok: true };
    },
  };

  daemon: DaemonControl = {
    restart: async () => {
      const mode = (this.cur && this.daemonMode[this.cur]) || "healthy";
      this.calls.push(`restart (${tag(this.cur)})`);
      if (mode === "kickstart-fails") throw new Error("launchctl kickstart failed (exit 113)");
      this.serving = mode === "down" ? null : mode === "wrong-version" ? sha(0xdead) : this.cur;
      this.busyUntil = 0;
    },
    launchdState: async () => this.launchdOverride ?? (this.serving ? "running" : "not-running"),
    health: async (): Promise<Health | null> => {
      if (this.unreachable || !this.serving) return null;
      return { ok: true, version: this.serving, busy: this.clock.now() < this.busyUntil, startedAt: 1 };
    },
  };

  lock = new MemLock();

  deployer(): Deployer {
    return new Deployer({
      clock: this.clock,
      remote: this.remote,
      ci: this.ciPort,
      review: this.reviewPort,
      releases: this.releases,
      smoke: this.smokePort,
      daemon: this.daemon,
      store: this.store,
      lock: this.lock,
      settings: this.settings,
      log: (l) => this.logs.push(l),
    });
  }
}
