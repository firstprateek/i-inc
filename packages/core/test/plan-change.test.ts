// A plan that changes under a running ticket (fast mode, 2026-11-14, replaced plan, prove and done-when in direct
// mode): the next stage is the plan's first one not finished, so the gates are never skipped and the run never
// falls off the end. And in direct mode a ticket that never pushed doesn't close as merged.
import { describe, expect, it } from "vitest";
import { fold, nextStage, planFor, retry, runTicket, type StageId, type TicketEvent } from "../src/index.ts";
import { ports, refundsTicket } from "./fixtures.ts";

const sha = "c".repeat(40);
const direct = <T extends { company: { policy: { mode: string } } }>(p: T) => {
  p.company.policy = { ...p.company.policy, mode: "direct" };
  return p;
};
/** The events of stages finished under the old Medium plan, before fast mode. */
const finishedUnderOldPlan = (stages: StageId[], at = 1): TicketEvent[] => [
  { type: "ticket-created", at, ticketId: "42" },
  ...stages.flatMap((stage): TicketEvent[] => [
    { type: "stage-started", at, stage },
    { type: "stage-finished", at, stage },
  ]),
];

describe("a plan that changed under a running ticket", () => {
  it("goes to the gates, not the report, after stages the new plan doesn't have (#20)", async () => {
    const p = direct(ports());
    await p.store.append(
      "42",
      finishedUnderOldPlan(["pickup", "plan", "build", "checks", "prove", "review", "done-when"]),
    );
    p.harness.gates.push({ ok: true, pushed: sha });

    expect(await runTicket(p, refundsTicket())).toEqual({ status: "done", outcome: "merged" });
    const s = fold(await p.store.read("42"));
    expect(s.pushed).toBe(sha);
    expect(s.finished.indexOf("gates")).toBeLessThan(s.finished.indexOf("report"));
  });

  it("writes the report after the gates instead of failing with 'ran out of stages' (#22)", async () => {
    const p = direct(ports());
    await p.store.append("42", [
      ...finishedUnderOldPlan(["pickup", "plan", "build", "checks", "prove", "review", "done-when"]),
      { type: "stage-started", at: 2, stage: "gates" },
      { type: "pushed", at: 2, sha },
      { type: "stage-finished", at: 2, stage: "gates" },
    ]);

    expect(await runTicket(p, refundsTicket())).toEqual({ status: "done", outcome: "merged" });
    expect(fold(await p.store.read("42")).finished).toContain("report");
  });

  it("closes a direct-mode ticket that never pushed as done, not merged", async () => {
    const p = direct(ports());
    await p.store.append("42", finishedUnderOldPlan(["pickup", "build", "checks", "review", "gates"]));

    expect(await runTicket(p, refundsTicket())).toEqual({ status: "done", outcome: "done" });
  });

  it("goes on after the furthest stage finished when the project switches mode, never back to plan", () => {
    const ownerMerges = { mode: "owner-merges" as const, protectedPaths: [], followUpsPerDay: 3 };
    const plan = planFor(refundsTicket(), ownerMerges);
    expect(nextStage(plan, { finished: ["pickup", "build", "checks", "review"] })).toBe("done-when");
    // "Not quite" keeps only the stages before build: building comes next again.
    expect(nextStage(plan, { finished: ["pickup", "plan"] })).toBe("build");
  });

  it("asks for a report session when the build ran under the fuller plan and wrote no summary (#22)", async () => {
    const p = direct(ports());
    await p.store.append("42", [
      ...finishedUnderOldPlan(["pickup", "plan", "build", "checks", "prove", "review", "done-when"]),
      { type: "stage-started", at: 2, stage: "gates" },
      { type: "pushed", at: 2, sha },
      { type: "stage-finished", at: 2, stage: "gates" },
    ]);
    await runTicket(p, refundsTicket());
    expect(p.agent.calls.some((c) => c.brief.includes("Write the report"))).toBe(true);
    expect(fold(await p.store.read("42")).outputs.report).not.toContain("didn't write a summary");
  });
});

describe("a reverted push", () => {
  it("no longer counts as pushed: Retry rebases and pushes again, and closes on the new push", async () => {
    const p = direct(ports());
    p.harness.gates.push({ ok: true, pushed: "5".repeat(40) }, { ok: true, pushed: "6".repeat(40) });
    p.harness.watchCi = async () => ({ ok: false, reason: "CI failed" });
    const append = p.store.append.bind(p.store);
    p.store.append = async (id, events) => {
      await append(id, events);
      if (events.some((e) => e.type === "main-red")) p.clock.advance(5 * 60);
    };
    expect(await runTicket(p, refundsTicket({ effort: "low" }))).toMatchObject({ status: "failed" });
    expect(p.harness.reverted).toEqual(["5".repeat(40)]);
    expect(fold(await p.store.read("42")).pushed).toBeNull();

    p.harness.watchCi = async () => ({ ok: true });
    p.harness.gates.push({ ok: true, pushed: "7".repeat(40) });
    const runs = p.harness.gateRuns;
    await retry(p, "42");
    expect(await runTicket(p, refundsTicket({ effort: "low" }))).toEqual({
      status: "done",
      outcome: "merged",
    });
    expect(p.harness.gateRuns).toBeGreaterThan(runs);
    expect(fold(await p.store.read("42")).pushed).toBe("7".repeat(40));
  });
});
