// A hired personal assistant's orientation (T71): its own done-when, an offline brief, and a check against what
// it left in its brain copy. A session that writes nothing (Pip, 2026-10-22) doesn't close the ticket as done.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { errandsPageExample, homePages, localBrainBudget } from "@i-inc/core";
import type { FakeAgent } from "@i-inc/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { brainRig, cleanRigs, page } from "./brain-rig.ts";

afterEach(cleanRigs);

/** Pages a model wrote in its own words. */
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

/** What the model does with its file tools: writes pages into its copy of its brain. */
function writesInCopy(w: Awaited<ReturnType<typeof brainRig>>, id: string, pages: Record<string, string>) {
  const agent = w.app.deps.agent as FakeAgent;
  const run = agent.run.bind(agent);
  agent.run = async (req) => {
    if (req.stage === "orient") {
      for (const [slug, text] of Object.entries(pages)) {
        const file = w.copy(id, "personal", `${slug}.md`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
      }
    }
    return run(req);
  };
}

const hire = (id = "lu") => ({
  id,
  name: "Lu",
  role: "Personal Assistant",
  duties: ["build"],
  engines: { default: "qwen", fallbacks: [] },
});

describe("hiring a personal assistant", () => {
  it("files its orientation with a done-when that fits home, not 'a page for each project'", async () => {
    const w = await brainRig();
    const made = await w.call("POST", "/api/employees", hire());
    expect(made.status).toBe(201);
    await w.app.daemon.idle();
    const t = (await w.call("GET", `/api/tickets/${made.body.orientation}`)).body.ticket;
    expect(t.type).toBe("orientation");
    expect(t.project).toBe("Home");
    expect(t.doneWhen).toHaveLength(2);
    expect(t.doneWhen.join(" ")).toContain(homePages.help);
    expect(t.doneWhen.join(" ")).toContain(homePages.errands);
    expect(t.doneWhen.join(" ")).not.toContain("each project");
  });

  it("does not close the ticket as done when the session wrote nothing: it asks again, then waits for the owner", async () => {
    const w = await brainRig();
    const agent = w.app.deps.agent as FakeAgent;
    // the scripted session replies "done" and changes nothing, like Pip did
    agent.on(
      { stage: "orient" },
      { kind: "done", output: "I can't proceed." },
      { kind: "done", output: "Still can't." },
    );
    const made = await w.call("POST", "/api/employees", hire());
    await w.app.daemon.idle();
    const t = (await w.call("GET", `/api/tickets/${made.body.orientation}`)).body.ticket;
    expect(t.outcome).not.toBe("done");
    expect(t.needsYou).toMatchObject({ kind: "stuck" });
    expect(t.needsYou.reason).toContain(`${homePages.help}: you did not write it in this ticket`);
    expect(t.needsYou.reason).toContain("after 2 sessions");
    const sessions = agent.callsFor("lu", "orient");
    expect(sessions).toHaveLength(2);
    // the first brief: the PA's own orientation, the offline section, and the brain trimmed for a small model
    expect(sessions[0]?.brief).toContain("This is your orientation, Lu");
    expect(sessions[0]?.brief).toContain("NO internet, no sudo and no root");
    expect(sessions[0]?.brief).toContain("<brain>");
    // the second: told what it left out, with the path
    expect(sessions[1]?.brief).toContain("did not finish the job");
    expect(sessions[1]?.brief).toContain("/home/employee/brain/lu/personal/reference/how-i-help-at-home.md");
  });

  it("closes as done once the two pages are in the brain, collected from the PA's own copy", async () => {
    const w = await brainRig();
    const agent = w.app.deps.agent as FakeAgent;
    writesInCopy(w, "lu", { [homePages.help]: helpPage, [homePages.errands]: errandsPage });
    const made = await w.call("POST", "/api/employees", hire());
    await w.app.daemon.idle();
    const t = (await w.call("GET", `/api/tickets/${made.body.orientation}`)).body.ticket;
    expect(t).toMatchObject({ column: "done", outcome: "done" });
    expect(agent.callsFor("lu", "orient")).toHaveLength(1);
    const brain = (await w.call("GET", "/api/knowledge/brains/lu")).body;
    expect(brain.pages.map((p: { path: string }) => p.path)).toEqual(
      expect.arrayContaining(["reference/how-i-help-at-home.md", "patterns/errands.md"]),
    );
  });

  it("does not count a page an earlier run left in the brain", async () => {
    const w = await brainRig();
    const agent = w.app.deps.agent as FakeAgent;
    // The two pages are already in Pip's brain from before; this ticket's sessions write nothing.
    w.commit("pip", {
      [`${homePages.help}.md`]: helpPage,
      [`${homePages.errands}.md`]: errandsPage,
    });
    agent.on({ stage: "orient" }, { kind: "done", output: "done" }, { kind: "done", output: "done" });
    const made = await w.call("POST", "/api/employees/pip/orientation");
    await w.app.daemon.idle();
    const t = (await w.call("GET", `/api/tickets/${made.body.orientation}`)).body.ticket;
    expect(t.outcome).not.toBe("done");
    expect(t.needsYou.reason).toContain("you did not write it in this ticket");
  });

  it("does not count a page whose frontmatter the daemon had to add", async () => {
    const w = await brainRig();
    const noFront = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n/, "");
    writesInCopy(w, "lu", { [homePages.help]: noFront(helpPage), [homePages.errands]: errandsPage });
    const made = await w.call("POST", "/api/employees", hire());
    await w.app.daemon.idle();
    const t = (await w.call("GET", `/api/tickets/${made.body.orientation}`)).body.ticket;
    expect(t.needsYou.reason).toContain(
      `${homePages.help}: it has no frontmatter with a title and a description`,
    );
    expect(t.needsYou.reason).not.toContain(`${homePages.errands}:`);
  });

  it("drops the junk keys of Pip's page when it collects it, and still does not count a page without its own title", async () => {
    const w = await brainRig();
    // Pip's file, as the 8B model wrote it from an example shown with "| " in front of every line.
    const mangled = errandsPage.replace(
      /^---\ntitle: (.*)\ndescription: (.*)\n---/,
      "---\n| title: $1\n| description: $2\n---",
    );
    expect(mangled).toContain("| title: Errands");
    writesInCopy(w, "lu", { [homePages.help]: helpPage, [homePages.errands]: mangled });
    const made = await w.call("POST", "/api/employees", hire());
    await w.app.daemon.idle();
    const t = (await w.call("GET", `/api/tickets/${made.body.orientation}`)).body.ticket;
    expect(t.needsYou.reason).toContain(
      `${homePages.errands}: it has no frontmatter with a title and a description`,
    );
    const brain = (await w.call("GET", "/api/knowledge/brains/lu")).body;
    const text: string =
      brain.pages.find((p: { path: string }) => p.path === "patterns/errands.md")?.text ?? "";
    expect(text).not.toBe("");
    expect(text).toContain("title: Errands");
    expect(text).not.toContain("| title");
    expect(text).not.toContain("| description");
    expect(w.logs.some((l) => l.includes("dropped 2 junk frontmatter keys"))).toBe(true);
  });

  it("does not count a copy of the example, or a page with TODOs", async () => {
    const w = await brainRig();
    writesInCopy(w, "lu", {
      [homePages.help]: helpPage.replace("I look after", "TODO TODO I look after"),
      [homePages.errands]: errandsPageExample(),
    });
    const made = await w.call("POST", "/api/employees", hire());
    await w.app.daemon.idle();
    const t = (await w.call("GET", `/api/tickets/${made.body.orientation}`)).body.ticket;
    expect(t.needsYou.reason).toContain("TODO placeholders");
    expect(t.needsYou.reason).toContain("the example copied as it is");
  });

  it("puts the offline note, with the tools the machine was seen to have, in the PA's brief", async () => {
    const w = await brainRig();
    const agent = w.app.deps.agent as FakeAgent;
    writesInCopy(w, "lu", { [homePages.help]: helpPage, [homePages.errands]: errandsPage });
    await w.call("POST", "/api/employees", hire());
    await w.app.daemon.idle();
    const brief = agent.callsFor("lu", "orient")[0]?.brief ?? "";
    expect(brief).toContain("NO internet, no sudo and no root");
    expect(brief).toContain("gh and docker are installed but cannot be used");
    expect(brief).toContain('/home/employee/brain/lu/.bin/brain search "words"');
    // The test machine (this host's bash) is asked whether rg is on its path, and the note says what it found.
    const hasRg = spawnSync("sh", ["-c", "command -v rg"]).status === 0;
    expect(brief.includes('use rg "words"')).toBe(hasRg);
    expect(brief).toContain('grep -rn "words"');
  });
});

describe("an errand that proposes nothing", () => {
  const file = (w: Awaited<ReturnType<typeof brainRig>>) =>
    w.call("POST", "/api/tickets", {
      title: "Morning triage",
      project: "Home",
      type: "errand",
      effort: "low",
      doneWhen: [],
      assignee: "pip",
    });

  it("is done with the reason on the ticket when nothing was needed", async () => {
    const w = await brainRig();
    const agent = w.app.deps.agent as FakeAgent;
    agent.on(
      { stage: "work" },
      { kind: "done", output: JSON.stringify({ proposals: [], nothing: "the inbox has no new mail" }) },
    );
    const made = await file(w);
    await w.app.daemon.idle();
    const t = (await w.call("GET", `/api/tickets/${made.body.ticket.id}`)).body.ticket;
    expect(t.outcome).toBe("done");
    expect(t.note).toBe("Proposed nothing: the inbox has no new mail");
  });

  it("waits for the owner when the reason is giving up", async () => {
    const w = await brainRig();
    const agent = w.app.deps.agent as FakeAgent;
    agent.on(
      { stage: "work" },
      { kind: "done", output: JSON.stringify({ proposals: [], nothing: "sudo failed, no internet" }) },
    );
    const made = await file(w);
    await w.app.daemon.idle();
    const t = (await w.call("GET", `/api/tickets/${made.body.ticket.id}`)).body.ticket;
    expect(t.outcome).not.toBe("done");
    expect(t.needsYou).toMatchObject({ kind: "stuck" });
    expect(t.needsYou.reason).toContain("sudo failed, no internet");
  });
});

describe("running a PA's orientation again", () => {
  it("files a fresh orientation ticket for an employee already hired, with the PA done-when", async () => {
    const w = await brainRig();
    const agent = w.app.deps.agent as FakeAgent;
    agent.on({ stage: "orient" }, { kind: "done", output: "nothing" }, { kind: "done", output: "nothing" });
    const made = await w.call("POST", "/api/employees/pip/orientation");
    expect(made.status).toBe(201);
    await w.app.daemon.idle();
    const t = (await w.call("GET", `/api/tickets/${made.body.orientation}`)).body.ticket;
    expect(t.doneWhen.join(" ")).toContain(homePages.help);
    expect(t.needsYou).toMatchObject({ kind: "stuck" });
    // Asking again while that one is open gives it back, however many times.
    for (let i = 0; i < 3; i++) {
      const again = await w.call("POST", "/api/employees/pip/orientation");
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ orientation: made.body.orientation, existing: true });
    }
    expect(
      w.app.deps.tickets.all().filter((r) => r.ticket.type === "orientation" && r.ticket.assignee === "pip"),
    ).toHaveLength(1);
    expect((await w.call("POST", "/api/employees/nobody/orientation")).status).toBe(404);
    // Someone who has left (tickets of theirs remain, they are not in the company) is a conflict.
    w.app.deps.tickets.create(
      { title: "old", project: "Duet", type: "chore", effort: "low", doneWhen: [], assignee: "gone" },
      w.clock.now(),
    );
    expect((await w.call("POST", "/api/employees/gone/orientation")).status).toBe(409);
    expect(agent.callsFor("pip", "orient")[0]?.brief).toContain("This is your orientation, Pip");
  });
});

describe("the brain section for a local engine", () => {
  it("carries fewer map lines and fewer, shorter pages than for a cloud engine", async () => {
    const w = await brainRig();
    const files: Record<string, string> = {};
    for (let i = 0; i < 90; i++) {
      files[`facts/errand-note-${i}.md`] = page(
        `Errand note ${i}`,
        `What to know about errand number ${i}`,
        `Errand note ${i}. ${"The owner prefers short replies and aisle seats. ".repeat(30)}`,
      );
    }
    w.commit("handbook", files);
    const ask = (budget?: typeof localBrainBudget) =>
      w.feed.forTicket({
        employeeId: "kit",
        sessionId: null,
        ...(budget ? { budget } : {}),
        query: { title: "errand note replies seats", project: "Duet", doneWhen: [] },
      });
    const cloud = await ask();
    const local = await ask(localBrainBudget);
    const lines = (t: string) => t.split("\n").filter((l) => l.startsWith("- [[")).length;
    const pages = (t: string) => (t.match(/<brain-page /g) ?? []).length;
    expect(lines(cloud.text)).toBeGreaterThan(80);
    expect(lines(local.text)).toBeLessThanOrEqual(localBrainBudget.mapLines);
    expect(pages(local.text)).toBeLessThanOrEqual(localBrainBudget.pages);
    expect(pages(cloud.text)).toBeGreaterThan(pages(local.text));
    expect(local.text.length).toBeLessThan(cloud.text.length * 0.6);
    // The pages it does carry stay within the token budget (about characters / 4).
    const pageChars = (local.text.match(/<brain-page [^>]*>[\s\S]*?<\/brain-page>/g) ?? []).join("").length;
    expect(pageChars / 4).toBeLessThanOrEqual(localBrainBudget.tokens + 200);
  });
});
