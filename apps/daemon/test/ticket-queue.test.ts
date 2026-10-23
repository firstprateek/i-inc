import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { migrate } from "../src/schema.ts";
import { type NewTicket, Tickets } from "../src/tickets.ts";

const input: NewTicket = {
  title: "Queued fix",
  project: "Duet",
  type: "fix",
  effort: "low",
  doneWhen: [],
  assignee: "ada",
};

describe("durable ticket queues", () => {
  it("appends assignments, preserves repeated assignments and holds, and never reuses positions", async () => {
    const db = await openDb(":memory:");
    try {
      migrate(db);
      const tickets = new Tickets(db);
      tickets.create({ ...input, assignee: undefined }, 0);
      tickets.create(input, 0);
      tickets.assign("1", "ada");
      expect(tickets.get("1")?.queueSequence).toBe(2);
      expect(tickets.get("2")?.queueSequence).toBe(1);
      tickets.assign("1", "ada");
      tickets.setHold("1", true);
      tickets.setHold("1", false);
      expect(tickets.get("1")?.queueSequence).toBe(2);
      tickets.assign("2", "kit", 123);
      expect(tickets.get("2")).toMatchObject({ queueSequence: 3, pickedAt: 123 });
      tickets.assign("2", "");
      expect(tickets.get("2")?.queueSequence).toBeNull();
      tickets.assign("2", "ada");
      expect(tickets.get("2")?.queueSequence).toBe(4);
      expect(tickets.get("2")?.pickedAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it("migrates legacy rows deterministically and preserves the counter across restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ticket-queue-"));
    const path = join(dir, "test.db");
    let db = await openDb(path);
    try {
      db.exec(`CREATE TABLE tickets (
        id TEXT PRIMARY KEY, body TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
        hold INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, picked_at INTEGER
      )`);
      for (const [id, priority, createdAt, assignee] of [
        ["10", 1, 0, "ada"],
        ["2", 1, 0, "ada"],
        ["3", 9, 100, "kit"],
        ["4", 0, 0, ""],
      ] as const) {
        db.run(
          "INSERT INTO tickets VALUES (?, ?, ?, 0, ?, 123)",
          id,
          JSON.stringify({ ...input, id, assignee }),
          priority,
          createdAt,
        );
      }
      db.run("INSERT INTO tickets VALUES ('5', 'broken', 0, 0, 0, NULL)");
      migrate(db);
      const tickets = new Tickets(db);
      expect(["3", "2", "10", "4"].map((id) => tickets.get(id)?.queueSequence)).toEqual([1, 2, 3, null]);
      expect(tickets.get("10")).toMatchObject({ pickedAt: 123, ticket: { title: input.title } });
      tickets.assign("10", "kit");
      db.close();
      db = await openDb(path);
      migrate(db);
      const restarted = new Tickets(db);
      expect(restarted.get("10")?.queueSequence).toBe(4);
      restarted.assign("4", "ada");
      expect(restarted.get("4")?.queueSequence).toBe(5);
      expect(restarted.get("2")?.queueSequence).toBe(2);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
