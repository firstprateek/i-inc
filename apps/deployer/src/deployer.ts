// The deployer's decisions (docs/design/v1-plan.md §5): watch main, wait for green CI, build in a
// fresh release folder, smoke-test it on a spare port, wait for the running daemon to be idle,
// switch, check health, and roll back on any failure. Every I/O is a port (types.ts).
import type {
  Ci,
  Clock,
  DaemonControl,
  DeployRecord,
  Lock,
  Outcome,
  Releases,
  Remote,
  Settings,
  Smoke,
  State,
  Store,
} from "./types.ts";

export type CycleAction =
  | "idle"
  | "no-current"
  | "known-bad"
  | "waiting-ci"
  | "rate-limited"
  | "ci-error"
  | "remote-error"
  | "deferred"
  | Outcome;

export interface CycleResult {
  action: CycleAction;
  sha?: string;
}

export interface DeployerDeps {
  clock: Clock;
  remote: Remote;
  ci: Ci;
  releases: Releases;
  smoke: Smoke;
  daemon: DaemonControl;
  store: Store;
  lock: Lock;
  settings: Settings;
  log: (line: string) => void;
}

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "none");
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 300);

export class Deployer {
  private lastStatus = "";

  constructor(private readonly d: DeployerDeps) {}

  /** Logs a line only when it differs from the last status line, so a quiet loop stays quiet. */
  private status(line: string): void {
    if (line === this.lastStatus) return;
    this.lastStatus = line;
    this.d.log(line);
  }

  private event(line: string): void {
    this.lastStatus = "";
    this.d.log(line);
  }

  private mutate(fn: (s: State) => void): State {
    const s = this.d.store.state();
    fn(s);
    this.d.store.save(s);
    return s;
  }

  /** Takes the single-instance lock. False means another deployer is alive. */
  acquire(): boolean {
    return this.d.lock.acquire();
  }

  release(): void {
    this.d.lock.release();
  }

  /**
   * Finishes (or rolls back) a deploy that was cut short by a crash or a restart of the deployer
   * itself. Call it once at startup, after acquire().
   */
  async recover(): Promise<CycleResult | undefined> {
    const flight = this.d.store.state().inFlight;
    if (!flight) return undefined;
    const { sha, from } = flight;
    this.event(`recovering a deploy of ${short(sha)} that was cut short in "${flight.phase}"`);
    if (flight.phase === "rollback") {
      return this.rollback(sha, from, flight.reason ?? "rollback was cut short", flight.startedAt);
    }
    if (flight.phase === "switch") {
      const current = await this.d.releases.current();
      if (current === sha) {
        const ok = await this.waitForVersion(sha);
        if (ok)
          return this.finishDeployed(sha, from, flight.startedAt, "resumed after a restart of the deployer");
        return this.rollback(
          sha,
          from,
          "the new daemon was not healthy after the deployer restarted",
          flight.startedAt,
        );
      }
    }
    // Nothing was switched: the attempt simply never finished. It counts towards maxAttempts.
    this.mutate((s) => {
      s.inFlight = null;
    });
    return { action: "idle", sha };
  }

  /** One pass: look at main and, if there is a green new commit, deploy it. */
  async cycle(): Promise<CycleResult> {
    const { releases, remote, ci } = this.d;
    const current = await releases.current();
    if (!current) {
      this.status("no current release: run tools/host/install-deployer.sh --apply");
      return { action: "no-current" };
    }
    let head: string;
    try {
      head = await remote.head();
    } catch (err) {
      this.status(`could not read origin/main: ${oneLine(String(err))}`);
      return { action: "remote-error" };
    }
    if (head === current) {
      this.status(`idle: ${short(current)} is current`);
      return { action: "idle", sha: head };
    }
    const state = this.d.store.state();
    const bad = state.bad[head];
    if (bad) {
      this.status(`${short(head)} was marked bad (${oneLine(bad.reason)}): waiting for a newer commit`);
      return { action: "known-bad", sha: head };
    }

    // A commit that already built and passed its smoke test is past the CI question.
    if (!state.ready[head]) {
      const result = await ci.check(head);
      switch (result.state) {
        case "pending":
          this.status(`${short(head)}: waiting for CI (${oneLine(result.reason)})`);
          return { action: "waiting-ci", sha: head };
        case "rate-limited":
          this.status(
            `${short(head)}: GitHub rate limit, backing off until ${new Date(result.until).toISOString()}`,
          );
          return { action: "rate-limited", sha: head };
        case "error":
          this.status(`${short(head)}: could not read CI (${oneLine(result.reason)})`);
          return { action: "ci-error", sha: head };
        case "failure": {
          if (!state.ciFailed.includes(head)) {
            this.mutate((s) => {
              s.ciFailed.push(head);
            });
            this.record({
              at: this.d.clock.now(),
              sha: head,
              from: current,
              outcome: "skipped-ci",
              reason: result.reason,
              durationMs: 0,
            });
            this.event(`${short(head)}: CI failed (${oneLine(result.reason)}), skipped`);
          } else {
            this.status(`${short(head)}: CI failed, skipped`);
          }
          return { action: "skipped-ci", sha: head };
        }
        case "success":
          break;
      }
    }
    return this.deploy(head, current);
  }

  private async deploy(sha: string, from: string): Promise<CycleResult> {
    const { releases, smoke, clock, settings } = this.d;
    const startedAt = clock.now();
    const fresh = this.d.store.state();
    const ready = !!fresh.ready[sha] && (await releases.has(sha));
    const attempts = (fresh.attempts[sha] ?? 0) + 1;
    if (!ready && attempts > settings.maxAttempts) {
      return this.fail(
        sha,
        from,
        "failed-build",
        `gave up after ${settings.maxAttempts} interrupted attempts`,
        startedAt,
      );
    }
    this.mutate((s) => {
      s.attempts[sha] = attempts;
      s.inFlight = { sha, from, phase: "build", startedAt };
    });

    if (!ready) {
      this.event(`${short(sha)}: CI is green, building (was ${short(from)})`);
      try {
        await releases.remove(sha); // an earlier, interrupted build of the same commit
        await releases.build(sha);
      } catch (err) {
        return this.fail(
          sha,
          from,
          "failed-build",
          oneLine(String(err instanceof Error ? err.message : err)),
          startedAt,
        );
      }
      this.event(`${short(sha)}: built, smoke-testing on a spare port`);
      const result = await smoke.run(sha).catch((err) => ({ ok: false as const, reason: String(err) }));
      if (!result.ok) return this.fail(sha, from, "failed-smoke", oneLine(result.reason), startedAt);
      this.mutate((s) => {
        s.ready[sha] = { drainSince: null };
      });
      this.event(`${short(sha)}: smoke test passed`);
    }

    // Drain: switch only when no ticket stage or conversation turn is running.
    this.mutate((s) => {
      if (s.inFlight) s.inFlight.phase = "drain";
    });
    const drained = await this.drain(sha);
    if (!drained) {
      this.mutate((s) => {
        s.inFlight = null;
      });
      return { action: "deferred", sha };
    }

    this.mutate((s) => {
      s.inFlight = { sha, from, phase: "switch", startedAt };
    });
    this.event(`${short(sha)}: switching (kickstart inc.i.daemon)`);
    try {
      await releases.point(sha);
      await this.d.daemon.restart();
    } catch (err) {
      return this.rollback(sha, from, `switching failed: ${oneLine(String(err))}`, startedAt);
    }
    if (await this.waitForVersion(sha)) return this.finishDeployed(sha, from, startedAt, "");
    return this.rollback(
      sha,
      from,
      `the new daemon did not report version ${short(sha)} on /api/health within ${Math.round(settings.healthTimeoutMs / 1000)} s`,
      startedAt,
    );
  }

  /** True when the running daemon is idle (or the owner's --force-after has passed). */
  private async drain(sha: string): Promise<boolean> {
    const { daemon, clock, settings } = this.d;
    const began = clock.now();
    let announced = false;
    for (;;) {
      const health = await daemon.health();
      if (!health?.busy) {
        this.event(`${short(sha)}: the daemon is idle`);
        return true;
      }
      const state = this.d.store.state();
      const since = state.ready[sha]?.drainSince ?? began;
      if (state.ready[sha]?.drainSince == null) {
        this.mutate((s) => {
          const r = s.ready[sha];
          if (r) r.drainSince = since;
        });
      }
      if (settings.forceAfterMs !== undefined && clock.now() - since >= settings.forceAfterMs) {
        this.event(
          `${short(sha)}: still busy after ${Math.round((clock.now() - since) / 60_000)} min, forcing the switch`,
        );
        return true;
      }
      if (clock.now() - began >= settings.drainMaxMs) {
        this.event(
          `${short(sha)}: the daemon is still busy after ${Math.round(settings.drainMaxMs / 60_000)} min, will retry next cycle`,
        );
        return false;
      }
      if (!announced) {
        this.event(`${short(sha)}: waiting for the daemon to be idle`);
        announced = true;
      }
      await clock.sleep(settings.drainPollMs);
    }
  }

  /** Polls /api/health until it reports `version` = sha, within the health timeout. */
  private async waitForVersion(sha: string): Promise<boolean> {
    const { daemon, clock, settings } = this.d;
    const deadline = clock.now() + settings.healthTimeoutMs;
    for (;;) {
      const health = await daemon.health().catch(() => null);
      if (health?.ok && health.version === sha) return true;
      if (clock.now() >= deadline) return false;
      await clock.sleep(settings.healthPollMs);
    }
  }

  private finishDeployed(
    sha: string,
    from: string | null,
    startedAt: number,
    note: string,
  ): Promise<CycleResult> {
    const at = this.d.clock.now();
    this.record({
      at,
      sha,
      from,
      outcome: "deployed",
      reason: note,
      durationMs: at - startedAt,
    });
    this.mutate((s) => {
      s.inFlight = null;
      delete s.ready[sha];
      delete s.attempts[sha];
      if (s.history.length === 0 && from) s.history.push(from);
      s.history = [...s.history.filter((h) => h !== sha), sha].slice(-20);
    });
    this.event(`${short(sha)}: deployed (from ${short(from)}) in ${Math.round((at - startedAt) / 1000)} s`);
    return this.prune().then(() => ({ action: "deployed" as const, sha }));
  }

  /** Puts the previous release back, restarts, records, and never tries this commit again. */
  private async rollback(
    sha: string,
    from: string | null,
    reason: string,
    startedAt: number,
  ): Promise<CycleResult> {
    this.mutate((s) => {
      s.inFlight = { sha, from, phase: "rollback", startedAt, reason };
    });
    this.event(`${short(sha)}: rolling back to ${short(from)}: ${reason}`);
    let note = reason;
    if (from) {
      try {
        await this.d.releases.point(from);
        await this.d.daemon.restart();
        if (!(await this.waitForVersion(from))) {
          note += `; the previous release ${short(from)} did not report healthy either`;
        }
      } catch (err) {
        note += `; rolling back failed: ${oneLine(String(err))}`;
      }
    } else {
      note += "; there was no previous release";
    }
    const at = this.d.clock.now();
    this.markBad(sha, note, at);
    this.record({ at, sha, from, outcome: "rolled-back", reason: note, durationMs: at - startedAt });
    this.mutate((s) => {
      s.inFlight = null;
      delete s.ready[sha];
    });
    await this.d.releases.remove(sha).catch(() => {});
    this.event(`${short(sha)}: rolled back to ${short(from)}, marked bad`);
    return { action: "rolled-back", sha };
  }

  /** Build or smoke failed before anything was switched: nothing to roll back. */
  private async fail(
    sha: string,
    from: string,
    outcome: "failed-build" | "failed-smoke",
    reason: string,
    startedAt: number,
  ): Promise<CycleResult> {
    const at = this.d.clock.now();
    this.markBad(sha, reason, at);
    this.record({ at, sha, from, outcome, reason, durationMs: at - startedAt });
    this.mutate((s) => {
      s.inFlight = null;
      delete s.ready[sha];
    });
    await this.d.releases.remove(sha).catch(() => {});
    this.event(`${short(sha)}: ${outcome} (${reason}), marked bad; ${short(from)} keeps running`);
    return { action: outcome, sha };
  }

  private markBad(sha: string, reason: string, at: number): void {
    this.mutate((s) => {
      s.bad[sha] = { at, reason };
    });
  }

  private record(r: DeployRecord): void {
    this.d.store.append(r);
  }

  /** Keeps the last `keep` releases (always including `current`) and removes the rest. */
  async prune(): Promise<string[]> {
    const { releases, settings } = this.d;
    const current = await releases.current();
    const flight = this.d.store.state().inFlight;
    const previous = current ? await this.previousDeployed(current) : null;
    const protectedShas = new Set(
      [current, previous, flight?.sha, flight?.from].filter((x): x is string => !!x),
    );
    const all = await releases.list();
    const keep = new Set<string>(protectedShas);
    for (const r of all) {
      if (keep.size >= settings.keep) break;
      keep.add(r.sha);
    }
    const removed: string[] = await releases.sweep([...protectedShas]);
    for (const r of all) {
      if (keep.has(r.sha)) continue;
      await releases.remove(r.sha);
      removed.push(r.sha);
    }
    if (removed.length) this.event(`pruned ${removed.map(short).join(", ")}`);
    return removed;
  }

  /** The release deployed before `current` that is still on disk and not marked bad. */
  async previousDeployed(current: string): Promise<string | null> {
    const state = this.d.store.state();
    for (const sha of [...state.history].reverse()) {
      if (sha === current || state.bad[sha]) continue;
      if (await this.d.releases.has(sha)) return sha;
    }
    return null;
  }

  /** Records the first release (`--seed`) so a later rollback has somewhere to go back to. */
  noteSeeded(sha: string): void {
    this.mutate((s) => {
      if (!s.history.includes(sha)) s.history.push(sha);
    });
  }

  /**
   * Rolls back by hand (`--rollback [sha]`). The target is the previous release that was actually
   * deployed (from the history, never a candidate that was only built), or `target`, which must also be
   * one of those. The daemon must be idle unless `force`. The release being left is marked bad so main's
   * tip is not deployed again; the target (now live) never is.
   */
  async rollbackByHand(target?: string, opts: { force?: boolean } = {}): Promise<CycleResult> {
    const current = await this.d.releases.current();
    if (!current) throw new Error("there is no current release");
    const state = this.d.store.state();
    const to = target ?? (await this.previousDeployed(current));
    if (!to)
      throw new Error("no previous deployed release is recorded: pass the sha of one in ~/i-inc-releases");
    if (to === current) throw new Error(`${short(to)} is already current`);
    if (!state.history.includes(to)) {
      throw new Error(`${short(to)} was never deployed (it may be a candidate that was only built)`);
    }
    if (!(await this.d.releases.has(to))) throw new Error(`release ${short(to)} is no longer on disk`);
    if (!opts.force) {
      const health = await this.d.daemon.health();
      if (!health) throw new Error("the daemon does not answer /api/health: use --force to roll back anyway");
      if (health.busy)
        throw new Error("the daemon is busy (a ticket or chat turn is running): wait, or use --force");
    }
    const startedAt = this.d.clock.now();
    this.event(`rolling back by hand from ${short(current)} to ${short(to)}`);
    await this.d.releases.point(to);
    await this.d.daemon.restart();
    const healthy = await this.waitForVersion(to);
    const at = this.d.clock.now();
    this.markBad(current, `rolled back by hand to ${short(to)}`, at);
    this.mutate((s) => {
      s.history = [...s.history.filter((h) => h !== to), to].slice(-20);
    });
    this.record({
      at,
      sha: current,
      from: current,
      outcome: "rolled-back",
      reason: healthy
        ? `rolled back by hand to ${short(to)}`
        : `rolled back by hand to ${short(to)}, but the daemon did not report healthy`,
      durationMs: at - startedAt,
    });
    return { action: "rolled-back", sha: current };
  }
}
