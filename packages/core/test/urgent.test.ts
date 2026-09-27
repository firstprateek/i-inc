// An urgent chat message stops the session and starts the stage again with the message first
// (spec §10, "Chat"). An ordinary one waits for the next stage boundary.
import { describe, expect, it } from "vitest";
import { runTicket } from "../src/index.ts";
import { ports, refundsTicket } from "./fixtures.ts";

describe("an urgent message", () => {
  it("restarts the interrupted stage with the message first", async () => {
    const p = ports();
    const controllers: AbortController[] = [];
    const signal = () => {
      const c = new AbortController();
      controllers.push(c);
      return c.signal;
    };
    p.agent.on({ stage: "build" }, { kind: "hang" });
    const run = runTicket(p, refundsTicket(), { signal });

    // Wait for the build session to start, then send the message and stop it.
    while (!p.agent.callsFor("ada", "build").length) await new Promise((r) => setTimeout(r, 0));
    p.clock.advance(1);
    await p.store.append("42", [
      {
        type: "owner-message",
        at: p.clock.now(),
        text: "Use the ledger's sign, not the category",
        urgent: true,
      },
      { type: "owner-message", at: p.clock.now(), text: "Nice work so far" },
    ]);
    controllers.at(-1)?.abort("urgent");

    expect((await run).status).toBe("ready");
    const builds = p.agent.callsFor("ada", "build");
    expect(builds).toHaveLength(2);
    expect(builds[1]?.brief).toContain("The owner stopped your last session with an urgent message");
    expect(builds[1]?.brief).toContain("- Use the ledger's sign, not the category");
    // The ordinary note still waits for the next stage.
    expect(builds[1]?.brief).not.toContain("Nice work so far");
    expect(p.agent.callsFor("ada", "report")[0]?.brief).toContain("Nice work so far");
    expect(p.agent.callsFor("ada", "report")[0]?.brief).not.toContain("stopped your last session");
  });
});
