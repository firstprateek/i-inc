// T50: a reviewer or verifier that can't start never fails the builder's ticket. It is recorded as
// unavailable for the duty, another is picked, and only then does the builder's own seat (on a
// different engine) or a visible wait take over. Real outcomes of an engine that did start are unchanged.
import { describe, expect, it } from "vitest";
import {
  assignHelper,
  type Employee,
  fold,
  retry,
  runTicket,
  type Snapshot,
  StartupError,
  schedule,
  type TicketEvent,
} from "../src/index.ts";
import { fakePorts } from "../src/testing/index.ts";
import { ada, engines, grace, kit, quinn, refundsTicket } from "./fixtures.ts";

const didntStart = {
  kind: "stuck" as const,
  reason: "the antigravity ACP server didn't start: the agent exited (127) mid-session",
  startup: true as const,
};

const juno: Employee = { ...grace, id: "juno", name: "Juno" };
const sha = "a".repeat(40);

/** The cast, with Juno as a second reviewer, in direct mode (reviews are fresh-context, 2 rounds). */
const cast = (
  roster: Employee[] = [ada, kit, grace, juno, quinn],
  mode: "direct" | "owner-merges" = "direct",
) => {
  const p = fakePorts(roster, engines);
  p.company.policy = { ...p.company.policy, mode };
  return p;
};

const unavailable = (events: TicketEvent[]) =>
  events.filter(
    (e): e is Extract<TicketEvent, { type: "helper-unavailable" }> => e.type === "helper-unavailable",
  );

describe("a reviewer whose engine can't start", () => {
  it("is skipped and the next reviewer reviews; the ticket is not failed", async () => {
    const p = cast();
    p.agent.on({ employee: "grace", stage: "review" }, didntStart);
    p.harness.gates.push({ ok: true, pushed: sha });

    expect(await runTicket(p, refundsTicket())).toEqual({ status: "done", outcome: "merged" });

    const events = await p.store.read("42");
    expect(unavailable(events)).toMatchObject([{ duty: "review", employeeId: "grace", stage: "review" }]);
    expect(unavailable(events)[0]?.reason).toContain("exited (127)");
    expect(p.agent.callsFor("juno", "review")).toHaveLength(1);
    expect(events.some((e) => e.type === "failed")).toBe(false);
    // The failed start doesn't count as Grace's work on the ticket.
    expect(fold(events).sessions.some((x) => x.employeeId === "grace" && x.stage === "review")).toBe(false);
  });

  it("with no other reviewer, falls back to the builder's seat on a different engine", async () => {
    const p = cast([ada, kit, grace, quinn]);
    p.agent.on({ employee: "grace", stage: "review" }, didntStart);
    p.harness.gates.push({ ok: true, pushed: sha });

    expect(await runTicket(p, refundsTicket())).toEqual({ status: "done", outcome: "merged" });

    const events = await p.store.read("42");
    expect(unavailable(events)).toHaveLength(1);
    const review = p.agent.calls.filter((c) => c.stage === "review" && c.employee.id === "ada");
    expect(review).toHaveLength(1);
    expect(review[0]?.engine.harness).not.toBe("claude-code");
    expect(review[0]?.brief).toContain("fresh eyes");
  });

  it("is never the builder, even after everyone else failed to start", async () => {
    const p = cast([ada, grace, quinn]);
    p.agent.on({ employee: "grace", stage: "review" }, didntStart);
    p.harness.gates.push({ ok: true, pushed: sha });
    await runTicket(p, refundsTicket());
    // Grace is excluded for review; the builder's own seat reviews on another engine.
    expect(p.agent.callsFor("grace", "review")).toHaveLength(1);
    const own = p.agent.calls.find((c) => c.stage === "review" && c.employee.id === "ada");
    expect(own?.engine.id).not.toBe("opus");
  });

  it("a seat on the builder's other engine that can't start is ruled out too, not the builder", async () => {
    const p = cast([ada, grace, quinn]);
    p.agent.on({ employee: "grace", stage: "review" }, didntStart);
    // The builder's seat on the first other engine (gemini) can't start either.
    p.agent.on({ employee: "ada", stage: "review", engine: "gemini" }, didntStart);
    p.harness.gates.push({ ok: true, pushed: sha });
    expect(await runTicket(p, refundsTicket())).toEqual({ status: "done", outcome: "merged" });
    const events = await p.store.read("42");
    expect(unavailable(events).map((u) => [u.employeeId, u.engineId])).toEqual([
      ["grace", undefined],
      ["ada", "gemini"],
    ]);
    const ownReviews = p.agent.calls.filter((c) => c.stage === "review" && c.employee.id === "ada");
    expect(ownReviews.map((c) => c.engine.id)).toEqual(["gemini", "flash"]);
  });

  it("outside direct mode waits with a reason instead of skipping the review", async () => {
    const p = cast([ada, grace, quinn], "owner-merges");
    p.agent.on({ employee: "grace", stage: "review" }, didntStart);
    // Scheduler mode: the stage wants a reviewer, the scheduler assigns Grace, she can't start.
    expect(await runTicket(p, refundsTicket(), { helpers: "scheduler" })).toEqual({
      status: "waiting",
      duty: "verify",
    });
    await assignHelper(p, "42", "verify", "quinn");
    expect(await runTicket(p, refundsTicket(), { helpers: "scheduler" })).toEqual({
      status: "waiting",
      duty: "review",
    });
    await assignHelper(p, "42", "review", "grace");
    // Grace fails to start; nobody else can review, so the ticket waits, and is not failed.
    expect(await runTicket(p, refundsTicket(), { helpers: "scheduler" })).toEqual({
      status: "waiting",
      duty: "review",
    });
    const s = fold(await p.store.read("42"));
    expect(s.status).toBe("running");
    expect(s.waitingFor?.duty).toBe("review");
    expect(s.unavailable.review).toEqual([{ employeeId: "grace" }]);
    expect(s.helpers.review).toBeUndefined();

    // The scheduler says why, and never offers Grace again for this ticket.
    const snap: Snapshot = {
      now: 1_000,
      localHour: 12,
      employees: [ada, grace, quinn],
      busy: [],
      accountsBlockedUntil: {},
      capReachedUntil: {},
      pickedUpToday: {},
      pending: [{ ticketId: "42", duty: "review", builder: "ada", exclude: ["ada", "grace"], since: 0 }],
      backlog: [],
    };
    const plan = schedule(snap, p.company);
    expect(plan.starts).toEqual([]);
    expect(plan.waiting).toEqual([{ ticketId: "42", reason: "waits for a reviewer who can start" }]);
  });
});

describe("a verifier that can't start", () => {
  it("is replaced by the builder's seat on another engine; proof still runs", async () => {
    const p = cast();
    p.agent.on({ employee: "quinn", stage: "prove" }, didntStart);
    p.harness.gates.push({ ok: true, pushed: sha });
    expect(await runTicket(p, refundsTicket())).toEqual({ status: "done", outcome: "merged" });
    const proof = p.agent.calls.find((c) => c.stage === "prove" && c.employee.id === "ada");
    expect(proof?.engine.harness).not.toBe("claude-code");
    expect(unavailable(await p.store.read("42"))).toMatchObject([{ duty: "verify", employeeId: "quinn" }]);
  });

  it("waits, not fails, when the builder has no other engine to verify on", async () => {
    const claudeQuinn: Employee = { ...quinn, engines: { default: "sonnet", fallbacks: [] } };
    const p = fakePorts(
      [ada, grace, claudeQuinn],
      engines.filter((e) => e.harness === "claude-code"),
    );
    p.company.policy = { ...p.company.policy, mode: "direct" };
    p.agent.on({ employee: "quinn", stage: "prove" }, didntStart);
    const ticket = refundsTicket();
    expect(await runTicket(p, ticket, { helpers: "scheduler" })).toEqual({
      status: "waiting",
      duty: "verify",
    });
    await assignHelper(p, "42", "verify", "quinn");
    expect(await runTicket(p, ticket, { helpers: "scheduler" })).toEqual({
      status: "waiting",
      duty: "verify",
    });

    const s = fold(await p.store.read("42"));
    expect(s.status).toBe("running");
    expect(s.waitingFor?.duty).toBe("verify");
    expect(s.unavailable.verify).toEqual([{ employeeId: "quinn" }]);
    expect(p.agent.callsFor("ada", "prove")).toHaveLength(0);
  });
});

describe("what still fails or switches as before", () => {
  it("a reviewer that started and then got stuck fails the ticket", async () => {
    const p = cast();
    p.agent.on({ employee: "grace", stage: "review" }, { kind: "stuck", reason: "tool crashed mid-review" });
    const result = await runTicket(p, refundsTicket());
    expect(result.status).toBe("failed");
    expect(unavailable(await p.store.read("42"))).toEqual([]);
  });

  it("the builder's own engine failing to start follows the switch rules, not the helper path", async () => {
    const p = cast();
    p.agent.on({ employee: "ada", stage: "plan" }, didntStart);
    await runTicket(p, refundsTicket());
    const events = await p.store.read("42");
    expect(unavailable(events)).toEqual([]);
    expect(events.some((e) => e.type === "engine-switched")).toBe(true);
  });

  it("an owner retry forgets who couldn't start", async () => {
    const p = cast([ada, grace, quinn], "owner-merges");
    p.agent.on({ employee: "grace", stage: "review" }, didntStart);
    await p.store.append("42", [{ type: "ticket-created", at: 1, ticketId: "42" }]);
    await p.store.append("42", [
      { type: "stage-started", at: 2, stage: "review" },
      {
        type: "helper-unavailable",
        at: 3,
        stage: "review",
        duty: "review",
        employeeId: "grace",
        reason: "x",
      },
      { type: "failed", at: 4, stage: "review", reason: "boom", tried: [] },
    ]);
    expect(fold(await p.store.read("42")).unavailable.review).toHaveLength(1);
    await retry(p, "42");
    expect(fold(await p.store.read("42")).unavailable).toEqual({});
  });
});

describe("helper readiness", () => {
  it("skips a reviewer whose engine is blocked (sandbox down, not signed in) and picks the next", async () => {
    const p = cast();
    p.company.blocks.push({
      employee: "grace",
      duty: "review",
      block: { reason: "Grace's antigravity isn't signed in" },
    });
    p.harness.gates.push({ ok: true, pushed: sha });
    expect(await runTicket(p, refundsTicket())).toEqual({ status: "done", outcome: "merged" });
    expect(p.agent.callsFor("grace", "review")).toHaveLength(0);
    expect(p.agent.callsFor("juno", "review")).toHaveLength(1);
    // Blocked is not a failure: nothing is recorded as unavailable.
    expect(unavailable(await p.store.read("42"))).toEqual([]);
  });

  it("falls back to the builder's seat when every reviewer is blocked", async () => {
    const p = cast();
    p.company.blocks.push({ duty: "review", employee: "grace", block: { reason: "x" } });
    p.company.blocks.push({ duty: "review", employee: "juno", block: { reason: "x" } });
    p.harness.gates.push({ ok: true, pushed: sha });
    await runTicket(p, refundsTicket());
    const own = p.agent.calls.find((c) => c.stage === "review");
    expect(own?.employee.id).toBe("ada");
    expect(own?.engine.harness).not.toBe("claude-code");
  });

  it("does not use an engine blocked in the builder's own seat", async () => {
    const p = cast([ada, quinn]);
    p.company.blocks.push({ employee: "ada", engine: "gemini", duty: "review", block: { reason: "x" } });
    p.harness.gates.push({ ok: true, pushed: sha });
    await runTicket(p, refundsTicket());
    const own = p.agent.calls.find((c) => c.stage === "review");
    expect(own?.engine.id).toBe("flash");
  });

  it("a helper whose sandbox won't boot (StartupError) is skipped, not the builder's failure", async () => {
    const p = cast();
    p.machines.bootFailures.set("grace", new StartupError("the sandbox can't start", 5_000));
    p.harness.gates.push({ ok: true, pushed: sha });
    expect(await runTicket(p, refundsTicket())).toEqual({ status: "done", outcome: "merged" });
    const events = await p.store.read("42");
    expect(unavailable(events)).toMatchObject([{ employeeId: "grace", reason: "the sandbox can't start" }]);
    expect(p.agent.callsFor("juno", "review")).toHaveLength(1);
  });

  it("but the builder's own sandbox failing to boot propagates for the daemon to wait on", async () => {
    const p = cast();
    p.machines.bootFailures.set("ada", new StartupError("the sandbox can't start", 5_000));
    await expect(runTicket(p, refundsTicket())).rejects.toBeInstanceOf(StartupError);
  });
});

describe("the scheduler and a blocked sandbox", () => {
  const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
    now: 1_000,
    localHour: 12,
    employees: [ada, grace, juno],
    busy: [],
    accountsBlockedUntil: {},
    capReachedUntil: {},
    pickedUpToday: {},
    pending: [],
    backlog: [],
    ...over,
  });
  const company = (blocks: { employee: string; reason: string; until?: number }[]) => {
    const p = cast();
    for (const b of blocks)
      p.company.blocks.push({
        employee: b.employee,
        block: { reason: b.reason, ...(b.until ? { until: b.until } : {}) },
      });
    return p.company;
  };

  it("holds an assigned ticket with a calm reason and the retry time", () => {
    const backlogItem = {
      id: "7",
      project: "Duet",
      type: "fix" as const,
      priority: 1,
      createdAt: 0,
      assignee: "ada",
    };
    const plan = schedule(
      snap({ backlog: [backlogItem] }),
      company([
        { employee: "ada", reason: "the engineering sandbox can't start (restart it)", until: 60_000 },
      ]),
    );
    expect(plan.starts).toEqual([]);
    expect(plan.waiting).toEqual([
      { ticketId: "7", reason: "the engineering sandbox can't start (restart it)" },
    ]);
    expect(plan.resets).toEqual({ "7": 60_000 });
  });

  it("passes over a blocked reviewer for one who can start", () => {
    const plan = schedule(
      snap({ pending: [{ ticketId: "42", duty: "review", builder: "ada", exclude: ["ada"], since: 0 }] }),
      company([{ employee: "grace", reason: "Grace's antigravity isn't signed in" }]),
    );
    expect(plan.starts).toEqual([{ employeeId: "juno", ticketId: "42", as: "review" }]);
  });

  it("says why when every candidate is blocked", () => {
    const plan = schedule(
      snap({ pending: [{ ticketId: "42", duty: "review", builder: "ada", exclude: ["ada"], since: 0 }] }),
      company([
        { employee: "grace", reason: "Grace's antigravity isn't signed in" },
        { employee: "juno", reason: "Juno's antigravity isn't signed in" },
      ]),
    );
    expect(plan.waiting).toEqual([
      { ticketId: "42", reason: "waits for a reviewer: Grace's antigravity isn't signed in" },
    ]);
  });
});
