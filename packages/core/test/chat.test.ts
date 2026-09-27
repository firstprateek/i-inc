// Chat (spec §10, and design case 9, "A word with Kit").
import { describe, expect, it } from "vitest";
import { handleMessage, runTicket } from "../src/index.ts";
import { FakeChat, FakeHelper } from "../src/testing/index.ts";
import { engines, kit, pip, ports, refundsTicket } from "./fixtures.ts";

const engine = (id: string) => {
  const e = engines.find((x) => x.id === id);
  if (!e) throw new Error(`no engine ${id}`);
  return e;
};
const csv = refundsTicket({
  id: "18",
  title: "CSV import",
  project: "fintrack",
  type: "feat",
  assignee: "kit",
});

describe("a chat message", () => {
  it("answers a question in a short session, from the employee's notes", async () => {
    const chat = new FakeChat();
    chat.outcomes.push({ kind: "done", output: "All the sample files were US format." });
    const out = await handleMessage(
      "Why do you parse dates as US format?",
      {
        employee: kit,
        engine: engine("sonnet"),
        current: csv,
        notes: "plan: parse MM/DD",
        defaultProject: "Duet",
      },
      new FakeHelper(),
      chat,
    );
    expect(out).toEqual({ kind: "answer", text: "All the sample files were US format." });
    expect(chat.briefs[0]).toContain("You are working on #18 CSV import (fintrack).");
    expect(chat.briefs[0]).toContain("plan: parse MM/DD");
    expect(chat.briefs[0]).toContain("Don't start any work.");
  });

  it("turns an ask for new work into a draft ticket for the owner to confirm", async () => {
    const out = await handleMessage(
      "Also accept ISO dates.",
      { employee: kit, engine: engine("sonnet"), current: csv, notes: "", defaultProject: "Duet" },
      new FakeHelper(),
      new FakeChat(),
    );
    expect(out).toEqual({
      kind: "draft",
      ticket: {
        title: "Also accept ISO dates",
        project: "fintrack",
        type: "feat",
        effort: "medium",
        doneWhen: [],
        assignee: "kit",
      },
    });
  });

  it("files a PA's ask as an errand straight away", async () => {
    const out = await handleMessage(
      "Find me flights to Bengaluru in December",
      { employee: pip, engine: engine("qwen"), current: null, notes: "", defaultProject: "Duet" },
      new FakeHelper(),
      new FakeChat(),
    );
    expect(out).toMatchObject({
      kind: "errand",
      ticket: { project: "Home", type: "errand", assignee: "pip" },
    });
  });

  it("keeps a note about the work in progress for the next stage boundary", async () => {
    const out = await handleMessage(
      "Keep it behind a flag for now",
      { employee: kit, engine: engine("sonnet"), current: csv, notes: "", defaultProject: "Duet" },
      new FakeHelper(),
      new FakeChat(),
    );
    expect(out).toEqual({ kind: "note", ticketId: "18" });
  });

  it("says so when the employee's engine is out of tokens", async () => {
    const chat = new FakeChat();
    chat.outcomes.push({ kind: "out-of-tokens", resetsAt: Date.UTC(2026, 8, 27, 15, 40) });
    const out = await handleMessage(
      "How is it going?",
      { employee: kit, engine: engine("sonnet"), current: null, notes: "", defaultProject: "Duet" },
      new FakeHelper(),
      chat,
    );
    expect(out).toMatchObject({ kind: "unavailable" });
  });
});

describe("a message mid-ticket", () => {
  it("reaches the employee at the next stage boundary, not before", async () => {
    const p = ports();
    p.agent.on(
      { employee: "ada", stage: "build" },
      { kind: "out-of-tokens", resetsAt: p.clock.now() + 60 * 60_000 },
    );
    await runTicket(p, refundsTicket());
    p.clock.advance(1);
    await p.store.append("42", [{ type: "owner-message", at: p.clock.now(), text: "keep it behind a flag" }]);
    p.clock.advance(60);
    await runTicket(p, refundsTicket());

    expect(p.agent.callsFor("ada", "build")[1]?.brief).not.toContain("keep it behind a flag");
    expect(p.agent.callsFor("ada", "checks")).toHaveLength(0);
    expect(p.agent.callsFor("ada", "report")[0]?.brief).toContain(
      "Messages from the owner:\n- keep it behind a flag",
    );
  });
});
