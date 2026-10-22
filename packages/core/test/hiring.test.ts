// Hiring rules (spec §5 and §7).
import { describe, expect, it } from "vitest";
import { type Employee, hiringProblems, isLocalEngine, pickTint, tintCount } from "../src/index.ts";
import { ada, engines, pip, team } from "./fixtures.ts";

describe("hiring", () => {
  it("accepts a well-formed hire", () => {
    expect(hiringProblems({ ...ada, id: "lin", name: "Lin" }, engines, team)).toEqual([]);
  });

  it("refuses a duplicate, a nameless or duty-less hire, and unknown engines", () => {
    expect(
      hiringProblems(
        { ...ada, name: " ", duties: [], engines: { default: "gpt", fallbacks: [] } },
        engines,
        team,
      ),
    ).toEqual([
      "an employee needs a name",
      "someone called ada already works here",
      "an employee needs at least one duty",
      "there is no engine gpt",
    ]);
  });

  it("keeps a Personal Assistant on local engines only, fallbacks included", () => {
    const cloudy = { ...pip, id: "pip2" };
    expect(hiringProblems(cloudy, engines, team)).toEqual([
      "a Personal Assistant works on home data and its sandbox has no internet, so it may only use local engines, not gemini",
    ]);
    expect(
      hiringProblems({ ...cloudy, engines: { default: "qwen", fallbacks: ["qwen-moe"] } }, engines, team),
    ).toEqual([]);
  });

  it("checks every duty's engine for a Personal Assistant, and names each cloud engine once", () => {
    const perDuty = {
      ...pip,
      id: "pip3",
      engines: {
        default: "qwen",
        perDuty: { build: "opus", review: "opus", verify: "qwen-moe" },
        fallbacks: ["gemini"],
      },
    };
    expect(hiringProblems(perDuty, engines, team)).toEqual([
      "a Personal Assistant works on home data and its sandbox has no internet, so it may only use local engines, not opus, gemini",
    ]);
  });

  it("does not trust Codex's local flag: it is a cloud service", () => {
    const codex = { id: "codex", harness: "codex" as const, model: "m", accountId: "a", local: true };
    expect(isLocalEngine(codex)).toBe(false);
    expect(
      hiringProblems(
        { ...pip, id: "pip4", engines: { default: "codex", fallbacks: [] } },
        [...engines, codex],
        team,
      ),
    ).toHaveLength(1);
  });

  it("says plainly that no local engine is set up yet, rather than listing cloud engines", () => {
    const cloudOnly = engines.filter((x) => !x.local);
    const problems = hiringProblems(
      { ...pip, id: "pip5", engines: { default: "opus", fallbacks: [] } },
      cloudOnly,
      team,
    );
    expect(problems).toEqual([
      "a Personal Assistant works on home data and its sandbox has no internet, so it needs a local engine (OpenCode on Ollama), and none is set up yet: add one in Setup, then hire the Personal Assistant",
    ]);
  });
});

describe("avatar tints", () => {
  it("gives each new hire the tint fewest employees wear, so no two match until there are eight", () => {
    const hired: Employee[] = [];
    for (let i = 0; i < tintCount; i++) hired.push({ ...ada, id: `e${i}`, tint: pickTint(hired) });
    expect(new Set(hired.map((e) => e.tint)).size).toBe(tintCount);
    // The eighth repeats the first free-est tint; someone leaving frees theirs for the next hire.
    expect(pickTint(hired)).toBe(0);
    expect(pickTint(hired.filter((e) => e.tint !== 4))).toBe(4);
  });
});
