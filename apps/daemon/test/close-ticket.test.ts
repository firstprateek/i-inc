// The owner closes a ticket nobody has started: it never runs, shows as Rejected, and frees the queue.
import { describe, expect, it } from "vitest";
import { refunds, testApp } from "./setup.ts";

describe("POST /api/tickets/:id/close", () => {
  it("closes a queued ticket behind a busy employee, so it never runs and the next one does", async () => {
    const app = await testApp();
    app.agent.on(
      { employee: "ada", stage: "build" },
      { kind: "out-of-tokens", resetsAt: app.clock.now() + 3_600_000 },
    );
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    await app.call("POST", "/api/tickets", { ...refunds, title: "Not wanted any more" });
    await app.call("POST", "/api/tickets", { ...refunds, title: "Still wanted" });
    await app.daemon.idle();
    expect((await app.call("GET", "/api/tickets/2")).body.ticket).toMatchObject({
      status: "queued",
      waiting: "Ada is busy",
    });

    const res = await app.call("POST", "/api/tickets/2/close", {});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const closed = (await app.call("GET", "/api/tickets/2")).body.ticket;
    expect(closed).toMatchObject({ column: "done", status: "done", outcome: "rejected", held: false });
    // Closing it a second time is refused: it is no longer a ticket nobody started.
    expect((await app.call("POST", "/api/tickets/2/close", {})).status).toBe(409);

    // Ada's account comes back: she finishes the first ticket and goes on to the third, never the second.
    app.clock.advance(3_600_001);
    await app.daemon.tick();
    await app.daemon.idle();
    const ran = new Set(app.agent.callsFor("ada").map((c) => c.ticket.id));
    expect(ran.has("2")).toBe(false);
    expect(ran.has("3")).toBe(true);
  });

  it("takes a held ticket (a draft, or a follow-up over the day's budget) off hold once it's closed", async () => {
    const app = await testApp();
    app.agent.on(
      { employee: "ada", stage: "build" },
      { kind: "out-of-tokens", resetsAt: app.clock.now() + 3_600_000 },
    );
    await app.call("POST", "/api/tickets", refunds);
    await app.call("POST", "/api/tickets", { ...refunds, title: "A held follow-up" });
    await app.daemon.idle();
    app.deps.tickets.setHold("2", true);

    expect((await app.call("POST", "/api/tickets/2/close", {})).status).toBe(200);
    expect((await app.call("GET", "/api/tickets/2")).body.ticket).toMatchObject({
      status: "done",
      outcome: "rejected",
      held: false,
    });
  });

  it("closes once when two requests for the same ticket arrive together", async () => {
    const app = await testApp();
    app.agent.on(
      { employee: "ada", stage: "build" },
      { kind: "out-of-tokens", resetsAt: app.clock.now() + 3_600_000 },
    );
    await app.call("POST", "/api/tickets", refunds);
    await app.call("POST", "/api/tickets", { ...refunds, title: "Closed twice by a retry" });
    await app.daemon.idle();

    const [a, b] = await Promise.all([
      app.call("POST", "/api/tickets/2/close", {}),
      app.call("POST", "/api/tickets/2/close", {}),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const events = await app.deps.store.read("2");
    expect(events.filter((e) => e.type === "closed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "ticket-created")).toHaveLength(1);
    expect((await app.call("GET", "/api/tickets/2")).body.ticket.held).toBe(false);
  });

  it("refuses a ticket that has started", async () => {
    const app = await testApp();
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    const res = await app.call("POST", "/api/tickets/1/close", {});
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already started");
  });

  it("returns 404 for an unknown ticket", async () => {
    const app = await testApp();
    expect((await app.call("POST", "/api/tickets/99/close", {})).status).toBe(404);
  });
});
