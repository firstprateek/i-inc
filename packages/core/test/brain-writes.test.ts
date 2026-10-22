// The core's side of brain writes (T58): the retro asks for edits in the brain copy when agents have one, the
// librarian duty and the daily tidy-up ticket, and the engine chosen for that duty.
import { describe, expect, it } from "vitest";
import {
  type BacklogItem,
  decide,
  type Employee,
  hiringProblems,
  knowledgeLog,
  planFor,
  runTicket,
  type Snapshot,
  schedule,
  type Ticket,
} from "../src/index.ts";
import { fakePorts } from "../src/testing/index.ts";
import { ada, engines, grace, kit, ports, quinn, refundsTicket, team } from "./fixtures.ts";

const librarian: Employee = {
  ...kit,
  id: "lib",
  name: "Lib",
  duties: ["librarian"],
  engines: { default: "sonnet", perDuty: { librarian: "qwen" }, fallbacks: [] },
};

const tidy = (over: Partial<Ticket> = {}): Ticket => ({
  id: "t1",
  title: "Tend the brain",
  project: "General",
  type: "tidy",
  effort: "low",
  doneWhen: ["duplicate pages are merged into one"],
  assignee: "lib",
  labels: ["brain-tidy"],
  ...over,
});

describe("the retro with a brain copy", () => {
  it("asks for lessons as edits to the copy and proposes none itself", async () => {
    const p = ports();
    p.brainWrites = true;
    p.agent.on(
      { stage: "retro" },
      { kind: "done", output: '{"edits":[{"layer":"policy","page":"x","text":"sneaky"}]}' },
    );
    await runTicket(p, refundsTicket());
    await decide(p, "42", "approve");
    await runTicket(p, refundsTicket());
    const brief = p.agent.callsFor("ada", "retro")[0]?.brief ?? "";
    expect(brief).toContain("brain copy");
    expect(brief).not.toContain('Reply as JSON: {"edits"');
    // Whatever the reply says, nothing is proposed: the copy is what counts.
    const log = knowledgeLog("42", await p.store.read("42"));
    expect([...log.due, ...log.awaiting, ...log.refused]).toEqual([]);
  });

  it("keeps the JSON reply when there is no copy (demo mode)", async () => {
    const p = ports();
    await runTicket(p, refundsTicket());
    await decide(p, "42", "approve");
    await runTicket(p, refundsTicket());
    expect(p.agent.callsFor("ada", "retro")[0]?.brief).toContain('Reply as JSON: {"edits"');
  });
});

describe("the librarian duty", () => {
  it("is a duty like the others: a hire may have it, with an engine of its own", () => {
    expect(hiringProblems(librarian, engines, [])).toEqual([]);
    expect(
      hiringProblems(
        { ...librarian, engines: { default: "sonnet", perDuty: { librarian: "nope" }, fallbacks: [] } },
        engines,
        [],
      ),
    ).toEqual(["there is no engine nope"]);
  });

  it("gives a tidy-up ticket a short plan of its own and runs it on the librarian's engine, then closes it", async () => {
    expect(planFor(tidy()).stages).toEqual(["pickup", "tidy"]);
    const q = fakePorts([...team, librarian], engines);
    const result = await runTicket(q, tidy());
    expect(result).toEqual({ status: "done", outcome: "done" });
    const call = q.agent.callsFor("lib", "tidy")[0];
    expect(call?.duty).toBe("librarian");
    expect(call?.engine.id).toBe("qwen");
    expect(call?.brief).toContain("Tend the brain");
    expect(q.agent.callsFor("lib", "retro")).toEqual([]);
  });
});

describe("the scheduler and the tidy-up", () => {
  const item = (over: Partial<BacklogItem> = {}): BacklogItem => ({
    id: "t1",
    project: "General",
    type: "tidy",
    priority: 0,
    createdAt: 0,
    assignee: "lib",
    ...over,
  });
  const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
    now: 1_000,
    localHour: 12,
    employees: [ada, grace, quinn, librarian],
    busy: [],
    accountsBlockedUntil: {},
    capReachedUntil: {},
    pickedUpToday: {},
    pending: [],
    backlog: [item()],
    ...over,
  });
  const company = { engine: (id: string) => engines.find((e) => e.id === id) as (typeof engines)[number] };

  it("starts it when the librarian is free", () => {
    expect(schedule(snap(), company).starts).toEqual([
      { employeeId: "lib", ticketId: "t1", as: "build", by: "assignment" },
    ]);
  });

  it("looks at the account of the engine chosen for the librarian duty, not the default one", () => {
    // Sonnet (the default) is blocked, qwen (local) is not: the tidy-up goes ahead.
    expect(schedule(snap({ accountsBlockedUntil: { "claude-pro": 99_999 } }), company).starts).toHaveLength(
      1,
    );
    // The local account is blocked: it waits, though the default engine is fine.
    const waits = schedule(snap({ accountsBlockedUntil: { local: 99_999 } }), company);
    expect(waits.starts).toEqual([]);
    expect(waits.waiting[0]?.reason).toContain("waits for local to reset");
  });
});
