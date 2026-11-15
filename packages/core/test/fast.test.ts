// Fast mode (decided 2026-11-14), direct mode's default for Low and Medium: the builder plans inside its build
// session; one fresh check session in its own seat and engine reviews the diff and the done-when together, without
// the brain and at low effort; round 2 looks only at what changed; the daemon writes the report from the builder's
// summary; and the retro runs only when something happened.
import { describe, expect, it } from "vitest";
import { answer, fold, planFor, runTicket, type TicketEvent } from "../src/index.ts";
import { FakeWorkspace, fakePorts, json } from "../src/testing/index.ts";
import { ada, engines, ports, refundsTicket } from "./fixtures.ts";

const sha = (n: number) => String(n).repeat(40);
const direct = <T extends { company: { policy: { mode: string } } }>(p: T) => {
  p.company.policy = { ...p.company.policy, mode: "direct" };
  return p;
};
const [first, second] = refundsTicket().doneWhen as [string, string];
const say = (output: string) => ({ kind: "done" as const, output });
type V = "met" | "not met" | "can't tell";
const check = (approved: boolean, v: V[], findings: unknown[] = []) =>
  say(
    json({
      approved,
      findings,
      doneWhen: [first, second].map((doneWhen, n) => ({
        doneWhen,
        verdict: v[n],
        evidence: `evidence ${n + 1}`,
      })),
    }),
  );
const built = say(
  `Plan: subtract refunds in the sorter.\n\nDone.\n\n\`\`\`json\n${json({
    summary: "Refunds now offset spending.",
    followUps: [
      {
        title: "Test refunds across months",
        doneWhen: ["a test covers it"],
        type: "chore",
        effort: "low",
        reason: "r",
      },
    ],
  })}\n\`\`\``,
);
const events = async (p: { store: { read: (id: string) => Promise<TicketEvent[]> } }) => p.store.read("42");

describe("fast mode", () => {
  it("is the plan for Low and Medium in direct mode; High stays thorough", () => {
    const policy = { mode: "direct" as const, protectedPaths: [], followUpsPerDay: 3 };
    expect(planFor(refundsTicket({ effort: "low" }), policy).fast).toBe(true);
    expect(planFor(refundsTicket({ effort: "medium" }), policy).stages).toEqual([
      "pickup",
      "build",
      "checks",
      "review",
      "gates",
      "report",
    ]);
    expect(planFor(refundsTicket({ effort: "high" }), policy).fast).toBeUndefined();
    expect(planFor(refundsTicket(), { ...policy, mode: "owner-merges" }).fast).toBeUndefined();
  });

  it("builds with a plan inside, checks in the builder's own seat, and reports without a session", async () => {
    const p = direct(ports());
    p.harness.gates.push({ ok: true, pushed: sha(1) });
    p.agent.on({ stage: "build" }, built);
    expect(await runTicket(p, refundsTicket())).toEqual({ status: "done", outcome: "merged" });

    const s = fold(await events(p));
    expect(s.finished).toEqual(["pickup", "build", "checks", "review", "gates", "report", "retro"]);
    // Two sessions in all: the build and the check. No plan, prove, done-when, report or retro session.
    expect(p.agent.calls.map((c) => c.stage)).toEqual(["build", "review"]);
    expect(p.agent.calls[0]?.brief).toContain("Start with a short plan");

    const call = p.agent.calls[1];
    expect(call?.employee.id).toBe("ada"); // not Grace, who holds the review duty: the builder's own seat
    expect(call?.engine.id).toBe(p.agent.calls[0]?.engine.id); // on the same engine
    expect(call?.effort).toBe("low");
    expect(call?.brain).toBe(false);
    expect(call?.brief).not.toContain("Assignee:"); // a fresh context
    expect(call?.brief).toContain("fresh eyes");
    expect(call?.brief).toContain(`- ${first}`);
    expect(call?.brief).toContain("passed on the builder's last run");

    expect(s.doneCheck).toMatchObject({ by: "ada" });
    expect(s.doneCheck?.items.map((i) => i.verdict)).toEqual(["met", "met"]);
    const log = await events(p);
    expect(log.find((e) => e.type === "report-ready")).toMatchObject({
      summary: "Refunds now offset spending.",
    });
    expect(log.find((e) => e.type === "follow-ups")).toMatchObject({
      employeeId: "ada",
      tickets: [{ title: "Test refunds across months" }],
    });
    expect(log.some((e) => e.type === "needs-you")).toBe(false);
  });

  it("a build reply with no summary still reports, and says so", async () => {
    const p = direct(ports());
    p.agent.on({ stage: "build" }, say("Done, see the commits."));
    await runTicket(p, refundsTicket());
    expect((await events(p)).find((e) => e.type === "report-ready")).toMatchObject({
      summary: "Ada didn't write a summary; the commits say what changed.",
    });
  });

  it("checks on another vendor's engine only when the project opts in", async () => {
    const p = direct(fakePorts([ada], engines));
    p.company.policy = { ...p.company.policy, crossVendorReview: true };
    await runTicket(p, refundsTicket());
    const call = p.agent.calls.find((c) => c.stage === "review" && c.duty === "review");
    expect(call?.employee.id).toBe("ada");
    expect(call?.engine.harness).not.toBe("claude-code");
  });

  it("an unmet item is a blocking finding; round 2 looks only at what changed and at the open item", async () => {
    const p = direct(ports());
    p.harness.gates.push({ ok: true, pushed: sha(7) }); // direct mode's gates push, as the real harness does
    p.workspace = new FakeWorkspace();
    p.agent.on(
      { stage: "review", duty: "review" },
      check(false, ["met", "not met"], [{ severity: "should-fix", where: "refunds.ts:4", text: "name it" }]),
      say(
        json({
          approved: true,
          findings: [],
          doneWhen: [{ doneWhen: second, verdict: "met", evidence: "a test" }],
        }),
      ),
    );
    expect(await runTicket(p, refundsTicket())).toEqual({ status: "done", outcome: "merged" });

    const log = await events(p);
    const verdicts = log.filter((e) => e.type === "review-verdict");
    expect(verdicts[0]).toMatchObject({ approved: false, round: 1, head: "a".repeat(40) });
    expect(
      (verdicts[0] as { findings: { severity: string; where: string; text: string }[] }).findings,
    ).toEqual([
      { severity: "should-fix", where: "refunds.ts:4", text: "name it" },
      { severity: "blocking", where: "done-when", text: `not met: ${second} (evidence 2)` },
    ]);
    const checks = p.agent.calls.filter((c) => c.stage === "review" && c.duty === "review");
    expect(checks).toHaveLength(2);
    expect(checks[1]?.brief).toContain(`git diff ${"a".repeat(40)}`);
    expect(checks[1]?.brief).toContain("don't review the rest again");
    // Met last time: carried over, not asked again.
    expect(checks[1]?.brief).toContain(`Done-when:\n- ${second}\nBe brief.`);
    expect(fold(log).doneCheck?.items.map((i) => i.verdict)).toEqual(["met", "met"]);
  });

  it("an item still open after the last round goes to the owner, never to done (T72)", async () => {
    const p = direct(ports());
    p.harness.gates.push({ ok: true, pushed: sha(7) }); // direct mode's gates push, as the real harness does
    p.agent.on(
      { stage: "review", duty: "review" },
      check(false, ["met", "not met"]),
      check(false, ["met", "can't tell"]),
    );
    const result = await runTicket(p, refundsTicket());
    if (result.status !== "needs-you" || result.ask.kind !== "stuck")
      throw new Error("expected a stuck card");
    expect(result.ask.reason).toBe("1 of 2 done-when items can't be confirmed after 2 check rounds");
    expect(p.harness.gateRuns).toBe(0);
    // Keep going starts the check again from a fresh first round: met this time, and on to the gates.
    await answer(p, "42", "continue");
    const after = await runTicket(p, refundsTicket());
    expect(after, JSON.stringify(after)).toEqual({ status: "done", outcome: "merged" });
  });

  it("lenient: a check that approves with an item it can't confirm goes on to the gates", async () => {
    const p = direct(ports());
    p.harness.gates.push({ ok: true, pushed: sha(7) }); // direct mode's gates push, as the real harness does
    p.company.approvalLevel = "lenient";
    p.agent.on({ stage: "review", duty: "review" }, check(true, ["met", "can't tell"]));
    expect(await runTicket(p, refundsTicket())).toEqual({ status: "done", outcome: "merged" });
    expect(p.agent.calls.filter((c) => c.stage === "review" && c.duty === "review")).toHaveLength(1);
  });

  it("a check that changed files has them put back, and the owner decides", async () => {
    const p = direct(ports());
    const ws = new FakeWorkspace();
    p.workspace = ws;
    const run = p.agent.run.bind(p.agent);
    p.agent.run = async (req) => {
      if (req.stage === "review" && req.duty === "review")
        ws.trees.set("ada", { head: "a".repeat(40), status: [" M src/refunds.ts"] });
      return run(req);
    };
    const result = await runTicket(p, refundsTicket());
    if (result.status !== "needs-you" || result.ask.kind !== "stuck")
      throw new Error("expected a stuck card");
    expect(result.ask.reason).toContain("changed files (src/refunds.ts)");
    expect(ws.restored).toEqual([{ employeeId: "ada", paths: ["src/refunds.ts"] }]);
    expect(fold(await events(p)).doneCheck?.items.map((i) => i.verdict)).toEqual(["cant-tell", "cant-tell"]);
  });

  it("runs no retro on a quiet ticket, and the builder's alone after a failed check run", async () => {
    const quiet = direct(ports());
    await runTicket(quiet, refundsTicket());
    expect(quiet.agent.calls.some((c) => c.stage === "retro")).toBe(false);

    const bumpy = direct(ports());
    bumpy.harness.checks.push({ green: false, failures: ["lint: 1 error"] });
    await runTicket(bumpy, refundsTicket());
    expect(bumpy.agent.calls.filter((c) => c.stage === "retro").map((c) => c.employee.id)).toEqual(["ada"]);
  });
});
