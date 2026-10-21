// Brains and the handbook (spec §5, "The brain"): where proposed edits land, and which wait.
import { describe, expect, it } from "vitest";
import {
  type KnowledgeEdit,
  knowledgeLog,
  mayRead,
  pagePath,
  parseScope,
  pathOfSlug,
  readableScopes,
  runTicket,
  scopeKind,
  scopeOfPath,
  type TicketEvent,
} from "../src/index.ts";
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

describe("handbook sections", () => {
  it("files handbook facts under facts, projects and a team's section", () => {
    const fact = (page: string): KnowledgeEdit => ({ layer: "fact", page, text: "x" });
    expect(pagePath(fact("projects/Duet"))).toBe("projects/duet.md");
    expect(pagePath(fact("teams/engineering/Release Notes"))).toBe("teams/engineering/release-notes.md");
    expect(pagePath(fact("facts/gh-cli"))).toBe("facts/gh-cli.md");
    for (const page of [
      "teams/engineering",
      "teams/../x/y",
      "teams/a/b/c",
      "teams//x",
      "projects/a/b",
      "policies/merging",
      "projects/../x",
      "teams/Bad_Id/x",
    ]) {
      expect(pagePath(fact(page))).toBeNull();
    }
    // Policies stay in policies/, and a team can't be reached through them.
    expect(pagePath({ layer: "policy", page: "teams/eng/x", text: "x" })).toBeNull();
    expect(pagePath({ layer: "policy", page: "policies/merging", text: "x" })).toBe("policies/merging.md");
  });
});

describe("scopes", () => {
  const teams = [
    { id: "engineering", members: ["ada", "kit"] },
    { id: "home", members: ["pia"] },
  ];

  it("lets an employee read their own brain, their teams' sections and the company, nearest first", () => {
    expect(readableScopes({ id: "ada" }, teams)).toEqual(["brain:ada", "team:engineering", "company"]);
    expect(readableScopes({ id: "nobody" }, teams)).toEqual(["brain:nobody", "company"]);
    expect(readableScopes({ id: "ada" }, [])).toEqual(["brain:ada", "company"]);
  });

  it("never lets anyone read another employee's brain, so a PA's home data stays with the PA", () => {
    for (const other of ["ada", "kit", "nobody"]) {
      expect(mayRead({ id: other }, "brain:pia", teams)).toBe(false);
      expect(readableScopes({ id: other }, teams)).not.toContain("brain:pia");
    }
    expect(mayRead({ id: "pia" }, "brain:pia", teams)).toBe(true);
    expect(mayRead({ id: "ada" }, "team:home", teams)).toBe(false);
    expect(mayRead({ id: "pia" }, "company", teams)).toBe(true);
  });

  it("parses scope names and refuses malformed ones", () => {
    expect(parseScope("company")).toEqual({ kind: "company" });
    expect(parseScope("team:engineering")).toEqual({ kind: "team", id: "engineering" });
    expect(parseScope("brain:ada")).toEqual({ kind: "brain", id: "ada" });
    for (const bad of ["", "team:", "team:../x", "brain:A b", "other:x", "company:x"]) {
      expect(parseScope(bad)).toBeNull();
    }
    expect(scopeKind("team:engineering")).toBe("team");
  });

  it("maps files to scopes and slugs, and back", () => {
    const hb = { kind: "handbook" } as const;
    const br = { kind: "brain", id: "ada" } as const;
    expect(scopeOfPath(hb, "facts/gh-cli.md")).toEqual({ scope: "company", slug: "facts/gh-cli" });
    expect(scopeOfPath(hb, "projects/duet.md")).toEqual({ scope: "company", slug: "projects/duet" });
    expect(scopeOfPath(hb, "teams/engineering/release.md")).toEqual({
      scope: "team:engineering",
      slug: "release",
    });
    expect(scopeOfPath(br, "tools/vitest.md")).toEqual({ scope: "brain:ada", slug: "tools/vitest" });
    expect(scopeOfPath(br, "personality.md")).toEqual({ scope: "brain:ada", slug: "personality" });
    for (const [repo, path] of [
      [hb, "INDEX.md"],
      [br, "INDEX.md"],
      [hb, "teams/x.md"],
      [hb, "facts/.hidden.md"],
      [hb, "notes.txt"],
    ] as const) {
      expect(scopeOfPath(repo, path)).toBeNull();
    }
    expect(pathOfSlug("team:engineering", "release")).toBe("teams/engineering/release.md");
    expect(pathOfSlug("company", "facts/gh-cli")).toBe("facts/gh-cli.md");
  });
});
