// A failed ticket tried again (the first real ticket needed it), and a report's minutes that count
// working time only.
import { describe, expect, it } from "vitest";
import { fold, retry, runTicket } from "../src/index.ts";
import { FakeWorkspace } from "../src/testing/index.ts";
import { ports, refundsTicket } from "./fixtures.ts";

describe("trying a failed ticket again", () => {
  it("resumes from the stage it failed in, and the days it sat failed don't count as work", async () => {
    const p = ports();
    const workspace = new FakeWorkspace();
    p.workspace = workspace;
    p.agent.on({ stage: "build" }, { kind: "stuck", reason: "the build tool crashed" });
    p.agent.on({ stage: "build" }, { kind: "stuck", reason: "the build tool crashed" });
    const first = await runTicket(p, refundsTicket());
    expect(first.status).toBe("failed");
    p.clock.advance(3 * 24 * 60); // it sits failed for three days
    await expect(retry(p, "42")).resolves.toBeUndefined();
    await expect(runTicket(p, refundsTicket())).resolves.toMatchObject({ status: "ready" });
    const s = fold(await p.store.read("42"));
    expect(s.finished).toContain("build");
    expect(workspace.opened).toEqual(["42"]);
    const builds = p.agent.calls.filter((c) => c.stage === "build");
    expect(builds.at(-1)?.brief).toContain("You are resuming this stage");
    expect(workspace.readied[0]?.report).not.toContain("4320");
    await expect(retry(p, "42")).rejects.toThrow("not failed");
  });
});
