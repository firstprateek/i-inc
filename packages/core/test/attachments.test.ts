// Images the owner adds after filing a ticket (#15): copied into the builder's worktree and named in
// the brief of its next session, whether the ticket was running or waiting on the owner.
import { describe, expect, it } from "vitest";
import { answer, decide, fold, runTicket, type TicketAttachment, type TicketEvent } from "../src/index.ts";
import { FakeWorkspace } from "../src/testing/index.ts";
import { ports, refundsTicket } from "./fixtures.ts";

const chart: TicketAttachment = { n: 1, name: "chart.png", mime: "image/png", size: 10 };
const receipt: TicketAttachment = { n: 2, name: "receipt.jpg", mime: "image/jpeg", size: 20 };
const attached = (at: number, ...attachments: TicketAttachment[]): TicketEvent => ({
  type: "owner-attached",
  at,
  attachments,
});

function withWorkspace() {
  const p = ports();
  const workspace = new FakeWorkspace();
  p.workspace = workspace;
  return { p, workspace };
}

describe("images added to an existing ticket", () => {
  it("reach a running ticket at its next session, copied once and before it starts", async () => {
    const { p, workspace } = withWorkspace();
    const controllers: AbortController[] = [];
    const signal = () => {
      const c = new AbortController();
      controllers.push(c);
      return c.signal;
    };
    // The build session runs on while the owner adds an image; it ends by itself (here, an abort).
    p.agent.on({ stage: "build" }, { kind: "hang" });
    const run = runTicket(p, refundsTicket({ attachments: [chart] }), { signal });
    while (!p.agent.callsFor("ada", "build").length) await new Promise((r) => setTimeout(r, 0));
    expect(workspace.attached).toEqual([]);

    p.clock.advance(1);
    await p.store.append("42", [attached(p.clock.now(), receipt)]);
    p.clock.advance(1);
    controllers.at(-1)?.abort("ended");

    expect((await run).status).toBe("ready");
    // Pick-up copied the first image; the second was copied once, for Ada's next session.
    expect(workspace.attached).toEqual([{ ticketId: "42", employeeId: "ada", ns: [2] }]);
    const builds = p.agent.callsFor("ada", "build");
    expect(builds).toHaveLength(2);
    expect(builds[0]?.brief).not.toContain("receipt");
    expect(builds[1]?.brief).toContain(
      "Images from the owner (open them):\n- .inc/attachments/1-chart.png\n- .inc/attachments/2-receipt.jpg",
    );
    expect(builds[1]?.brief).toContain(
      "The owner added images since your last session (open them):\n- .inc/attachments/2-receipt.jpg",
    );
    expect(builds[1]?.ticket.attachments).toEqual([chart, receipt]);
    // Only the session right after hears it's new.
    expect(p.agent.callsFor("ada", "report")[0]?.brief).not.toContain("since your last session");

    const events = await p.store.read("42");
    const copied = events.filter((e) => e.type === "attachments-copied");
    expect(copied.map((e) => e.type === "attachments-copied" && e.upTo)).toEqual([1, 2]);
    // The copy comes before the session that needs it.
    const copiedAt = events.findIndex((e) => e.type === "attachments-copied" && e.upTo === 2);
    const second = events.findIndex(
      (e, i) => i > copiedAt && e.type === "session-started" && e.stage === "build",
    );
    expect(second).toBeGreaterThan(copiedAt);
  });

  it("reach a ticket waiting on the owner in the first session after the answer", async () => {
    const { p, workspace } = withWorkspace();
    p.agent.on({ duty: "plan" }, { kind: "done", output: "Add an alerts table: a schema migration." });
    expect((await runTicket(p, refundsTicket())).status).toBe("needs-you");

    p.clock.advance(5);
    await p.store.append("42", [attached(p.clock.now(), chart, receipt)]);
    expect(fold(await p.store.read("42")).status).toBe("needs-you");
    await answer(p, "42", "approve");

    // The daemon runs the ticket with what it had stored; the events carry the rest.
    expect((await runTicket(p, refundsTicket())).status).toBe("ready");
    expect(workspace.attached).toEqual([{ ticketId: "42", employeeId: "ada", ns: [1, 2] }]);
    const build = p.agent.callsFor("ada", "build")[0]?.brief ?? "";
    expect(build).toContain("- .inc/attachments/1-chart.png\n- .inc/attachments/2-receipt.jpg");
    expect(build).toContain("The owner added images since your last session");
  });

  it("go with a 'Not quite' reply, into the Build brief beside the note", async () => {
    const { p, workspace } = withWorkspace();
    expect((await runTicket(p, refundsTicket())).status).toBe("ready");
    p.clock.advance(5);
    await p.store.append("42", [attached(p.clock.now(), chart)]);
    await decide(p, "42", "changes", "match the colors in the chart");

    expect((await runTicket(p, refundsTicket())).status).toBe("ready");
    expect(workspace.attached).toEqual([{ ticketId: "42", employeeId: "ada", ns: [1] }]);
    // The same branch and PR: nothing new is opened, and the report goes to the same PR.
    expect(workspace.opened).toEqual(["42"]);
    expect(workspace.readied).toHaveLength(2);
    const build = p.agent.callsFor("ada", "build")[1]?.brief ?? "";
    expect(build).toContain("The owner asked for changes: match the colors in the chart");
    expect(build).toContain(
      "The owner added images since your last session (open them):\n- .inc/attachments/1-chart.png",
    );
  });

  it("are copied at pick-up when they come before it, and not again", async () => {
    const { p, workspace } = withWorkspace();
    await p.store.append("42", [attached(p.clock.now(), chart)]);
    p.clock.advance(1);
    expect((await runTicket(p, refundsTicket())).status).toBe("ready");
    expect(workspace.attached).toEqual([]);
    const build = p.agent.callsFor("ada", "build")[0]?.brief ?? "";
    expect(build).toContain("Images from the owner (open them):\n- .inc/attachments/1-chart.png");
    expect(build).not.toContain("since your last session");
  });

  it("fails the ticket with the reason when the copy fails", async () => {
    const { p, workspace } = withWorkspace();
    p.agent.on({ duty: "plan" }, { kind: "done", output: "Add an alerts table: a schema migration." });
    await runTicket(p, refundsTicket());
    await p.store.append("42", [attached(p.clock.now(), chart)]);
    await answer(p, "42", "approve");
    workspace.failAttach = "the machine is out of disk";

    expect(await runTicket(p, refundsTicket())).toMatchObject({
      status: "failed",
      reason: "couldn't copy the owner's images: the machine is out of disk",
    });
    expect(p.agent.callsFor("ada", "build")).toHaveLength(0);
  });
});
