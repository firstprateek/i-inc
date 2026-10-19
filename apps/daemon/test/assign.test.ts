// C17: the owner assigns a ticket that has not started, and the board says why it waits.
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api.ts";
import { refunds, testApp } from "./setup.ts";

const unassigned = { ...refunds, title: "Dark mode for the budget page", assignee: undefined };

describe("POST /api/tickets/:id/assign", () => {
  it("leaves an unassigned ticket waiting, says why, and starts it once assigned", async () => {
    const app = await testApp();
    const filed = await app.call("POST", "/api/tickets", unassigned);
    expect(filed.status).toBe(201);
    await app.daemon.idle();

    const before = (await app.call("GET", "/api/tickets/1")).body.ticket;
    expect(before).toMatchObject({
      status: "queued",
      assignee: null,
      waiting: "unassigned, and no standing order covers it",
    });
    const onBoard = (await app.call("GET", "/api/board")).body.tickets;
    expect(onBoard[0].waiting).toBe("unassigned, and no standing order covers it");

    const res = await app.call("POST", "/api/tickets/1/assign", { to: "ada" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    await app.daemon.idle();

    const after = (await app.call("GET", "/api/tickets/1")).body.ticket;
    expect(after.assignee).toMatchObject({ id: "ada", name: "Ada" });
    expect(after.status).not.toBe("queued");
    expect(after.waiting).toBeNull();
    expect(app.deps.tickets.get("1")?.ticket.assignee).toBe("ada");
  });

  it("returns 404 for an unknown ticket", async () => {
    const app = await testApp();
    const res = await app.call("POST", "/api/tickets/99/assign", { to: "ada" });
    expect(res.status).toBe(404);
  });

  it("returns 400 for an unknown or missing employee, and changes nothing", async () => {
    const app = await testApp();
    await app.call("POST", "/api/tickets", unassigned);
    expect((await app.call("POST", "/api/tickets/1/assign", { to: "nobody" })).status).toBe(400);
    expect((await app.call("POST", "/api/tickets/1/assign", {})).status).toBe(400);
    expect(app.deps.tickets.get("1")?.ticket.assignee).toBe("");
  });

  it("returns 409 when the employee doesn't work on the ticket's project", async () => {
    const app = await testApp();
    app.deps.registry.hire({ ...app.deps.registry.employee("kit"), projects: ["listy"] });
    await app.call("POST", "/api/tickets", unassigned);
    const res = await app.call("POST", "/api/tickets/1/assign", { to: "kit" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Kit doesn't work on Duet");
    expect(app.deps.tickets.get("1")?.ticket.assignee).toBe("");
    // An employee whose projects list includes it is fine.
    app.deps.registry.hire({ ...app.deps.registry.employee("kit"), projects: ["Duet"] });
    expect((await app.call("POST", "/api/tickets/1/assign", { to: "kit" })).status).toBe(200);
  });

  it("returns 409 for a ticket that already started", async () => {
    const app = await testApp();
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    const res = await app.call("POST", "/api/tickets/1/assign", { to: "kit" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("ticket 1 already started — use handoff");
    expect(app.deps.tickets.get("1")?.ticket.assignee).toBe("ada");
  });

  it("leaves a hold alone: an assigned ticket on hold still waits", async () => {
    const app = await testApp();
    await app.call("POST", "/api/tickets", { ...unassigned, hold: true });
    expect((await app.call("POST", "/api/tickets/1/assign", { to: "ada" })).status).toBe(200);
    await app.daemon.idle();
    const t = (await app.call("GET", "/api/tickets/1")).body.ticket;
    expect(t).toMatchObject({ status: "queued", held: true });
  });

  it("is refused without the token, and for a cross-site or non-JSON write", async () => {
    const app = await testApp();
    await app.call("POST", "/api/tickets", unassigned);
    const guarded = createApi(app.daemon, app.deps, { token: "s3cret", hosts: ["i.inc"] });
    const post = (headers: Record<string, string>, body = '{"to":"ada"}') =>
      guarded(
        new Request("http://i.inc/api/tickets/1/assign", {
          method: "POST",
          body,
          headers: { host: "i.inc", ...headers },
        }),
      );
    expect((await post({ "content-type": "application/json" })).status).toBe(401);
    const auth = { authorization: "Bearer s3cret" };
    expect(
      (await post({ ...auth, "content-type": "application/json", origin: "http://evil.example" })).status,
    ).toBe(403);
    expect((await post({ ...auth, "content-type": "text/plain" })).status).toBe(415);
    expect(app.deps.tickets.get("1")?.ticket.assignee).toBe("");
    expect((await post({ ...auth, "content-type": "application/json" })).status).toBe(200);
    expect(app.deps.tickets.get("1")?.ticket.assignee).toBe("ada");
  });
});

describe("handing off a ticket that has not started", () => {
  it("assigns it, the way the scheduler reads it", async () => {
    const app = await testApp();
    await app.call("POST", "/api/tickets", unassigned);
    expect((await app.call("POST", "/api/tickets/1/handoff", { to: "kit" })).status).toBe(200);
    await app.daemon.idle();
    const t = (await app.call("GET", "/api/tickets/1")).body.ticket;
    expect(t.assignee).toMatchObject({ id: "kit" });
    expect(t.status).not.toBe("queued");
  });
});

describe("why a ticket is waiting", () => {
  it("sends when a blocked account resets", async () => {
    const app = await testApp();
    const until = app.clock.now() + 2 * 3_600_000;
    app.deps.registry.setAccountRateLimit("claude-pro", {
      status: "rejected",
      resetsAt: until,
      updatedAt: app.clock.now(),
    });
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    const t = (await app.call("GET", "/api/tickets/1")).body.ticket;
    expect(t.status).toBe("queued");
    expect(t.waiting).toMatch(/usage cap/);
    expect(t.waitingUntil).toBe(until);
  });

  it("doesn't send waitingUntil for a reason that isn't about a reset", async () => {
    const app = await testApp();
    await app.call("POST", "/api/tickets", unassigned);
    await app.daemon.idle();
    const t = (await app.call("GET", "/api/tickets/1")).body.ticket;
    expect(t).not.toHaveProperty("waitingUntil");
  });
});
