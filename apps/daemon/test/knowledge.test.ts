// Brains and the handbook on the host (spec §5, "The brain"), through the API.
import { json } from "@i-inc/core/testing";
import { describe, expect, it } from "vitest";
import { refunds, testApp } from "./setup.ts";

describe("what employees learn", () => {
  it("applies brain edits and facts at the retro, holds policies for the owner, and can revert", async () => {
    const app = await testApp();
    app.agent.on(
      { employee: "ada", stage: "retro" },
      {
        kind: "done",
        output: json({
          edits: [
            { layer: "fact", page: "gh-cli", text: "gh pr checks --watch waits for CI." },
            { layer: "policy", page: "merging", text: "Squash-merge every PR." },
          ],
        }),
      },
    );
    app.agent.on(
      { employee: "kit", stage: "retro" },
      {
        kind: "done",
        output: json({
          edits: [{ layer: "brain", page: "duties/review", text: "Ada skips tests for dates." }],
        }),
      },
    );
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    await app.call("POST", "/api/tickets/1/decide", { decision: "approve" });
    await app.daemon.idle();

    let handbook = (await app.call("GET", "/api/knowledge/handbook")).body;
    const fact = handbook.pages.find((p: { path: string }) => p.path === "facts/gh-cli.md");
    expect(fact.text).toContain("gh pr checks --watch waits for CI.");
    expect(handbook.pages[0].text).toContain("- [Gh cli](facts/gh-cli.md)");
    expect(handbook.pages.some((p: { path: string }) => p.path.startsWith("policies/"))).toBe(false);
    expect(handbook.awaiting).toMatchObject([
      { author: "Ada", page: "merging", text: "Squash-merge every PR." },
    ]);

    const kit = (await app.call("GET", "/api/knowledge/brains/kit")).body;
    expect(kit.pages.find((p: { path: string }) => p.path === "duties/review.md").text).toContain(
      "skips tests",
    );
    expect(kit.history[0]).toMatchObject({
      subject: "Add duties/review.md",
      author: "kit",
      authorName: "Kit",
      ticketId: "1",
    });

    // Approving the policy writes it; the tick loop applying the same edits again changes nothing.
    await app.call("POST", `/api/knowledge/policies/${handbook.awaiting[0].id}`, { approved: true });
    await app.daemon.tick();
    handbook = (await app.call("GET", "/api/knowledge/handbook")).body;
    expect(handbook.awaiting).toEqual([]);
    expect(handbook.pages.find((p: { path: string }) => p.path === "policies/merging.md")).toBeTruthy();
    expect(handbook.history.filter((c: { subject: string }) => c.subject.includes("gh-cli"))).toHaveLength(1);

    // Revert the fact: the page is gone, the history keeps both.
    const factCommit = handbook.history.find(
      (c: { subject: string }) => c.subject === "Add facts/gh-cli.md",
    ).commit;
    const reverted = await app.call("POST", "/api/knowledge/handbook/revert", { commit: factCommit });
    expect(reverted.status).toBe(200);
    handbook = (await app.call("GET", "/api/knowledge/handbook")).body;
    expect(handbook.pages.some((p: { path: string }) => p.path === "facts/gh-cli.md")).toBe(false);
    expect(handbook.history.find((c: { commit: string }) => c.commit === factCommit).reverted).toBe(true);

    const recent = (await app.call("GET", "/api/knowledge/recent")).body.changes;
    expect(recent.map((c: { subject: string }) => c.subject)).toContain("Add duties/review.md");
  });

  it("never writes outside the brain, whatever page a session names", async () => {
    const app = await testApp();
    app.agent.on(
      { employee: "ada", stage: "retro" },
      {
        kind: "done",
        output: json({ edits: [{ layer: "brain", page: "../../handbook/policies/merging", text: "x" }] }),
      },
    );
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    await app.call("POST", "/api/tickets/1/decide", { decision: "approve" });
    await app.daemon.idle();
    const ada = (await app.call("GET", "/api/knowledge/brains/ada")).body;
    expect(ada.pages.map((p: { path: string }) => p.path)).toEqual(["INDEX.md", "personality.md"]);
    const handbook = (await app.call("GET", "/api/knowledge/handbook")).body;
    expect(handbook.pages.map((p: { path: string }) => p.path)).toEqual(["INDEX.md"]);
  });
});

describe("hiring", () => {
  it("makes a brain from the template and runs orientation as the first ticket", async () => {
    const app = await testApp();
    const hired = await app.call("POST", "/api/employees", {
      name: "Lin",
      role: "Senior Engineer",
      engines: { default: "sonnet", fallbacks: [] },
      projects: ["fintrack"],
    });
    expect(hired.status).toBe(201);
    await app.daemon.idle();

    const t = (await app.call("GET", `/api/tickets/${hired.body.orientation}`)).body.ticket;
    expect(t).toMatchObject({
      type: "orientation",
      column: "done",
      outcome: "done",
      assignee: { id: "lin" },
    });
    const lin = (await app.call("GET", "/api/knowledge/brains/lin")).body;
    expect(lin.pages.map((p: { path: string }) => p.path)).toEqual([
      "INDEX.md",
      "personality.md",
      "projects/fintrack.md",
    ]);
    expect(lin.pages[0].text).toContain("- [Fintrack](projects/fintrack.md)");
  });
});
