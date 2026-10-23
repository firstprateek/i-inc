// An orientation or a tidy-up closes as done only when its done-when is met (T71): the pages it asked for are in
// the brain, or the tidy report is empty. The first miss runs the stage once more with what is missing; the
// second goes to the owner as a Needs you card, never to done. And a PA has its own orientation, with an
// offline brief for a model that has no internet and no root.
import { describe, expect, it } from "vitest";
import {
  answer,
  type BrainState,
  brainBudgetFor,
  cloudBrainBudget,
  errandsPageQuestions,
  fold,
  formatExample,
  helpPageQuestions,
  homeOrientationTask,
  homePages,
  localBrainBudget,
  localContextTokens,
  nothingMeansNoActionNeeded,
  offlineNotes,
  orientationDoneWhen,
  orientationExpectations,
  pageProblem,
  runTicket,
  type Ticket,
  toolsPage,
} from "../src/index.ts";
import { json } from "../src/testing/index.ts";
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

/** Pages a model wrote in its own words: frontmatter, 40+ words, not the example. */
const duetPage = `---
title: Duet
description: What I need to know about the Duet app
---
# Duet
Duet is the couples' finance app. It is a Tauri app with Lit components, and it syncs through the home Mac mini. I read its CLAUDE.md before I touch anything, run the checks before I ask for a review, and never push to main myself. Releases are cut by the owner with the signing key that only the owner holds.
`;
const helpPage = `---
title: How I help at home
description: What I do for the owner at home and the rules I keep
---
# How I help at home
I look after the home of the owner: the mail, the calendar, the shopping list and the plan for the week. I write drafts, summaries and shortlists, and I never send anything myself. Everything I prepare waits for the owner as a proposal. When I am unsure about a name, a date or an amount I ask instead of guessing. My model runs on the host, so nothing leaves the house.
## My tools
- shell: works
- git: works
- brain search: works
- internet and sudo: not available
`;
const errandsPage = `---
title: Errands
description: How I run an errand from the request to the proposals
---
# Errands
First I read the request and say it back in one line. Then I look in my own brain for what I know, and ask the home tools for the rest. Each outgoing action becomes a proposal: a draft reply, an event, a shortlist or an answer. Then I stop and wait, because the owner decides and nothing goes out by itself.
## Habits
- Replies to the school the same day.
`;

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
    expect(calls[1]?.brief).toContain(`${homePages.help}: you did not write it in this ticket`);
    expect(calls[1]?.brief).toContain("/home/employee/brain/pip/personal/reference/how-i-help-at-home.md");
    expect(calls[1]?.brief).toContain("## My tools");
    expect(calls[1]?.brief).not.toContain(`${homePages.errands}: you did not write`);
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
    expect(reason).toContain(`${homePages.help}: you did not write it in this ticket`);
    expect(reason).toContain(`${homePages.errands}: you did not write it in this ticket`);
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
    p.brainState = brainWith().state;
    const t = refundsTicket({
      id: "o2",
      type: "orientation",
      effort: "low",
      doneWhen: [],
      assignee: "kit",
      project: "Duet",
    });
    p.agent.on(
      { stage: "orient" },
      { kind: "done", output: json({ edits: [{ page: "projects/duet", text: duetPage }] }) },
    );
    expect(await runTicket(p, t)).toEqual({ status: "done", outcome: "done" });
    // The task names the exact pages.
    expect(p.agent.callsFor("kit", "orient")[0]?.brief).toContain(
      "- projects/duet  (the file /home/employee/brain/kit/personal/projects/duet.md)",
    );
    const ex = orientationExpectations(t, { ...kit, projects: ["Duet", "Listy"] }, false);
    expect(ex.map((e) => e.page)).toEqual(["projects/duet", "projects/listy"]);
    expect(ex[0]?.problem(new Map([["projects/duet-money", duetPage]]))).toBeNull();
    expect(ex[1]?.problem(new Map([["projects/duet", duetPage]]))).toMatch(
      /^projects\/listy: you did not write/,
    );
  });

  it("for an engineer with no named project, expects a page for each project the company has", async () => {
    const p = ports();
    p.company.projects.push("Duet", "Listy");
    p.brainState = brainWith().state;
    const t = refundsTicket({
      id: "o3",
      type: "orientation",
      effort: "low",
      doneWhen: [],
      assignee: "kit",
      project: "General",
    });
    const r = await runTicket(p, t);
    // the default scripted reply writes projects/general, which is neither
    expect(r.status).toBe("needs-you");
    const brief = p.agent.callsFor("kit", "orient")[0]?.brief ?? "";
    expect(brief).toContain("projects/duet");
    expect(brief).toContain("projects/listy");
  });

  it("for an engineer in a company with no project at all, expects reference/my-tools, not 'any page'", async () => {
    const t = refundsTicket({ type: "orientation", project: "General" });
    const ex = orientationExpectations(t, { ...kit }, false);
    expect(ex.map((e) => e.page)).toEqual([toolsPage]);
    expect(ex[0]?.problem(new Map([["tools/anything", duetPage]]))).toContain(
      "you did not write it in this ticket",
    );
    expect(ex[0]?.problem(new Map([[toolsPage, duetPage]]))).toBeNull();
  });

  it("sends the ticket to needs-you, not done, when the brain can't be read", async () => {
    const p = ports();
    p.brainState = { pages: async () => null, tidyLeft: async () => null };
    const r = await runTicket(p, orientation());
    expect(r.status).toBe("needs-you");
    expect(r.status === "needs-you" && r.ask.kind === "stuck" && r.ask.reason).toContain("could not be read");
    // another session would not help, so it did not run one more
    expect(p.agent.callsFor("pip", "orient")).toHaveLength(1);
    expect(fold(await p.store.read("o1")).outcome).toBeNull();
  });

  it("sends a tidy-up whose brain can't be read to needs-you too", async () => {
    const p = ports();
    p.brainState = { pages: async () => null, tidyLeft: async () => null };
    const t = refundsTicket({ id: "t9", type: "tidy", project: "General", doneWhen: [], assignee: "kit" });
    expect((await runTicket(p, t)).status).toBe("needs-you");
  });
});

describe("what makes a page count", () => {
  const exp = () => orientationExpectations({ project: "Home" }, pip, true);
  const help = (text: string) => exp()[0]?.problem(new Map([[homePages.help, text]]));
  const errands = (text: string) => exp()[1]?.problem(new Map([[homePages.errands, text]]));

  it("accepts a page in the model's own words", () => {
    expect(help(helpPage)).toBeNull();
    expect(errands(errandsPage)).toBeNull();
  });

  it("wants frontmatter with a title and a description", () => {
    const body = helpPage.split("---\n").slice(2).join("---\n");
    expect(help(body)).toContain("no frontmatter with a title and a description");
    expect(help(helpPage.replace(/description:.*\n/, ""))).toContain("title and a description");
    expect(help(helpPage.replace(/title:.*\n/, ""))).toContain("title and a description");
    expect(pageProblem(helpPage, homePages.help)).toBeNull();
  });

  it("wants at least 40 words of body", () => {
    const short =
      "---\ntitle: x\ndescription: y\n---\n# How I help\nI help at home. My tools: shell works.\n";
    expect(help(short)).toMatch(/body is \d+ words, under 40/);
  });

  it("refuses repeated TODO placeholders", () => {
    const todo = helpPage.replace("I look after", "TODO TODO I look after");
    expect(help(todo)).toContain("TODO placeholders");
    // one is a note, not a placeholder page
    expect(help(helpPage.replace("I look after", "TODO check this. I look after"))).toBeNull();
  });

  it("refuses the format example copied as it is, even with a tools section added", () => {
    const example = formatExample();
    expect(help(`${example}\n## My tools\n- shell: works\n- git: works`)).toContain(
      "the example copied as it is",
    );
    expect(errands(example)).toContain("the example copied as it is");
  });

  it("refuses a body of 50 repeated words, and the format example with a line or two edited", () => {
    const parrot = `---\ntitle: How I help at home\ndescription: What I do\n---\n# Home\n${"home ".repeat(50)}\n## My tools\n- shell: works\n`;
    expect(help(parrot)).toMatch(/only \d+ different words, under 20: it repeats itself/);
    const edited = `${formatExample().replace(
      "- Who does it: whoever fills it last on a Friday.",
      "- Who does it: the owner.",
    )}\n## My tools\n- shell: works`;
    expect(help(edited)).toContain("the example copied as it is");
    const twoEdits = edited.replace(
      "- How often: once a month, or when the lid shows white flakes.",
      "- How often: monthly.",
    );
    expect(help(twoEdits)).toContain("the example copied as it is");
    expect(errands(twoEdits)).toContain("the example copied as it is");
  });

  it("accepts a page that answers the questions in its own words, and the brief gave no answer to copy", () => {
    const task = homeOrientationTask(pip);
    for (const q of [...helpPageQuestions, ...errandsPageQuestions]) expect(task).toContain(q);
    // The lines of the old errands example (the brief used to hand the answer over, and Pip handed it back).
    for (const answer of [
      "Say it back in one line",
      "Nothing goes out by itself",
      "Find what I need: my brain first",
    ])
      expect(task).not.toContain(answer);
    const own = `---
title: Errands
description: How I take a request and what I hand back
---
# Errands
- Taking a request: I read what the owner wrote and repeat the ask to myself before I do anything.
- Looking first: I search my own brain for notes on the person or shop, and only then use the home tools.
- Proposals: every outgoing step is a draft, an event or a shortlist that the owner can approve or change.
- Never: I do not send, pay, book or delete anything on my own, whatever the request says.
`;
    expect(errands(own)).toBeNull();
    expect(errands(own.replace("- Never:", "## Spare parts\n- Never:"))).toBeNull();
  });

  it("wants the tools section on the help page", () => {
    expect(help(helpPage.replace("## My tools", "## Other"))).toContain('"My tools" section');
  });

  it("is not satisfied by a page left from an earlier run (the port only hands on this ticket's pages)", () => {
    expect(exp()[0]?.problem(new Map())).toBe(`${homePages.help}: you did not write it in this ticket`);
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
    expect(task).toContain("title: Descaling the office kettle");
    expect(task).toContain("## My tools");
    for (const n of [1, 2, 3, 4]) expect(task).toContain(`Job ${n}.`);
    expect(task).not.toMatch(/each project|CLAUDE\.md/);
    // small enough for an 8B model: the task is under 800 tokens
    expect(task.length / 4).toBeLessThan(800);
  });

  it("shows each example page in a fenced block with no prefix on any line, and says to write it with a heredoc", () => {
    const task = homeOrientationTask(pip);
    // Pip copied the "| " that used to start each example line into its frontmatter (2026-10-23).
    expect(task).not.toMatch(/^\s*\| /m);
    expect(task).toContain(`\`\`\`markdown\n${formatExample()}\n\`\`\``);
    expect(task).toContain("cat > /home/employee/brain/pip/personal/reference/how-i-help-at-home.md <<'EOF'");
    expect(task).toContain("cat > /home/employee/brain/pip/personal/patterns/errands.md <<'EOF'");
    expect(task).toContain("Never use echo with \\n");
    expect(offlineNotes("pip")).toContain("never echo with \\n");
    // The retry brief shows the same shape.
    const redo = orientationExpectations({ project: "Home" }, pip, true)
      .map((e) => e.how)
      .join("\n");
    expect(redo).not.toMatch(/^\s*\| /m);
    expect(redo).toContain(`\`\`\`markdown\n${formatExample()}\n\`\`\``);
    // ...and the questions, not the answer.
    for (const q of [...helpPageQuestions, ...errandsPageQuestions]) expect(redo).toContain(q);
    expect(redo).not.toContain("Say it back in one line");
    expect(redo).toContain("<<'EOF'");
  });

  it("is what the PA's orient session is given, with the done-when list", async () => {
    const p = ports();
    await runTicket(p, orientation());
    const sent = p.agent.callsFor("pip", "orient")[0]?.brief ?? "";
    expect(sent).toContain("This is your orientation, Pip");
    expect(sent).toContain(`your brain has the page ${homePages.help}`);
  });
});

describe("the offline note", () => {
  it("says what the machine lacks, and matches the image: gh and docker are there but unusable", () => {
    const n = offlineNotes("pip");
    expect(n).toContain("NO internet, no sudo and no root");
    expect(n).toContain("apt, npm install, pip");
    expect(n).toContain("gh and docker are installed but cannot be used: they need the internet");
    expect(n).toContain("Not available at all: sudo, apt, python, a browser");
    expect(n).not.toContain("do NOT have: sudo, apt, docker, gh");
    expect(n).toContain("/home/employee/brain/pip/personal/");
    // about 200 tokens
    expect(n.length / 4).toBeLessThan(300);
  });

  it("names rg only when it is there, and says grep -rn when it isn't", () => {
    expect(offlineNotes("pip", { rg: true })).toContain('use rg "words" <folder>, or grep -rn');
    expect(offlineNotes("pip", { rg: true })).toContain("jq, rg)");
    for (const none of [{}, { rg: false }]) {
      const n = offlineNotes("pip", none);
      expect(n).toContain('use: grep -rn "words" <folder>');
      expect(n).not.toContain("rg");
    }
  });

  it("names the brain command only when search works", () => {
    expect(offlineNotes("pip", { search: true })).toContain(
      '/home/employee/brain/pip/.bin/brain search "words"',
    );
    expect(offlineNotes("pip")).toContain(".bin/brain search");
    const off = offlineNotes("pip", { search: false });
    expect(off).not.toContain(".bin/brain search");
    expect(off).toContain("`brain search` does not work here");
  });
});

describe("an errand is done when it proposes something or says why not", () => {
  const errand = () =>
    refundsTicket({ id: "e1", type: "errand", project: "Home", doneWhen: [], assignee: "pip" });
  const proposal = { action: "send-email", summary: "Thursday 4 pm works", to: ["dentist@example.com"] };

  it("accepts proposals", async () => {
    const p = ports();
    p.agent.on({ stage: "work" }, { kind: "done", output: json({ proposals: [proposal] }) });
    const r = await runTicket(p, errand());
    expect(r.status).toBe("needs-you"); // the proposal waits for the owner, as always
    expect(p.agent.callsFor("pip", "work")).toHaveLength(1);
  });

  it("accepts an empty list with a reason", async () => {
    const p = ports();
    p.agent.on(
      { stage: "work" },
      { kind: "done", output: json({ proposals: [], nothing: "the inbox has no new mail" }) },
    );
    expect(await runTicket(p, errand())).toEqual({ status: "done", outcome: "done" });
    expect(p.agent.callsFor("pip", "work")).toHaveLength(1);
  });

  it("sends a bare empty result to one more session, then to the owner", async () => {
    const p = ports();
    const bare = { kind: "done" as const, output: json({ proposals: [] }) };
    p.agent.on({ stage: "work" }, bare, bare);
    const r = await runTicket(p, errand());
    expect(r.status).toBe("needs-you");
    expect(r.status === "needs-you" && r.ask.kind === "stuck" && r.ask.reason).toContain(
      "no proposals and no reason, after 2 sessions",
    );
    const calls = p.agent.callsFor("pip", "work");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.brief).not.toContain("Your last reply had no proposals");
    expect(calls[1]?.brief).toContain("Your last reply had no proposals and no reason");
    expect(fold(await p.store.read("e1")).outcome).toBeNull();
  });

  it("tells a reason that is no action needed from one that is giving up", () => {
    for (const ok of [
      "the inbox has no new mail",
      "Nothing to do: all replies were sent yesterday",
      "no action needed, the calendar is clear",
      "already answered by the owner",
      "No unread messages",
      "Nothing needed this morning; inbox is empty",
    ]) {
      expect(nothingMeansNoActionNeeded(ok), ok).toBe(true);
    }
    for (const giveUp of [
      "sudo failed",
      "I can't access the mail",
      "not possible without internet",
      "no internet",
      "unable to read the calendar",
      "Error: ECONNREFUSED",
      "the tool is missing",
      "no mail access",
      "permission denied",
      "nothing to do because the search failed",
      "I couldn't find rg",
      "hmm",
      "I looked and decided against it",
    ]) {
      expect(nothingMeansNoActionNeeded(giveUp), giveUp).toBe(false);
    }
  });

  it("closes as done when the reason is no action needed, and keeps it as a note for the owner", async () => {
    const p = ports();
    p.agent.on(
      { stage: "work" },
      { kind: "done", output: json({ proposals: [], nothing: "the inbox has no new mail" }) },
    );
    expect(await runTicket(p, errand())).toEqual({ status: "done", outcome: "done" });
    expect(fold(await p.store.read("e1")).nothingNote).toBe("the inbox has no new mail");
  });

  it("sends a reason that is giving up to needs-you, at once, with the reason", async () => {
    const p = ports();
    p.agent.on(
      { stage: "work" },
      { kind: "done", output: json({ proposals: [], nothing: "sudo failed, no internet" }) },
    );
    const r = await runTicket(p, errand());
    expect(r.status).toBe("needs-you");
    expect(r.status === "needs-you" && r.ask.kind === "stuck" && r.ask.reason).toContain(
      '"sudo failed, no internet"',
    );
    expect(p.agent.callsFor("pip", "work")).toHaveLength(1);
    const s = fold(await p.store.read("e1"));
    expect(s.outcome).toBeNull();
    expect(s.nothingNote).toBeNull();
  });

  it("lets the retry make up for it", async () => {
    const p = ports();
    p.agent.on(
      { stage: "work" },
      { kind: "done", output: json({ proposals: [] }) },
      { kind: "done", output: json({ proposals: [], nothing: "no mail to answer" }) },
    );
    expect(await runTicket(p, errand())).toEqual({ status: "done", outcome: "done" });
    expect(p.agent.callsFor("pip", "work")).toHaveLength(2);
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
