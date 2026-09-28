// A code ticket's branch and pull request (spec §6, stages 1 and 9), against the fake workspace.
import { describe, expect, it } from "vitest";
import { fold, runTicket } from "../src/index.ts";
import { FakeWorkspace } from "../src/testing/index.ts";
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

  it("isn't opened for an orientation, which has no code", async () => {
    const p = ports();
    const workspace = new FakeWorkspace();
    p.workspace = workspace;
    await runTicket(p, refundsTicket({ type: "orientation", effort: "low" }));
    expect(workspace.opened).toEqual([]);
  });
});
