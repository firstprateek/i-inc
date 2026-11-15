// Approval levels (decided 2026-11-15): lenient, the company's default, asks only where a mistake is costly or
// can't be undone; careful asks the way i.inc always did. The fakes default to careful, so here they are lenient.
import { describe, expect, it } from "vitest";
import { approvalLevel, askLine, fold, maxAskLength, runTicket, stuckAsk } from "../src/index.ts";
import { json } from "../src/testing/index.ts";
import { ports, refundsTicket } from "./fixtures.ts";

const lenient = () => {
  const p = ports();
  p.company.approvalLevel = "lenient";
  return p;
};
const [first, second] = refundsTicket().doneWhen as [string, string];
const say = (output: string) => ({ kind: "done" as const, output });
const doneWhen = (...v: string[]) =>
  say(
    json({
      items: [first, second].map((d, n) => ({ doneWhen: d, verdict: v[n], evidence: `evidence ${n + 1}` })),
    }),
  );

describe("approval levels", () => {
  it("an employee's own level wins, then the company's, then lenient", () => {
    expect(approvalLevel("careful", "lenient")).toBe("careful");
    expect(approvalLevel(undefined, "careful")).toBe("careful");
    expect(approvalLevel(undefined, undefined)).toBe("lenient");
  });

  it("lenient: a plan in a risky area goes straight to building", async () => {
    const p = lenient();
    p.agent.on({ duty: "plan" }, say("Add an alerts table: a schema migration."));
    expect((await runTicket(p, refundsTicket())).status).toBe("ready");
  });

  it("careful: the same plan still waits at the gate", async () => {
    const p = ports();
    p.agent.on({ duty: "plan" }, say("Add an alerts table: a schema migration."));
    expect((await runTicket(p, refundsTicket())).status).toBe("needs-you");
  });

  it("lenient: an item the checker can't confirm doesn't stop the work, and is recorded", async () => {
    const p = lenient();
    p.agent.on({ stage: "done-when", duty: "verify" }, doneWhen("met", "can't tell"));
    expect((await runTicket(p, refundsTicket({ effort: "low" }))).status).toBe("ready");
    const s = fold(await p.store.read("42"));
    expect(s.doneCheck?.items.map((i) => i.verdict)).toEqual(["met", "cant-tell"]);
  });

  it("lenient: a recheck that doesn't answer for an item that was not met still asks", async () => {
    const p = lenient();
    const onlyFirst = say(json({ items: [{ doneWhen: first, verdict: "met", evidence: "a test" }] }));
    p.agent.on({ stage: "done-when", duty: "verify" }, doneWhen("met", "not met"), onlyFirst);
    const r = await runTicket(p, refundsTicket({ effort: "low" }));
    expect(r.status).toBe("needs-you");
  });

  it("lenient: a recheck that can't tell an item that was not met keeps it not met", async () => {
    const p = lenient();
    p.agent.on(
      { stage: "done-when", duty: "verify" },
      doneWhen("met", "not met"),
      doneWhen("met", "can't tell"),
    );
    const r = await runTicket(p, refundsTicket({ effort: "low" }));
    expect(r.status).toBe("needs-you");
    expect(fold(await p.store.read("42")).doneCheck?.items.map((i) => i.verdict)).toEqual(["met", "not-met"]);
  });

  it("lenient: a checker reply that can't be read never passes", async () => {
    const p = lenient();
    p.agent.on({ stage: "done-when", duty: "verify" }, say("looks fine to me"));
    expect((await runTicket(p, refundsTicket({ effort: "low" }))).status).toBe("needs-you");
  });

  it("lenient, fast mode: a second round that approves without a done-when list doesn't clear a not-met item", async () => {
    const p = lenient();
    p.company.policy = { ...p.company.policy, mode: "direct" };
    const round1 = say(
      json({
        approved: false,
        findings: [],
        doneWhen: [first, second].map((d, n) => ({
          doneWhen: d,
          verdict: n ? "not met" : "met",
          evidence: `evidence ${n + 1}`,
        })),
      }),
    );
    p.agent.on({ stage: "review", duty: "review" }, round1, say(json({ approved: true, findings: [] })));
    const r = await runTicket(p, refundsTicket());
    expect(r.status).toBe("needs-you");
    expect(p.harness.gateRuns).toBe(0);
  });

  it("lenient: an item still not met after the builder's fix asks, in one short line", async () => {
    const p = lenient();
    p.agent.on(
      { stage: "done-when", duty: "verify" },
      doneWhen("met", "not met"),
      doneWhen("met", "not met"),
    );
    const r = await runTicket(p, refundsTicket({ effort: "low" }));
    if (r.status !== "needs-you" || r.ask.kind !== "stuck") throw new Error("expected a stuck card");
    expect(r.ask.reason).toMatch(/^1 of 2 done-when items is not met after the fix/);
  });

  it("lenient: a builder and reviewer who still disagree go on, with the dispute in the report", async () => {
    const p = lenient();
    const changes = say(
      json({
        approved: false,
        findings: [{ severity: "blocking", where: "sync/cache.ts:40", text: "stale" }],
      }),
    );
    const dispute = say(json({ disputed: "sync clears the cache in after.ts" }));
    p.agent.on({ employee: "grace", duty: "review" }, changes, changes);
    p.agent.on({ employee: "ada", stage: "review" }, dispute, dispute);
    const r = await runTicket(p, refundsTicket({ effort: "high" }));
    expect(r.status).toBe("ready");
  });
});

describe("askLine", () => {
  it("keeps a short request as it is, on one line", () => {
    expect(askLine("Ship it?\n  Now")).toBe("Ship it? Now");
  });
  it("cuts a long one at a word, with an ellipsis, within the cap", () => {
    const long = `The done-when is not confirmed: ${"a long explanation ".repeat(30)}`;
    const line = askLine(long);
    expect(line.length).toBeLessThanOrEqual(maxAskLength);
    expect(line.endsWith("…")).toBe(true);
    expect(line).not.toMatch(/\s…$/);
  });
});

describe("stuckAsk", () => {
  it("has no detail when the line is the whole text", () => {
    expect(stuckAsk("Checks are red")).toEqual({ kind: "stuck", reason: "Checks are red" });
  });
  it("keeps the whole text as the detail when the line is cut", () => {
    const long = "x ".repeat(200).trim();
    const ask = stuckAsk(long);
    expect(ask.reason.length).toBeLessThanOrEqual(maxAskLength);
    expect(ask.detail).toBe(long);
  });
});
