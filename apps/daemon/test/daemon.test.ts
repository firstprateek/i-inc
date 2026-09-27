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

describe("hiring", () => {
  it("gives the demo team seven different avatar tints, and keeps a tint when someone is updated", async () => {
    const app = await testApp();
    const { registry } = app.deps;
    expect(new Set(registry.employees().map((e) => e.tint)).size).toBe(7);
    const kit = registry.employee("kit");
    const { tint, ...untinted } = kit;
    registry.hire({ ...untinted, role: "Staff Engineer" });
    expect(registry.employee("kit").tint).toBe(tint);
    const board = (await app.call("GET", "/api/office")).body.employees;
    expect(board.find((e: { id: string }) => e.id === "kit").tint).toBe(tint);
  });
});

describe("a restart", () => {
  it("resumes a ticket whose session died with the daemon", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "i-inc-")), "test.db");
    const first = await testApp(path);
    first.agent.on({ stage: "build" }, { kind: "crash" });
    await first.call("POST", "/api/tickets", refunds);
    await first.daemon.idle();
    expect((await first.call("GET", "/api/tickets/1")).body.ticket.status).toBe("running");
    first.db.close();

    const second = await testApp(path);
    await second.daemon.tick();
    await second.daemon.idle();
    const t = (await second.call("GET", "/api/tickets/1")).body.ticket;
    expect(t.status).toBe("ready");
    expect(second.agent.callsFor("ada", "build")).toHaveLength(1);
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

  it("schedules a review like any other work: it waits for a free reviewer, then carries on", async () => {
    const app = await testApp();
    // Kit is the only other reviewer, and Kit's own build (on the local account) runs out of tokens.
    const { registry } = app.deps;
    registry.hire({ ...registry.employee("grace"), duties: ["plan"] });
    registry.hire({ ...registry.employee("kit"), engines: { default: "qwen", fallbacks: [] } });
    app.agent.on(
      { employee: "kit", stage: "build" },
      { kind: "out-of-tokens", resetsAt: app.clock.now() + 2 * 3_600_000 },
    );
    await app.call("POST", "/api/tickets", { ...refunds, title: "Kit's fix", assignee: "kit" });
    await app.daemon.idle();
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();

    let ada = (await app.call("GET", "/api/tickets/2")).body.ticket;
    expect(ada).toMatchObject({
      status: "running",
      waiting: "waits for a reviewer: Kit waits for local to reset",
      live: "Review · waits for a reviewer",
    });

    // The account resets: Kit's build resumes first, and the review waits for Kit to finish it.
    app.clock.advance(121);
    await app.daemon.tick();
    await app.daemon.idle();
    ada = (await app.call("GET", "/api/tickets/2")).body.ticket;
    expect(ada).toMatchObject({ status: "ready" });
    expect(ada.report.byline).toBe("Ada (Claude Opus), reviewed by Kit, 1 round");
    expect(app.agent.callsFor("kit", "review")[0]?.engine.id).toBe("qwen");

    expect((await app.deps.store.read("2")).map((e) => e.type)).toContain("helper-wanted");
    // Kit does one thing at a time: its own build resumes, then Ada's review while Kit's proof waits
    // for Kit, then Kit's report once Ada has reviewed Kit's work in turn.
    expect(app.agent.callsFor("kit").map((c) => `${c.ticket.id}:${c.stage}`)).toEqual([
      "1:plan",
      "1:build",
      "1:build",
      "2:review",
      "1:report",
    ]);
    expect(app.agent.callsFor("ada", "review").map((c) => c.ticket.id)).toEqual(["1"]);
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

describe("chat", () => {
  it("stops a session for an urgent message, and the stage starts again with it", async () => {
    const app = await testApp();
    app.agent.on({ employee: "ada", stage: "build" }, { kind: "hang" });
    await app.call("POST", "/api/tickets", refunds);
    while (!app.agent.callsFor("ada", "build").length) await new Promise((r) => setTimeout(r, 0));

    const sent = await app.call("POST", "/api/chat/ada", {
      text: "Keep it small: use the ledger's sign",
      urgent: true,
    });
    expect(sent.body.entries.at(-1).text).toBe("Ada stopped to read this, and carries on from there.");
    await app.daemon.idle();

    const builds = app.agent.callsFor("ada", "build");
    expect(builds).toHaveLength(2);
    expect(builds[1]?.brief).toContain("- Keep it small: use the ledger's sign");
    expect((await app.call("GET", "/api/tickets/1")).body.ticket.status).toBe("ready");
  });

  it("answers a question, and turns an ask into a draft the owner puts on the board", async () => {
    const app = await testApp();
    app.chat.outcomes.push({ kind: "done", output: "The sample files were all US format." });

    const q = await app.call("POST", "/api/chat/kit", { text: "Why US dates?" });
    expect(q.body.entries.at(-1)).toMatchObject({
      from: "employee",
      text: "The sample files were all US format.",
    });

    const ask = await app.call("POST", "/api/chat/kit", { text: "Also accept ISO dates." });
    const draft = ask.body.entries.at(-1);
    expect(draft).toMatchObject({ kind: "draft", title: "Also accept ISO dates", confirmed: false });

    let card = (await app.call("GET", `/api/tickets/${draft.ticketId}`)).body.ticket;
    expect(card).toMatchObject({ held: true, status: "queued" });

    await app.call("POST", `/api/chat/kit/drafts/${draft.ticketId}`);
    await app.daemon.idle();
    card = (await app.call("GET", `/api/tickets/${draft.ticketId}`)).body.ticket;
    expect(card).toMatchObject({ held: false, status: "ready" });
    const thread = (await app.call("GET", "/api/chat/kit")).body.entries;
    expect(thread.find((e: { kind?: string }) => e.kind === "draft").confirmed).toBe(true);
  });

  it("files a PA's ask as an errand straight away", async () => {
    const app = await testApp();
    const res = await app.call("POST", "/api/chat/pip", { text: "Find me flights to Bengaluru in December" });
    const errand = res.body.entries.at(-1);
    expect(errand).toMatchObject({ kind: "errand" });
    await app.daemon.idle();
    const t = (await app.call("GET", `/api/tickets/${errand.ticketId}`)).body.ticket;
    expect(t).toMatchObject({ type: "errand", project: "Home", assignee: { id: "pip" } });
  });

  it("passes a note to the ticket in progress, for the next stage boundary", async () => {
    const app = await testApp();
    app.agent.on(
      { employee: "ada", stage: "build" },
      { kind: "out-of-tokens", resetsAt: app.clock.now() + 3_600_000 },
    );
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();

    const res = await app.call("POST", "/api/chat/ada", { text: "Keep it behind a flag" });
    expect(res.body.entries.at(-1)).toMatchObject({
      from: "system",
      text: "Ada will see this at the next stage boundary.",
    });
    const events = (await app.call("GET", "/api/tickets/1")).body.events;
    expect(events.at(-1)).toMatchObject({ type: "owner-message", text: "Keep it behind a flag" });
  });
});
