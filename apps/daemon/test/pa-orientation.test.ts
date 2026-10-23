// A hired personal assistant's orientation (T71): its own done-when, an offline brief, and a check against what
// it left in its brain copy. A session that writes nothing (Pip, 2026-10-22) doesn't close the ticket as done.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { errandsPageExample, helpPageExample, homePages, localBrainBudget } from "@i-inc/core";
import type { FakeAgent } from "@i-inc/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { brainRig, cleanRigs, page } from "./brain-rig.ts";

afterEach(cleanRigs);

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
    expect(t.needsYou.reason).toContain(`you did not write ${homePages.help}`);
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
    const run = agent.run.bind(agent);
    agent.run = async (req) => {
      if (req.stage === "orient") {
        // what the model does with its file tools: writes the two files in its copy
        for (const [slug, text] of [
          [homePages.help, helpPageExample()],
          [homePages.errands, errandsPageExample()],
        ] as const) {
          const file = w.copy("lu", "personal", `${slug}.md`);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, `${text}\n`);
        }
      }
      return run(req);
    };
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
    expect((await w.call("POST", "/api/employees/nobody/orientation")).status).toBe(404);
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
