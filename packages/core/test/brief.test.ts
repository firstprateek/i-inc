// The resume brief (M1 step 6): what a fresh session needs, including what its machine has and
// whether the checks ran, which M1's brief left out.
import { describe, expect, it } from "vitest";
import { runTicket } from "../src/index.ts";
import { ports, refundsTicket } from "./fixtures.ts";

describe("the brief", () => {
  it("says what the machine has and which checks the harness runs, and when they last passed", async () => {
    const p = ports();
    p.harness.description = ["Your machine has Node 24 and pnpm 10.", "The harness runs `pnpm test`."];
    await runTicket(p, refundsTicket());

    const build = p.agent.calls.find((c) => c.stage === "build");
    expect(build?.brief).toContain(
      "Your machine and the checks:\n- Your machine has Node 24 and pnpm 10.\n- The harness runs `pnpm test`.",
    );
    expect(build?.brief).not.toContain("The last check run passed.");
    const review = p.agent.calls.find((c) => c.stage === "review");
    expect(review?.brief).toContain("The last check run passed.");
  });
});
