// Errands and outbound permissions (spec §7, and design case 10, "The PA's morning").
import { describe, expect, it } from "vitest";
import { answer, decideOutbound, fold, type Proposal, runTicket } from "../src/index.ts";
import { json } from "../src/testing/index.ts";
import { pip, ports, refundsTicket } from "./fixtures.ts";

const errand = refundsTicket({
  id: "e7",
  title: "Morning triage",
  project: "Home",
  type: "errand",
  doneWhen: [],
  assignee: "pip",
});

const replyToDentist: Proposal = {
  action: "send-email",
  summary: "Thursday 4 pm works",
  to: ["dentist@example.com"],
};
const holdForTrip: Proposal = { action: "calendar-hold", summary: "Hold 16–19 Dec", invitesOthers: false };
const bookFlight: Proposal = { action: "book", summary: "Book option A" };
const replyToStranger: Proposal = {
  action: "send-email",
  summary: "Re: your invoice",
  to: ["billing@unknown.example"],
};
const deleteSpam: Proposal = { action: "delete-mail", summary: "Delete 14 newsletters" };

const trustingPip = {
  ...pip,
  outbound: {
    "send-email": { mode: "rule" as const, rule: { onlyToContacts: true } },
    "calendar-hold": { mode: "rule" as const, rule: { noInvitees: true } },
    book: { mode: "rule" as const, rule: {} },
    "delete-mail": { mode: "off" as const },
  },
};

describe("outbound permissions", () => {
  const isContact = (a: string) => a === "dentist@example.com";

  it("starts every action as Ask", () => {
    expect(decideOutbound(replyToDentist, {}, isContact)).toBe("ask");
  });

  it("lets a rule send to contacts, and never to anyone else", () => {
    expect(decideOutbound(replyToDentist, trustingPip.outbound, isContact)).toBe("auto");
    expect(decideOutbound(replyToStranger, trustingPip.outbound, isContact)).toBe("ask");
  });

  it("never makes bookings, payments or deletions automatic, whatever the settings", () => {
    expect(decideOutbound(bookFlight, trustingPip.outbound, isContact)).toBe("ask");
    expect(
      decideOutbound({ action: "pay", summary: "x" }, { pay: { mode: "rule", rule: {} } }, isContact),
    ).toBe("ask");
    expect(decideOutbound(deleteSpam, trustingPip.outbound, isContact)).toBe("off");
  });

  it("keeps calendar holds automatic only when nobody else is invited", () => {
    expect(decideOutbound(holdForTrip, trustingPip.outbound, isContact)).toBe("auto");
    expect(decideOutbound({ ...holdForTrip, invitesOthers: true }, trustingPip.outbound, isContact)).toBe(
      "ask",
    );
  });
});

describe("an errand", () => {
  it("runs the short loop on a local engine, carries out what rules allow, and asks about the rest", async () => {
    const p = ports(trustingPip);
    p.company.contacts.push("dentist@example.com");
    p.agent.on(
      { employee: "pip", stage: "work" },
      {
        kind: "done",
        output: json({ proposals: [replyToDentist, holdForTrip, bookFlight, replyToStranger, deleteSpam] }),
      },
    );

    const first = await runTicket(p, errand);
    expect(first).toEqual({
      status: "needs-you",
      ask: { kind: "proposals", items: [bookFlight, replyToStranger] },
    });

    await answer(p, "e7", "approve");
    expect(await runTicket(p, errand)).toEqual({ status: "done", outcome: "done" });

    const events = await p.store.read("e7");
    expect(events.find((e) => e.type === "proposals-decided")).toMatchObject({
      carryOut: [replyToDentist, holdForTrip, bookFlight, replyToStranger],
      declined: [deleteSpam],
    });
    expect(fold(events).finished).toEqual(["pickup", "work", "proposals", "retro"]);
    expect(p.agent.calls.every((c) => c.engine.local)).toBe(true);
  });

  it("declines what the owner rejects", async () => {
    const p = ports();
    p.agent.on(
      { employee: "pip", stage: "work" },
      { kind: "done", output: json({ proposals: [bookFlight] }) },
    );

    await runTicket(p, errand);
    await answer(p, "e7", "reject");
    await runTicket(p, errand);

    const decided = (await p.store.read("e7")).find((e) => e.type === "proposals-decided");
    expect(decided).toMatchObject({ carryOut: [], declined: [bookFlight] });
  });

  it("finishes without the owner when there's nothing to ask", async () => {
    const p = ports();
    expect(await runTicket(p, errand)).toEqual({ status: "done", outcome: "done" });
  });
});
