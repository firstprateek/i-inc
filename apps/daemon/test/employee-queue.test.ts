import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { refunds, testApp } from "./setup.ts";

describe("employee queue", () => {
  it("shows execution order, moves held work durably, and drains the override after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "employee-queue-"));
    const path = join(dir, "test.db");
    const app = await testApp(path);
    let restarted: Awaited<ReturnType<typeof testApp>> | undefined;
    try {
      app.agent.on(
        { employee: "ada", stage: "build" },
        {
          kind: "out-of-tokens",
          resetsAt: app.clock.now() + 3_600_000,
        },
      );
      await app.call("POST", "/api/tickets", refunds);
      await app.daemon.idle();
      for (const [title, priority, hold] of [
        ["First", 0, false],
        ["Held", 50, true],
        ["Urgent", 100, false],
      ] as const) {
        await app.call("POST", "/api/tickets", { ...refunds, title, priority, hold });
      }
      await app.call("POST", "/api/tickets", { ...refunds, assignee: "kit", hold: true });
      const queue = () => app.call("GET", "/api/employees/ada/queue");
      expect((await queue()).body.tickets).toEqual([
        { id: "2", title: "First", project: "Duet", held: false },
        { id: "3", title: "Held", project: "Duet", held: true },
        { id: "4", title: "Urgent", project: "Duet", held: false },
      ]);
      const activeSequence = app.deps.tickets.get("1")?.queueSequence;
      expect(
        (
          await app.call("PUT", "/api/employees/ada/queue", {
            ticketId: "4",
            before: "2",
            expected: ["2", "3", "4"],
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await app.call("PUT", "/api/employees/ada/queue", {
            ticketId: "3",
            before: "4",
            expected: ["4", "2", "3"],
          })
        ).status,
      ).toBe(200);
      expect((await queue()).body.tickets.map((t: { id: string }) => t.id)).toEqual(["3", "4", "2"]);
      expect(app.deps.tickets.get("1")?.queueSequence).toBe(activeSequence);
      expect((await app.daemon.state("1")).status).toBe("paused");
      expect(app.agent.callsFor("ada", "plan").map((c) => c.ticket.id)).toEqual(["1"]);
      app.db.close();
      restarted = await testApp(path);
      expect(
        (await restarted.call("GET", "/api/employees/ada/queue")).body.tickets.map(
          (t: { id: string }) => t.id,
        ),
      ).toEqual(["3", "4", "2"]);
      restarted.clock.advance(61);
      await restarted.daemon.tick();
      await restarted.daemon.idle();
      expect(restarted.agent.callsFor("ada", "plan").map((c) => c.ticket.id)).toEqual(["4", "2"]);
      expect((await restarted.call("GET", "/api/employees/ada/queue")).body.tickets).toEqual([
        { id: "3", title: "Held", project: "Duet", held: true },
      ]);
      restarted.deps.tickets.setHold("3", false);
      await restarted.daemon.tick();
      await restarted.daemon.idle();
      expect(restarted.agent.callsFor("ada", "plan").map((c) => c.ticket.id)).toEqual(["4", "2", "3"]);
    } finally {
      (restarted ?? app).db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects stale orders, started/foreign tickets, malformed moves and unknown employees", async () => {
    const app = await testApp();
    try {
      for (let i = 0; i < 3; i++)
        app.deps.tickets.create({ ...refunds, type: "fix", effort: "medium", hold: true }, 0);
      app.deps.tickets.create({ ...refunds, type: "fix", effort: "medium", assignee: "kit", hold: true }, 0);
      const move = (body: unknown) => app.call("PUT", "/api/employees/ada/queue", body);
      for (const body of [
        null,
        {},
        { ticketId: 1, before: null, expected: [] },
        { ticketId: "1", before: null, expected: [1] },
      ]) {
        expect((await move(body)).status).toBe(400);
      }
      for (const [ticketId, before, expected] of [
        ["4", "1", ["1", "2", "3"]],
        ["1", "4", ["1", "2", "3"]],
        ["1", null, ["1", "2"]],
        ["1", null, ["1", "1", "3"]],
      ])
        expect((await move({ ticketId, before, expected })).status).toBe(409);
      expect((await move({ ticketId: "1", before: null, expected: ["1", "2", "3"] })).status).toBe(200);
      expect((await move({ ticketId: "2", before: null, expected: ["1", "2", "3"] })).status).toBe(409);
      // A ticket started after the owner read the queue must not be moved, even if it is held now.
      await app.deps.store.append("2", [{ type: "ticket-created", ticketId: "2", at: 0 }]);
      expect((await move({ ticketId: "2", before: null, expected: ["2", "3", "1"] })).status).toBe(409);
      expect(app.deps.tickets.queue("ada").map((r) => r.ticket.id)).toEqual(["3", "1"]);
      expect((await app.call("GET", "/api/employees/missing/queue")).status).toBe(404);
      expect((await app.call("PUT", "/api/employees/missing/queue", {})).status).toBe(404);
    } finally {
      app.db.close();
    }
  });
});
