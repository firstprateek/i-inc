// Reviewers and verifiers are scheduled like any other work (spec §6, "Assignment and scheduling"):
// a stage that needs one waits, the scheduler picks a free one, and the ticket carries on.
import { describe, expect, it } from "vitest";
import {
  assignHelper,
  emptyState,
  fold,
  occupancy,
  runTicket,
  type Snapshot,
  schedule,
  type TicketState,
} from "../src/index.ts";
import { ada, engines, grace, kit, ports, quinn, refundsTicket } from "./fixtures.ts";

const company = {
  engine: (id: string) => {
    const e = engines.find((x) => x.id === id);
    if (!e) throw new Error(id);
    return e;
  },
};

const state = (over: Partial<TicketState>): TicketState => ({ ...emptyState(), created: true, ...over });

const snap = (over: Partial<Snapshot>): Snapshot => ({
  now: 1_000,
  localHour: 12,
  employees: [ada, kit, grace, quinn],
  busy: [],
  accountsBlockedUntil: {},
  capReachedUntil: {},
  pickedUpToday: {},
  pending: [],
  backlog: [],
  ...over,
});

describe("a stage that needs a helper", () => {
  it("waits for the scheduler, then runs with the employee it picked", async () => {
    const p = ports();
    const ticket = refundsTicket();

    const first = await runTicket(p, ticket, { helpers: "scheduler" });
    expect(first).toEqual({ status: "waiting", duty: "verify" });
    expect(fold(await p.store.read("42")).waitingFor?.duty).toBe("verify");

    await assignHelper(p, "42", "verify", "quinn");
    expect(await runTicket(p, ticket, { helpers: "scheduler" })).toEqual({
      status: "waiting",
      duty: "review",
    });

    await assignHelper(p, "42", "review", "grace");
    const done = await runTicket(p, ticket, { helpers: "scheduler" });
    expect(done.status).toBe("ready");
    expect(p.agent.callsFor("quinn", "prove")).toHaveLength(1);
    expect(p.agent.callsFor("grace", "review")).toHaveLength(1);
  });

  it("goes on without one when no one else has the duty", async () => {
    const p = ports();
    const s = await runTicket(p, refundsTicket({ assignee: "quinn" }), { helpers: "scheduler" });
    // Quinn is the only verifier, so proof is skipped; review still wants Grace.
    expect(s).toEqual({ status: "waiting", duty: "review" });
    expect(fold(await p.store.read("42")).outputs.prove).toBe("no one on the team has the verify duty");
  });
});

describe("who is busy", () => {
  it("counts a running builder and an assigned reviewer as busy, and a waiting builder as holding", () => {
    const o = occupancy(
      [
        { builder: "ada", state: state({ active: "build" }) },
        { builder: "kit", state: state({ active: "review", waitingFor: { duty: "review", since: 0 } }) },
        { builder: "juno", state: state({ active: "review", helpers: { review: "grace" } }) },
        { builder: "qwen", state: state({ status: "ready" }) },
        {
          builder: "pip",
          state: state({ status: "paused", paused: { engineId: "qwen", since: 0, until: 500 } }),
        },
        {
          builder: "quinn",
          state: state({ status: "paused", paused: { engineId: "flash", since: 0, until: 5_000 } }),
        },
      ],
      1_000,
    );
    // Pip's account has reset, so its ticket resumes now; Quinn's hasn't.
    expect(o.busy.sort()).toEqual(["ada", "grace", "juno", "pip"]);
    expect(o.holding.sort()).toEqual(["kit", "quinn"]);
  });

  it("frees a reviewer when the owner has to settle a disagreement", () => {
    const o = occupancy(
      [
        {
          builder: "ada",
          state: state({ active: "review", status: "needs-you", helpers: { review: "grace" } }),
        },
      ],
      0,
    );
    expect(o).toEqual({ busy: [], holding: ["ada"] });
  });
});

describe("scheduling reviews", () => {
  const reviewers = [
    { ...ada, duties: ["build" as const, "review" as const] },
    { ...kit, duties: ["build" as const, "review" as const] },
  ];

  it("lets two builders waiting on each other take turns reviewing", () => {
    const plan = schedule(
      snap({
        employees: reviewers,
        holding: ["ada", "kit"],
        pending: [
          { ticketId: "1", duty: "review", builder: "ada", exclude: ["ada"], since: 1 },
          { ticketId: "2", duty: "review", builder: "kit", exclude: ["kit"], since: 2 },
        ],
      }),
      company,
    );
    // Kit reviews Ada's ticket; Ada is busy with that review's findings, so Kit's own waits its turn.
    expect(plan.starts).toEqual([{ employeeId: "kit", ticketId: "1", as: "review" }]);
    expect(plan.waiting).toEqual([{ ticketId: "2", reason: "Kit is busy" }]);
  });

  it("doesn't start a new build for someone holding a ticket", () => {
    const plan = schedule(
      snap({
        holding: ["ada"],
        backlog: [{ id: "3", project: "Duet", type: "fix", priority: 0, createdAt: 0, assignee: "ada" }],
      }),
      company,
    );
    expect(plan.starts).toEqual([]);
    expect(plan.waiting).toEqual([{ ticketId: "3", reason: "Ada is busy" }]);
  });

  it("says why a review waits", () => {
    const plan = schedule(
      snap({
        busy: ["grace"],
        pending: [{ ticketId: "1", duty: "review", builder: "ada", exclude: ["ada"], since: 1 }],
      }),
      company,
    );
    expect(plan.waiting).toEqual([{ ticketId: "1", reason: "waits for a reviewer: Grace is busy" }]);
  });
});
