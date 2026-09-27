// Brains and the handbook (spec §5, "The brain"): where proposed edits land, and which wait.
import { describe, expect, it } from "vitest";
import { type KnowledgeEdit, knowledgeLog, pagePath, runTicket, type TicketEvent } from "../src/index.ts";
import { ports } from "./fixtures.ts";

const brain = (page: string): KnowledgeEdit => ({ layer: "brain", page, text: "x" });

describe("page names", () => {
  it("files brain pages under the wiki's folders, and handbook pages under facts and policies", () => {
    expect(pagePath(brain("tools/Vitest Mocks"))).toBe("tools/vitest-mocks.md");
    expect(pagePath(brain("personality"))).toBe("personality.md");
    expect(pagePath({ layer: "fact", page: "gh-cli", text: "x" })).toBe("facts/gh-cli.md");
    expect(pagePath({ layer: "fact", page: "facts/gh-cli.md", text: "x" })).toBe("facts/gh-cli.md");
    expect(pagePath({ layer: "policy", page: "merging", text: "x" })).toBe("policies/merging.md");
  });

  it("refuses anything that could escape the repo or land somewhere unexpected", () => {
    for (const page of ["../../etc/passwd", "/abs", "tools/../x", "secrets/key", "tools/a/b", "INDEX", ""]) {
      expect(pagePath(brain(page))).toBeNull();
    }
    expect(pagePath({ layer: "fact", page: "policies/merging", text: "x" })).toBeNull();
  });
});

describe("the knowledge log", () => {
  const events: TicketEvent[] = [
    { type: "ticket-created", at: 0, ticketId: "9" },
    {
      type: "knowledge-proposed",
      at: 1,
      employeeId: "ada",
      apply: [brain("duties/review"), { layer: "fact", page: "../x", text: "sneaky" }],
      awaitOwner: [
        { layer: "policy", page: "merging", text: "Squash always." },
        { layer: "policy", page: "reviews", text: "Two reviewers for schema changes." },
      ],
    },
    { type: "policy-decided", at: 2, editId: "9:1:p0", approved: true },
  ];

  it("applies brain edits and facts at once, and policies once the owner approves", () => {
    const log = knowledgeLog("9", events);
    expect(log.due.map((e) => e.id)).toEqual(["9:1:a0", "9:1:p0"]);
    expect(log.awaiting.map((e) => e.edit.page)).toEqual(["reviews"]);
    expect(log.refused.map((e) => e.edit.text)).toEqual(["sneaky"]);
  });

  it("drops a declined policy", () => {
    const declined: TicketEvent[] = [
      ...events,
      { type: "policy-decided", at: 3, editId: "9:1:p1", approved: false },
    ];
    expect(knowledgeLog("9", declined).awaiting).toEqual([]);
  });
});

describe("orientation", () => {
  it("is a new hire's first ticket: it reads, proposes brain pages, and closes", async () => {
    const p = ports();
    const result = await runTicket(p, {
      id: "o1",
      title: "Orientation",
      project: "Duet",
      type: "orientation",
      effort: "low",
      doneWhen: [],
      assignee: "kit",
    });
    expect(result).toEqual({ status: "done", outcome: "done" });
    const log = knowledgeLog("o1", await p.store.read("o1"));
    expect(log.due.map((e) => [e.author, e.edit.layer, e.edit.page])).toEqual([
      ["kit", "brain", "projects/duet"],
    ]);
    expect(p.agent.callsFor("kit", "orient")[0]?.brief).toContain("CLAUDE.md");
  });
});
