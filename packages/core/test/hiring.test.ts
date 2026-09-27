// Hiring rules (spec §5 and §7).
import { describe, expect, it } from "vitest";
import { hiringProblems } from "../src/index.ts";
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
      "a Personal Assistant works on home data, so it may only use local engines, not gemini",
    ]);
    expect(
      hiringProblems({ ...cloudy, engines: { default: "qwen", fallbacks: ["qwen-moe"] } }, engines, team),
    ).toEqual([]);
  });
});
