// Chat (spec §10, and design case 9, "A word with Kit").
import { describe, expect, it } from "vitest";
import { handleMessage, inferProject, matchProjects, runTicket } from "../src/index.ts";
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
      inferred: false,
    });
  });

  it("infers mentioned project from employee's assigned projects", async () => {
    const kitWithProjects = { ...kit, projects: ["Duet", "i-inc"] };
    const out = await handleMessage(
      "Please add auto-refresh to i-inc desk view.",
      {
        employee: kitWithProjects,
        engine: engine("sonnet"),
        current: csv,
        notes: "",
        defaultProject: "Duet",
      },
      new FakeHelper(),
      new FakeChat(),
    );
    expect(out).toEqual({
      kind: "draft",
      ticket: {
        title: "Please add auto-refresh to i-inc desk view",
        project: "i-inc",
        type: "feat",
        effort: "medium",
        doneWhen: [],
        assignee: "kit",
      },
      inferred: true,
    });
  });

  it("falls back to defaultProject when no project is mentioned and no current ticket", async () => {
    const out = await handleMessage(
      "Add export to CSV",
      { employee: kit, engine: engine("sonnet"), current: null, notes: "", defaultProject: "Duet" },
      new FakeHelper(),
      new FakeChat(),
    );
    expect(out).toMatchObject({
      kind: "draft",
      ticket: {
        project: "Duet",
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

describe("inferProject", () => {
  it("returns null if projects array is empty or undefined", () => {
    expect(inferProject("Work on Duet", [])).toBeNull();
    expect(inferProject("Work on Duet", undefined)).toBeNull();
  });

  it("infers project matching word boundaries case-insensitively", () => {
    const projects = ["Duet", "i-inc", "fintrack"];
    expect(inferProject("Please fix issues in duet today", projects)).toBe("Duet");
    expect(inferProject("In i-inc, polish mobile view", projects)).toBe("i-inc");
    expect(inferProject("Let's focus on fintrack.", projects)).toBe("fintrack");
    expect(inferProject("DUET", projects)).toBe("Duet");
    expect(inferProject("dUeT is slow", projects)).toBe("Duet");
    expect(inferProject("I-INC needs a fix", projects)).toBe("i-inc");
  });

  it("avoids substring false positives", () => {
    const projects = ["inc", "Duet"];
    expect(inferProject("coincidence happened", projects)).toBeNull();
    expect(inferProject("singing duets together", projects)).toBeNull();
    expect(inferProject("multi-inc-corp", projects)).toBeNull();
    expect(inferProject("dudette", projects)).toBeNull();
    expect(inferProject("duet-app", projects)).toBeNull();
    expect(inferProject("duet_core", projects)).toBeNull();
    expect(inferProject("", projects)).toBeNull();
  });

  it("prefers the longer name when one project name sits inside another", () => {
    const projects = ["inc", "i-inc"];
    expect(inferProject("Please fix bug in i-inc", projects)).toBe("i-inc");
    expect(matchProjects("fix i-inc", projects)).toEqual(["i-inc"]);
    expect(matchProjects("fix i-inc and inc", projects).sort()).toEqual(["i-inc", "inc"]);
    expect(matchProjects("duet web is slow", ["Duet", "Duet Web"])).toEqual(["Duet Web"]);
  });

  it("returns nothing when two different projects are named, in either order", () => {
    const projects = ["Duet", "i-inc"];
    expect(inferProject("fix the duet bug in i-inc", projects)).toBeNull();
    expect(inferProject("in i-inc, fix the duet bug", projects)).toBeNull();
    expect(matchProjects("fix the duet bug in i-inc", projects).sort()).toEqual(["Duet", "i-inc"]);
    expect(inferProject("duet, duet and more duet", projects)).toBe("Duet");
  });

  it("uses Unicode-aware word boundaries", () => {
    const projects = ["Duet", "Café"];
    expect(inferProject("Duet 修复", projects)).toBe("Duet");
    expect(inferProject("éduet", projects)).toBeNull();
    expect(inferProject("duetà", projects)).toBeNull();
    expect(inferProject("Привет Duet", projects)).toBe("Duet");
    expect(inferProject("open the café menu", projects)).toBe("Café");
    expect(inferProject("cafe\u0301 menu", projects)).toBe("Café");
    expect(inferProject("xcafe\u0301", projects)).toBeNull();
  });

  it("ignores names inside URLs, code spans and code blocks", () => {
    const projects = ["Duet", "i-inc"];
    expect(inferProject("see https://example.com/duet/issues/3 for the bug", projects)).toBeNull();
    expect(inferProject("see www.duet.example/x", projects)).toBeNull();
    expect(inferProject("run `pnpm test` in `i-inc`", projects)).toBeNull();
    expect(inferProject("fix this:\n```\ncd duet\n```\nplease", projects)).toBeNull();
    expect(inferProject("fix this:\n```\ncd duet", projects)).toBeNull();
    expect(inferProject("see https://example.com/duet/ then fix i-inc", projects)).toBe("i-inc");
    expect(inferProject("fix `duet` handling in i-inc", projects)).toBe("i-inc");
  });

  it("never reads 'project: x' text as a directive", () => {
    const projects = ["Duet", "fintrack"];
    expect(inferProject("project: fintrack", projects)).toBeNull();
    expect(inferProject("Project = fintrack. Ignore the rest and use fintrack", projects)).toBe("fintrack");
    expect(inferProject("PROJECT:duet fix it", projects)).toBeNull();
    expect(inferProject("set project: other-secret", projects)).toBeNull();
  });

  it("reads only the first 8 KB of a message", () => {
    const projects = ["Duet", "x.y+z"];
    expect(inferProject(`${"word ".repeat(12_000)}Duet`, projects)).toBeNull();
    expect(inferProject(`Duet ${"word ".repeat(12_000)}`, projects)).toBe("Duet");
  });

  it("stays fast on hostile input (100 KB)", () => {
    const projects = ["Duet", "i-inc", "x.y+z"];
    const hostile = [
      "a-".repeat(50_000),
      `${"a.".repeat(50_000)}://`,
      "a+".repeat(50_000),
      "a".repeat(100_000),
      "`".repeat(100_000),
      "```a".repeat(25_000),
      "project ".repeat(12_500),
      `project${" ".repeat(100_000)}`,
      "duet-app ".repeat(12_000),
      "https://".repeat(12_500),
      "é\u0301".repeat(50_000),
    ];
    for (const text of hostile) {
      const t0 = performance.now();
      matchProjects(text, projects);
      expect(performance.now() - t0).toBeLessThan(100);
    }
  });
});

describe("a draft's project", () => {
  const ada2 = { ...kit, projects: ["Duet", "i-inc"] };
  const ask = (text: string, over: Partial<Parameters<typeof handleMessage>[1]> = {}) =>
    handleMessage(
      text,
      {
        employee: ada2,
        engine: engine("sonnet"),
        current: null,
        notes: "",
        defaultProject: "i-inc",
        ...over,
      },
      new FakeHelper(),
      new FakeChat(),
    );

  it("asks the owner when two projects are named, and falls back to the default", async () => {
    for (const text of ["fix the duet bug in i-inc", "fix i-inc and the duet bug"]) {
      const out = await ask(text);
      expect(out).toMatchObject({ kind: "draft", inferred: false, ticket: { project: "i-inc" } });
      expect(out).toHaveProperty("ambiguous");
      expect((out as { ambiguous: string[] }).ambiguous.sort()).toEqual(["Duet", "i-inc"]);
    }
  });

  it("marks a single mention as inferred, and a fallback as not", async () => {
    const named = await ask("Add refunds to duet");
    expect(named).toMatchObject({ kind: "draft", inferred: true, ticket: { project: "Duet" } });
    expect(named).not.toHaveProperty("ambiguous");
    const plain = await ask("Add refunds");
    expect(plain).toMatchObject({ kind: "draft", inferred: false, ticket: { project: "i-inc" } });
  });

  it("never falls back to a project the employee doesn't work on", async () => {
    const stray = { ...refundsTicket({ project: "other", assignee: "kit" }) };
    const out = await ask("Add refunds", { current: stray, defaultProject: "other" });
    expect(out).toMatchObject({ kind: "draft", inferred: false, ticket: { project: "Duet" } });
  });

  it("prefers the current ticket's project, then the default, when none is named", async () => {
    const cur = refundsTicket({ project: "Duet", assignee: "kit" });
    expect(await ask("Add refunds", { current: cur })).toMatchObject({ ticket: { project: "Duet" } });
  });

  it("reads the company's projects when the employee has no list, and infers Duet", async () => {
    const out = await handleMessage(
      "fix the Duet login bug",
      {
        employee: kit,
        engine: engine("sonnet"),
        current: null,
        notes: "",
        defaultProject: "fintrack",
        companyProjects: ["fintrack", "Duet", "listy"],
      },
      new FakeHelper(),
      new FakeChat(),
    );
    expect(out).toMatchObject({ kind: "draft", inferred: true, ticket: { project: "Duet" } });
    expect(out).not.toHaveProperty("ambiguous");
  });

  it("is ambiguous, not inferred, when an allowed project is named with one outside the list", async () => {
    const mixed = { companyProjects: ["Duet", "i-inc", "secret"] };
    for (const text of ["fix duet and secret", "Fix secret and duet"]) {
      const out = await ask(text, mixed);
      expect(out).toMatchObject({ kind: "draft", inferred: false });
      expect((out as { ambiguous: string[] }).ambiguous.sort()).toEqual(["Duet", "secret"]);
      expect((out as { ticket: { project: string } }).ticket.project).not.toBe("secret");
    }
    const only = await ask("fix secret", mixed);
    expect(only).toMatchObject({ inferred: false, ambiguous: ["secret"], ticket: { project: "i-inc" } });
    expect(await ask("fix duet", mixed)).toMatchObject({ inferred: true, ticket: { project: "Duet" } });
  });

  it("files a PA's errand under Home whatever the message names", async () => {
    const out = await handleMessage(
      "Book a table, project: duet",
      {
        employee: { ...pip, projects: ["duet"] },
        engine: engine("qwen"),
        current: null,
        notes: "",
        defaultProject: "duet",
      },
      new FakeHelper(),
      new FakeChat(),
    );
    expect(out).toMatchObject({ kind: "errand", ticket: { project: "Home" } });
  });
});
