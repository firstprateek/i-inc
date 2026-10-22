// T63: whatever is in an event row, replaying it never throws. Every field of every kind of event a
// full run writes is replaced in turn with a value of the wrong type, and the fold, the card, the
// desk, the report and the knowledge log all still produce something.
import { assembleReport, fold, knowledgeLog, type TicketEvent } from "@i-inc/core";
import { describe, expect, it } from "vitest";
import { deskView, liveLine, ticketView } from "../src/views.ts";
import { refunds, testApp } from "./setup.ts";

const wrong: unknown[] = [null, "text", 7, -1, true, [], {}, [1, "x"], { a: 1 }];

/** Copies of `event` with one field at a time (shallow, and one level in) replaced by something of the wrong type. */
function damaged(event: TicketEvent): TicketEvent[] {
  const out: TicketEvent[] = [];
  const record = event as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key === "type") continue;
    for (const w of wrong) {
      out.push({ ...record, [key]: w } as unknown as TicketEvent);
      const inner = record[key];
      const first = Array.isArray(inner) ? inner[0] : inner;
      if (first && typeof first === "object") {
        for (const k of Object.keys(first as object)) {
          for (const w2 of wrong) {
            const patched = { ...(first as object), [k]: w2 };
            out.push({
              ...record,
              [key]: Array.isArray(inner) ? [patched, ...inner.slice(1)] : patched,
            } as unknown as TicketEvent);
          }
        }
      }
    }
  }
  return out;
}

describe("replaying events of the wrong shape", () => {
  it("never throws, whatever field of whatever event is damaged", async () => {
    const app = await testApp();
    app.deps.registry.addProject({ id: "Duet", repo: "o/duet", checks: ["x"], mode: "direct" });
    app.agent.on(
      { stage: "report" },
      {
        kind: "done",
        output: JSON.stringify({
          report: "done",
          followUps: [{ title: "More", doneWhen: ["x"], type: "chore", effort: "low", reason: "r" }],
        }),
      },
    );
    app.agent.on(
      { stage: "retro" },
      {
        kind: "done",
        output: JSON.stringify({ edits: [{ layer: "brain", page: "tools/vitest", text: "t" }] }),
      },
    );
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    const record = app.deps.tickets.get("1");
    if (!record) throw new Error("no ticket");
    const base = await app.deps.store.read("1");
    // One of each type a run writes, plus the ones a run rarely does.
    const kinds = new Map<string, TicketEvent>();
    const rare: TicketEvent[] = [
      { type: "needs-you", at: 1, stage: "plan", ask: { kind: "plan-gate", plan: "p" } },
      { type: "needs-you", at: 1, stage: "gates", ask: { kind: "protected-paths", paths: ["a"] } },
      {
        type: "needs-you",
        at: 1,
        stage: "review",
        ask: { kind: "disagreement", builder: "b", reviewer: "r" },
      },
      { type: "owner-answered", at: 1, answer: "approve", note: "n" },
      { type: "owner-attached", at: 1, attachments: [{ n: 1, name: "a.png", mime: "image/png", size: 3 }] },
      { type: "main-red", at: 1, sha: "a".repeat(40), reason: "r" },
      {
        type: "helper-unavailable",
        at: 1,
        stage: "review",
        duty: "review",
        employeeId: "grace",
        reason: "r",
      },
      { type: "proposals-sorted", at: 1, auto: [], ask: [{ action: "book", summary: "s" }], off: [] },
      { type: "engine-switched", at: 1, stage: "build", from: "opus", to: "gemini", reason: "r" },
      { type: "out-of-tokens", at: 1, stage: "build", engineId: "opus", resetsAt: 5 },
    ];
    for (const e of [...base, ...rare]) if (!kinds.has(e.type)) kinds.set(e.type, e);
    expect(kinds.size).toBeGreaterThan(12);

    let n = 0;
    for (const original of kinds.values()) {
      for (const bad of damaged(original)) {
        n++;
        const events = [...base.filter((e) => e !== original), bad];
        const label = `${original.type} ← ${JSON.stringify(bad).slice(0, 120)}`;
        let state: ReturnType<typeof fold>;
        try {
          state = fold(events);
          liveLine(events, app.deps.registry);
          knowledgeLog("1", events);
          ticketView(record, state, events, app.deps.registry, null);
          deskView(new Map([["1", events]]), app.deps.registry, app.clock.now());
          if (state.status === "ready") assembleReport(record.ticket, state, app.deps.registry);
        } catch (err) {
          throw new Error(`${label}: ${String(err)}`);
        }
      }
    }
    expect(n).toBeGreaterThan(500);
  });
});
