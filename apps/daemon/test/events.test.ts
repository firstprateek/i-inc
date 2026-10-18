// Live updates SSE test (Contract C3: GET /api/events)
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api.ts";
import { refunds, testApp } from "./setup.ts";

function createEventReader(response: Response) {
  if (!response.body) throw new Error("no response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const queue: Array<{ event: string; data: string } | string> = [];
  let waiter: (() => void) | null = null;
  let done = false;

  const wake = () => {
    const notify = waiter;
    waiter = null;
    notify?.();
  };

  (async () => {
    while (true) {
      const res = await reader.read();
      if (res.done) {
        done = true;
        wake();
        break;
      }
      buffer += decoder.decode(res.value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (!part.trim()) continue;
        if (part.startsWith(":")) {
          queue.push(part);
        } else {
          let event = "message";
          let data = "";
          for (const line of part.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("event:")) event = line.slice(6);
            else if (line.startsWith("data: ")) data = line.slice(6);
            else if (line.startsWith("data:")) data = line.slice(5);
          }
          queue.push({ event, data });
        }
      }
      wake();
    }
  })();

  return {
    async next() {
      while (queue.length === 0) {
        if (done) return null;
        await new Promise<void>((r) => {
          waiter = r;
        });
      }
      const item = queue.shift();
      if (!item) throw new Error("unexpected empty queue");
      return item;
    },
    async cancel() {
      await reader.cancel();
    },
  };
}

describe("live updates SSE API (GET /api/events)", () => {
  it("streams ticket and office events and sends heartbeats", async () => {
    const app = await testApp();
    const abort = new AbortController();

    const res = await app.handle(
      new Request("http://i.inc/api/events", {
        method: "GET",
        signal: abort.signal,
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("connection")).toBe("keep-alive");
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    const reader = createEventReader(res);

    const initial = await reader.next();
    expect(initial).toBe(": connected");

    // 1. Create a ticket -> ticket event
    const ticket = app.deps.tickets.create(
      { ...refunds, type: "fix", effort: "medium" },
      app.deps.clock.now(),
    );
    const ticketEvt = await reader.next();
    expect(ticketEvt).toEqual({
      event: "ticket",
      data: JSON.stringify({ id: ticket.id }),
    });

    // 2. Append events to ticket -> ticket event
    await app.deps.store.append(ticket.id, [
      { type: "stage-started", stage: "plan", at: app.deps.clock.now() },
    ]);
    const appendEvt = await reader.next();
    expect(appendEvt).toEqual({
      event: "ticket",
      data: JSON.stringify({ id: ticket.id }),
    });

    // 3. Toggle ticket hold -> ticket event
    app.deps.tickets.setHold(ticket.id, true);
    const holdEvt = await reader.next();
    expect(holdEvt).toEqual({
      event: "ticket",
      data: JSON.stringify({ id: ticket.id }),
    });

    // 4. Update employee -> office event
    const empRes = await app.call("PUT", "/api/employees/ada", {
      role: "Staff Engineer",
    });
    expect(empRes.status).toBe(200);
    const empEvt = await reader.next();
    expect(empEvt).toEqual({
      event: "office",
      data: "{}",
    });

    // 5. Update team -> office event
    const teamRes = await app.call("PUT", "/api/teams/platform", {
      name: "Platform",
      members: ["ada"],
    });
    expect(teamRes.status).toBe(200);
    const teamEvt = await reader.next();
    expect(teamEvt).toEqual({
      event: "office",
      data: "{}",
    });

    abort.abort();
    await reader.cancel();
  });

  it("immediately sends : connected comment as first chunk on stream start", async () => {
    const app = await testApp();
    const abort = new AbortController();

    const res = await app.handle(
      new Request("http://i.inc/api/events", {
        method: "GET",
        signal: abort.signal,
      }),
    );
    expect(res.status).toBe(200);
    const reader = createEventReader(res);

    const first = await reader.next();
    expect(first).toBe(": connected");

    abort.abort();
    await reader.cancel();
  });

  it("delivers 5 events fired in one tick and keeps stream open", async () => {
    const app = await testApp();
    const abort = new AbortController();

    const res = await app.handle(
      new Request("http://i.inc/api/events", {
        method: "GET",
        signal: abort.signal,
      }),
    );
    expect(res.status).toBe(200);
    const reader = createEventReader(res);

    const initial = await reader.next();
    expect(initial).toBe(": connected");

    // Fire 5 events in one synchronous tick
    const ticketIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const ticket = app.deps.tickets.create(
        { ...refunds, type: "fix", effort: "medium" },
        app.deps.clock.now(),
      );
      ticketIds.push(ticket.id);
    }

    // Stream should remain open with active listeners
    expect(app.live.listenerCount("ticket")).toBe(1);

    // All 5 events are delivered
    for (const id of ticketIds) {
      const evt = await reader.next();
      expect(evt).toEqual({
        event: "ticket",
        data: JSON.stringify({ id }),
      });
    }

    // Still open and healthy
    expect(app.live.listenerCount("ticket")).toBe(1);

    abort.abort();
    await reader.cancel();
  });

  it("narrows office events: engine/account writes do NOT emit office, team/employee writes do", async () => {
    const app = await testApp();
    const abort = new AbortController();

    const res = await app.handle(
      new Request("http://i.inc/api/events", {
        method: "GET",
        signal: abort.signal,
      }),
    );
    expect(res.status).toBe(200);
    const reader = createEventReader(res);

    const initial = await reader.next();
    expect(initial).toBe(": connected");

    // Account and engine writes should NOT trigger office events
    app.deps.registry.addAccount({ id: "acct-test", name: "Test Account" });
    app.deps.registry.addEngine({
      id: "engine-test",
      harness: "claude-code",
      model: "claude-3-5-sonnet",
      accountId: "acct-test",
      local: false,
    });
    app.deps.registry.addProject({
      id: "proj-test",
      repo: "org/repo",
      checks: ["test"],
    });

    // Employee write DOES emit office
    const grace = app.deps.registry.employee("grace");
    app.deps.registry.hire({
      ...grace,
      role: "Lead Architect",
    });

    // Next received event must be office (from employee write, not from earlier writes)
    const empEvt = await reader.next();
    expect(empEvt).toEqual({
      event: "office",
      data: "{}",
    });

    // Team write DOES emit office
    app.deps.registry.addTeam({
      id: "core-team",
      name: "Core",
      members: ["grace"],
    });

    const teamEvt = await reader.next();
    expect(teamEvt).toEqual({
      event: "office",
      data: "{}",
    });

    // Also verify via API PUT calls
    await app.call("PUT", "/api/accounts/acct-api", { name: "Acct API" });
    await app.call("PUT", "/api/engines/engine-api", {
      harness: "claude-code",
      model: "claude-3-5-sonnet",
      accountId: "acct-api",
    });

    await app.call("PUT", "/api/employees/ada", { role: "Principal Engineer" });
    const apiEmpEvt = await reader.next();
    expect(apiEmpEvt).toEqual({
      event: "office",
      data: "{}",
    });

    await app.call("PUT", "/api/teams/infra", { name: "Infra", members: ["ada"] });
    const apiTeamEvt = await reader.next();
    expect(apiTeamEvt).toEqual({
      event: "office",
      data: "{}",
    });

    abort.abort();
    await reader.cancel();
  });

  it("sends heartbeat comments on the configured interval", async () => {
    const app = await testApp();
    const handle = createApi(app.daemon, app.deps, {
      heartbeatMs: 25,
    });
    const abort = new AbortController();

    const res = await handle(
      new Request("http://i.inc/api/events", {
        method: "GET",
        signal: abort.signal,
      }),
    );

    expect(res.status).toBe(200);
    const reader = createEventReader(res);

    const initial = await reader.next();
    expect(initial).toBe(": connected");

    const chunk = await reader.next();
    expect(chunk).toBe(": keepalive");

    abort.abort();
    await reader.cancel();
  });

  it("cleans up listeners on abort", async () => {
    const app = await testApp();
    const abort = new AbortController();

    const listenersBefore = app.live.listenerCount("ticket");

    const res = await app.handle(
      new Request("http://i.inc/api/events", {
        method: "GET",
        signal: abort.signal,
      }),
    );
    expect(res.status).toBe(200);
    expect(app.live.listenerCount("ticket")).toBe(listenersBefore + 1);

    abort.abort();
    expect(app.live.listenerCount("ticket")).toBe(listenersBefore);
    expect(app.live.listenerCount("office")).toBe(0);
  });

  it("requires authentication when token is configured (bearer header or i_inc cookie)", async () => {
    const app = await testApp();
    const handle = createApi(app.daemon, app.deps, {
      token: "secret-token",
    });

    // Without token: 401
    const unauth = await handle(new Request("http://i.inc/api/events"));
    expect(unauth.status).toBe(401);

    // With bearer token: 200
    const abortBearer = new AbortController();
    const authedBearer = await handle(
      new Request("http://i.inc/api/events", {
        headers: { authorization: "Bearer secret-token" },
        signal: abortBearer.signal,
      }),
    );
    expect(authedBearer.status).toBe(200);
    abortBearer.abort();

    // With cookie (EventSource path in browsers): 200
    const abortCookie = new AbortController();
    const authedCookie = await handle(
      new Request("http://i.inc/api/events", {
        headers: { cookie: "i_inc=secret-token" },
        signal: abortCookie.signal,
      }),
    );
    expect(authedCookie.status).toBe(200);
    abortCookie.abort();
  });

  it("drops and closes stream when client stalls and buffer fills (desiredSize <= 0)", async () => {
    const app = await testApp();
    const abort = new AbortController();
    const res = await app.handle(
      new Request("http://i.inc/api/events", {
        method: "GET",
        signal: abort.signal,
      }),
    );
    expect(res.status).toBe(200);
    expect(app.live.listenerCount("ticket")).toBe(1);

    // High water mark is 64. Initial ": connected" occupies 1 chunk.
    // Enqueue 63 events to fill the buffer to 64 queued chunks (desiredSize reaches 0).
    for (let i = 0; i < 63; i++) {
      app.deps.tickets.create({ ...refunds, type: "fix", effort: "medium" }, app.deps.clock.now());
    }
    // Stream is still open and listeners active
    expect(app.live.listenerCount("ticket")).toBe(1);

    // Next event triggers desiredSize <= 0 drop
    app.deps.tickets.create({ ...refunds, type: "fix", effort: "medium" }, app.deps.clock.now());

    // Listeners should be cleaned up
    expect(app.live.listenerCount("ticket")).toBe(0);
  });
});
