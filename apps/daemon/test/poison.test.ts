// T63 audit, group 1: no single bad datum may take down the tick, the board, an API route or startup.
// Each case is seeded the way the audit found it, and the test asserts that the daemon stays up, that
// the other tickets carry on, and that the owner is told which ticket is the problem.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fold, type TicketEvent } from "@i-inc/core";
import { describe, expect, it } from "vitest";
import { AcpAgent } from "../src/acp.ts";
import { refunds, testApp } from "./setup.ts";

type App = Awaited<ReturnType<typeof testApp>>;

const kitsTicket = (app: App, title = "Second ticket") =>
  app.deps.tickets.create(
    { title, project: "Duet", type: "fix", effort: "low", doneWhen: ["x"], assignee: "kit" },
    app.clock.now(),
  );

const statusOf = async (app: App, id: string) => fold(await app.deps.store.read(id)).status;

/** The routes the audit saw fail with one poisoned ticket: they all still answer 200. */
async function theAppStillAnswers(app: App) {
  for (const path of ["/api/board", "/api/tickets/1", "/api/desk", "/api/office"]) {
    const res = await app.call("GET", path);
    expect(res.status, path).toBe(200);
  }
  const created = await app.call("POST", "/api/tickets", { ...refunds, title: "New work", assignee: "kit" });
  expect(created.status).toBe(201);
}

/** Puts a raw event row into a ticket's log, as an older release or a crash could have. */
const insertRow = (app: App, ticketId: string, at: number, type: string, body: string) => {
  const [row] = app.db.all<{ n: number }>("SELECT MAX(seq) AS n FROM events WHERE ticket_id = ?", ticketId);
  app.db.run(
    "INSERT INTO events (ticket_id, seq, at, type, body) VALUES (?, ?, ?, ?, ?)",
    ticketId,
    (row?.n ?? 0) + 1,
    at,
    type,
    body,
  );
};

describe("a malformed agent reply", () => {
  it("fails that ticket as unreadable; the second ticket starts and the whole app keeps answering", async () => {
    const app = await testApp();
    app.agent.on({ duty: "verify" }, { kind: "done", output: '{"items": "all pass"}' });
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    expect(await statusOf(app, "1")).toBe("failed");

    kitsTicket(app);
    await app.daemon.tick();
    await app.daemon.idle();
    expect((await app.deps.store.read("2")).length).toBeGreaterThan(0);
    expect(await statusOf(app, "2")).not.toBe("running");
    await theAppStillAnswers(app);
  });

  it("an old poison event already in the log (a proof whose items are a string) breaks nothing", async () => {
    const app = await testApp();
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    insertRow(
      app,
      "1",
      app.clock.now(),
      "proof",
      JSON.stringify({ type: "proof", at: app.clock.now(), items: "all pass" }),
    );
    insertRow(
      app,
      "1",
      app.clock.now(),
      "review-verdict",
      JSON.stringify({
        type: "review-verdict",
        at: app.clock.now(),
        reviewerId: "grace",
        round: 1,
        approved: false,
      }),
    );
    kitsTicket(app);
    await expect(app.daemon.tick()).resolves.toBeUndefined();
    await app.daemon.idle();
    expect((await app.deps.store.read("2")).length).toBeGreaterThan(0);
    await theAppStillAnswers(app);
  });

  it("a builder's follow-up with an effort nobody knows is not filed, and its assignee is not stuck busy", async () => {
    const app = await testApp();
    app.deps.registry.addProject({ id: "Duet", repo: "o/duet", checks: ["x"], mode: "direct" });
    const followUps = [
      { title: "Do more", doneWhen: ["x"], type: "fix", effort: "huge", reason: "r" },
      { title: "Errand", doneWhen: ["x"], type: "errand", effort: "low", reason: "r" },
      { title: 5, doneWhen: ["x"], type: "fix", effort: "low", reason: "r" },
    ];
    app.agent.on(
      { stage: "report" },
      { kind: "done", output: JSON.stringify({ report: "done", followUps }) },
    );
    await app.call("POST", "/api/tickets", { ...refunds, effort: "low" });
    await app.daemon.idle();
    expect(app.deps.tickets.get("2")).toBeUndefined();

    // The same events as an older release stored them, unchecked: replayed, they file nothing and
    // leave Ada free for real work.
    insertRow(
      app,
      "1",
      app.clock.now(),
      "follow-ups",
      JSON.stringify({ type: "follow-ups", at: app.clock.now(), employeeId: "ada", tickets: followUps }),
    );
    await app.daemon.tick();
    await app.daemon.idle();
    expect(app.deps.tickets.get("2")).toBeUndefined();

    await app.call("POST", "/api/tickets", { ...refunds, title: "Real work for Ada", effort: "low" });
    await app.daemon.idle();
    expect(["ready", "done"]).toContain(await statusOf(app, "2"));
    await theAppStillAnswers(app);
  });

  it("a stored ticket with an effort this version does not know is planned as Medium, not thrown at", async () => {
    const app = await testApp();
    const t = kitsTicket(app);
    app.db.run("UPDATE tickets SET body = ? WHERE id = ?", JSON.stringify({ ...t, effort: "huge" }), t.id);
    await app.daemon.tick();
    await app.daemon.idle();
    expect((await app.deps.store.read(t.id)).length).toBeGreaterThan(0);
    const board = await app.call("GET", "/api/board");
    expect(board.status).toBe(200);
    expect(board.body.tickets.find((x: { id: string }) => x.id === t.id)).toBeTruthy();
  });
});

describe("a corrupt or truncated row", () => {
  it("a truncated event body is set aside and logged; the other ticket progresses; the board lists the ticket", async () => {
    const logs: string[] = [];
    const app = await testApp(":memory:", undefined, { log: (m) => logs.push(m) });
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    const before = (await app.deps.store.read("1")).length;
    app.db.run("UPDATE events SET body = substr(body, 1, 10) WHERE ticket_id = '1' AND seq = 3");

    kitsTicket(app);
    await expect(app.daemon.tick()).resolves.toBeUndefined();
    await app.daemon.idle();
    expect((await app.deps.store.read("2")).length).toBeGreaterThan(0);

    const events = await app.deps.store.read("1");
    expect(events).toHaveLength(before);
    expect(events[2]).toMatchObject({ type: "unreadable", seq: 3 });
    expect(app.deps.store.quarantined()).toEqual([{ ticketId: "1", seq: 3, reason: expect.any(String) }]);
    // Logged once, not at every read.
    await app.daemon.tick();
    expect(logs.filter((l) => l.includes("event 3 can't be read"))).toHaveLength(1);
    await theAppStillAnswers(app);
  });

  it("a row that parses but is not an event (a bare number, no type, no time) is set aside too", async () => {
    const app = await testApp();
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    insertRow(app, "1", 1, "x", "42");
    insertRow(app, "1", 1, "x", '{"hello":"world"}');
    insertRow(app, "1", 1, "x", '{"type":"proof"}');
    expect((await app.deps.store.read("1")).filter((e) => e.type === "unreadable")).toHaveLength(3);
    expect(app.deps.store.quarantined()).toHaveLength(3);
    await theAppStillAnswers(app);
  });

  it("a ticket row that is not JSON is skipped and listed as unreadable; the others still start", async () => {
    const app = await testApp();
    const bad = kitsTicket(app, "Broken");
    app.db.run('UPDATE tickets SET body = \'{"id":"1","ti\' WHERE id = ?', bad.id);
    app.deps.tickets.create(
      { title: "Healthy", project: "Duet", type: "fix", effort: "low", doneWhen: ["x"], assignee: "ada" },
      app.clock.now(),
    );
    await expect(app.daemon.tick()).resolves.toBeUndefined();
    await app.daemon.idle();
    expect((await app.deps.store.read("1")).length).toBe(0);
    expect((await app.deps.store.read("2")).length).toBeGreaterThan(0);
    const board = await app.call("GET", "/api/board");
    expect(board.status).toBe(200);
    expect(board.body.unreadable).toEqual([{ id: "1", reason: expect.any(String) }]);
    expect(board.body.tickets.map((t: { id: string }) => t.id)).toEqual(["2"]);
  });

  it("a company row that is not JSON is ignored, not thrown at every tick", async () => {
    const app = await testApp();
    app.db.run("INSERT INTO company (kind, id, body) VALUES ('employee', 'ghost', '{\"id\":')");
    app.db.run("INSERT INTO company (kind, id, body) VALUES ('rate_limit', 'x', 'nope')");
    kitsTicket(app);
    await expect(app.daemon.tick()).resolves.toBeUndefined();
    await app.daemon.idle();
    expect((await app.deps.store.read("1")).length).toBeGreaterThan(0);
    expect(app.deps.registry.employees().map((e) => e.id)).not.toContain("ghost");
    await theAppStillAnswers(app);
  });
});

describe("a deleted engine that is still referenced", () => {
  it("is refused with 409 while an employee uses it", async () => {
    const app = await testApp();
    const res = await app.call("DELETE", "/api/engines/opus");
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Ada");
    expect(app.deps.registry.engines().some((e) => e.id === "opus")).toBe(true);
  });

  it("when it is gone anyway (older data), Kit's unrelated ticket still starts and Ada's says why it waits", async () => {
    const app = await testApp();
    app.deps.registry.removeEngine("opus");
    app.deps.tickets.create(
      { title: "Ada's", project: "Duet", type: "fix", effort: "low", doneWhen: ["x"], assignee: "ada" },
      app.clock.now(),
    );
    kitsTicket(app);
    await expect(app.daemon.tick()).resolves.toBeUndefined();
    await app.daemon.idle();
    expect((await app.deps.store.read("2")).length).toBeGreaterThan(0);
    expect((await app.deps.store.read("1")).length).toBe(0);
    expect(app.daemon.waiting).toContainEqual({ ticketId: "1", reason: expect.stringContaining("engine") });
    const board = await app.call("GET", "/api/board");
    expect(board.status).toBe(200);
    expect((await app.call("GET", "/api/office")).status).toBe(200);
    expect((await app.call("GET", "/api/desk")).status).toBe(200);
  });

  it("a paused ticket whose engine was removed does not stop the scheduler", async () => {
    const app = await testApp();
    app.agent.on(
      { employee: "ada", stage: "build" },
      { kind: "out-of-tokens", resetsAt: app.clock.now() + 3_600_000 },
    );
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    expect(await statusOf(app, "1")).toBe("paused");
    app.deps.registry.removeEngine("opus");

    kitsTicket(app);
    await expect(app.daemon.tick()).resolves.toBeUndefined();
    await app.daemon.idle();
    expect((await app.deps.store.read("2")).length).toBeGreaterThan(0);
    expect((await app.call("GET", "/api/board")).status).toBe(200);
    expect((await app.call("GET", "/api/tickets/1")).status).toBe(200);
  });
});

describe("an agent that throws instead of answering", () => {
  it("backs off between tries and fails the ticket with the reason after a few, instead of growing the log for ever", async () => {
    const app = await testApp();
    let attempts = 0;
    const run = app.deps.agent.run.bind(app.deps.agent);
    app.deps.agent.run = async (r) => {
      if (r.stage === "build") {
        attempts++;
        throw new Error("credentials: the token request failed with a 502");
      }
      return run(r);
    };
    await app.call("POST", "/api/tickets", { ...refunds, effort: "low" });
    await app.daemon.idle();
    expect(attempts).toBe(1);

    // Ticks inside the back-off do not run it again, and add nothing to its log.
    const events = (await app.deps.store.read("1")).length;
    for (let i = 0; i < 5; i++) {
      await app.daemon.tick();
      await app.daemon.idle();
    }
    expect(attempts).toBe(1);
    expect((await app.deps.store.read("1")).length).toBe(events);
    expect(app.daemon.waiting.find((w) => w.ticketId === "1")?.reason).toContain("502");

    // Past the back-off it tries again, and after five in a row it gives up and says why.
    for (let i = 0; i < 10 && (await statusOf(app, "1")) === "running"; i++) {
      app.clock.advance(11);
      await app.daemon.tick();
      await app.daemon.idle();
    }
    expect(attempts).toBe(5);
    const s = fold(await app.deps.store.read("1"));
    expect(s.status).toBe("failed");
    expect(s.failure?.reason).toContain("stopped after 5 errors in a row");
    expect(s.failure?.reason).toContain("502");
    expect((await app.deps.store.read("1")).filter((e) => e.type === "session-started")).toHaveLength(5);
  });

  it("one ticket's error leaves the other tickets running", async () => {
    const app = await testApp();
    const run = app.deps.agent.run.bind(app.deps.agent);
    app.deps.agent.run = async (r) => {
      if (r.ticket.id === "1" && r.stage === "build") throw new Error("boom");
      return run(r);
    };
    await app.call("POST", "/api/tickets", { ...refunds, effort: "low" });
    kitsTicket(app);
    await app.daemon.tick();
    await app.daemon.idle();
    expect(await statusOf(app, "2")).not.toBe("running");
  });
});

describe("the owner's answers are checked", () => {
  it("decide refuses a body with no decision or one that is not one of the three", async () => {
    const app = await testApp();
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    expect(await statusOf(app, "1")).toBe("ready");
    expect((await app.call("POST", "/api/tickets/1/decide", {})).status).toBe(400);
    expect((await app.call("POST", "/api/tickets/1/decide", { decision: "merge-it" })).status).toBe(400);
    expect((await app.call("POST", "/api/tickets/1/decide", { decision: "approve", note: 5 })).status).toBe(
      400,
    );
    expect(await statusOf(app, "1")).toBe("ready");
    expect((await app.call("POST", "/api/tickets/1/decide", { decision: "approve" })).status).toBe(200);
  });

  it("answer refuses an answer that is not one of the four", async () => {
    const app = await testApp();
    app.deps.registry.addProject({ id: "Duet", repo: "o/duet", checks: ["x"], mode: "direct" });
    app.harness.gates.push({ ok: false, conflict: false, reason: "p", protectedPaths: [".github/ci.yml"] });
    await app.call("POST", "/api/tickets", { ...refunds, effort: "low" });
    await app.daemon.idle();
    expect(await statusOf(app, "1")).toBe("needs-you");
    expect((await app.call("POST", "/api/tickets/1/answer", {})).status).toBe(400);
    expect((await app.call("POST", "/api/tickets/1/answer", { answer: "sure" })).status).toBe(400);
    expect(await statusOf(app, "1")).toBe("needs-you");
  });
});

describe("startup and requests survive bad data", () => {
  it("a tick that fails is logged and never rejects; the next tick works", async () => {
    const logs: string[] = [];
    const app = await testApp(":memory:", undefined, { log: (m) => logs.push(m) });
    const limits = app.deps.registry.accountRateLimits.bind(app.deps.registry);
    app.deps.registry.accountRateLimits = () => {
      throw new Error("the company table is gone");
    };
    kitsTicket(app);
    await expect(app.daemon.tick()).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes("tick failed") && l.includes("company table"))).toBe(true);
    app.deps.registry.accountRateLimits = limits;
    await app.daemon.tick();
    await app.daemon.idle();
    expect((await app.deps.store.read("1")).length).toBeGreaterThan(0);
  });

  it("an app opened over a database with a poison row in every table comes up and ticks", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "i-inc-")), "poison.db");
    const first = await testApp(path);
    await first.call("POST", "/api/tickets", refunds);
    await first.daemon.idle();
    first.db.run("UPDATE events SET body = substr(body, 1, 7) WHERE ticket_id = '1' AND seq = 2");
    first.db.run("INSERT INTO events (ticket_id, seq, at, type, body) VALUES ('1', 999, 1, 'proof', '[1,2')");
    first.db.run("INSERT INTO company (kind, id, body) VALUES ('employee', 'ghost', '{')");
    first.db.run("INSERT INTO tickets (id, body, created_at) VALUES ('77', 'not json', 1)");
    first.db.close();

    const logs: string[] = [];
    const second = await testApp(path, undefined, { log: (m) => logs.push(m) });
    kitsTicket(second);
    await expect(second.daemon.tick()).resolves.toBeUndefined();
    await second.daemon.idle();
    // The poisoned ticket 77 counts for an id, so Kit's is 3.
    expect((await second.deps.store.read("3")).length).toBeGreaterThan(0);
    expect((await second.call("GET", "/api/board")).status).toBe(200);
    expect((await second.call("GET", "/api/desk")).status).toBe(200);
  });

  it("a route that throws answers 500 with plain JSON, and the next request is served", async () => {
    const app = await testApp();
    const projects = app.deps.registry.projects.bind(app.deps.registry);
    app.deps.registry.projects = () => {
      throw new Error("/Users/padi/secret/path.ts exploded");
    };
    const res = await app.call("GET", "/api/projects");
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("/Users/padi");
    app.deps.registry.projects = projects;
    expect((await app.call("GET", "/api/projects")).status).toBe(200);
  });

  it("an event of a type this version does not know (a rollback) is replayed past", async () => {
    const app = await testApp();
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    const at = app.clock.now();
    insertRow(app, "1", at, "from-the-future", JSON.stringify({ type: "from-the-future", at, x: 1 }));
    const events: TicketEvent[] = await app.deps.store.read("1");
    expect(fold(events).status).toBe("ready");
    await theAppStillAnswers(app);
  });
});

describe("a launch that keeps failing", () => {
  it("adds nothing to the log, then puts the ticket in front of the owner after two hours", async () => {
    let clockNow = () => 0;
    let attempts = 0;
    const agent = new AcpAgent({
      launch: () => {
        attempts++;
        throw new Error("the walls aren't up");
      },
      credentials: () => ({}),
      cwdFor: (id) => `/w/inc-${id}`,
      now: () => clockNow(),
    });
    const app = await testApp(":memory:", undefined, { agent });
    clockNow = () => app.clock.now();
    await app.call("POST", "/api/tickets", { ...refunds, effort: "low" });
    await app.daemon.idle();
    expect(attempts).toBe(1);
    expect(app.daemon.waiting.find((w) => w.ticketId === "1")?.reason).toContain("the walls aren't up");

    let hours = 0;
    for (let i = 0; i < 60 && (await statusOf(app, "1")) === "running"; i++) {
      app.clock.advance(11);
      hours += 11;
      await app.daemon.tick();
      await app.daemon.idle();
    }
    // It waited out the first two hours, trying again each time, and no session was ever recorded.
    expect(hours).toBeGreaterThanOrEqual(120);
    expect(attempts).toBeGreaterThan(5);
    const events = await app.deps.store.read("1");
    expect(events.filter((e) => e.type === "session-started")).toHaveLength(0);
    const s = fold(events);
    expect(s.status).toBe("needs-you");
    expect(s.needsYou).toMatchObject({ kind: "stuck", reason: expect.stringContaining("can't start: ") });
    expect(JSON.stringify(s.needsYou)).toContain("the walls aren't up");
  });
});

describe("what the ticket says about its record", () => {
  it("notes the unreadable events that were set aside", async () => {
    const app = await testApp();
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    expect((await app.call("GET", "/api/tickets/1")).body.ticket.note).toBeUndefined();
    app.db.run("UPDATE events SET body = substr(body, 1, 10) WHERE ticket_id = '1' AND seq IN (3, 4)");
    const one = (await app.call("GET", "/api/tickets/1")).body.ticket;
    expect(one.note).toBe("2 unreadable events were set aside (see event_quarantine)");
    const board = (await app.call("GET", "/api/board")).body.tickets;
    expect(board.find((t: { id: string }) => t.id === "1").note).toContain("2 unreadable events");
  });

  it("does not say 'round undefined' for a verdict stored without a round", async () => {
    const app = await testApp();
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    const at = app.clock.now();
    insertRow(
      app,
      "1",
      at,
      "review-verdict",
      JSON.stringify({ type: "review-verdict", at, reviewerId: "grace", approved: true, findings: [] }),
    );
    const live = (await app.call("GET", "/api/board")).body.tickets.find(
      (t: { id: string }) => t.id === "1",
    ).live;
    expect(live).toBe("Approved");
    expect(live).not.toContain("undefined");
    insertRow(
      app,
      "1",
      at,
      "review-verdict",
      JSON.stringify({ type: "review-verdict", at, reviewerId: "grace", approved: false, findings: [] }),
    );
    expect(
      (await app.call("GET", "/api/board")).body.tickets.find((t: { id: string }) => t.id === "1").live,
    ).toBe("Review · 0 findings");
    expect(Number.isFinite(fold(await app.deps.store.read("1")).review.round)).toBe(true);
  });
});
