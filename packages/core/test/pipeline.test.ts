// The M2 cases from the spec (§9, "Tests"), run end to end against the fakes.
import { describe, expect, it } from "vitest";
import { answer, fold, runTicket } from "../src/index.ts";
import { Crash, json } from "../src/testing/index.ts";
import { ada, grace, kit, ports, refundsTicket } from "./fixtures.ts";

describe("the happy path", () => {
  it("takes a Medium fix through every stage to a ready report", async () => {
    const p = ports();
    const result = await runTicket(p, refundsTicket());

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.report.title).toBe("[fix] Refunds are counted as spending · Duet");
    expect(result.report.byline).toBe("Ada (Claude Opus), reviewed by Grace, 1 round");
    expect(result.report.engines).toBeNull();

    const s = fold(await p.store.read("42"));
    expect(s.finished).toEqual(["pickup", "plan", "build", "checks", "prove", "review", "gates", "report"]);
    expect(p.agent.callsFor("quinn", "prove")).toHaveLength(1);
    expect(p.harness.gateRuns).toBe(1);
  });

  it("skips plan, proof and review on Low effort", async () => {
    const p = ports();
    await runTicket(p, refundsTicket({ effort: "low" }));
    const s = fold(await p.store.read("42"));
    expect(s.finished).toEqual(["pickup", "build", "checks", "gates", "report"]);
    expect(p.agent.calls.some((c) => c.employee.id === grace.id)).toBe(false);
  });

  it("never lets the builder review its own work", async () => {
    const p = ports();
    await runTicket(p, refundsTicket({ assignee: "grace" }));
    const reviewers = p.agent.calls.filter((c) => c.duty === "review").map((c) => c.employee.id);
    expect(reviewers).not.toContain("grace");
  });
});

describe("the plan gate", () => {
  it("waits for the owner when a Medium plan touches the schema", async () => {
    const p = ports();
    p.agent.on({ duty: "plan" }, { kind: "done", output: "Add an alerts table: a schema migration." });

    const first = await runTicket(p, refundsTicket());
    expect(first).toEqual({
      status: "needs-you",
      ask: { kind: "plan-gate", plan: "Add an alerts table: a schema migration." },
    });

    await answer(p, "42", "approve");
    expect((await runTicket(p, refundsTicket())).status).toBe("ready");
  });

  it("fails honestly when the owner rejects the plan", async () => {
    const p = ports();
    await runTicket(p, refundsTicket({ effort: "high" }));
    await answer(p, "42", "reject");
    const result = await runTicket(p, refundsTicket({ effort: "high" }));
    expect(result).toMatchObject({ status: "failed", reason: "the owner rejected the plan" });
  });
});

describe("a quota pause", () => {
  it("waits for the account to reset, then resumes the stage with a resume brief", async () => {
    const p = ports();
    const resetsAt = p.clock.now() + 3 * 60 * 60_000;
    p.agent.on({ employee: "ada", stage: "build" }, { kind: "out-of-tokens", resetsAt });

    expect(await runTicket(p, refundsTicket())).toEqual({ status: "paused", until: resetsAt });
    p.clock.advance(60);
    expect(await runTicket(p, refundsTicket())).toEqual({ status: "paused", until: resetsAt });

    p.clock.advance(121);
    expect((await runTicket(p, refundsTicket())).status).toBe("ready");

    const builds = p.agent.callsFor("ada", "build");
    expect(builds).toHaveLength(2);
    expect(builds[1]?.brief).toContain("You are resuming this stage");
    expect(builds[1]?.engine.id).toBe("opus");
  });

  it("moves to a fallback engine after waiting, when the switch rule says so", async () => {
    const q = ports({
      ...ada,
      switchRules: { ...ada.switchRules, outOfTokens: { action: "fallback", afterMinutes: 30 } },
    });
    const p = q;
    q.agent.on(
      { employee: "ada", stage: "build", engine: "opus" },
      { kind: "out-of-tokens", resetsAt: p.clock.now() + 3 * 60 * 60_000 },
    );

    expect((await runTicket(q, refundsTicket())).status).toBe("paused");
    p.clock.advance(31);
    const result = await runTicket(q, refundsTicket());

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.report.engines).toBe(
      "started on Claude Opus; moved to Gemini 3 Pro for build after Claude Opus ran out of tokens",
    );
  });
});

describe("an engine switch partway through a stage", () => {
  it("moves a stuck builder to its fallback after 3 failed check runs, keeping the branch and plan", async () => {
    const p = ports();
    const red = { green: false, failures: ["csv.test.ts: parses 03/04/2026"] };
    p.harness.checks.push(red, red, red);

    const result = await runTicket(
      p,
      refundsTicket({ id: "18", title: "CSV import", project: "fintrack", type: "feat", assignee: "kit" }),
    );

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.report.engines).toBe(
      "started on Claude Sonnet; moved to Gemini 3 Pro for checks after 3 failed check runs",
    );

    const afterSwitch = p.agent.calls.find((c) => c.employee.id === "kit" && c.engine.id === "gemini");
    expect(afterSwitch?.stage).toBe("checks");
    expect(afterSwitch?.brief).toContain("Engine switched from sonnet: 3 failed check runs.");
    expect(afterSwitch?.brief).toContain("Plan:");
    expect(afterSwitch?.brief).toContain("csv.test.ts: parses 03/04/2026");
  });

  it("fails honestly, naming what was tried, when there is no fallback left", async () => {
    const p = ports();
    const red = { green: false, failures: ["lint: 2 errors"] };
    p.harness.checks.push(red, red, red, red, red, red);

    const result = await runTicket(p, refundsTicket({ assignee: "kit" }));
    expect(result).toEqual({
      status: "failed",
      reason: "3 failed check runs",
      tried: ["Claude Sonnet", "Gemini 3 Pro"],
    });
  });
});

describe("a review deadlock", () => {
  it("goes to the owner with both sides after the rounds run out, and carries on once settled", async () => {
    const p = ports();
    const changes = {
      kind: "done" as const,
      output: json({
        approved: false,
        findings: [
          { severity: "blocking", where: "sync/cache.ts:40", text: "the cache goes stale after a sync" },
        ],
      }),
    };
    const dispute = {
      kind: "done" as const,
      output: json({ disputed: "sync clears the cache in after.ts" }),
    };
    p.agent.on({ employee: "grace", duty: "review" }, changes, changes);
    p.agent.on({ employee: "ada", stage: "review" }, dispute, dispute);
    const ticket = refundsTicket({ effort: "high" });

    expect((await runTicket(p, ticket)).status).toBe("needs-you"); // High effort always gates the plan
    await answer(p, "42", "approve");

    const deadlock = await runTicket(p, ticket);
    expect(deadlock).toEqual({
      status: "needs-you",
      ask: {
        kind: "disagreement",
        builder: "sync clears the cache in after.ts",
        reviewer: "sync/cache.ts:40: the cache goes stale after a sync",
      },
    });
    expect(p.agent.callsFor("grace", "review")).toHaveLength(2);
    expect(p.agent.callsFor("grace", "review")[1]?.brief).toContain("Builder's reply to the findings");

    await answer(p, "42", "builder");
    const result = await runTicket(p, ticket);
    expect(result.status).toBe("ready");
    if (result.status === "ready")
      expect(result.report.byline).toBe("Ada (Claude Opus), reviewed by Grace, 2 rounds");
  });

  it("goes on without the owner when the builder fixes every finding", async () => {
    const p = ports();
    p.agent.on(
      { employee: "grace", duty: "review" },
      {
        kind: "done",
        output: json({
          approved: false,
          findings: [{ severity: "nit", where: "ui/list.ts:12", text: "rename total" }],
        }),
      },
    );
    expect((await runTicket(p, refundsTicket())).status).toBe("ready");
  });
});

describe("flaky checks", () => {
  it("fixes and reruns after a red run, without switching engine", async () => {
    const p = ports();
    p.harness.checks.push({ green: false, failures: ["e2e: timeout"] });

    const result = await runTicket(p, refundsTicket());

    expect(result.status).toBe("ready");
    expect(p.harness.checkRuns).toBe(2);
    expect(p.agent.callsFor("ada", "checks")).toHaveLength(1);
    expect(fold(await p.store.read("42")).switches).toEqual([]);
  });
});

describe("a daemon crash", () => {
  it("resumes the interrupted stage from the event log with a resume brief", async () => {
    const p = ports();
    p.agent.on({ employee: "ada", stage: "build" }, { kind: "crash" });

    await expect(runTicket(p, refundsTicket())).rejects.toBeInstanceOf(Crash);
    const beforeRestart = fold(await p.store.read("42"));
    expect(beforeRestart.active).toBe("build");
    expect(beforeRestart.interrupted).toBe(true);

    // A new daemon: same event log, nothing in memory.
    expect((await runTicket(p, refundsTicket())).status).toBe("ready");
    const builds = fold(await p.store.read("42")).sessions.filter((x) => x.stage === "build");
    expect(builds.map((b) => b.resume)).toEqual([false, true]);
    expect(p.agent.callsFor("ada", "build")[1]?.brief).toContain("You are resuming this stage");
    expect(p.agent.callsFor("ada", "plan")).toHaveLength(1);
  });
});

describe("a rebase conflict", () => {
  it("has the builder resolve it once, then passes the gates", async () => {
    const p = ports();
    p.harness.gates.push({ ok: false, conflict: true, reason: "conflict in core/sorter.ts" });

    expect((await runTicket(p, refundsTicket())).status).toBe("ready");
    expect(p.harness.gateRuns).toBe(2);
    expect(p.agent.callsFor("ada", "gates")).toHaveLength(1);
  });

  it("fails honestly when the conflict comes back", async () => {
    const p = ports();
    const conflict = { ok: false as const, conflict: true, reason: "conflict in core/sorter.ts" };
    p.harness.gates.push(conflict, conflict);

    expect(await runTicket(p, refundsTicket())).toMatchObject({
      status: "failed",
      reason: "the rebase on main conflicted again after a fix",
    });
  });
});

describe("engines", () => {
  it("uses the engine per duty for that duty only", async () => {
    const p = ports({ ...kit, engines: { ...kit.engines, perDuty: { plan: "opus" } } });
    const q = p;
    await runTicket(q, refundsTicket({ assignee: "kit" }));
    expect(p.agent.callsFor("kit", "plan")[0]?.engine.id).toBe("opus");
    expect(p.agent.callsFor("kit", "build")[0]?.engine.id).toBe("sonnet");
  });

  it("switches away from the engine the stuck duty was actually using", async () => {
    const p = ports({ ...kit, engines: { ...kit.engines, perDuty: { plan: "opus" } } });
    p.agent.on(
      { employee: "kit", duty: "plan", engine: "opus" },
      { kind: "stuck", reason: "cannot find the importer" },
    );

    await runTicket(p, refundsTicket({ assignee: "kit" }));
    const s = fold(await p.store.read("42"));
    expect(s.switches).toEqual([
      { stage: "plan", from: "opus", to: "gemini", reason: "the agent is stuck: cannot find the importer" },
    ]);
  });

  it("keeps home data on local engines: an errand never falls back to a cloud engine", async () => {
    const p = ports();
    p.agent.on({ employee: "pip", engine: "qwen" }, { kind: "stuck", reason: "the model loops" });
    const errand = refundsTicket({
      id: "e1",
      title: "Reply to the dentist",
      project: "Home",
      type: "errand",
      effort: "low",
      assignee: "pip",
    });

    expect((await runTicket(p, errand)).status).toBe("done");
    const engines = p.agent.callsFor("pip").map((c) => c.engine.id);
    expect(engines).not.toContain("gemini");
    expect(engines).toContain("qwen-moe");
    expect(p.agent.calls.every((c) => c.engine.local)).toBe(true);
  });
});
