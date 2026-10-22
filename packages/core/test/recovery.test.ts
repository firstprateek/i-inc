// Recovery and the owner's approvals (T63 audit, groups 2 and 6): what a restart, a retry or an
// answer must leave behind.
import { describe, expect, it } from "vitest";
import { answer, defaultSwitchRules, type Employee, fold, retry, runTicket } from "../src/index.ts";
import { Crash, FakeWorkspace } from "../src/testing/index.ts";
import { ada, ports, refundsTicket } from "./fixtures.ts";

const sha = (n: number) => String(n).repeat(40);
const direct = <T extends { company: { policy: { mode: string } } }>(p: T) => {
  p.company.policy = { ...p.company.policy, mode: "direct" };
  return p;
};
const low = () => refundsTicket({ effort: "low" });
const builds = (p: { agent: { calls: { duty: string }[] } }) =>
  p.agent.calls.filter((c) => c.duty === "build").length;

describe("2.3 a push that landed but whose record was lost", () => {
  it("writes push-intended before the push, and hands it to the next run so it can carry on to CI and the report", async () => {
    const p = direct(ports());
    p.harness.crashAfterPushOf = sha(1);
    await expect(runTicket(p, low())).rejects.toBeInstanceOf(Crash);
    const events = await p.store.read("42");
    expect(events.at(-1)).toMatchObject({ type: "push-intended", headSha: sha(1) });
    expect(events.some((e) => e.type === "pushed")).toBe(false);

    // The next run is told what the last one was about to push (the real harness finds it on main).
    p.harness.gates.push({ ok: true, pushed: sha(1) });
    const result = await runTicket(p, low());
    expect(p.harness.gateOpts[1]).toMatchObject({ pushIntended: sha(1) });
    expect(result).toEqual({ status: "done", outcome: "merged" });
    const s = fold(await p.store.read("42"));
    expect(s.pushed).toBe(sha(1));
    expect(s.pushIntended).toBeNull();
    // CI was watched and the report written, as for any push.
    expect((await p.store.read("42")).some((e) => e.type === "ci-green")).toBe(true);
    expect(s.finished).toContain("report");
  });
});

describe("2.4 a retry or an owner's answer starts the stage's counters over", () => {
  const noFallback: Employee = {
    ...ada,
    engines: { default: "opus", fallbacks: [] },
    switchRules: { ...defaultSwitchRules, onStuck: "switch", checksFailedBeforeSwitch: 2 },
  };

  it("retry after failed checks runs the builder again, instead of failing at once", async () => {
    const p = ports(noFallback);
    p.harness.checks.push({ green: false, failures: ["a"] }, { green: false, failures: ["b"] });
    const first = await runTicket(p, low());
    expect(first.status).toBe("failed");
    const before = builds(p);
    await retry(p, "42");
    const second = await runTicket(p, low());
    expect(builds(p)).toBeGreaterThan(before);
    expect(second.status).toBe("ready");
  });

  it("retry after failed proof runs the verifier again", async () => {
    const p = ports();
    const bad = JSON.stringify({ items: [{ doneWhen: "x", pass: false, evidence: "no" }] });
    p.agent.on({ duty: "verify" }, { kind: "done", output: bad }, { kind: "done", output: bad });
    expect((await runTicket(p, refundsTicket())).status).toBe("failed");
    const before = p.agent.calls.length;
    await retry(p, "42");
    expect((await runTicket(p, refundsTicket())).status).toBe("ready");
    expect(p.agent.calls.length).toBeGreaterThan(before);
  });

  it("retry after a rebase that conflicted twice resolves it again", async () => {
    const p = direct(ports());
    p.harness.gates.push(
      { ok: false, conflict: true, reason: "conflict" },
      { ok: false, conflict: true, reason: "conflict" },
    );
    expect((await runTicket(p, low())).status).toBe("failed");
    const before = builds(p);
    await retry(p, "42");
    p.harness.gates.push({ ok: true, pushed: sha(2) });
    expect((await runTicket(p, low())).status).toBe("done");
    expect(builds(p)).toBeGreaterThan(before);
  });

  it("a stuck card's Keep going answer starts a builder session, and the card does not come straight back", async () => {
    const p = ports({ ...noFallback, switchRules: { ...noFallback.switchRules, onStuck: "escalate" } });
    p.harness.checks.push({ green: false, failures: ["a"] }, { green: false, failures: ["b"] });
    const first = await runTicket(p, low());
    expect(first).toMatchObject({ status: "needs-you", ask: { kind: "stuck" } });
    const before = builds(p);
    await answer(p, "42", "continue");
    const state = fold(await p.store.read("42"));
    expect(state.checkFailures).toBe(0);
    expect(state.lastAnswer).toBeNull();
    const second = await runTicket(p, low());
    expect(builds(p)).toBeGreaterThan(before);
    expect(second.status).toBe("ready");
  });

  it("any answer to a stuck card resets the counters", async () => {
    const p = ports({ ...noFallback, switchRules: { ...noFallback.switchRules, onStuck: "escalate" } });
    p.harness.checks.push({ green: false, failures: ["a"] }, { green: false, failures: ["b"] });
    await runTicket(p, low());
    const before = builds(p);
    await answer(p, "42", "builder");
    expect((await runTicket(p, low())).status).toBe("ready");
    expect(builds(p)).toBeGreaterThan(before);
  });
});

describe("6.1 the owner's OK for protected paths covers the paths on its card", () => {
  it("does not carry over to a later run: a fix session after red CI is asked about again", async () => {
    const p = direct(ports());
    p.harness.gates.push(
      { ok: false, conflict: false, reason: "p", protectedPaths: ["docs/x"] },
      { ok: true, pushed: sha(1) },
      // After the red CI and a fix session, the fix touches a new protected path.
      { ok: false, conflict: false, reason: "p", protectedPaths: [".github/workflows/ci.yml"] },
    );
    p.harness.ci.push({ ok: false, reason: "red" });
    expect((await runTicket(p, low())).status).toBe("needs-you");
    await answer(p, "42", "approve");
    const second = await runTicket(p, low());

    // The second run was told: the OK is for docs/x only.
    expect(p.harness.gateOpts[1]).toMatchObject({ ownerApproved: true, approvedPaths: ["docs/x"] });
    // The third (after the fix session) has no sticky approval, and the new path is asked about.
    expect(p.harness.gateOpts[2]).toMatchObject({ ownerApproved: false, approvedPaths: ["docs/x"] });
    expect(second).toEqual({
      status: "needs-you",
      ask: { kind: "protected-paths", paths: [".github/workflows/ci.yml"] },
    });
    const s = fold(await p.store.read("42"));
    expect(s.approvedPaths).toEqual(["docs/x"]);
    expect(s.lastAnswer).toBeNull();
  });
});

describe("2.5 a retried ticket does not build in a folder cleanup emptied", () => {
  it("makes the worktree again, before the builder's session, when it is gone", async () => {
    const noFallback: Employee = {
      ...ada,
      engines: { default: "opus", fallbacks: [] },
      switchRules: { ...defaultSwitchRules, onStuck: "switch", checksFailedBeforeSwitch: 2 },
    };
    const p = ports(noFallback);
    const workspace = new FakeWorkspace();
    p.workspace = workspace;
    p.harness.checks.push({ green: false, failures: ["a"] }, { green: false, failures: ["b"] });
    expect((await runTicket(p, low())).status).toBe("failed");
    expect(workspace.opened).toEqual(["42"]);

    // Days later cleanup took the worktree; the owner retries.
    p.clock.advance(4 * 24 * 60);
    workspace.gone.add("ada");
    await retry(p, "42");
    expect((await runTicket(p, low())).status).toBe("ready");
    expect(workspace.opened).toEqual(["42", "42"]);
    expect(workspace.calls.filter((c) => c === "open ada")).toHaveLength(2);
    // It looked before it opened, and the builder's session came after.
    expect(workspace.looked).toContain("ada");
  });

  it("does not look again for a builder who worked a moment ago", async () => {
    const p = ports();
    const workspace = new FakeWorkspace();
    p.workspace = workspace;
    expect((await runTicket(p, low())).status).toBe("ready");
    expect(workspace.looked).toEqual([]);
  });
});
