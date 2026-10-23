// An orientation or a tidy-up closes as done only when its done-when is met (T71): the pages it asked for are in
// the brain, or the tidy report is empty. The first miss runs the stage once more with what is missing; the
// second goes to the owner as a Needs you card, never to done. And a PA has its own orientation, with an
// offline brief for a model that has no internet and no root.
import { describe, expect, it } from "vitest";
import {
  answer,
  type BrainState,
  brainBudgetFor,
  brief,
  cloudBrainBudget,
  emptyState,
  errandsPageExample,
  fold,
  helpPageExample,
  homeOrientationTask,
  homePages,
  localBrainBudget,
  localContextTokens,
  offlineNotes,
  orientationDoneWhen,
  orientationExpectations,
  runTicket,
  type Ticket,
} from "../src/index.ts";
import { engines, kit, pip, ports, refundsTicket } from "./fixtures.ts";

const orientation = (over: Partial<Ticket> = {}) =>
  refundsTicket({
    id: "o1",
    title: "Orientation for Pip",
    project: "Home",
    type: "orientation",
    effort: "low",
    doneWhen: orientationDoneWhen(true),
    assignee: "pip",
    ...over,
  });

/** A brain the test controls: what is in it now, and what the "collect" step finds when it runs. */
function brainWith(initial: Record<string, string> = {}) {
  const pages = new Map(Object.entries(initial));
  const calls: string[] = [];
  const tidy: { left: string[] } = { left: [] };
  const state: BrainState = {
    pages: async () => {
      calls.push("pages");
      return new Map(pages);
    },
    tidyLeft: async () => {
      calls.push("tidy");
      return [...tidy.left];
    },
  };
  return { pages, calls, tidy, state };
}

const helpPage = helpPageExample();
const errandsPage = errandsPageExample();

describe("an orientation's done-when is checked", () => {
  it("closes as done when the pages are there", async () => {
    const p = ports();
    const b = brainWith({ [homePages.help]: helpPage, [homePages.errands]: errandsPage });
    p.brainState = b.state;
    expect(await runTicket(p, orientation())).toEqual({ status: "done", outcome: "done" });
    const s = fold(await p.store.read("o1"));
    expect(s.doneWhen).toEqual({ misses: 0, last: { met: true, missing: [] } });
    expect(p.agent.callsFor("pip", "orient")).toHaveLength(1);
  });

  it("runs one more session with feedback when a page is missing, then closes when the retry delivers it", async () => {
    const p = ports();
    const b = brainWith({ [homePages.errands]: errandsPage });
    p.brainState = b.state;
    // the second session writes the page that was missing
    p.agent.on({ stage: "orient" }, { kind: "done", output: "done" }, { kind: "done", output: "done" });
    const run = runTicket(p, orientation());
    // after the first session the page is still missing; it appears before the second session's check
    const real = b.state.pages;
    let n = 0;
    b.state.pages = async (...a) => {
      if (++n === 2) b.pages.set(homePages.help, helpPage);
      return real(...a);
    };
    expect(await run).toEqual({ status: "done", outcome: "done" });
    const calls = p.agent.callsFor("pip", "orient");
    expect(calls).toHaveLength(2);
    // the retry is told what it did not do, with the exact path and the shape to copy
    expect(calls[0]?.brief).not.toContain("did not finish the job");
    expect(calls[1]?.brief).toContain("did not finish the job");
    expect(calls[1]?.brief).toContain(`you did not write ${homePages.help}`);
    expect(calls[1]?.brief).toContain("/home/employee/brain/pip/personal/reference/how-i-help-at-home.md");
    expect(calls[1]?.brief).toContain("## My tools");
    expect(calls[1]?.brief).not.toContain(`you did not write ${homePages.errands}`);
  });

  it("goes to needs-you, not done, when the second session misses too, and says why", async () => {
    const p = ports();
    const b = brainWith(); // Pip writes nothing, like Pip did on 2026-10-22
    p.brainState = b.state;
    const r = await runTicket(p, orientation());
    expect(r.status).toBe("needs-you");
    if (r.status !== "needs-you") return;
    expect(r.ask.kind).toBe("stuck");
    const reason = r.ask.kind === "stuck" ? r.ask.reason : "";
    expect(reason).toContain(`you did not write ${homePages.help}`);
    expect(reason).toContain(`you did not write ${homePages.errands}`);
    expect(reason).toContain("after 2 sessions");
    expect(p.agent.callsFor("pip", "orient")).toHaveLength(2);
    expect(fold(await p.store.read("o1")).status).toBe("needs-you");
    // "Keep going" gives it two more sessions, and the pages let it close
    b.pages.set(homePages.help, helpPage);
    b.pages.set(homePages.errands, errandsPage);
    await answer(p, "o1", "continue");
    expect(await runTicket(p, orientation())).toEqual({ status: "done", outcome: "done" });
    expect(p.agent.callsFor("pip", "orient")).toHaveLength(3);
  });

  it("fails the ticket when the owner declines to keep going", async () => {
    const p = ports();
    p.brainState = brainWith().state;
    await runTicket(p, orientation());
    await answer(p, "o1", "reject");
    expect((await runTicket(p, orientation())).status).toBe("failed");
  });

  it("counts a page the agent sent back as JSON, and finds a page that is only a heading wanting", async () => {
    const p = ports();
    p.brainState = brainWith({ [homePages.help]: "---\ntitle: x\n---\n" }).state; // empty body does not count
    p.agent.on(
      { stage: "orient" },
      {
        kind: "done",
        output: JSON.stringify({
          edits: [
            { page: homePages.help, text: helpPage },
            { page: homePages.errands, text: errandsPage },
          ],
        }),
      },
    );
    expect(await runTicket(p, orientation())).toEqual({ status: "done", outcome: "done" });
  });

  it("closes as before when there is no brain to look at", async () => {
    const p = ports();
    expect(await runTicket(p, orientation())).toEqual({ status: "done", outcome: "done" });
    expect(fold(await p.store.read("o1")).doneWhen.last).toBeNull();
  });

  it("holds an engineer to a page for each of its projects", async () => {
    const p = ports();
    const b = brainWith({ personality: "x".repeat(40) });
    p.brainState = b.state;
    const t = refundsTicket({
      id: "o2",
      type: "orientation",
      effort: "low",
      doneWhen: [],
      assignee: "kit",
      project: "Duet",
    });
    const r = await runTicket(p, t);
    // the scripted agent replies with projects/duet as JSON, which counts
    expect(r).toEqual({ status: "done", outcome: "done" });
    const ex = orientationExpectations(t, { ...kit, projects: ["Duet", "Listy"] }, false);
    expect(ex.map((e) => e.page)).toEqual(["projects/duet", "projects/listy"]);
    expect(ex[0]?.met(new Map([["projects/duet-money", "Notes about Duet that are long enough."]]))).toBe(
      true,
    );
    expect(ex[1]?.met(new Map([["projects/duet", "Notes about Duet that are long enough."]]))).toBe(false);
  });
});

describe("a tidy-up's done-when is checked", () => {
  const tidy = (): Ticket =>
    refundsTicket({
      id: "t1",
      type: "tidy",
      project: "General",
      doneWhen: ["broken [[links]] are fixed"],
      assignee: "kit",
    });

  it("closes when nothing is left on the report", async () => {
    const p = ports();
    p.brainState = brainWith().state;
    expect(await runTicket(p, tidy())).toEqual({ status: "done", outcome: "done" });
  });

  it("tries once more with what is left, then asks the owner", async () => {
    const p = ports();
    const b = brainWith();
    b.tidy.left = ["broken link [[facts/missing]] in company/facts/gh"];
    p.brainState = b.state;
    const r = await runTicket(p, tidy());
    expect(r.status).toBe("needs-you");
    const calls = p.agent.callsFor("kit", "tidy");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.brief).toContain("These are still wrong in your brain copy");
    expect(calls[1]?.brief).toContain("[[facts/missing]]");
  });
});

describe("a PA's orientation and brief", () => {
  it("has its own done-when, not 'a page for each project'", () => {
    expect(orientationDoneWhen(true).join(" ")).toContain(homePages.help);
    expect(orientationDoneWhen(true).join(" ")).toContain(homePages.errands);
    expect(orientationDoneWhen(true).join(" ")).not.toContain("each project");
    expect(orientationDoneWhen(false)).toEqual(["the brain has a page for each project"]);
  });

  it("names the exact path of each page, shows the format, and keeps to short numbered jobs", () => {
    const task = homeOrientationTask(pip);
    expect(task).toContain("/home/employee/brain/pip/personal/reference/how-i-help-at-home.md");
    expect(task).toContain("/home/employee/brain/pip/personal/patterns/errands.md");
    expect(task).toContain("title: How I help at home");
    expect(task).toContain("## My tools");
    for (const n of [1, 2, 3, 4]) expect(task).toContain(`Job ${n}.`);
    expect(task).not.toMatch(/each project|CLAUDE\.md/);
    // small enough for an 8B model: the task is under 800 tokens
    expect(task.length / 4).toBeLessThan(800);
  });

  it("is what the PA's orient session is given, with the done-when list and the offline section", async () => {
    const p = ports();
    await runTicket(p, orientation());
    const sent = p.agent.callsFor("pip", "orient")[0]?.brief ?? "";
    expect(sent).toContain("This is your orientation, Pip");
    expect(sent).toContain(`your brain has the page ${homePages.help}`);
    expect(sent).toContain("NO internet, no sudo");
  });

  it("puts the offline section in every PA brief, and in nobody else's", () => {
    const t = refundsTicket({ type: "errand", project: "Home", assignee: "pip" });
    const forPip = brief(t, "work", emptyState(), "Do the errand.", [], true, pip);
    expect(forPip).toContain("Your machine");
    expect(forPip).toContain("NO internet, no sudo and no root");
    expect(forPip).toContain("apt, npm install, pip");
    expect(forPip).toContain("`rg` (ripgrep) may be missing");
    expect(forPip).toContain('grep -rn "words"');
    expect(forPip).toContain('/home/employee/brain/pip/.bin/brain search "words"');
    expect(forPip).toContain("You do NOT have: sudo, apt, docker, gh, python");
    expect(brief(t, "work", emptyState(), "x", [], true, kit)).not.toContain("NO internet");
    // the section is short: about 200 tokens
    expect(offlineNotes("pip").length / 4).toBeLessThan(260);
  });
});

describe("what a local engine's window can take", () => {
  it("gives a local engine well under half the brain section a cloud engine gets", () => {
    const local = engines.find((e) => e.id === "qwen");
    const cloud = engines.find((e) => e.id === "opus");
    expect(brainBudgetFor(local as never)).toBe(localBrainBudget);
    expect(brainBudgetFor(cloud as never)).toBe(cloudBrainBudget);
    expect(localBrainBudget).toEqual({ mapLines: 40, tokens: 1500, pages: 3 });
    expect(cloudBrainBudget).toEqual({ mapLines: 150, tokens: 3000, pages: 5 });
  });

  it("fits qwen3:8b's window with room to work, and would not fit the default one", () => {
    // Estimates in tokens (characters / 4). OpenCode's own system prompt and tool list are about 10,000.
    const opencode = 10_000;
    const task = homeOrientationTask(pip).length / 4;
    const notes = offlineNotes("pip").length / 4;
    const ticket = 150;
    const mapLine = 25;
    const wrapper = 400; // the brain section's own words (editRules, the untrusted-pages note)
    const local =
      opencode +
      task +
      notes +
      ticket +
      localBrainBudget.mapLines * mapLine +
      localBrainBudget.tokens +
      wrapper;
    const cloud =
      opencode +
      task +
      notes +
      ticket +
      cloudBrainBudget.mapLines * mapLine +
      cloudBrainBudget.tokens +
      wrapper;
    expect(localContextTokens).toBe(32768);
    expect(local).toBeLessThan(localContextTokens * 0.5);
    expect(local).toBeGreaterThan(4096); // Ollama's default window cuts it, and an unannounced cut loses the front of the prompt
    expect(cloud).toBeGreaterThan(local);
    expect(cloud - local).toBeGreaterThan(4000);
  });
});
