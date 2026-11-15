// A plan that changes under a running ticket (fast mode, 2026-11-14, replaced plan, prove and done-when in direct
// mode): the next stage is the plan's first one not finished, so the gates are never skipped and the run never
// falls off the end. And in direct mode a ticket that never pushed doesn't close as merged.
import { describe, expect, it } from "vitest";
import { fold, runTicket, type StageId, type TicketEvent } from "../src/index.ts";
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
});
