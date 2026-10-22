// The board opens on a summary and pages (T63): 1,000 tickets must not mean a 600 KB answer per refresh.
import { describe, expect, it } from "vitest";
import { testApp } from "./setup.ts";

async function board(total: number, done: number) {
  const app = await testApp();
  const now = app.clock.now();
  for (let i = 0; i < total; i++) {
    const t = app.deps.tickets.create(
      {
        title: `Ticket ${i + 1}`,
        project: "Duet",
        type: "fix",
        effort: "low",
        doneWhen: ["it works"],
        hold: true,
      },
      now,
    );
    if (i < done) {
      await app.deps.store.append(t.id, [
        { type: "ticket-created", at: now, ticketId: t.id },
        { type: "closed", at: now + i, outcome: "merged" },
      ]);
    }
  }
  return app;
}

describe("GET /api/board/summary", () => {
  it("sends each column's first cards and its total, not every ticket", async () => {
    const app = await board(150, 100);
    const full = await app.call("GET", "/api/board");
    expect(full.body.tickets).toHaveLength(150);
    const { status, body } = await app.call("GET", "/api/board/summary");
    expect(status).toBe(200);
    expect(body.columns.done.total).toBe(100);
    expect(body.columns.todo.total).toBe(50);
    expect(body.columns.done.tickets).toHaveLength(15);
    expect(body.columns.todo.tickets).toHaveLength(40);
    expect(body.columns["in-progress"]).toEqual({ total: 0, tickets: [] });
    // Done is newest first; the rest are as they were filed.
    expect(body.columns.done.tickets[0].id).toBe("100");
    expect(body.columns.todo.tickets[0].id).toBe("101");
    const bytes = JSON.stringify(body).length;
    expect(bytes).toBeLessThan(JSON.stringify(full.body).length / 2);
  });

  it("carries the report of every Done card it sends, so the page makes no request per card", async () => {
    const app = await board(30, 30);
    const { body } = await app.call("GET", "/api/board/summary");
    const ids = body.columns.done.tickets.map((t: { id: string }) => t.id);
    expect(Object.keys(body.reports).sort()).toEqual([...ids].sort());
    expect(body.reports["30"]).toMatchObject({ id: "30", outcome: "Merged" });
  });

  it("honours limit and doneLimit, within bounds", async () => {
    const app = await board(60, 20);
    const { body } = await app.call("GET", "/api/board/summary?limit=5&doneLimit=3");
    expect(body.columns.todo.tickets).toHaveLength(5);
    expect(body.columns.done.tickets).toHaveLength(3);
    const big = await app.call("GET", "/api/board/summary?limit=100000");
    expect(big.body.columns.todo.tickets.length).toBeLessThanOrEqual(100);
  });
});

describe("GET /api/board/column", () => {
  it("pages a column from where the summary stopped", async () => {
    const app = await board(80, 50);
    const first = (await app.call("GET", "/api/board/summary")).body.columns.done.tickets;
    const next = await app.call("GET", "/api/board/column?column=done&offset=15&limit=20");
    expect(next.status).toBe(200);
    expect(next.body.total).toBe(50);
    expect(next.body.tickets).toHaveLength(20);
    expect(next.body.tickets[0].id).toBe(String(Number(first.at(-1).id) - 1));
    expect(Object.keys(next.body.reports)).toHaveLength(20);
    const tail = await app.call("GET", "/api/board/column?column=done&offset=45&limit=20");
    expect(tail.body.tickets).toHaveLength(5);
  });

  it("refuses a column that does not exist", async () => {
    const app = await board(1, 0);
    expect((await app.call("GET", "/api/board/column?column=nope")).status).toBe(400);
  });
});

describe("GET /api/board/cards", () => {
  it("answers a live event with the cards of those tickets alone", async () => {
    const app = await board(100, 10);
    const { status, body } = await app.call("GET", "/api/board/cards?ids=3,50,999");
    expect(status).toBe(200);
    expect(body.tickets.map((t: { id: string }) => t.id).sort()).toEqual(["3", "50"]);
    expect(body.gone).toEqual(["999"]);
    expect(body.reports["3"]).toMatchObject({ outcome: "Merged" });
    expect(body.reports["50"]).toBeUndefined();
    expect(JSON.stringify(body).length).toBeLessThan(5000);
  });
});

describe("GET /api/needs-you", () => {
  it("answers the badge and the page in one request", async () => {
    const app = await testApp();
    const now = app.clock.now();
    const make = (title: string, assignee?: string) =>
      app.deps.tickets.create(
        {
          title,
          project: "Duet",
          type: "fix",
          effort: "low",
          doneWhen: ["x"],
          ...(assignee ? { assignee } : {}),
        },
        now,
      );
    const unassigned = make("Nobody yet");
    make("Quiet", "ada");
    await app.daemon.tick();
    await app.daemon.idle();
    const res = await app.call("GET", "/api/needs-you");
    expect(res.status).toBe(200);
    const ids = res.body.tickets.map((t: { id: string }) => t.id);
    expect(ids).toContain(unassigned.id);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
    expect(res.body.count).toBe(
      res.body.tickets.filter((t: { status: string }) => t.status === "needs-you").length +
        res.body.tickets.filter(
          (t: { status: string; waiting: string | null }) =>
            t.status === "queued" && (t.waiting ?? "").startsWith("unassigned"),
        ).length +
        res.body.policies.length +
        res.body.proposals.length +
        res.body.conversations.length,
    );
    expect(Array.isArray(res.body.policies)).toBe(true);
    expect(Array.isArray(res.body.proposals)).toBe(true);
    expect(Array.isArray(res.body.conversations)).toBe(true);
  });
});
