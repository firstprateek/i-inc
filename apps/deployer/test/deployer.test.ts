import { describe, expect, it } from "vitest";
import { sha, World } from "./fakes.ts";

const A = sha(1);
const B = sha(2);
const C = sha(3);

describe("watching main", () => {
  it("does nothing when main is already current, and logs that once", async () => {
    const w = new World();
    const d = w.deployer();
    expect((await d.cycle()).action).toBe("idle");
    await d.cycle();
    await d.cycle();
    expect(w.logs.filter((l) => l.includes("idle"))).toHaveLength(1);
    expect(w.ciCalls).toBe(0);
  });

  it("asks for the install when there is no current release", async () => {
    const w = new World();
    w.cur = null;
    expect((await w.deployer().cycle()).action).toBe("no-current");
    expect(w.logs.join("\n")).toContain("install-deployer.sh");
  });

  it("keeps going when origin cannot be read", async () => {
    const w = new World();
    w.remote.head = async () => {
      throw new Error("network down");
    };
    expect((await w.deployer().cycle()).action).toBe("remote-error");
  });
});

describe("history must continue", () => {
  it("skips a force-push to a commit that does not descend from the running release, reporting it once", async () => {
    const w = new World();
    w.head = B;
    w.ci[B] = { state: "success" };
    w.descendsAnswer[B] = false;
    const d = w.deployer();
    expect((await d.cycle()).action).toBe("skipped-ancestry");
    expect((await d.cycle()).action).toBe("skipped-ancestry");
    expect(w.builds).toEqual([]);
    expect(w.ciCalls).toBe(0);
    expect(w.store.records).toHaveLength(1);
    expect(w.store.records[0]).toMatchObject({ sha: B, from: A, outcome: "skipped-ancestry" });
    expect(w.store.records[0]?.reason).toContain("--sha");
    expect(w.logs.join("\n")).toContain("WARNING");
    // A later commit that does continue it is deployed.
    w.head = C;
    w.ci[C] = { state: "success" };
    expect((await d.cycle()).action).toBe("deployed");
  });

  it("does not deploy when ancestry cannot be checked, and tries again", async () => {
    const w = new World();
    w.head = B;
    w.ci[B] = { state: "success" };
    w.descendsAnswer[B] = null;
    const d = w.deployer();
    expect((await d.cycle()).action).toBe("remote-error");
    expect(w.builds).toEqual([]);
    delete w.descendsAnswer[B];
    expect((await d.cycle()).action).toBe("deployed");
  });

  it("deploys such a commit when the owner allowed it with --sha", async () => {
    const w = new World();
    w.head = B;
    w.ci[B] = { state: "success" };
    w.descendsAnswer[B] = false;
    const d = w.deployer();
    await d.cycle();
    d.allowRewrite(B);
    expect((await d.cycle()).action).toBe("deployed");
  });
});

describe("CI gate", () => {
  it("waits while CI is pending, then deploys once it is green", async () => {
    const w = new World();
    w.head = B;
    const d = w.deployer();
    w.ci[B] = { state: "pending", reason: "check is in_progress" };
    expect((await d.cycle()).action).toBe("waiting-ci");
    expect(w.builds).toEqual([]);
    w.ci[B] = { state: "success" };
    expect((await d.cycle()).action).toBe("deployed");
    expect(w.cur).toBe(B);
  });

  it("records a failed CI once as skipped-ci and never builds it", async () => {
    const w = new World();
    w.head = B;
    w.ci[B] = { state: "failure", reason: 'CI check "check" failure' };
    const d = w.deployer();
    expect((await d.cycle()).action).toBe("skipped-ci");
    expect((await d.cycle()).action).toBe("skipped-ci");
    expect(w.store.records).toHaveLength(1);
    expect(w.store.records[0]).toMatchObject({ sha: B, from: A, outcome: "skipped-ci", durationMs: 0 });
    expect(w.builds).toEqual([]);
    // A newer green commit is still deployed.
    w.head = C;
    w.ci[C] = { state: "success" };
    expect((await d.cycle()).action).toBe("deployed");
  });

  it("does not build while rate limited or when CI cannot be read", async () => {
    const w = new World();
    w.head = B;
    w.ci[B] = { state: "rate-limited", until: w.clock.now() + 60_000 };
    const d = w.deployer();
    expect((await d.cycle()).action).toBe("rate-limited");
    w.ci[B] = { state: "error", reason: "GitHub answered 500" };
    expect((await d.cycle()).action).toBe("ci-error");
    expect(w.builds).toEqual([]);
    expect(w.store.records).toEqual([]);
  });
});

describe("a green commit", () => {
  it("builds, smoke tests, switches, health checks, and records a deploy", async () => {
    const w = new World();
    w.head = B;
    w.ci[B] = { state: "success" };
    const r = await w.deployer().cycle();
    expect(r).toEqual({ action: "deployed", sha: B });
    expect(w.calls).toEqual(["build 02", "smoke 02", "point 02", "restart (02)"]);
    expect(w.cur).toBe(B);
    expect(w.store.records).toHaveLength(1);
    expect(w.store.records[0]).toMatchObject({ sha: B, from: A, outcome: "deployed", reason: "" });
    expect(w.store.records[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(w.store.s.inFlight).toBeNull();
    expect(w.store.s.bad).toEqual({});
  });

  it("a build failure is retried once from clean, then marks the sha bad; newer commits are tried", async () => {
    const w = new World();
    w.head = B;
    w.ci[B] = { state: "success" };
    w.buildFails[B] = "pnpm install failed (exit 1): lockfile";
    const d = w.deployer();
    expect((await d.cycle()).action).toBe("failed-build");
    expect(w.cur).toBe(A);
    expect(w.calls).not.toContain("restart (01)");
    // The first failure is not final: nothing is recorded or marked, and the retry waits.
    expect(w.store.records).toEqual([]);
    expect(w.store.s.bad[B]).toBeUndefined();
    expect((await d.cycle()).action).toBe("retry-wait");
    w.clock.t += 3 * 60_000;
    expect((await d.cycle()).action).toBe("failed-build");
    expect(w.builds).toEqual([B, B]);
    expect(w.store.records).toHaveLength(1);
    expect(w.store.records[0]).toMatchObject({ sha: B, from: A, outcome: "failed-build" });
    expect(w.store.records[0]?.reason).toContain("lockfile");
    expect(w.store.s.bad[B]).toBeDefined();
    // Never retried again:
    w.builds.length = 0;
    expect((await d.cycle()).action).toBe("known-bad");
    expect(w.builds).toEqual([]);
    // A newer commit is tried:
    w.head = C;
    w.ci[C] = { state: "success" };
    expect((await d.cycle()).action).toBe("deployed");
    expect(w.cur).toBe(C);
  });

  it("a flaky build that works on the clean retry deploys, and was never marked bad", async () => {
    const w = new World();
    w.head = B;
    w.ci[B] = { state: "success" };
    w.buildFails[B] = "vite build failed (exit 1)";
    const d = w.deployer();
    await d.cycle();
    delete w.buildFails[B];
    w.clock.t += 3 * 60_000;
    expect((await d.cycle()).action).toBe("deployed");
    expect(w.store.s.bad).toEqual({});
    expect(w.store.s.retry).toEqual({});
  });

  for (const reason of [
    "git clone failed (exit 128): fatal: unable to access 'https://github.com/firstprateek/i-inc.git/': Could not resolve host",
    "pnpm install failed (exit 1): ENOSPC: no space left on device, write",
    "pnpm install timed out after 15 min",
    "pnpm install failed (exit 1): ECONNRESET",
  ]) {
    it(`a temporary failure never marks the sha bad, however often it repeats: ${reason.slice(0, 40)}`, async () => {
      const w = new World();
      w.head = B;
      w.ci[B] = { state: "success" };
      w.buildFails[B] = reason;
      const d = w.deployer();
      for (let i = 0; i < 6; i++) {
        expect((await d.cycle()).action).toBe("failed-build");
        expect(w.store.s.bad[B]).toBeUndefined();
        w.clock.t += 61 * 60_000; // past any back-off
      }
      // Said once, not every time.
      expect(w.store.records).toHaveLength(1);
      expect(w.store.records[0]?.reason).toContain("temporary");
      // The network or the disk recovers: it deploys.
      delete w.buildFails[B];
      expect((await d.cycle()).action).toBe("deployed");
    });
  }

  it("backs off between temporary failures: 2, 4, 8 minutes, at most an hour", async () => {
    const w = new World();
    w.head = B;
    w.ci[B] = { state: "success" };
    w.buildFails[B] = "ENOSPC: no space left on device";
    const d = w.deployer();
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      await d.cycle();
      waits.push(w.store.s.retry[B]?.nextAt ? w.store.s.retry[B].nextAt - w.clock.now() : 0);
      w.clock.t = w.store.s.retry[B]?.nextAt ?? w.clock.t;
    }
    expect(waits.slice(0, 4)).toEqual([2, 4, 8, 16].map((m) => m * 60_000));
    expect(Math.max(...waits)).toBe(60 * 60_000);
  });

  it("a failed smoke test never switches or restarts anything, and is written off when it fails again", async () => {
    const w = new World();
    w.head = B;
    w.ci[B] = { state: "success" };
    w.smokeFails[B] = "/api/health did not answer in 60 s";
    const d = w.deployer();
    expect((await d.cycle()).action).toBe("failed-smoke");
    expect(w.calls).toEqual(["build 02", "smoke 02", "remove 02"]);
    expect(w.cur).toBe(A);
    expect(w.store.s.bad[B]).toBeUndefined();
    w.clock.t += 3 * 60_000;
    expect((await d.cycle()).action).toBe("failed-smoke");
    expect(w.calls).not.toContain("point 02");
    expect(w.store.records).toHaveLength(1);
    expect(w.store.records[0]).toMatchObject({ outcome: "failed-smoke", from: A });
    expect(w.store.s.bad[B]).toBeDefined();
  });
});

describe("drain", () => {
  it("waits for the running daemon to go idle before switching", async () => {
    const w = new World();
    w.head = B;
    w.ci[B] = { state: "success" };
    w.busyUntil = w.clock.now() + 5 * 60_000;
    const start = w.clock.now();
    expect((await w.deployer().cycle()).action).toBe("deployed");
    expect(w.clock.now() - start).toBeGreaterThanOrEqual(5 * 60_000);
    const order = w.calls.join(",");
    expect(order).toBe("build 02,smoke 02,point 02,restart (02)");
  });

  it("gives up after 30 minutes without switching, and finishes next cycle without rebuilding", async () => {
    const w = new World();
    w.head = B;
    w.ci[B] = { state: "success" };
    w.busyUntil = Number.POSITIVE_INFINITY;
    const d = w.deployer();
    const start = w.clock.now();
    expect((await d.cycle()).action).toBe("deferred");
    expect(w.clock.now() - start).toBeGreaterThanOrEqual(30 * 60_000);
    expect(w.clock.now() - start).toBeLessThan(31 * 60_000);
    expect(w.cur).toBe(A);
    expect(w.store.records).toEqual([]);
    expect(w.store.s.bad).toEqual({});
    expect(w.store.s.inFlight).toBeNull();

    w.busyUntil = 0;
    w.builds.length = 0;
    const ciCalls = w.ciCalls;
    expect((await d.cycle()).action).toBe("deployed");
    expect(w.builds).toEqual([]);
    expect(w.ciCalls).toBe(ciCalls);
    expect(w.cur).toBe(B);
  });

  it("--force-after switches a busy daemon once the wait has passed", async () => {
    const w = new World();
    w.head = B;
    w.ci[B] = { state: "success" };
    w.busyUntil = Number.POSITIVE_INFINITY;
    w.settings.forceAfterMs = 10 * 60_000;
    const start = w.clock.now();
    expect((await w.deployer().cycle()).action).toBe("deployed");
    expect(w.clock.now() - start).toBeGreaterThanOrEqual(10 * 60_000);
    expect(w.clock.now() - start).toBeLessThan(11 * 60_000);
  });

  it("a daemon that is down and not running under launchd does not block the deploy that may repair it", async () => {
    const w = new World();
    w.head = B;
    w.ci[B] = { state: "success" };
    w.serving = null; // down: nothing answers, and launchd says it is not running
    const start = w.clock.now();
    expect((await w.deployer().cycle()).action).toBe("deployed");
    expect(w.clock.now() - start).toBeLessThan(2 * 60_000);
    expect(w.cur).toBe(B);
    expect(w.serving).toBe(B);
    expect(w.store.records[0]?.outcome).toBe("deployed");
    expect(w.store.records[0]?.reason).toContain("recovery: the daemon was down");
    expect(w.store.records[0]?.reason).toContain("not running");
  });

  it("a daemon that launchd thinks is running but that does not answer blocks for ten minutes, then the deploy goes ahead", async () => {
    const w = new World();
    w.head = B;
    w.ci[B] = { state: "success" };
    w.unreachable = true; // launchd: running; /api/health: nothing
    w.daemon.restart = async () => {
      w.calls.push("restart");
      w.unreachable = false;
      w.serving = w.cur;
    };
    const start = w.clock.now();
    expect((await w.deployer().cycle()).action).toBe("deployed");
    expect(w.clock.now() - start).toBeGreaterThanOrEqual(10 * 60_000);
    expect(w.clock.now() - start).toBeLessThan(11 * 60_000);
    expect(w.store.records[0]?.reason).toContain("no answer for 10 min");
  });

  it("when launchd cannot say, a silent daemon waits the ten minutes", async () => {
    const w = new World();
    w.head = B;
    w.ci[B] = { state: "success" };
    w.serving = null;
    w.launchdOverride = "unknown";
    w.daemon.restart = async () => {
      w.serving = w.cur;
    };
    const start = w.clock.now();
    expect((await w.deployer().cycle()).action).toBe("deployed");
    expect(w.clock.now() - start).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it("a busy daemon is still waited for, even for a long time", async () => {
    const w = new World();
    w.head = B;
    w.ci[B] = { state: "success" };
    w.busyUntil = Number.POSITIVE_INFINITY;
    expect((await w.deployer().cycle()).action).toBe("deferred");
    expect(w.cur).toBe(A);
  });

  it("proceeds as soon as a daemon that was not answering comes back idle", async () => {
    const w = new World();
    w.head = B;
    w.ci[B] = { state: "success" };
    w.unreachable = true;
    const answer = w.daemon.health;
    let polls = 0;
    w.daemon.health = async () => {
      if (++polls === 4) w.unreachable = false;
      return answer();
    };
    expect((await w.deployer().cycle()).action).toBe("deployed");
    expect(polls).toBeGreaterThanOrEqual(4);
  });
});

describe("health check and rollback", () => {
  for (const mode of ["down", "wrong-version"] as const) {
    it(`rolls back when the new daemon is ${mode}`, async () => {
      const w = new World();
      w.head = B;
      w.ci[B] = { state: "success" };
      w.daemonMode[B] = mode;
      const start = w.clock.now();
      const r = await w.deployer().cycle();
      expect(r).toEqual({ action: "rolled-back", sha: B });
      expect(w.clock.now() - start).toBeGreaterThanOrEqual(90_000);
      expect(w.clock.now() - start).toBeLessThan(100_000);
      expect(w.cur).toBe(A);
      expect(w.serving).toBe(A);
      expect(w.calls).toEqual([
        "build 02",
        "smoke 02",
        "point 02",
        "restart (02)",
        "point 01",
        "restart (01)",
        "remove 02",
      ]);
      expect(w.store.records).toHaveLength(1);
      expect(w.store.records[0]).toMatchObject({ sha: B, from: A, outcome: "rolled-back" });
      expect(w.store.records[0]?.reason).toContain("did not report version 0000002");
      expect(w.store.s.inFlight).toBeNull();
      // The first failed health check is retried from clean; the second writes the commit off.
      expect(w.store.s.bad[B]).toBeUndefined();
      expect((await w.deployer().cycle()).action).toBe("retry-wait");
      w.clock.t += 3 * 60_000;
      expect((await w.deployer().cycle()).action).toBe("rolled-back");
      expect(w.store.records).toHaveLength(2);
      expect(w.store.s.bad[B]).toBeDefined();
      expect((await w.deployer().cycle()).action).toBe("known-bad");
    });
  }

  it("a slow first start that comes up on the retry is deployed, not written off", async () => {
    const w = new World();
    w.head = B;
    w.ci[B] = { state: "success" };
    w.daemonMode[B] = "down";
    const d = w.deployer();
    expect((await d.cycle()).action).toBe("rolled-back");
    delete w.daemonMode[B];
    w.clock.t += 3 * 60_000;
    expect((await d.cycle()).action).toBe("deployed");
    expect(w.store.s.bad).toEqual({});
  });

  it("rolls back when the kickstart itself fails, which is not the commit's fault: retried, never written off", async () => {
    const w = new World();
    w.head = B;
    w.ci[B] = { state: "success" };
    w.daemonMode[B] = "kickstart-fails";
    const d = w.deployer();
    expect((await d.cycle()).action).toBe("rolled-back");
    expect(w.store.records[0]?.reason).toContain("kickstart");
    for (let i = 0; i < 4; i++) {
      w.clock.t += 61 * 60_000;
      expect((await d.cycle()).action).toBe("rolled-back");
      expect(w.store.s.bad[B]).toBeUndefined();
    }
  });

  it("says so when the previous release is unhealthy too", async () => {
    const w = new World();
    w.head = B;
    w.ci[B] = { state: "success" };
    w.daemonMode[B] = "down";
    w.daemonMode[A] = "down";
    await w.deployer().cycle();
    expect(w.store.records[0]?.reason).toContain("previous release 0000001 did not report healthy either");
  });
});

describe("pruning", () => {
  it("keeps the last 5 releases and always the current one", async () => {
    const w = new World();
    const d = w.deployer();
    for (let n = 2; n <= 9; n++) {
      w.head = sha(n);
      w.ci[sha(n)] = { state: "success" };
      expect((await d.cycle()).action).toBe("deployed");
    }
    const left = (await w.releases.list()).map((r) => r.sha);
    expect(left).toHaveLength(5);
    expect(left).toContain(sha(9));
    expect(left).toEqual([sha(9), sha(8), sha(7), sha(6), sha(5)]);
    expect(w.cur).toBe(sha(9));
  });
});

describe("restarting the deployer mid-deploy", () => {
  it("clears a deploy that died while building and counts the attempt", async () => {
    const w = new World();
    w.head = B;
    w.ci[B] = { state: "success" };
    w.store.s.inFlight = { sha: B, from: A, phase: "build", startedAt: w.clock.now() };
    w.store.s.attempts[B] = 1;
    const d = w.deployer();
    await d.recover();
    expect(w.store.s.inFlight).toBeNull();
    expect(w.cur).toBe(A);
    expect((await d.cycle()).action).toBe("deployed");
  });

  it("gives up on a commit that keeps killing the deployer", async () => {
    const w = new World();
    w.head = B;
    w.ci[B] = { state: "success" };
    w.store.s.attempts[B] = 3;
    expect((await w.deployer().cycle()).action).toBe("failed-build");
    expect(w.store.records[0]?.reason).toContain("interrupted attempts");
    expect(w.builds).toEqual([]);
  });

  it("resumes a switch that was cut short, and records the deploy when the new daemon is healthy", async () => {
    const w = new World();
    w.head = B;
    w.built.set(B, 5);
    w.cur = B;
    w.serving = B;
    w.store.s.inFlight = { sha: B, from: A, phase: "switch", startedAt: w.clock.now() - 20_000 };
    const r = await w.deployer().recover();
    expect(r?.action).toBe("deployed");
    expect(w.store.records[0]).toMatchObject({ sha: B, from: A, outcome: "deployed" });
    expect(w.store.s.inFlight).toBeNull();
  });

  it("rolls back a switch that was cut short when the new daemon is not healthy", async () => {
    const w = new World();
    w.head = B;
    w.built.set(B, 5);
    w.cur = B;
    w.serving = null;
    w.daemonMode[B] = "down";
    w.store.s.inFlight = { sha: B, from: A, phase: "switch", startedAt: w.clock.now() };
    const r = await w.deployer().recover();
    expect(r?.action).toBe("rolled-back");
    expect(w.cur).toBe(A);
    expect(w.serving).toBe(A);
    expect(w.store.s.retry[B]?.failures).toBe(1);
  });

  it("a crash after the link moved but before the kickstart: restarts onto the candidate and keeps it", async () => {
    const w = new World();
    w.head = B;
    w.built.set(B, 5);
    w.cur = B; // point() happened...
    w.serving = A; // ...the kickstart did not
    w.store.s.inFlight = { sha: B, from: A, phase: "switch", startedAt: w.clock.now() };
    const start = w.clock.now();
    const r = await w.deployer().recover();
    expect(r?.action).toBe("deployed");
    expect(w.calls).toEqual(["restart (02)"]);
    expect(w.serving).toBe(B);
    expect(w.clock.now() - start).toBeLessThan(10_000); // not a 90 s wait before the restart
    expect(w.store.s.bad[B]).toBeUndefined();
    expect(w.store.records[0]).toMatchObject({ sha: B, outcome: "deployed" });
  });

  it("finishes a rollback that was cut short", async () => {
    const w = new World();
    w.head = B;
    w.built.set(B, 5);
    w.cur = B;
    w.serving = null;
    w.store.s.inFlight = { sha: B, from: A, phase: "rollback", startedAt: w.clock.now(), reason: "health" };
    const r = await w.deployer().recover();
    expect(r?.action).toBe("rolled-back");
    expect(w.cur).toBe(A);
    expect(w.store.records[0]?.reason).toContain("health");
  });

  it("a switch that never happened (current is still the old one) is simply forgotten", async () => {
    const w = new World();
    w.head = B;
    w.store.s.inFlight = { sha: B, from: A, phase: "switch", startedAt: w.clock.now() };
    await w.deployer().recover();
    expect(w.store.s.inFlight).toBeNull();
    expect(w.store.records).toEqual([]);
  });
});

describe("one instance", () => {
  it("a second deployer cannot take the lock", () => {
    const w = new World();
    const first = w.deployer();
    const second = new World().deployer();
    expect(first.acquire()).toBe(true);
    expect(second.acquire()).toBe(false);
    first.release();
    expect(second.acquire()).toBe(true);
    second.release();
  });
});

describe("rolling back by hand", () => {
  async function deployed(w: World, ...order: number[]) {
    const d = w.deployer();
    for (const n of order) {
      w.head = sha(n);
      w.ci[sha(n)] = { state: "success" };
      expect((await d.cycle()).action).toBe("deployed");
    }
    return d;
  }

  it("goes back to the previous deployed release, marks nothing bad, and pauses at main's tip", async () => {
    const w = new World();
    const d = await deployed(w, 2);
    await d.rollbackByHand();
    expect(w.cur).toBe(A);
    expect(w.serving).toBe(A);
    expect(w.store.s.bad).toEqual({});
    expect(w.store.s.paused).toMatchObject({ sha: B, to: A });
    expect(w.store.records.at(-1)).toMatchObject({ sha: B, from: B, outcome: "rolled-back" });
    expect(w.store.records.at(-1)?.reason).toBe("rolled back by hand to 0000001");
  });

  it("does not redeploy the tip it just rolled back from, even seconds later and cycle after cycle", async () => {
    const w = new World();
    const d = await deployed(w, 2);
    await d.rollbackByHand();
    w.builds.length = 0;
    for (let i = 0; i < 5; i++) {
      w.clock.t += 3_000 + i * 120_000;
      expect((await d.cycle()).action).toBe("paused");
    }
    expect(w.builds).toEqual([]);
    expect(w.cur).toBe(A);
    expect(d.pauseStatus()).toBe(
      "paused after hand rollback at 0000002 — resumes on the next commit (now on 0000001)",
    );
  });

  it("resumes by itself when a newer commit lands on main", async () => {
    const w = new World();
    const d = await deployed(w, 2);
    await d.rollbackByHand();
    expect((await d.cycle()).action).toBe("paused");
    w.head = C;
    w.ci[C] = { state: "success" };
    expect((await d.cycle()).action).toBe("deployed");
    expect(w.cur).toBe(C);
    expect(w.store.s.paused).toBeNull();
    expect(d.pauseStatus()).toBeNull();
  });

  it("--resume lifts the pause so the same tip can be deployed again", async () => {
    const w = new World();
    const d = await deployed(w, 2);
    await d.rollbackByHand();
    expect(d.resume()).toBe(true);
    expect(d.resume()).toBe(false);
    expect((await d.cycle()).action).toBe("deployed");
    expect(w.cur).toBe(B);
  });

  it("never picks a candidate that was built but not switched to, even if it is the newest on disk", async () => {
    const w = new World();
    const d = await deployed(w, 2);
    w.built.set(C, 999); // built, smoke-tested, waiting for a drain: newest mtime
    await d.rollbackByHand();
    expect(w.cur).toBe(A);
    expect(w.store.s.bad[C]).toBeUndefined();
    expect(w.built.has(C)).toBe(true);
  });

  it("walks back one deployed release at a time", async () => {
    const w = new World();
    const d = await deployed(w, 2, 3);
    await d.rollbackByHand();
    expect(w.cur).toBe(B);
    await d.rollbackByHand();
    expect(w.cur).toBe(A);
    expect(w.store.s.bad).toEqual({});
  });

  it("refuses while the daemon is busy or does not answer, unless forced", async () => {
    const w = new World();
    const d = await deployed(w, 2);
    w.busyUntil = Number.POSITIVE_INFINITY;
    await expect(d.rollbackByHand()).rejects.toThrow(/busy/);
    expect(w.cur).toBe(B);
    w.busyUntil = 0;
    w.unreachable = true;
    await expect(d.rollbackByHand()).rejects.toThrow(/does not answer/);
    expect(w.cur).toBe(B);
    w.unreachable = false;
    w.busyUntil = Number.POSITIVE_INFINITY;
    await d.rollbackByHand(undefined, { force: true });
    expect(w.cur).toBe(A);
  });

  it("refuses an explicit sha that was never deployed, and when there is nothing to go back to", async () => {
    const w = new World();
    const d = w.deployer();
    await expect(d.rollbackByHand()).rejects.toThrow(/no previous deployed release/);
    await deployed(w, 2);
    w.built.set(C, 50);
    await expect(d.rollbackByHand(C)).rejects.toThrow(/never deployed/);
    await expect(d.rollbackByHand(B)).rejects.toThrow(/already current/);
    expect(w.cur).toBe(B);
  });

  it("goes to a named earlier deployed release", async () => {
    const w = new World();
    const d = await deployed(w, 2, 3);
    await d.rollbackByHand(A);
    expect(w.cur).toBe(A);
  });
});

describe("records and state stay tidy", () => {
  it("leaves no attempts, ready, retry or in-flight entries after a deploy, a failure or a rollback", async () => {
    const w = new World();
    const d = w.deployer();
    w.head = B;
    w.ci[B] = { state: "success" };
    await d.cycle();
    expect(w.store.s.attempts).toEqual({});
    expect(w.store.s.ready).toEqual({});
    expect(w.store.s.retry).toEqual({});
    w.head = C;
    w.ci[C] = { state: "success" };
    w.buildFails[C] = "boom";
    await d.cycle();
    w.clock.t += 3 * 60_000;
    await d.cycle();
    expect(w.store.s.bad[C]).toBeDefined();
    expect(w.store.s.attempts).toEqual({});
    expect(w.store.s.ready).toEqual({});
    expect(w.store.s.retry).toEqual({});
    const x = sha(4);
    w.head = x;
    w.ci[x] = { state: "success" };
    w.daemonMode[x] = "down";
    await d.cycle();
    w.clock.t += 3 * 60_000;
    await d.cycle();
    expect(w.store.s.bad[x]).toBeDefined();
    expect(Object.keys(w.store.s.attempts)).toEqual([]);
    expect(Object.keys(w.store.s.ready)).toEqual([]);
    expect(w.store.s.inFlight).toBeNull();
  });

  it("clears every leftover retry entry once a deploy succeeds", async () => {
    const w = new World();
    w.head = B;
    w.ci[B] = { state: "success" };
    w.store.s.retry[B] = { failures: 1, transients: 2, nextAt: 0 };
    w.store.s.retry[sha(9)] = { failures: 0, transients: 1, nextAt: 0 };
    expect((await w.deployer().cycle()).action).toBe("deployed");
    expect(w.store.s.retry).toEqual({});
  });

  it("a restart after the record was written but before the state was cleared does not write it twice", async () => {
    const w = new World();
    w.head = B;
    w.built.set(B, 5);
    w.cur = B;
    w.serving = B;
    const startedAt = w.clock.now() - 20_000;
    w.store.s.inFlight = { sha: B, from: A, phase: "switch", startedAt };
    w.store.records.push({ at: 1, sha: B, from: A, outcome: "deployed", reason: "", durationMs: 1 });
    w.store.s.recorded = [`${B}:deployed:${startedAt}`];
    await w.deployer().recover();
    expect(w.store.records).toHaveLength(1);
    expect(w.store.s.inFlight).toBeNull();
  });

  it("shows no absolute home paths in a failure reason", async () => {
    const w = new World();
    w.head = B;
    w.ci[B] = { state: "success" };
    w.buildFails[B] =
      "pnpm install failed (exit 1): ENOENT /Users/padi/i-inc-releases/abc/package.json and /home/owner/x";
    const d = w.deployer();
    await d.cycle();
    w.clock.t += 3 * 60_000;
    await d.cycle();
    const reason = w.store.records[0]?.reason ?? "";
    expect(reason).toContain("ENOENT");
    expect(reason).not.toContain("/Users/padi");
    expect(reason).not.toContain("/home/owner");
    expect(w.logs.join("\n")).not.toContain("/Users/padi");
  });
});

describe("pruning keeps what a rollback needs", () => {
  it("never prunes the current or the previous deployed release, however small keep is", async () => {
    const w = new World();
    w.settings.keep = 1;
    const d = w.deployer();
    for (const n of [2, 3, 4]) {
      w.head = sha(n);
      w.ci[sha(n)] = { state: "success" };
      await d.cycle();
      expect(w.built.has(sha(n))).toBe(true);
      expect(w.built.has(sha(n - 1))).toBe(true);
    }
    expect(w.built.has(sha(2))).toBe(false);
    expect(w.built.has(sha(1))).toBe(false);
    expect(w.cur).toBe(sha(4));
  });
});
