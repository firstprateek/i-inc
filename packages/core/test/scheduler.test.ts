// Who starts what (spec §6, "Assignment and scheduling"), including the night-shift story (§3, case 2).
import { describe, expect, it } from "vitest";
import { type BacklogItem, type Employee, type Snapshot, schedule, withinHours } from "../src/index.ts";
import { ada, engines, grace, kit, quinn } from "./fixtures.ts";

const company = {
  engine: (id: string) => {
    const e = engines.find((x) => x.id === id);
    if (!e) throw new Error(id);
    return e;
  },
};

const qwenBot: Employee = {
  ...kit,
  id: "qwen-bot",
  name: "Qwen",
  engines: { default: "qwen", fallbacks: [] },
  standingOrders: [{ types: ["chore"], labels: ["deps"], maxPerDay: 2 }],
};
const juno: Employee = {
  ...kit,
  id: "juno",
  name: "Juno",
  engines: { default: "flash", fallbacks: [] },
  workingHours: { from: 22, to: 7 },
};

const item = (id: string, over: Partial<BacklogItem> = {}): BacklogItem => ({
  id,
  project: "Duet",
  type: "fix",
  priority: 0,
  createdAt: 0,
  assignee: null,
  ...over,
});

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  now: 1_000,
  localHour: 23,
  employees: [ada, kit, grace, quinn, qwenBot, juno],
  busy: [],
  accountsBlockedUntil: {},
  capReachedUntil: {},
  pickedUpToday: {},
  pending: [],
  backlog: [],
  ...over,
});

describe("the scheduler", () => {
  it("runs the night shift: Ada waits for its account, Kit and the local employee start", () => {
    const plan = schedule(
      snap({
        accountsBlockedUntil: { "claude-pro": 5_000 },
        backlog: [
          item("16", { assignee: "ada" }),
          item("18", { assignee: "kit", project: "fintrack" }),
          item("11", { type: "chore", labels: ["deps"], project: "fintrack" }),
          item("12", { assignee: "juno", project: "listy" }),
        ],
        employees: [
          ada,
          { ...kit, engines: { default: "gemini", fallbacks: [] } },
          grace,
          quinn,
          qwenBot,
          juno,
        ],
      }),
      company,
    );

    expect(plan.starts).toEqual([
      { employeeId: "kit", ticketId: "18", as: "build", by: "assignment" },
      { employeeId: "qwen-bot", ticketId: "11", as: "build", by: "standing-order" },
      { employeeId: "juno", ticketId: "12", as: "build", by: "assignment" },
    ]);
    expect(plan.waiting).toEqual([{ ticketId: "16", reason: "Ada waits for claude-pro to reset" }]);
  });

  it("puts a pending review ahead of a new build, and never picks the builder", () => {
    const plan = schedule(
      snap({
        pending: [{ ticketId: "42", duty: "review", builder: "grace", exclude: ["grace"], since: 0 }],
        backlog: [item("50", { assignee: "ada" })],
        employees: [ada, grace, { ...kit, duties: ["build", "review"] }],
      }),
      company,
    );
    expect(plan.starts[0]).toEqual({ employeeId: "kit", ticketId: "42", as: "review" });
    expect(plan.starts[1]).toEqual({ employeeId: "ada", ticketId: "50", as: "build", by: "assignment" });
  });

  it("gives each employee one thing at a time, highest priority first", () => {
    const plan = schedule(
      snap({
        backlog: [item("a", { assignee: "ada", priority: 1 }), item("b", { assignee: "ada", priority: 5 })],
      }),
      company,
    );
    expect(plan.starts).toEqual([{ employeeId: "ada", ticketId: "b", as: "build", by: "assignment" }]);
    expect(plan.waiting).toEqual([{ ticketId: "a", reason: "Ada is busy" }]);
  });

  it("respects holds, working hours, usage caps and standing-order limits", () => {
    const plan = schedule(
      snap({
        localHour: 14,
        capReachedUntil: { kit: 9_999 },
        pickedUpToday: { "qwen-bot": 2 },
        backlog: [
          item("held", { assignee: "ada", hold: true }),
          item("night", { assignee: "juno" }),
          item("capped", { assignee: "kit" }),
          item("deps", { type: "chore", labels: ["deps"] }),
          item("orphan", { type: "feat" }),
        ],
      }),
      company,
    );
    expect(plan.starts).toEqual([]);
    expect(plan.waiting).toEqual([
      { ticketId: "night", reason: "Juno is off until 22:00" },
      { ticketId: "capped", reason: "Kit reached its usage cap" },
      { ticketId: "deps", reason: "unassigned, and no standing order covers it" },
      { ticketId: "orphan", reason: "unassigned, and no standing order covers it" },
    ]);
  });

  it("wraps working hours past midnight", () => {
    expect(withinHours({ from: 22, to: 7 }, 23)).toBe(true);
    expect(withinHours({ from: 22, to: 7 }, 3)).toBe(true);
    expect(withinHours({ from: 22, to: 7 }, 12)).toBe(false);
    expect(withinHours({ from: 9, to: 17 }, 12)).toBe(true);
  });
});
