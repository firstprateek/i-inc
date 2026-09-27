// The daemon end to end: SQLite, the tick loop and the API, with the scripted agent.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { refunds, testApp } from "./setup.ts";

describe("the event log in SQLite", () => {
  it("keeps every ticket's events in order across a restart", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "i-inc-")), "test.db");
    const first = await testApp(path);
    await first.call("POST", "/api/tickets", refunds);
    await first.daemon.idle();
    const before = await first.deps.store.read("1");
    first.db.close();

    const second = await testApp(path);
    const after = await second.deps.store.read("1");
    expect(after).toEqual(before);
    expect(after[0]?.type).toBe("ticket-created");
    expect(after.at(-1)?.type).toBe("report-ready");
  });
});

describe("the API", () => {
  it("takes a ticket from creation to a ready report on the board", async () => {
    const app = await testApp();
    const created = await app.call("POST", "/api/tickets", refunds);
    expect(created.status).toBe(201);
    await app.daemon.idle();

    const board = await app.call("GET", "/api/board");
    const card = board.body.tickets[0];
    expect(card).toMatchObject({ id: "1", column: "review", status: "ready", live: "Report ready" });
    expect(card.report.byline).toBe("Ada (Claude Opus), reviewed by Kit, 1 round");
    expect(card.stages.every((s: { state: string }) => s.state === "done")).toBe(true);
  });

  it("rejects a malformed ticket", async () => {
    const app = await testApp();
    const res = await app.call("POST", "/api/tickets", { ...refunds, effort: "huge" });
    expect(res).toEqual({ status: 400, body: { error: "effort must be low, medium or high" } });
  });

  it("answers a plan gate and decides a ready ticket through to merged", async () => {
    const app = await testApp();
    app.agent.on({ duty: "plan" }, { kind: "done", output: "Add an alerts table: a schema change." });
    await app.call("POST", "/api/tickets", { ...refunds, title: "Budget alerts" });
    await app.daemon.idle();

    let t = (await app.call("GET", "/api/tickets/1")).body.ticket;
    expect(t.status).toBe("needs-you");
    expect(t.needsYou.kind).toBe("plan-gate");

    expect((await app.call("POST", "/api/tickets/1/decide", { decision: "approve" })).status).toBe(409);
    await app.call("POST", "/api/tickets/1/answer", { answer: "approve" });
    await app.daemon.idle();
    expect((await app.call("GET", "/api/tickets/1")).body.ticket.status).toBe("ready");

    await app.call("POST", "/api/tickets/1/decide", { decision: "approve" });
    await app.daemon.idle();
    t = (await app.call("GET", "/api/tickets/1")).body.ticket;
    expect(t).toMatchObject({ column: "done", outcome: "merged", live: "Merged" });
  });

  it("guards every route with the token when one is set", async () => {
    const app = await testApp();
    const { createApi } = await import("../src/api.ts");
    const guarded = createApi(app.daemon, app.deps, { token: "s3cret" });
    expect((await guarded(new Request("http://i.inc/api/board"))).status).toBe(401);
    const ok = await guarded(
      new Request("http://i.inc/api/board", { headers: { authorization: "Bearer s3cret" } }),
    );
    expect(ok.status).toBe(200);
  });
});

describe("the tick loop", () => {
  it("runs the night shift: a paused ticket waits, a standing order picks up a chore, and the pause resumes", async () => {
    const app = await testApp();
    app.agent.on(
      { employee: "ada", stage: "build" },
      { kind: "out-of-tokens", resetsAt: app.clock.now() + 2 * 3_600_000 },
    );

    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    await app.call("POST", "/api/tickets", {
      ...refunds,
      title: "Bump deps",
      type: "chore",
      labels: ["deps"],
      assignee: undefined,
    });
    await app.daemon.idle();

    const board = (await app.call("GET", "/api/board")).body.tickets;
    expect(board[0]).toMatchObject({ status: "paused", column: "in-progress" });
    expect(board[0].live).toMatch(/^Out of tokens/);
    expect(board[1]).toMatchObject({ status: "ready", assignee: { id: "qwen", name: "Qwen" } });

    const office = (await app.call("GET", "/api/office")).body.employees;
    expect(office.find((e: { id: string }) => e.id === "ada").state).toBe("out-of-tokens");

    app.clock.advance(121);
    await app.daemon.tick();
    await app.daemon.idle();
    expect((await app.call("GET", "/api/tickets/1")).body.ticket.status).toBe("ready");
  });

  it("tells the board why a ticket is waiting", async () => {
    const app = await testApp();
    app.agent.on(
      { employee: "ada", stage: "build" },
      { kind: "out-of-tokens", resetsAt: app.clock.now() + 3_600_000 },
    );
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    await app.call("POST", "/api/tickets", { ...refunds, title: "Second fix for Ada" });
    await app.daemon.idle();

    const second = (await app.call("GET", "/api/tickets/2")).body.ticket;
    expect(second).toMatchObject({ status: "queued", column: "todo", waiting: "Ada is busy" });
  });

  it("hands a paused ticket to someone else", async () => {
    const app = await testApp();
    app.agent.on(
      { employee: "ada", stage: "build" },
      { kind: "out-of-tokens", resetsAt: app.clock.now() + 3_600_000 },
    );
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();

    expect((await app.call("POST", "/api/tickets/1/handoff", { to: "nobody" })).status).toBe(400);
    await app.call("POST", "/api/tickets/1/handoff", { to: "kit" });
    await app.daemon.idle();
    const t = (await app.call("GET", "/api/tickets/1")).body.ticket;
    expect(t).toMatchObject({ status: "ready", assignee: { id: "kit", name: "Kit" } });
  });
});

describe("My desk", () => {
  it("shows this month's spend and the bottleneck", async () => {
    const app = await testApp();
    app.deps.registry.setSettings({ pricePerKWh: 0.3 });
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    app.clock.advance(90);
    await app.call("POST", "/api/tickets/1/decide", { decision: "approve" });
    await app.daemon.idle();

    const desk = (await app.call("GET", "/api/desk")).body;
    expect(desk.merged).toBe(1);
    expect(desk.bottleneck).toMatchObject({ reason: "owner-decision", tickets: 1 });
    expect(desk.spend.lines.map((l: { name: string; kind: string }) => `${l.name} ${l.kind}`)).toEqual([
      "Claude Pro subscription",
      "Google AI Pro subscription",
      "Mac mini hardware",
      "Mac mini electricity",
    ]);
    expect(desk.spend.perMergedPR).toBeGreaterThan(0);
  });
});

describe("hiring", () => {
  it("hires an engineer, who then shows up in the office", async () => {
    const app = await testApp();
    const res = await app.call("POST", "/api/employees", {
      name: "Lin",
      role: "Senior Engineer",
      engines: { default: "sonnet", fallbacks: ["gemini"] },
    });
    expect(res.status).toBe(201);
    expect(res.body.employee).toMatchObject({ id: "lin", duties: ["build", "review"] });
    const office = (await app.call("GET", "/api/office")).body.employees;
    expect(office.map((e: { name: string }) => e.name)).toContain("Lin");
  });

  it("refuses a PA on a cloud engine", async () => {
    const app = await testApp();
    const res = await app.call("POST", "/api/employees", {
      name: "Pip Two",
      role: "Personal Assistant",
      duties: ["build"],
      engines: { default: "qwen", fallbacks: ["flash"] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("may only use local engines, not flash");
  });
});
