// A code ticket's branch and pull request (spec §6, stages 1 and 9), against the fake workspace.
import { describe, expect, it } from "vitest";
import { fold, handOff, runTicket } from "../src/index.ts";
import { Crash, FakeWorkspace } from "../src/testing/index.ts";
import { ports, refundsTicket } from "./fixtures.ts";

describe("the ticket's pull request", () => {
  it("is opened as a draft at pick-up, named in every brief, and marked ready with the report", async () => {
    const p = ports();
    const workspace = new FakeWorkspace();
    p.workspace = workspace;
    const result = await runTicket(p, refundsTicket());

    expect(result.status).toBe("ready");
    expect(workspace.opened).toEqual(["42"]);
    const s = fold(await p.store.read("42"));
    expect(s.pr?.branch).toBe("inc/42-ada");
    for (const call of p.agent.calls) {
      expect(call.brief).toContain("Branch: inc/42-ada, with draft PR https://github.com/owner/repo/pull/42");
    }
    expect(workspace.readied).toHaveLength(1);
    const body = workspace.readied[0]?.report ?? "";
    expect(body.startsWith("## [fix] Refunds are counted as spending · Duet")).toBe(true);
    expect(body).toContain("Ada (Claude Opus), reviewed by Grace, 1 round · checks green");
    expect(body).toContain(s.outputs.report ?? "no report");
    if (result.status === "ready") expect(result.report.pr).toBe("https://github.com/owner/repo/pull/42");
  });

  it("fails the ticket honestly when GitHub refuses", async () => {
    const p = ports();
    const workspace = new FakeWorkspace();
    workspace.failOpen = "GitHub POST /pulls failed: 422 No commits between main and inc/42-ada";
    p.workspace = workspace;
    const result = await runTicket(p, refundsTicket());
    expect(result).toMatchObject({
      status: "failed",
      reason:
        "couldn't open the branch and draft PR: GitHub POST /pulls failed: 422 No commits between main and inc/42-ada",
    });
    expect(p.agent.calls).toHaveLength(0);
  });

  it("is made in the new builder's machine after a handoff, and only builders are told to push", async () => {
    const p = ports();
    const workspace = new FakeWorkspace();
    p.workspace = workspace;
    p.agent.on({ stage: "build", employee: "ada" }, { kind: "crash" });
    await expect(runTicket(p, refundsTicket())).rejects.toThrow(Crash);
    await handOff(p, "42", "kit");
    expect((await runTicket(p, refundsTicket())).status).toBe("ready");

    expect(workspace.openedFor).toEqual(["ada", "kit"]);
    const kits = p.agent.calls.filter((c) => c.employee.id === "kit");
    expect(kits.length).toBeGreaterThan(0);
    for (const call of kits) expect(call.brief).toContain("Commit to it and push.");
    const review = p.agent.calls.find((c) => c.stage === "review");
    expect(review?.brief).toContain("Check it out in your machine; don't push to it.");
  });

  it("tries again after a passing GitHub hiccup instead of failing", async () => {
    const p = ports();
    const workspace = new FakeWorkspace();
    workspace.failOpen = "GitHub POST /pulls failed: 502 Bad Gateway";
    p.workspace = workspace;
    await expect(runTicket(p, refundsTicket())).rejects.toThrow("502");
    workspace.failOpen = null;
    expect((await runTicket(p, refundsTicket())).status).toBe("ready");
  });

  it("isn't opened for an orientation, which has no code", async () => {
    const p = ports();
    const workspace = new FakeWorkspace();
    p.workspace = workspace;
    await runTicket(p, refundsTicket({ type: "orientation", effort: "low" }));
    expect(workspace.opened).toEqual([]);
  });
});
