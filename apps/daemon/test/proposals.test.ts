// C20: follow-ups over the daily budget wait as proposals for the owner (v1-plan §6).
import type { FollowUp, TicketEvent } from "@i-inc/core";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api.ts";
import { testApp } from "./setup.ts";

const followUp = (title: string, extra: Partial<FollowUp> = {}): FollowUp => ({
  title,
  doneWhen: [`${title} works`],
  type: "fix",
  effort: "low",
  reason: `Because ${title} matters`,
  ...extra,
});

type App = Awaited<ReturnType<typeof testApp>>;

/** Sets how many follow-ups agents may file for a project each day. */
function limit(app: App, project: string, followUpsPerDay: number) {
  const p = app.deps.registry.project(project);
  if (!p) throw new Error(`no project ${project}`);
  app.deps.registry.addProject({ ...p, followUpsPerDay });
}

/** A ticket for `project` to propose follow-ups after, without running it. */
function source(app: App, project = "Duet") {
  return app.deps.tickets.create(
    {
      title: "Source",
      project,
      type: "fix",
      effort: "low",
      doneWhen: ["done"],
      assignee: "ada",
    },
    app.clock.now(),
  );
}

/** What the daemon does when a ticket's events carry follow-ups. */
function propose(app: App, ticketId: string, ...ups: FollowUp[]) {
  const events: TicketEvent[] = [
    { type: "follow-ups", at: app.clock.now(), employeeId: "ada", tickets: ups },
  ];
  app.daemon.fileFollowUps(ticketId, events);
}

const open = async (app: App) => (await app.call("GET", "/api/proposals?status=open")).body.proposals;

describe("over-budget follow-ups become proposals", () => {
  it("files follow-ups within the budget, and keeps the rest as proposals", async () => {
    const logs: string[] = [];
    const app = await testApp();
    app.deps.log = (m) => logs.push(m);
    const t = source(app);
    propose(
      app,
      t.id,
      followUp("one"),
      followUp("two"),
      followUp("three"),
      followUp("four"),
      followUp("five"),
    );
    const filed = app.deps.tickets.all().filter((r) => r.ticket.createdBy);
    expect(filed.map((r) => r.ticket.title)).toEqual(["one", "two", "three"]);
    const list = await open(app);
    expect(list.map((p: { title: string }) => p.title).sort()).toEqual(["five", "four"]);
    expect(list[0]).toMatchObject({
      project: "Duet",
      proposedBy: "ada",
      proposer: { id: "ada", name: "Ada" },
      sourceTicket: t.id,
      status: "open",
      decidedAt: null,
      ticketId: null,
      type: "fix",
      effort: "low",
    });
    expect(list.find((p: { title: string }) => p.title === "four")).toMatchObject({
      body: "Because four matters",
      doneWhen: ["four works"],
    });
    expect(logs.filter((l) => l.includes("kept as proposal"))).toHaveLength(2);
  });

  it("stores nothing while the budget lasts", async () => {
    const app = await testApp();
    const t = source(app);
    propose(app, t.id, followUp("one"));
    expect(await open(app)).toEqual([]);
  });

  it("does not store the same open proposal twice, but does after it is decided", async () => {
    const app = await testApp();
    limit(app, "Duet", 0);
    const t = source(app);
    propose(app, t.id, followUp("Fix  the Flaky TEST."));
    propose(app, t.id, followUp("fix the flaky test"));
    expect(await open(app)).toHaveLength(1);
    // Another project may propose the same title.
    const other = source(app, "fintrack");
    limit(app, "fintrack", 0);
    propose(app, other.id, followUp("fix the flaky test"));
    expect(await open(app)).toHaveLength(2);
    const id = (await open(app)).find((p: { project: string }) => p.project === "Duet").id;
    await app.call("POST", `/api/proposals/${id}/decline`);
    propose(app, source(app).id, followUp("fix the flaky test"));
    expect((await open(app)).filter((p: { project: string }) => p.project === "Duet")).toHaveLength(1);
  });

  it("handles one follow-up event once (a restart does not store it again)", async () => {
    const app = await testApp();
    limit(app, "Duet", 0);
    const t = source(app);
    const events: TicketEvent[] = [
      { type: "follow-ups", at: app.clock.now(), employeeId: "ada", tickets: [followUp("a"), followUp("b")] },
    ];
    app.daemon.fileFollowUps(t.id, events);
    app.daemon.fileFollowUps(t.id, events);
    expect(await open(app)).toHaveLength(2);
  });
});

/** A project at its budget with `title` waiting; returns the proposal's id. */
async function waiting(app: App, title = "Add retry to the sync") {
  limit(app, "Duet", 0);
  const t = source(app);
  propose(app, t.id, followUp(title));
  return (await open(app))[0].id as number;
}

describe("GET and POST /api/proposals", () => {
  it("lists by status and rejects an unknown status", async () => {
    const app = await testApp();
    const id = await waiting(app);
    expect((await app.call("GET", "/api/proposals")).body.proposals).toHaveLength(1);
    expect((await app.call("GET", "/api/proposals?status=accepted")).body.proposals).toEqual([]);
    await app.call("POST", `/api/proposals/${id}/decline`);
    expect(await open(app)).toEqual([]);
    expect((await app.call("GET", "/api/proposals?status=declined")).body.proposals).toHaveLength(1);
    expect((await app.call("GET", "/api/proposals?status=nope")).status).toBe(400);
  });

  it("accept files the ticket as the proposer's, without using the budget", async () => {
    const app = await testApp();
    const id = await waiting(app);
    const res = await app.call("POST", `/api/proposals/${id}/accept`, {});
    expect(res.status).toBe(201);
    expect(res.body.ticket).toMatchObject({
      title: "Add retry to the sync",
      project: "Duet",
      type: "fix",
      effort: "low",
      doneWhen: ["Add retry to the sync works"],
      assignee: "ada",
      createdBy: "ada",
    });
    expect(res.body.proposal).toMatchObject({ id, status: "accepted", ticketId: res.body.ticket.id });
    expect(res.body.proposal.decidedAt).toBeTypeOf("number");
    expect(await open(app)).toEqual([]);
    // The budget (1 a day here) still has room: accepting did not use it.
    limit(app, "Duet", 1);
    const t = source(app);
    propose(app, t.id, followUp("agent-filed"));
    expect(app.deps.tickets.all().some((r) => r.ticket.title === "agent-filed")).toBe(true);
    expect(await open(app)).toEqual([]);
  });

  it("accept uses the assignee named, and checks it", async () => {
    const app = await testApp();
    const id = await waiting(app);
    const bad = await app.call("POST", `/api/proposals/${id}/accept`, { assignee: "nobody" });
    expect(bad.status).toBe(400);
    expect((await app.call("POST", `/api/proposals/${id}/accept`, { assignee: 7 })).status).toBe(400);
    await app.call("PUT", "/api/employees/kit", { projects: ["fintrack"] });
    const wrong = await app.call("POST", `/api/proposals/${id}/accept`, { assignee: "kit" });
    expect(wrong.status).toBe(409);
    expect((await open(app)).length).toBe(1);
    const ok = await app.call("POST", `/api/proposals/${id}/accept`, { assignee: "grace" });
    expect(ok.body.ticket).toMatchObject({ assignee: "grace", createdBy: "ada" });
  });

  it("accept falls back to the project's usual employee when the proposer left the project", async () => {
    const app = await testApp();
    const id = await waiting(app);
    await app.call("PUT", "/api/employees/ada", { projects: ["fintrack"] });
    const res = await app.call("POST", `/api/proposals/${id}/accept`, {});
    expect(res.status).toBe(201);
    expect(res.body.ticket.createdBy).toBe("ada");
    expect(res.body.ticket.assignee).not.toBe("ada");
    expect(res.body.ticket.assignee).not.toBe("");
  });

  it("decline marks it declined and files nothing", async () => {
    const app = await testApp();
    const id = await waiting(app);
    const before = app.deps.tickets.all().length;
    const res = await app.call("POST", `/api/proposals/${id}/decline`, {});
    expect(res.status).toBe(200);
    expect(res.body.proposal).toMatchObject({ id, status: "declined", ticketId: null });
    expect(app.deps.tickets.all().length).toBe(before);
  });

  it("404s an unknown proposal, 409s a decided one, 400s a bad body", async () => {
    const app = await testApp();
    const id = await waiting(app);
    for (const action of ["accept", "decline"]) {
      expect((await app.call("POST", `/api/proposals/999/${action}`, {})).status).toBe(404);
      expect((await app.call("POST", `/api/proposals/abc/${action}`, {})).status).toBe(404);
    }
    const send = (path: string, body: string) =>
      app.handle(
        new Request(`http://i.inc${path}`, {
          method: "POST",
          body,
          headers: { "content-type": "application/json" },
        }),
      );
    for (const action of ["accept", "decline"]) {
      for (const raw of ["null", "[]", "7", '"x"', "{oops"]) {
        const res = await send(`/api/proposals/${id}/${action}`, raw);
        expect(res.status).toBe(400);
        expect(res.headers.get("content-type")).toContain("application/json");
        expect(((await res.json()) as { error: string }).error).toBeTruthy();
      }
    }
    expect((await open(app)).length).toBe(1);
    await app.call("POST", `/api/proposals/${id}/accept`, {});
    expect((await app.call("POST", `/api/proposals/${id}/accept`, {})).status).toBe(409);
    expect((await app.call("POST", `/api/proposals/${id}/decline`, {})).status).toBe(409);
    const other = await waiting(app, "Another one");
    await app.call("POST", `/api/proposals/${other}/decline`, {});
    expect((await app.call("POST", `/api/proposals/${other}/accept`, {})).status).toBe(409);
  });

  it("lets exactly one of several simultaneous accepts file a ticket", async () => {
    const app = await testApp();
    const id = await waiting(app);
    const before = app.deps.tickets.all().length;
    const results = await Promise.all(
      Array.from({ length: 6 }, () => app.call("POST", `/api/proposals/${id}/accept`, {})),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(app.deps.tickets.all().length).toBe(before + 1);
  });

  it("lets only one of an accept and a decline win", async () => {
    const app = await testApp();
    const id = await waiting(app);
    const before = app.deps.tickets.all().length;
    const [a, d] = await Promise.all([
      app.call("POST", `/api/proposals/${id}/accept`, {}),
      app.call("POST", `/api/proposals/${id}/decline`, {}),
    ]);
    expect([a.status, d.status].sort()).toEqual(a.status === 201 ? [201, 409] : [200, 409]);
    expect([a.status === 201, d.status === 200].filter(Boolean)).toHaveLength(1);
    expect(app.deps.tickets.all().length).toBe(before + (a.status === 201 ? 1 : 0));
  });

  it("keeps the API's guards: JSON only, no cross-site writes", async () => {
    const app = await testApp();
    const id = await waiting(app);
    const guarded = createApi(app.daemon, app.deps, { hosts: ["i.inc"] });
    const plain = await guarded(
      new Request(`http://i.inc/api/proposals/${id}/accept`, {
        method: "POST",
        body: "{}",
        headers: { host: "i.inc", "content-type": "text/plain" },
      }),
    );
    expect(plain.status).toBe(415);
    const cross = await guarded(
      new Request(`http://i.inc/api/proposals/${id}/accept`, {
        method: "POST",
        body: "{}",
        headers: { host: "i.inc", "content-type": "application/json", origin: "http://evil.example" },
      }),
    );
    expect(cross.status).toBe(403);
  });

  it("tells open views to refresh when a proposal is stored or decided", async () => {
    const app = await testApp();
    const seen: string[] = [];
    app.live.on("office", () => seen.push("office"));
    app.live.on("ticket", (id) => seen.push(`ticket:${id}`));
    const id = await waiting(app);
    expect(seen).toContain("office");
    seen.length = 0;
    await app.call("POST", `/api/proposals/${id}/accept`, {});
    expect(seen).toContain("office");
    expect(seen.some((s) => s.startsWith("ticket:"))).toBe(true);
    seen.length = 0;
    const other = await waiting(app, "Second");
    seen.length = 0;
    await app.call("POST", `/api/proposals/${other}/decline`, {});
    expect(seen).toContain("office");
  });

  it("sends the refresh over the event stream", async () => {
    const app = await testApp();
    const res = await app.handle(new Request("http://i.inc/api/events"));
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    await reader.read(); // ": connected"
    await waiting(app);
    let text = "";
    while (!text.includes("event: office")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
    expect(text).toContain("event: office");
    await reader.cancel();
  });
});
