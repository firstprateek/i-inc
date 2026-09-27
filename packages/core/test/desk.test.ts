// My desk's numbers (spec §10) and handing a paused ticket to someone else (spec §6).
import { describe, expect, it } from "vitest";
import { decide, fold, handOff, runTicket, sessionHours, spend, waits } from "../src/index.ts";
import { ports, refundsTicket } from "./fixtures.ts";

describe("spend", () => {
  const inputs = {
    accounts: [
      { id: "claude-pro", name: "Claude Pro", monthlyFee: 20 },
      { id: "api", name: "API key", pricePerMillionTokens: 3 },
    ],
    hosts: [{ id: "mini", name: "Mac mini", purchasePrice: 1080, idleWatts: 7, busyWatts: 60 }],
    pricePerKWh: 0.3,
    hoursInPeriod: 730,
    tokensByAccount: { api: 2_000_000 },
    busyHoursByHost: { mini: 100 },
    mergedPRs: 10,
  };

  it("adds subscriptions, API tokens, hardware over 36 months and electricity from busy hours", () => {
    const s = spend(inputs);
    const amounts = Object.fromEntries(
      s.lines.map((l) => [`${l.name} ${l.kind}`, Math.round(l.amount * 100) / 100]),
    );
    expect(amounts).toEqual({
      "Claude Pro subscription": 20,
      "API key api": 6,
      "Mac mini hardware": 30,
      // (7 W × 630 h + 60 W × 100 h) ÷ 1000 = 10.41 kWh × 0.30
      "Mac mini electricity": 3.12,
    });
    expect(Math.round(s.total * 100) / 100).toBe(59.12);
    expect(Math.round((s.perMergedPR ?? 0) * 100) / 100).toBe(5.91);
  });

  it("spreads fixed costs over the part of the month that has passed", () => {
    const half = spend({ ...inputs, hoursInPeriod: 365, busyHoursByHost: { mini: 0 } });
    expect(half.lines.find((l) => l.kind === "subscription")?.amount).toBe(10);
    expect(half.lines.find((l) => l.kind === "hardware")?.amount).toBe(15);
  });

  it("has no cost per PR before anything merges", () => {
    expect(spend({ ...inputs, mergedPRs: 0 }).perMergedPR).toBeNull();
  });
});

describe("the bottleneck", () => {
  it("finds where work waited longest: tokens, the owner's answers, or the owner's decisions", async () => {
    const p = ports();
    const resetsAt = p.clock.now() + 3 * 3_600_000;
    p.agent.on({ employee: "ada", stage: "build" }, { kind: "out-of-tokens", resetsAt });
    await runTicket(p, refundsTicket());
    p.clock.advance(180);
    await runTicket(p, refundsTicket());
    p.clock.advance(60);
    await decide(p, "42", "approve");

    const events = await p.store.read("42");
    const w = waits([events], p.clock.now());
    expect(w.map((x) => [x.reason, Math.round(x.hours)])).toEqual([
      ["tokens", 3],
      ["owner-decision", 1],
    ]);
    expect(Object.keys(sessionHours([events]))).toContain("opus");
  });
});

describe("a handoff", () => {
  it("lets another employee carry on a ticket paused on an empty account", async () => {
    const p = ports();
    p.agent.on(
      { employee: "ada", stage: "build" },
      { kind: "out-of-tokens", resetsAt: p.clock.now() + 3 * 3_600_000 },
    );
    expect((await runTicket(p, refundsTicket())).status).toBe("paused");

    await handOff(p, "42", "kit");
    const result = await runTicket(p, refundsTicket());

    expect(result.status).toBe("ready");
    const kitBuild = p.agent.callsFor("kit", "build")[0];
    expect(kitBuild?.brief).toContain("You are taking this ticket over from ada");
    expect(kitBuild?.brief).toContain("Plan:");
    expect(p.agent.callsFor("kit", "plan")).toHaveLength(0);
    expect(fold(await p.store.read("42")).assignee).toBe("kit");
    if (result.status === "ready")
      expect(result.report.byline).toMatch(/^Kit \(Claude Sonnet\), reviewed by Grace/);
  });

  it("refuses to hand off finished work", async () => {
    const p = ports();
    await runTicket(p, refundsTicket());
    await expect(handOff(p, "42", "kit")).rejects.toThrow("nothing to hand off");
  });
});
