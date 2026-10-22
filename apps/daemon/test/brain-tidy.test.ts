// The daily "Tend the brain" ticket (docs/design/brain.md, "Tending"): who gets it, that it is filed at most
// once a day and never while the last one is open, the follow-up budget, and what the librarian is told.
import type { Employee, Ticket } from "@i-inc/core";
import type { FakeAgent } from "@i-inc/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { tidyReport } from "../src/brain-tidy.ts";
import { TIDY_LABEL } from "../src/daemon.ts";
import { brainRig, cleanRigs, page } from "./brain-rig.ts";

afterEach(cleanRigs);

const day = 86_400_000;

/** A brain with something to tend: two pages on one topic, a link to nowhere, a conflict kept. */
async function world() {
  const w = await brainRig();
  w.commit("handbook", {
    "facts/gh.md": page(
      "GitHub CLI",
      "gh pr checks waits for CI",
      "Use gh pr checks --watch. See [[facts/missing]].",
    ),
    "facts/github-cli.md": page("GitHub CLI", "gh pr checks waits for CI", "Use gh pr checks --watch too."),
    "facts/deploy.md": page(
      "Deploy",
      "How deploys go",
      "Deploys go out on merge.\n\n## Conflict\n\n> another version",
      [],
      "needs-tidy: true\n",
    ),
  });
  const tickets = () => w.app.deps.tickets.all().filter((r) => r.ticket.labels?.includes(TIDY_LABEL));
  const tick = async () => {
    await w.app.daemon.tick();
    await w.app.daemon.idle();
  };
  const withDuties = (id: string, duties: Employee["duties"]) => {
    const e = w.app.deps.registry.employee(id);
    w.app.deps.registry.hire({ ...e, duties });
  };
  return { ...w, tickets, tick, withDuties };
}

describe("who tends the brain", () => {
  it("asks an employee with the librarian duty, and takes turns when there are several", async () => {
    const w = await world();
    w.withDuties("kit", ["build", "librarian"]);
    w.withDuties("quinn", ["verify", "librarian"]);
    const pick = (n: number) => w.app.daemon.pickLibrarian(n * day)?.employee.id;
    expect([pick(0), pick(1), pick(2)]).toEqual(["kit", "quinn", "kit"]);
    expect(w.app.daemon.pickLibrarian(0)?.fallback).toBeNull();
  });

  it("falls back to the first with the plan duty, else review, else anyone, and never a personal assistant", async () => {
    const w = await world();
    const d = w.app.daemon;
    expect(d.pickLibrarian(0)).toMatchObject({ employee: { id: "grace" }, fallback: "plan" });
    w.withDuties("grace", ["review"]);
    expect(d.pickLibrarian(0)).toMatchObject({ employee: { id: "ada" }, fallback: "review" });
    // A personal assistant with the duty is still not asked: its brain is home data.
    w.withDuties("pip", ["build", "librarian"]);
    expect(d.pickLibrarian(0)?.employee.id).not.toBe("pip");
  });

  it("files the ticket with the librarian as assignee, and says which fallback it chose", async () => {
    const w = await world();
    await w.tick();
    const [t] = w.tickets();
    expect(t?.ticket).toMatchObject({
      title: "Tend the brain",
      type: "tidy",
      project: "General",
      assignee: "grace",
      createdBy: "grace",
      labels: [TIDY_LABEL],
    });
    expect(t?.ticket.reason).toContain("Nobody has the librarian duty, so Grace (plan) was asked");
    expect(t?.ticket.doneWhen.join(" ")).toContain("broken [[links]]");
    expect(w.logs.join("\n")).toContain("fell back to the plan duty");
    // It is an ordinary ticket: it shows on the board, and it ran.
    const board = (await w.call("GET", "/api/board")).body.tickets as { id: string; type: string }[];
    expect(board.find((b) => b.id === t?.ticket.id)).toBeDefined();
    expect(w.app.daemon.isRunning(t?.ticket.id ?? "")).toBe(false);
  });

  it("gives the ticket to the librarian when someone has the duty", async () => {
    const w = await world();
    w.withDuties("kit", ["build", "librarian"]);
    await w.tick();
    const [t] = w.tickets();
    expect(t?.ticket.assignee).toBe("kit");
    expect(t?.ticket.reason).not.toContain("Nobody has");
  });
});

describe("one at a time, once a day", () => {
  it("files one a day, and no second the same day however often the daemon looks", async () => {
    const w = await world();
    await w.tick();
    await w.tick();
    await w.tick();
    expect(w.tickets()).toHaveLength(1);
    w.clock.advance(24 * 60);
    await w.tick();
    expect(w.tickets()).toHaveLength(2);
  });

  it("files none while the previous one is still open", async () => {
    const w = await world();
    // The librarian is off duty: the first ticket is filed but cannot start.
    const hour = new Date(w.clock.now()).getUTCHours();
    const grace = w.app.deps.registry.employee("grace");
    w.app.deps.registry.hire({ ...grace, workingHours: { from: (hour + 2) % 24, to: (hour + 3) % 24 } });
    await w.tick();
    expect(w.tickets()).toHaveLength(1);
    w.clock.advance(3 * 24 * 60);
    await w.tick();
    expect(w.tickets()).toHaveLength(1);
    expect(w.logs.join("\n")).toContain("is still open");
  });

  it("respects the daily budget for tickets agents file themselves", async () => {
    const w = await world();
    for (let i = 0; i < 3; i++) {
      w.app.deps.tickets.create(
        {
          title: `follow-up ${i}`,
          project: "General",
          type: "chore",
          effort: "low",
          doneWhen: [],
          assignee: "ada",
          createdBy: "ada",
          hold: true,
        },
        w.clock.now(),
      );
    }
    await w.tick();
    expect(w.tickets()).toHaveLength(0);
    expect(w.logs.join("\n")).toContain("budget");
    // The next day the budget is fresh.
    w.clock.advance(24 * 60);
    await w.tick();
    expect(w.tickets()).toHaveLength(1);
  });

  it("files nothing when the brain has nothing to tend", async () => {
    const w = await brainRig();
    w.commit("handbook", {
      "facts/gh.md": page("GitHub CLI", "gh pr checks waits for CI", "Use gh pr checks --watch."),
    });
    await w.app.daemon.tick();
    await w.app.daemon.idle();
    expect(w.app.deps.tickets.all().filter((r) => r.ticket.type === "tidy")).toHaveLength(0);
    expect(w.logs.join("\n")).toContain("nothing to tend");
  });

  it("files nothing in demo mode, where there is no copy of the brain to tend", async () => {
    const w = await brainRig({ delivered: false });
    w.commit("handbook", {
      "facts/a.md": page("A", "a", "See [[nowhere]] for the details of this."),
    });
    await w.app.daemon.tick();
    expect(w.app.deps.tickets.all().filter((r) => r.ticket.type === "tidy")).toHaveLength(0);
  });
});

describe("what the librarian is told", () => {
  it("is given the report at the end of the brief, only for the tidy stage", async () => {
    const w = await world();
    await w.feed.sync("grace");
    const ports = (w.app.daemon as unknown as { ports: { agent: { run: (r: unknown) => Promise<unknown> } } })
      .ports;
    const ticket: Ticket = {
      id: "99",
      title: "Tend the brain",
      project: "General",
      type: "tidy",
      effort: "low",
      doneWhen: [],
      assignee: "grace",
    };
    const run = (stage: string) =>
      ports.agent.run({
        ticket,
        stage,
        duty: stage === "tidy" ? "librarian" : "build",
        employee: w.app.deps.registry.employee("grace"),
        engine: w.app.deps.registry.engine("gemini"),
        brief: "go",
      });
    await run("tidy");
    // The scripted agent records the brief it was given.
    const calls = (w.app.deps.agent as FakeAgent).calls;
    const tidy = calls.find((c) => c.stage === "tidy")?.brief ?? "";
    expect(tidy).toContain("<tidy>");
    expect(tidy).toContain("Duplicates");
    expect(tidy).toContain("company/facts/gh.md");
    expect(tidy).toContain("[[facts/missing]]");
    expect(tidy).toContain("Conflicts kept for you");
    expect(tidy).toContain("company/facts/deploy.md");
    await run("build");
    expect(
      calls
        .filter((c) => c.stage === "build")
        .map((c) => c.brief)
        .join(""),
    ).not.toContain("<tidy>");
  });

  it("calls a page unused only after 60 days of watching, 60 days unwritten and unlinked, and spares policies", async () => {
    const w = await brainRig();
    const old = (title: string, body: string) =>
      `---\ntitle: ${title}\ndescription: ${title} and what to know\nupdated: 2026-01-01\n---\n${body}\n`;
    w.commit("handbook", {
      "facts/stale.md": old("Stale", "Nothing opens this page and nothing links to it at all."),
      "facts/linked.md": old("Linked", "Another page links to this one, so it stays put here."),
      "facts/hub.md": `---\ntitle: Hub\ndescription: The hub\nupdated: 2026-10-20\n---\nSee [[facts/linked]] for details.\n`,
      "facts/used.md": old("Used", "An agent opened this page last week, so it is not unused."),
      "policies/review.md": old("Review", "Every change gets a fresh review before it merges."),
      "facts/fresh.md": `---\ntitle: Fresh\ndescription: New\nupdated: 2026-10-20\n---\nWritten yesterday and not opened yet by anybody at all.\n`,
    });
    const index = w.app.deps.brain;
    const now = Date.UTC(2026, 9, 21);
    index.markUsed("company", "facts/used", now - 3 * day);
    const scopes = ["company" as const];
    // Watching began yesterday: nothing may be called unused.
    expect(tidyReport(index, scopes, now, now - day).unused).toEqual([]);
    // Watched for 61 days: only the stale, unlinked, unopened page.
    const r = tidyReport(index, scopes, now, now - 61 * day);
    expect(r.unused.map((u) => u.slug)).toEqual(["facts/stale"]);
    expect(r.broken).toEqual([]);
    expect(r.maps[0]).toMatchObject({ scope: "company", limit: 150 });
  });
});
