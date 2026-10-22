// T63 audit, group 1: no single bad datum may break the pipeline. What an agent replies is checked
// before it is stored, and a bad event already in a log can't break the fold or the scheduler.
import { describe, expect, it } from "vitest";
import {
  decide,
  fold,
  knowledgeLog,
  planFor,
  readDisputed,
  readEdits,
  readFollowUps,
  readProof,
  readProposals,
  readVerdict,
  runTicket,
  type Snapshot,
  schedule,
  type TicketEvent,
} from "../src/index.ts";
import { fakePorts } from "../src/testing/index.ts";
import { ada, engines, ports, refundsTicket } from "./fixtures.ts";

const direct = <T extends { company: { policy: { mode: string } } }>(p: T) => {
  p.company.policy = { ...p.company.policy, mode: "direct" };
  return p;
};
const types = async (p: { store: { read: (id: string) => Promise<TicketEvent[]> } }) =>
  (await p.store.read("42")).map((e) => e.type);

describe("agent replies are checked before they are stored", () => {
  it("a verifier's items that are not a list fail the stage and leave a state that folds", async () => {
    const p = ports();
    p.agent.on({ duty: "verify" }, { kind: "done", output: '{"items": "all pass"}' });
    const result = await runTicket(p, refundsTicket());
    expect(result).toMatchObject({ status: "failed" });
    expect(result.status === "failed" && result.reason).toContain("proof could not be read");
    expect(await types(p)).not.toContain("proof");
    expect(fold(await p.store.read("42")).status).toBe("failed");
  });

  it("a proof item whose pass is not a boolean is refused, not guessed", async () => {
    const p = ports();
    p.agent.on({ duty: "verify" }, { kind: "done", output: '{"items":[{"doneWhen":"x","pass":"yes"}]}' });
    const result = await runTicket(p, refundsTicket());
    expect(result.status).toBe("failed");
    expect(await types(p)).not.toContain("proof");
  });

  it("a rejection without findings gets one, so the builder has something to answer", async () => {
    const p = direct(ports());
    p.agent.on({ duty: "review" }, { kind: "done", output: '{"approved": false}' });
    await runTicket(p, refundsTicket());
    const verdicts = (await p.store.read("42")).filter((e) => e.type === "review-verdict");
    expect(verdicts[0]).toMatchObject({
      approved: false,
      findings: [{ severity: "blocking" }],
    });
    // The loop carried on (the builder addressed it) instead of throwing on `findings.map`.
    expect(fold(await p.store.read("42")).status).not.toBe("running");
  });

  it("an approval without findings stores an empty list, not undefined", async () => {
    const p = ports();
    p.agent.on({ duty: "review" }, { kind: "done", output: '{"approved": true}' });
    await runTicket(p, refundsTicket());
    const verdict = (await p.store.read("42")).find((e) => e.type === "review-verdict");
    expect(verdict).toMatchObject({ approved: true, findings: [] });
    expect(fold(await p.store.read("42")).review.findings).toEqual([]);
  });

  it("a verdict whose approved is not a boolean fails the review as unreadable", async () => {
    const p = ports();
    p.agent.on({ duty: "review" }, { kind: "done", output: '{"approved":"yes","findings":[]}' });
    const result = await runTicket(p, refundsTicket());
    expect(result.status === "failed" && result.reason).toContain("review could not be read");
  });

  it("follow-ups with a bad effort or type are left out, with a note on the ticket", async () => {
    const p = direct(ports());
    p.harness.gates.push({ ok: true, pushed: "1".repeat(40) });
    const good = { title: "Good", doneWhen: ["x"], type: "chore", effort: "low", reason: "r" };
    p.agent.on(
      { stage: "report" },
      {
        kind: "done",
        output: JSON.stringify({
          report: "done",
          followUps: [
            good,
            { ...good, title: "Huge", effort: "huge" },
            { ...good, title: "Errand", type: "errand" },
            { ...good, title: 5 },
          ],
        }),
      },
    );
    await runTicket(p, refundsTicket({ effort: "low" }));
    const events = await p.store.read("42");
    const filed = events.find((e) => e.type === "follow-ups");
    expect(filed).toMatchObject({ tickets: [{ title: "Good", effort: "low" }] });
    expect((filed as { tickets: unknown[] }).tickets).toHaveLength(1);
    expect(events.find((e) => e.type === "reply-flagged")).toMatchObject({ what: "follow-ups" });
  });

  it("a report that is not a string falls back to the reply, instead of throwing on trim", async () => {
    const p = direct(ports());
    p.harness.gates.push({ ok: true, pushed: "1".repeat(40) });
    p.agent.on({ stage: "report" }, { kind: "done", output: '{"report": 12, "followUps": "none"}' });
    const result = await runTicket(p, refundsTicket({ effort: "low" }));
    expect(result.status).toBe("done");
  });

  it("retro edits that are not a list, or are malformed, never throw", async () => {
    const p = ports();
    p.agent.on({ stage: "retro" }, { kind: "done", output: '{"edits": "write more tests"}' });
    p.agent.on(
      { stage: "retro", employee: "grace" },
      { kind: "done", output: '{"edits":[null, 7, {"layer":"brain","page":5,"text":"x"}]}' },
    );
    expect((await runTicket(p, refundsTicket())).status).toBe("ready");
    await decide(p, "42", "approve");
    expect((await runTicket(p, refundsTicket())).status).toBe("done");
    const proposed = (await p.store.read("42")).filter((e) => e.type === "knowledge-proposed");
    expect(proposed.length).toBeGreaterThan(0);
    for (const e of proposed) expect(e).toMatchObject({ apply: [], awaitOwner: [] });
    expect((await p.store.read("42")).some((e) => e.type === "reply-flagged")).toBe(true);
  });

  it("an errand's proposals with an unknown action are refused as unreadable", async () => {
    const p = ports();
    p.agent.on(
      { stage: "work" },
      { kind: "done", output: '{"proposals":[{"action":"wire-money","summary":"x"}]}' },
    );
    const result = await runTicket(
      p,
      refundsTicket({ id: "42", type: "errand", doneWhen: [], assignee: "pip" }),
    );
    expect(result.status === "failed" && result.reason).toContain("could not be read");
  });

  it("the readers default what is harmless and refuse what is not", () => {
    expect(readProof({ items: [{ doneWhen: "a", pass: true }] })).toEqual([
      { doneWhen: "a", pass: true, evidence: "" },
    ]);
    expect(readProof({ items: [{ pass: 1 }] })).toBeNull();
    expect(readProof(null)).toBeNull();
    expect(readVerdict({ approved: true, findings: [{ severity: "weird", text: "t" }, 4] })).toEqual({
      approved: true,
      findings: [{ severity: "should-fix", where: "", text: "t" }],
    });
    expect(readVerdict({ approved: 1 })).toBeNull();
    expect(readDisputed({ disputed: "  " })).toBeNull();
    expect(readDisputed({ disputed: true })).toBe("true");
    expect(readFollowUps("nope")).toEqual({ kept: [], dropped: 1 });
    expect(readEdits([{ layer: "x", page: "p", text: "t" }])).toEqual({ kept: [], dropped: 1 });
    expect(readEdits([{ page: "p", text: "t" }], { layer: "brain" }).kept).toHaveLength(1);
    expect(readProposals({ proposals: [{ action: "book", summary: "s", to: ["a", 3] }] })).toEqual([
      { action: "book", summary: "s", to: ["a"] },
    ]);
  });
});

describe("a bad event already in a log never breaks the fold", () => {
  const at = 1_000;
  const bad = [
    { type: "ticket-created", at, ticketId: "42" },
    { type: "proof", at, items: "all pass" },
    { type: "review-verdict", at, reviewerId: "grace", round: 1, approved: false },
    { type: "checkpoint", at, stage: "build", note: 12 },
    { type: "knowledge-proposed", at, employeeId: "ada", apply: "x", awaitOwner: null },
    { type: "from-the-future", at, whatever: true },
    { type: "owner-attached", at, attachments: "none" },
    { type: "failed", at, stage: "gates", reason: 5 },
    { at },
    null,
    "text",
    { type: "checks-ran", at: "yesterday", green: true, failures: [] },
  ] as unknown as TicketEvent[];

  it("folds to a state, skipping what is not an event and reading the rest defensively", () => {
    const skipped: string[] = [];
    const s = fold(bad, (_e, why) => skipped.push(why));
    expect(s.created).toBe(true);
    expect(s.review.findings).toEqual([]);
    expect(s.lastProof).toEqual([]);
    expect(s.proofFailures).toBe(1);
    expect(skipped.length).toBeGreaterThanOrEqual(4);
    expect(s.status).toBe("failed");
  });

  it("a knowledge log over a bad proposal skips it", () => {
    const events = [
      {
        type: "knowledge-proposed",
        at,
        employeeId: "ada",
        apply: [null, { layer: "brain" }, 3],
        awaitOwner: "x",
      },
    ] as unknown as TicketEvent[];
    expect(knowledgeLog("42", events).due).toEqual([]);
  });

  it("an effort this version does not know plans as Medium", () => {
    const plan = planFor(refundsTicket({ effort: "huge" as never }));
    expect(plan.stages).toContain("plan");
  });
});

describe("an engine removed from Setup", () => {
  const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
    now: 1,
    localHour: 12,
    employees: [ada, { ...ada, id: "kit", name: "Kit", engines: { default: "sonnet", fallbacks: [] } }],
    busy: [],
    accountsBlockedUntil: {},
    capReachedUntil: {},
    pickedUpToday: {},
    pending: [],
    backlog: [
      { id: "1", project: "Duet", type: "fix", priority: 0, createdAt: 1, assignee: "ada" },
      { id: "2", project: "Duet", type: "fix", priority: 0, createdAt: 2, assignee: "kit" },
    ],
    ...over,
  });

  it("makes its employee wait with a reason; the scheduler still starts everyone else", () => {
    const p = fakePorts(
      [ada],
      engines.filter((e) => e.id !== "opus"),
    );
    const plan = schedule(snap(), p.company);
    expect(plan.starts.map((s) => s.ticketId)).toEqual(["2"]);
    expect(plan.waiting).toEqual([{ ticketId: "1", reason: expect.stringContaining("engine was removed") }]);
  });

  it("fails the ticket with a clear reason instead of throwing from the session", async () => {
    const p = fakePorts(
      [ada],
      engines.filter((e) => e.id !== "opus"),
    );
    const result = await runTicket(p, refundsTicket({ effort: "low" }));
    expect(result.status === "failed" && result.reason).toContain("engine");
    expect(p.agent.calls).toHaveLength(0);
  });

  it("a fallback that was removed is skipped when a stuck builder looks for the next engine", async () => {
    const stuckAda = { ...ada, engines: { default: "opus", fallbacks: ["gone", "gemini"] } };
    const p = fakePorts([stuckAda], engines);
    p.agent.on({ stage: "build" }, { kind: "stuck", reason: "lost" });
    await runTicket(p, refundsTicket({ effort: "low" }));
    const switched = (await p.store.read("42")).find((e) => e.type === "engine-switched");
    expect(switched).toMatchObject({ to: "gemini" });
  });

  it("a failure whose past sessions used a removed engine still reports which one it tried", async () => {
    const e = { ...ada, engines: { default: "opus", fallbacks: [] } };
    const p = fakePorts([e], engines);
    const at = p.clock.now();
    p.store.log.set("42", [
      { type: "ticket-created", at, ticketId: "42" },
      { type: "stage-started", at, stage: "pickup" },
      { type: "stage-finished", at, stage: "pickup" },
      { type: "stage-started", at, stage: "build" },
      { type: "session-started", at, stage: "build", employeeId: "ada", engineId: "gone", resume: false },
    ]);
    p.agent.on({ stage: "build" }, { kind: "stuck", reason: "lost" });
    const result = await runTicket(p, refundsTicket({ effort: "low" }));
    expect(result).toMatchObject({ status: "failed", tried: expect.arrayContaining(["gone"]) });
  });
});
