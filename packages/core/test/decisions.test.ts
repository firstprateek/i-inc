// The owner's decision, follow-ups and the retro (spec §6 stages 10-11; §3 case 5, "Not quite").
import { describe, expect, it } from "vitest";
import { decide, fold, runTicket } from "../src/index.ts";
import { json } from "../src/testing/index.ts";
import { ports, refundsTicket } from "./fixtures.ts";

const ticket = refundsTicket();

describe("the owner's decision", () => {
  it("merges on approve, after a retro by builder and reviewer", async () => {
    const p = ports();
    expect((await runTicket(p, ticket)).status).toBe("ready");

    await decide(p, "42", "approve");
    expect(await runTicket(p, ticket)).toEqual({ status: "done", outcome: "merged" });
    expect(p.agent.calls.filter((c) => c.stage === "retro").map((c) => c.employee.id)).toEqual([
      "ada",
      "grace",
    ]);
  });

  it("sends a follow-up back to Build on the same plan, with the note first", async () => {
    const p = ports();
    await runTicket(p, ticket);
    await decide(p, "42", "changes", "move the button to the toolbar");

    expect((await runTicket(p, ticket)).status).toBe("ready");
    const builds = p.agent.callsFor("ada", "build");
    expect(builds).toHaveLength(2);
    expect(builds[1]?.brief).toContain("The owner asked for changes: move the button to the toolbar");
    expect(p.agent.callsFor("ada", "plan")).toHaveLength(1);
    expect(fold(await p.store.read("42")).ownerNote).toBeNull();
  });

  it("closes as rejected, still with a retro", async () => {
    const p = ports();
    await runTicket(p, ticket);
    await decide(p, "42", "reject");
    expect(await runTicket(p, ticket)).toEqual({ status: "done", outcome: "rejected" });
  });
});

describe("the retro", () => {
  it("applies brain edits and handbook facts at once, and holds policy changes for the owner", async () => {
    const p = ports();
    p.agent.on(
      { employee: "ada", stage: "retro" },
      {
        kind: "done",
        output: json({
          edits: [
            { layer: "fact", page: "tools/vitest.md", text: "Duet's tests need TZ=UTC" },
            { layer: "policy", page: "policies/reviews.md", text: "Reviewers run the app, always" },
            { layer: "brain", page: "patterns/refunds.md", text: "a third edit is dropped" },
          ],
        }),
      },
    );
    await runTicket(p, ticket);
    await decide(p, "42", "approve");
    await runTicket(p, ticket);

    const proposed = (await p.store.read("42")).filter((e) => e.type === "knowledge-proposed");
    expect(proposed[0]).toMatchObject({
      employeeId: "ada",
      apply: [{ layer: "fact", page: "tools/vitest.md" }],
      awaitOwner: [{ layer: "policy", page: "policies/reviews.md" }],
    });
  });

  it("keeps an errand's lessons in the PA's own brain", async () => {
    const p = ports();
    p.agent.on(
      { employee: "pip", stage: "retro" },
      {
        kind: "done",
        output: json({ edits: [{ layer: "fact", page: "home/airlines.md", text: "prefers aisle seats" }] }),
      },
    );
    const errand = refundsTicket({
      id: "e9",
      type: "errand",
      project: "Home",
      assignee: "pip",
      doneWhen: [],
    });
    await runTicket(p, errand);

    const proposed = (await p.store.read("e9")).find((e) => e.type === "knowledge-proposed");
    expect(proposed).toMatchObject({ apply: [{ layer: "brain", page: "home/airlines.md" }], awaitOwner: [] });
  });
});
