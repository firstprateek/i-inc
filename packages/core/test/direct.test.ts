// Direct mode (decided 2026-10-17): a fresh-context review of at most 2 rounds, a push to main, CI on
// main with a fix or a revert, follow-ups, and nothing waiting for the owner but protected paths.
import { describe, expect, it } from "vitest";
import { answer, fold, runTicket } from "../src/index.ts";
import { fakePorts } from "../src/testing/index.ts";
import { ada, engines, ports, refundsTicket } from "./fixtures.ts";

const sha = (n: number) => String(n).repeat(40);
const direct = <T extends { company: { policy: { mode: string } } }>(p: T) => {
  p.company.policy = { ...p.company.policy, mode: "direct" };
  return p;
};

describe("direct mode", () => {
  it("reviews with fresh eyes, pushes to main, files follow-ups, and closes without the owner", async () => {
    const p = direct(ports());
    p.harness.gates.push({ ok: true, pushed: sha(1) });
    p.agent.on(
      { stage: "report" },
      {
        kind: "done",
        output: JSON.stringify({
          report: "Refunds now offset spending.",
          followUps: [
            {
              title: "Test refunds across months",
              doneWhen: ["a test covers it"],
              type: "chore",
              effort: "low",
              reason: "only same-month refunds are tested",
            },
          ],
        }),
      },
    );
    const result = await runTicket(p, refundsTicket());
    expect(result).toEqual({ status: "done", outcome: "merged" });

    const s = fold(await p.store.read("42"));
    expect(s.pushed).toBe(sha(1));
    expect(s.finished).toEqual([
      "pickup",
      "plan",
      "build",
      "checks",
      "prove",
      "review",
      "gates",
      "report",
      "retro",
    ]);
    const review = p.agent.calls.find((c) => c.stage === "review");
    expect(review?.employee.id).toBe("grace");
    expect(review?.brief).toContain("fresh eyes");
    expect(review?.brief).not.toContain("Plan:");
    const events = await p.store.read("42");
    expect(events.find((e) => e.type === "follow-ups")).toMatchObject({
      employeeId: "ada",
      tickets: [{ title: "Test refunds across months" }],
    });
    expect(events.some((e) => e.type === "needs-you")).toBe(false);
  });

  it("with no reviewer on the team, reviews in the builder's seat on a different engine", async () => {
    const p = direct(fakePorts([ada], engines));
    await runTicket(p, refundsTicket({ effort: "low" }));
    const review = p.agent.calls.find((c) => c.stage === "review");
    expect(review?.employee.id).toBe("ada");
    expect(review?.engine.id).not.toBe("opus");
    expect(review?.engine.harness).not.toBe("claude-code");
  });

  it("waits for the owner's OK on protected paths, then pushes with it", async () => {
    const p = direct(ports());
    p.harness.gates.push(
      {
        ok: false,
        conflict: false,
        reason: "touches protected paths",
        protectedPaths: [".github/workflows/ci.yml"],
      },
      { ok: true, pushed: sha(2) },
    );
    const first = await runTicket(p, refundsTicket({ effort: "low" }));
    expect(first).toEqual({
      status: "needs-you",
      ask: { kind: "protected-paths", paths: [".github/workflows/ci.yml"] },
    });
    await answer(p, "42", "approve");
    expect((await runTicket(p, refundsTicket({ effort: "low" }))).status).toBe("done");
    expect(p.harness.gateOpts.at(-1)).toMatchObject({
      ownerApproved: true,
      approvedPaths: [".github/workflows/ci.yml"],
    });
  });

  it("binds the owner's OK to the commit and the diff on the card, and a later card replaces it (T68)", async () => {
    const p = direct(ports());
    const card = (n: number) => ({
      ok: false as const,
      conflict: false,
      reason: "touches protected paths",
      protectedPaths: ["apps/x.ts"],
      approval: { sha: sha(n), patchId: `patch-${n}`, diff: `+change ${n}`, diffTruncated: true },
    });
    p.harness.gates.push(card(1), card(2), { ok: true, pushed: sha(2) });
    const first = await runTicket(p, refundsTicket({ effort: "low" }));
    // The card carries what the OK is for: the commit and the diff.
    expect(first).toEqual({
      status: "needs-you",
      ask: {
        kind: "protected-paths",
        paths: ["apps/x.ts"],
        sha: sha(1),
        patchId: "patch-1",
        diff: "+change 1",
        diffTruncated: true,
      },
    });
    await answer(p, "42", "approve");
    // The run after the OK is told what the OK was for.
    const second = await runTicket(p, refundsTicket({ effort: "low" }));
    expect(p.harness.gateOpts.at(-1)).toMatchObject({
      ownerApproved: true,
      approval: { sha: sha(1), patchId: "patch-1", paths: ["apps/x.ts"] },
    });
    // The host found other content: a new card, whose OK replaces the first (nothing adds up).
    expect(second).toMatchObject({ status: "needs-you", ask: { sha: sha(2), patchId: "patch-2" } });
    await answer(p, "42", "approve");
    expect((await runTicket(p, refundsTicket({ effort: "low" }))).status).toBe("done");
    expect(p.harness.gateOpts.at(-1)).toMatchObject({
      approval: { sha: sha(2), patchId: "patch-2", paths: ["apps/x.ts"] },
    });
  });

  it("has the builder fix red CI on main, and reverts the push if main is still red 2 hours on", async () => {
    const fixed = direct(ports());
    fixed.harness.gates.push({ ok: true, pushed: sha(3) }, { ok: true, pushed: sha(4) });
    fixed.harness.ci.push({ ok: false, reason: "CI failed: Lint, types and tests (failure)" });
    expect((await runTicket(fixed, refundsTicket({ effort: "low" }))).status).toBe("done");
    const fix = fixed.agent.calls.find((c) => c.stage === "gates");
    expect(fix?.brief).toContain("CI failed on main after your push (3333333)");
    expect(fixed.harness.reverted).toEqual([]);

    const red = direct(ports());
    red.harness.watchCi = async () => {
      red.clock.advance(70);
      return { ok: false, reason: "CI failed: Lint, types and tests (failure)" };
    };
    red.harness.gates.push(
      { ok: true, pushed: sha(5) },
      { ok: true, pushed: sha(6) },
      { ok: true, pushed: sha(7) },
    );
    const result = await runTicket(red, refundsTicket({ effort: "low" }));
    expect(result).toMatchObject({ status: "failed" });
    expect(result.status === "failed" ? result.reason : "").toContain(
      "main stayed red for 2 hours after 5555555",
    );
    expect(red.harness.reverted).toEqual([sha(5)]);
  });

  it("resumes watching CI after a restart without pushing a second time", async () => {
    const p = direct(ports());
    let gateCalls = 0;
    p.harness.runGates = async () => {
      gateCalls++;
      return { ok: true, conflict: false, pushed: sha(8) };
    };
    let interruptedOnce = false;
    p.harness.watchCi = async () => {
      if (!interruptedOnce) {
        interruptedOnce = true;
        throw new Error("daemon restarted mid-watchCi");
      }
      return { ok: true };
    };
    await expect(runTicket(p, refundsTicket({ effort: "low" }))).rejects.toThrow(
      "daemon restarted mid-watchCi",
    );
    expect(gateCalls).toBe(1);
    const resumed = await runTicket(p, refundsTicket({ effort: "low" }));
    expect(resumed).toEqual({ status: "done", outcome: "merged" });
    expect(gateCalls).toBe(1);
  });
});

describe("reading agents' JSON replies", () => {
  it("takes JSON on its own, in a code fence, or inside a sentence", async () => {
    const { parseJson } = await import("../src/runner.ts");
    const verdict = { approved: true, findings: [] };
    expect(parseJson(JSON.stringify(verdict))).toEqual(verdict);
    expect(parseJson(`Here's my review.\n\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\`\n`)).toEqual(
      verdict,
    );
    expect(parseJson(`Looks good: ${JSON.stringify(verdict)} That's all.`)).toEqual(verdict);
    expect(parseJson("No JSON here.")).toBeNull();
  });

  it("goes on when the reviewer wraps its verdict in prose", async () => {
    const p = direct(ports());
    p.agent.on(
      { stage: "review" },
      { kind: "done", output: 'Reviewed.\n```json\n{"approved": true, "findings": []}\n```' },
    );
    expect((await runTicket(p, refundsTicket({ effort: "low" }))).status).toBe("done");
  });
});
