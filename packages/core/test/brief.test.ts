// The resume brief (M1 step 6): what a fresh session needs, including what its machine has and
// whether the checks ran, which M1's brief left out.
import { describe, expect, it } from "vitest";
import { brief, emptyState, freshBrief, runTicket } from "../src/index.ts";
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

  it("lists the owner's images as files in the worktree, and says nothing of them when there are none", () => {
    const ticket = refundsTicket({
      attachments: [
        { n: 1, name: "chart.png", mime: "image/png", size: 10 },
        { n: 2, name: "receipt.jpg", mime: "image/jpeg", size: 20 },
      ],
    });
    const list =
      "Images from the owner (open them):\n- .inc/attachments/1-chart.png\n- .inc/attachments/2-receipt.jpg";
    expect(brief(ticket, "build", emptyState(), "Build it.")).toContain(
      `a test covers it\n${list}\nStage: build`,
    );
    expect(freshBrief(ticket, "review", "Review it.")).toContain(list);
    expect(brief(refundsTicket(), "build", emptyState(), "Build it.")).not.toContain("Images");
    expect(freshBrief(refundsTicket(), "review", "Review it.")).not.toContain("Images");
  });
});
