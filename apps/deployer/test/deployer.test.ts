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

  it("a build failure leaves the running release alone, marks the sha bad and tries newer ones", async () => {
    const w = new World();
    w.head = B;
    w.ci[B] = { state: "success" };
    w.buildFails[B] = "pnpm install failed (exit 1): lockfile";
    const d = w.deployer();
    expect((await d.cycle()).action).toBe("failed-build");
    expect(w.cur).toBe(A);
    expect(w.calls).not.toContain("restart (01)");
    expect(w.store.records[0]).toMatchObject({ sha: B, from: A, outcome: "failed-build" });
    expect(w.store.records[0]?.reason).toContain("lockfile");
    // Never retried:
    w.builds.length = 0;
    expect((await d.cycle()).action).toBe("known-bad");
    expect(w.builds).toEqual([]);
    expect(w.store.records).toHaveLength(1);
    // A newer commit is tried:
    w.head = C;
    w.ci[C] = { state: "success" };
    expect((await d.cycle()).action).toBe("deployed");
    expect(w.cur).toBe(C);
  });

  it("a failed smoke test never switches or restarts anything", async () => {
    const w = new World();
    w.head = B;
    w.ci[B] = { state: "success" };
    w.smokeFails[B] = "/api/health did not answer in 60 s";
    expect((await w.deployer().cycle()).action).toBe("failed-smoke");
    expect(w.calls).toEqual(["build 02", "smoke 02", "remove 02"]);
    expect(w.cur).toBe(A);
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

  it("treats a daemon that does not answer as drained", async () => {
    const w = new World();
    w.head = B;
    w.ci[B] = { state: "success" };
    w.unreachable = true;
    const start = w.clock.now();
    // The switch then fails its health check because the fake stays unreachable: rolled back.
    const r = await w.deployer().cycle();
    expect(r.action).toBe("rolled-back");
    expect(w.clock.now() - start).toBeLessThan(5 * 60_000);
    expect(w.calls).toContain("point 02");
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
      expect(w.store.s.bad[B]).toBeDefined();
      expect(w.store.s.inFlight).toBeNull();
    });
  }

  it("rolls back when the kickstart itself fails, and never retries that sha", async () => {
    const w = new World();
    w.head = B;
    w.ci[B] = { state: "success" };
    w.daemonMode[B] = "kickstart-fails";
    const d = w.deployer();
    expect((await d.cycle()).action).toBe("rolled-back");
    expect(w.store.records[0]?.reason).toContain("kickstart");
    w.builds.length = 0;
    expect((await d.cycle()).action).toBe("known-bad");
    expect(w.builds).toEqual([]);
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
    w.store.s.inFlight = { sha: B, from: A, phase: "switch", startedAt: w.clock.now() };
    const r = await w.deployer().recover();
    expect(r?.action).toBe("rolled-back");
    expect(w.cur).toBe(A);
    expect(w.serving).toBe(A);
    expect(w.store.s.bad[B]).toBeDefined();
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

  it("goes back to the previous deployed release and marks the one it leaves as bad, never the target", async () => {
    const w = new World();
    const d = await deployed(w, 2);
    await d.rollbackByHand();
    expect(w.cur).toBe(A);
    expect(w.serving).toBe(A);
    expect(w.store.s.bad[B]?.reason).toContain("rolled back by hand to 0000001");
    expect(w.store.s.bad[A]).toBeUndefined();
    expect(w.store.records.at(-1)).toMatchObject({ sha: B, from: B, outcome: "rolled-back" });
    expect(w.store.records.at(-1)?.reason).toBe("rolled back by hand to 0000001");
    // main still points at B, but it is not deployed again.
    expect((await d.cycle()).action).toBe("known-bad");
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

  it("walks back one deployed release at a time, skipping bad ones", async () => {
    const w = new World();
    const d = await deployed(w, 2, 3);
    await d.rollbackByHand();
    expect(w.cur).toBe(B);
    await d.rollbackByHand();
    expect(w.cur).toBe(A);
    expect(w.store.s.bad[C]).toBeDefined();
    expect(w.store.s.bad[B]).toBeDefined();
    expect(w.store.s.bad[A]).toBeUndefined();
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
