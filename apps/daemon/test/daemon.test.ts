// The daemon end to end: SQLite, the tick loop and the API, with the scripted agent.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { liveLine } from "../src/views.ts";
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

describe("machines", () => {
  it("stops a machine once its employee has nothing running", async () => {
    const app = await testApp();
    const machines = app.deps.machines as unknown as { started: string[]; stopped: string[] };
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    expect(machines.started).toContain("ada");
    // The ticket is ready: Ada and her reviewer have nothing running, so the next pass stops both.
    await app.daemon.tick();
    expect(machines.stopped.sort()).toEqual(["ada", "kit", "quinn"]);
    await app.daemon.tick();
    expect(machines.stopped).toHaveLength(3);
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
      "ChatGPT subscription",
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

  it("prioritizes employee's recent project and infers mentioned project in chat ask", async () => {
    const app = await testApp();
    // Seed a previous ticket for ada on Duet:
    app.deps.tickets.create(
      {
        title: "Refunds are counted as spending",
        project: "Duet",
        type: "fix",
        effort: "medium",
        doneWhen: [],
        assignee: "ada",
      },
      app.clock.now(),
    );

    // Give ada assigned projects ["website", "Duet"]:
    const adaEmp = app.deps.registry.employees().find((e) => e.id === "ada");
    if (!adaEmp) throw new Error("ada missing");
    app.deps.registry.hire({
      ...adaEmp,
      projects: ["website", "Duet"],
    });

    // 1. Without mentioning a project, defaults to recent ticket project (Duet), not e.projects[0] (website)
    const askRecent = await app.call("POST", "/api/chat/ada", { text: "Add more currency symbols" });
    const draftRecent = askRecent.body.entries.at(-1);
    const cardRecent = (await app.call("GET", `/api/tickets/${draftRecent.ticketId}`)).body.ticket;
    expect(cardRecent.project).toBe("Duet");

    // 2. When mentioning an assigned project ("website"), it infers "website"
    const askMentioned = await app.call("POST", "/api/chat/ada", {
      text: "Update hero CTA button on website",
    });
    const draftMentioned = askMentioned.body.entries.at(-1);
    const cardMentioned = (await app.call("GET", `/api/tickets/${draftMentioned.ticketId}`)).body.ticket;
    expect(cardMentioned.project).toBe("website");
  });

  describe("which project a chat draft is filed under (C12)", () => {
    async function withProjects(projects: string[]) {
      const app = await testApp();
      const ada = app.deps.registry.employees().find((e) => e.id === "ada");
      if (!ada) throw new Error("ada missing");
      app.deps.registry.hire({ ...ada, projects });
      const file = (project: string, at = app.clock.now()) =>
        app.deps.tickets.create(
          { title: `On ${project}`, project, type: "fix", effort: "low", doneWhen: [], assignee: "ada" },
          at,
        );
      const ask = async (text: string) =>
        (await app.call("POST", "/api/chat/ada", { text })).body.entries.at(-1);
      return { app, file, ask };
    }

    it("reports the inferred project, that it was inferred, and the choices", async () => {
      const { ask } = await withProjects(["Duet", "i-inc"]);
      expect(await ask("Add refunds to duet")).toMatchObject({
        kind: "draft",
        project: "Duet",
        inferred: true,
        choices: ["Duet", "i-inc"],
      });
      const plain = await ask("Add a thing");
      expect(plain).toMatchObject({ project: "Duet", inferred: false });
      expect(plain).not.toHaveProperty("ambiguous");
    });

    it("lists both names and infers nothing when two projects are named", async () => {
      const { ask } = await withProjects(["Duet", "i-inc"]);
      for (const text of ["Fix the duet bug in i-inc", "Fix i-inc and the duet bug"]) {
        const draft = await ask(text);
        expect(draft).toMatchObject({ kind: "draft", inferred: false });
        expect([...draft.ambiguous].sort()).toEqual(["Duet", "i-inc"]);
      }
    });

    it("breaks a recency tie by ticket order, and never leaves the employee's own projects", async () => {
      const { app, file, ask } = await withProjects(["Duet", "i-inc"]);
      file("Duet");
      file("i-inc"); // same instant: the later ticket wins
      expect((await ask("Add a thing")).project).toBe("i-inc");
      file("elsewhere"); // newest, but not one of Ada's projects
      expect((await ask("Add another thing")).project).toBe("i-inc");
      const card = (await app.call("GET", `/api/tickets/${(await ask("Add one more")).ticketId}`)).body
        .ticket;
      expect(card.project).toBe("i-inc");
    });

    it("falls back to the first of Ada's projects when none of her tickets is on one", async () => {
      const { file, ask } = await withProjects(["Duet", "i-inc"]);
      file("elsewhere");
      expect((await ask("Add a thing")).project).toBe("Duet");
    });

    it("files under the project the owner picks, and rejects one that isn't Ada's", async () => {
      const { app, ask } = await withProjects(["Duet", "i-inc"]);
      const draft = await ask("Add refunds to duet");
      for (const project of ["elsewhere", "", 7, ["Duet"]]) {
        const bad = await app.call("POST", `/api/chat/ada/drafts/${draft.ticketId}`, { project });
        expect(bad.status).toBe(400);
      }
      let card = (await app.call("GET", `/api/tickets/${draft.ticketId}`)).body.ticket;
      expect(card).toMatchObject({ held: true, project: "Duet" });

      const ok = await app.call("POST", `/api/chat/ada/drafts/${draft.ticketId}`, { project: "i-inc" });
      expect(ok.body).toEqual({ ok: true, project: "i-inc" });
      card = (await app.call("GET", `/api/tickets/${draft.ticketId}`)).body.ticket;
      expect(card).toMatchObject({ held: false, project: "i-inc" });
      const entry = (await app.call("GET", "/api/chat/ada")).body.entries.find(
        (e: { kind?: string }) => e.kind === "draft",
      );
      expect(entry).toMatchObject({ confirmed: true, project: "i-inc", inferred: false });
    });

    it("keeps the inferred project when confirmed without a body, or with the same project", async () => {
      const { app, ask } = await withProjects(["Duet", "i-inc"]);
      const a = await ask("Add refunds to duet");
      expect((await app.call("POST", `/api/chat/ada/drafts/${a.ticketId}`)).body).toEqual({
        ok: true,
        project: "Duet",
      });
      const b = await ask("Add refunds to i-inc");
      await app.call("POST", `/api/chat/ada/drafts/${b.ticketId}`, { project: "i-inc" });
      const entry = (await app.call("GET", "/api/chat/ada")).body.entries.filter(
        (e: { kind?: string }) => e.kind === "draft",
      );
      expect(entry[0]).toMatchObject({ project: "Duet", inferred: true, confirmed: true });
      expect(entry[1]).toMatchObject({ project: "i-inc", inferred: true, confirmed: true });
    });

    it("infers a company project for an employee with no list (the demo's Kit)", async () => {
      const app = await testApp();
      const draft = (
        await app.call("POST", "/api/chat/kit", { text: "Fix the Duet login bug" })
      ).body.entries.at(-1);
      expect(draft).toMatchObject({ kind: "draft", project: "Duet", inferred: true });
      expect(draft.choices).toEqual(expect.arrayContaining(["Duet", "fintrack", "listy"]));
    });

    it("treats a project the employee can't use, named with one it can, as ambiguous", async () => {
      const { app, ask } = await withProjects(["Duet", "fintrack"]);
      const draft = await ask("Fix the duet bug and the listy export");
      expect(draft).toMatchObject({ inferred: false });
      expect([...draft.ambiguous].sort()).toEqual(["Duet", "listy"]);
      expect(draft.choices).toEqual(["Duet", "fintrack"]);
      const bad = await app.call("POST", `/api/chat/ada/drafts/${draft.ticketId}`, { project: "listy" });
      expect(bad.status).toBe(400);
    });

    it("holds an ambiguous draft until the owner picks a project", async () => {
      const { app, ask } = await withProjects(["Duet", "i-inc"]);
      const draft = await ask("Fix the duet bug in i-inc");
      const none = await app.call("POST", `/api/chat/ada/drafts/${draft.ticketId}`);
      expect(none.status).toBe(400);
      expect(none.body.error).toMatch(/choose a project/);
      expect((await app.call("GET", `/api/tickets/${draft.ticketId}`)).body.ticket.held).toBe(true);
      const ok = await app.call("POST", `/api/chat/ada/drafts/${draft.ticketId}`, { project: "Duet" });
      expect(ok.body).toEqual({ ok: true, project: "Duet" });
    });

    it("answers 400, not 500, to a confirm body that isn't a JSON object", async () => {
      const { app, ask } = await withProjects(["Duet", "i-inc"]);
      const draft = await ask("Add refunds to duet");
      for (const raw of ["null", "[]", '"Duet"', "7", "true", "{nope", '[{"project":"Duet"}]']) {
        const res = await app.handle(
          new Request(`http://i.inc/api/chat/ada/drafts/${draft.ticketId}`, {
            method: "POST",
            body: raw,
            headers: { "content-type": "application/json" },
          }),
        );
        expect(res.status).toBe(400);
      }
    });

    it("lets an employee without a project list use any project the company has", async () => {
      const app = await testApp();
      await app.call("PUT", "/api/projects/zed", { repo: "x/y", checks: ["pnpm test"] });
      const draft = (await app.call("POST", "/api/chat/kit", { text: "Add a thing" })).body.entries.at(-1);
      expect(draft.choices).toContain("zed");
      const ok = await app.call("POST", `/api/chat/kit/drafts/${draft.ticketId}`, { project: "zed" });
      expect(ok.status).toBe(200);
      const bad = await app.call("POST", "/api/chat/kit/drafts/9999", { project: "zed" });
      expect(bad.status).toBe(404);
    });
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

  it("formats helper-unavailable event in liveLine with stage, helper name and reason", async () => {
    const app = await testApp();
    const line = liveLine(
      [
        {
          type: "helper-unavailable",
          at: 1000,
          stage: "review",
          duty: "review",
          employeeId: "kit",
          reason: "the sandbox can't start",
        },
      ],
      app.deps.registry,
    );
    expect(line).toBe("Review · Kit unavailable: the sandbox can't start");
  });

  describe("performance and indexing (Group 5)", () => {
    it("uses indexed lookup for knowledge and avoids queries on unchanged tickets", async () => {
      const app = await testApp();
      await app.call("POST", "/api/tickets", refunds);
      await app.daemon.idle();

      let knowledgeQueries = 0;
      let eventQueries = 0;
      const origAll = app.db.all.bind(app.db);
      app.db.all = <T extends Record<string, unknown>>(
        sql: string,
        ...params: (string | number | null | Uint8Array)[]
      ) => {
        if (sql.includes("knowledge_applied")) {
          knowledgeQueries++;
          expect(sql).not.toContain("LIKE");
        }
        if (sql.includes("FROM events WHERE ticket_id")) {
          eventQueries++;
        }
        return origAll(sql, ...params) as T[];
      };

      // Subsequent tick on unchanged tickets
      const kBefore = knowledgeQueries;
      const eBefore = eventQueries;
      await app.daemon.tick();

      // Unchanged tickets should skip reading events and knowledge_applied
      expect(knowledgeQueries - kBefore).toBe(0);
      expect(eventQueries - eBefore).toBe(0);

      // Invalidate ticket 1 by appending an event
      await app.deps.store.append("1", [
        { type: "checkpoint", at: Date.now(), stage: "build", note: "testing cache invalidation" },
      ]);
      await app.daemon.tick();

      // Since ticket 1 is dirty, events should be read
      expect(eventQueries - eBefore).toBeGreaterThan(0);
    });

    it("has indexes for events(type, at) and tickets(created_at, CAST(id AS INTEGER))", async () => {
      const app = await testApp();
      const eventIndexes = app.db.all<{ name: string }>("PRAGMA index_list('events')");
      expect(eventIndexes.some((idx) => idx.name === "idx_events_type_at")).toBe(true);

      const ticketIndexes = app.db.all<{ name: string }>("PRAGMA index_list('tickets')");
      expect(ticketIndexes.some((idx) => idx.name === "idx_tickets_created_at_id")).toBe(true);

      const eventPlan = app.db.all<{ detail: string }>(
        "EXPLAIN QUERY PLAN SELECT * FROM events WHERE type = 'report-ready' ORDER BY at",
      );
      expect(eventPlan.some((p) => p.detail.includes("idx_events_type_at"))).toBe(true);

      const ticketPlan = app.db.all<{ detail: string }>(
        "EXPLAIN QUERY PLAN SELECT * FROM tickets ORDER BY created_at, CAST(id AS INTEGER)",
      );
      expect(ticketPlan.some((p) => p.detail.includes("idx_tickets_created_at_id"))).toBe(true);
    });
  });
});
