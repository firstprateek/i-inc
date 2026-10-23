// The done-when check through the daemon (T72): a code ticket with no prove stage is checked by a fresh session
// that the scheduler picks, and the board, the ticket page's data and the report carry the result for each item.
import { json } from "@i-inc/core/testing";
import { describe, expect, it } from "vitest";
import { refunds, testApp } from "./setup.ts";

const item = (doneWhen: string, verdict: string, evidence = "the diff") => ({ doneWhen, verdict, evidence });
const say = (...items: ReturnType<typeof item>[]) => ({ kind: "done" as const, output: json({ items }) });
const asked = "August drops by the refund";

describe("the done-when check", () => {
  it("checks a low-effort ticket by someone else before it is ready, and shows the result on the ticket", async () => {
    const app = await testApp();
    app.agent.on({ stage: "done-when" }, say(item(asked, "met", "refunds.test.ts covers August")));
    await app.call("POST", "/api/tickets", { ...refunds, effort: "low" });
    await app.daemon.idle();

    const t = (await app.call("GET", "/api/tickets/1")).body.ticket;
    expect(t.status).toBe("ready");
    expect(t.stages.map((s: { id: string }) => s.id)).toContain("done-when");
    expect(t.stages.every((s: { state: string }) => s.state === "done")).toBe(true);
    expect(t.doneCheck).toMatchObject({
      by: { name: "Quinn" },
      items: [{ doneWhen: asked, verdict: "met", evidence: "refunds.test.ts covers August" }],
      note: null,
    });
    expect(t.report.doneWhen.items).toHaveLength(1);
    const calls = app.agent.calls.filter((c) => c.stage === "done-when");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.employee.id).not.toBe("ada");
    expect(calls[0]?.effort).toBe("low");
  });

  it("sends a ticket that is still not met after the builder's fix to the owner, with every item's result", async () => {
    const app = await testApp();
    app.agent.on(
      { stage: "done-when", duty: "verify" },
      say(item(asked, "not met", "nothing handles refunds")),
      say(item(asked, "not met", "still nothing")),
    );
    await app.call("POST", "/api/tickets", { ...refunds, effort: "low" });
    await app.daemon.idle();

    const t = (await app.call("GET", "/api/tickets/1")).body.ticket;
    expect(t.status).toBe("needs-you");
    expect(t.needsYou.kind).toBe("stuck");
    expect(t.needsYou.reason).toContain(`${asked} (not met: still nothing)`);
    expect(t.doneCheck.items).toMatchObject([{ verdict: "not-met", evidence: "still nothing" }]);
    expect(app.agent.callsFor("ada", "done-when")).toHaveLength(1);
    expect(app.harness.gateRuns).toBe(0);
  });

  it("goes to the owner on can't tell, without asking the builder to fix anything", async () => {
    const app = await testApp();
    app.agent.on(
      { stage: "done-when", duty: "verify" },
      say(item(asked, "can't tell", "needs the running app")),
    );
    await app.call("POST", "/api/tickets", { ...refunds, effort: "low" });
    await app.daemon.idle();
    const t = (await app.call("GET", "/api/tickets/1")).body.ticket;
    expect(t.status).toBe("needs-you");
    expect(t.doneCheck.items[0].verdict).toBe("cant-tell");
    expect(app.agent.callsFor("ada", "done-when")).toHaveLength(0);
  });

  it("keeps using the prove stage on a medium ticket with a verifier, and does not check twice", async () => {
    const app = await testApp();
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    const t = (await app.call("GET", "/api/tickets/1")).body.ticket;
    expect(t.status).toBe("ready");
    expect(app.agent.calls.filter((c) => c.stage === "prove")).toHaveLength(1);
    expect(app.agent.calls.filter((c) => c.stage === "done-when")).toHaveLength(0);
    expect(t.doneCheck).toMatchObject({ by: null, note: "Checked in the prove stage" });
  });

  it("says there was nothing to check when the ticket has no done-when", async () => {
    const app = await testApp();
    const made = await app.call("POST", "/api/tickets", { ...refunds, effort: "low", doneWhen: [] });
    expect(made.status).toBe(201);
    await app.daemon.idle();
    const t = (await app.call("GET", "/api/tickets/1")).body.ticket;
    expect(t.status).toBe("ready");
    expect(t.doneCheck).toEqual({ by: null, items: [], note: "No done-when to check" });
    expect(app.agent.calls.filter((c) => c.stage === "done-when")).toHaveLength(0);
  });
});
