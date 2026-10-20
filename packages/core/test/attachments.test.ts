// Images the owner adds after filing a ticket (#15): copied into the builder's worktree and named in
// the brief of its next session, whether the ticket was running or waiting on the owner. A reviewer
// or verifier, maybe on another team's machine, gets the branch and the images too (#17).
import { describe, expect, it } from "vitest";
import {
  answer,
  decide,
  type Employee,
  fold,
  runTicket,
  type Ticket,
  type TicketAttachment,
  type TicketEvent,
} from "../src/index.ts";
import { FakeWorkspace, fakePorts } from "../src/testing/index.ts";
import { engines, grace, ports, refundsTicket, team } from "./fixtures.ts";

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

/** The images copied in after pick-up for the builder's own machine. */
const forAda = (w: FakeWorkspace) => w.attached.filter((a) => a.employeeId === "ada");

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
    expect(forAda(workspace)).toEqual([{ ticketId: "42", employeeId: "ada", ns: [2] }]);
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
    const copied = events.filter((e) => e.type === "attachments-copied" && e.employeeId === "ada");
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
    expect(forAda(workspace)).toEqual([{ ticketId: "42", employeeId: "ada", ns: [1, 2] }]);
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
    expect(forAda(workspace)).toEqual([{ ticketId: "42", employeeId: "ada", ns: [1] }]);
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
    expect(forAda(workspace)).toEqual([]);
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

describe("a second employee reviews a ticket with images", () => {
  const paths = "- .inc/attachments/1-chart.png\n- .inc/attachments/2-receipt.jpg";
  const changes = {
    kind: "done" as const,
    output: JSON.stringify({
      approved: false,
      findings: [{ severity: "blocking", where: "chart.ts:3", text: "the colors don't match" }],
    }),
  };

  for (const mode of ["owner-merges", "direct"] as const) {
    it(`gets the branch and every image in its own machine before its session, and its brief lists them (${mode})`, async () => {
      const { p, workspace } = withWorkspace();
      p.company.policy = { ...p.company.policy, mode };
      if (mode === "direct") p.harness.gates.push({ ok: true, pushed: "a".repeat(40) });
      const ticket = refundsTicket({ attachments: [chart, receipt] });
      expect((await runTicket(p, ticket)).status).toBe(mode === "direct" ? "done" : "ready");

      // Ada's pick-up copied both; Grace (review) and Quinn (verify) got the branch, then the images.
      expect(workspace.calls).toEqual([
        "open ada",
        "checkout quinn",
        "attach quinn 1,2",
        "checkout grace",
        "attach grace 1,2",
      ]);
      const events = await p.store.read("42");
      const copied = events.findIndex((e) => e.type === "attachments-copied" && e.employeeId === "grace");
      const review = events.findIndex(
        (e) => e.type === "session-started" && e.stage === "review" && e.employeeId === "grace",
      );
      expect(copied).toBeGreaterThan(-1);
      expect(review).toBeGreaterThan(copied);
      expect(fold(events).copiedUpTo).toEqual({ ada: 2, grace: 2, quinn: 2 });

      const brief = p.agent.callsFor("grace", "review")[0]?.brief ?? "";
      expect(brief).toContain(`Images from the owner (open them):\n${paths}`);
      expect(p.agent.callsFor("quinn", "prove")[0]?.brief).toContain(paths);
    });
  }

  it("copies an image added before the next round once, and checks the branch out again", async () => {
    const { p, workspace } = withWorkspace();
    // Direct mode re-reviews once the builder addressed the findings.
    p.company.policy = { ...p.company.policy, mode: "direct" };
    p.harness.gates.push({ ok: true, pushed: "a".repeat(40) });
    const controllers: AbortController[] = [];
    const signal = () => {
      const c = new AbortController();
      controllers.push(c);
      return c.signal;
    };
    p.agent.on({ employee: "grace", duty: "review" }, changes);
    // Ada works on the findings while the owner adds an image.
    p.agent.on({ employee: "ada", stage: "review" }, { kind: "hang" });
    const run = runTicket(p, refundsTicket({ attachments: [chart] }), { signal });
    while (!p.agent.callsFor("ada", "review").length) await new Promise((r) => setTimeout(r, 0));
    p.clock.advance(1);
    await p.store.append("42", [attached(p.clock.now(), receipt)]);
    p.clock.advance(1);
    controllers.at(-1)?.abort("ended");

    expect((await run).status).toBe("done");
    expect(workspace.attached.filter((a) => a.employeeId === "grace")).toEqual([
      { ticketId: "42", employeeId: "grace", ns: [1] },
      { ticketId: "42", employeeId: "grace", ns: [2] },
    ]);
    expect(workspace.checkedOut.filter((x) => x.employeeId === "grace")).toHaveLength(2);
    const rounds = p.agent.callsFor("grace", "review");
    expect(rounds).toHaveLength(2);
    // A fresh-eyes brief lists every image, the new one with them.
    expect(rounds[1]?.brief).toContain(paths);
  });

  it("with no images, still checks the branch out but copies nothing", async () => {
    const { p, workspace } = withWorkspace();
    expect((await runTicket(p, refundsTicket())).status).toBe("ready");
    expect(workspace.checkedOut.map((x) => x.employeeId)).toEqual(["quinn", "grace"]);
    expect(workspace.attached).toEqual([]);
  });

  it("skips a reviewer whose machine can't take them, and the ticket isn't failed", async () => {
    const p = fakePorts([...team, { ...grace, id: "juno", name: "Juno" }], engines);
    const workspace = new FakeWorkspace();
    p.workspace = workspace;
    p.company.policy = { ...p.company.policy, mode: "direct" };
    p.harness.gates.push({ ok: true, pushed: "a".repeat(40) });
    const attach = workspace.attach.bind(workspace);
    workspace.attach = async (t: Ticket, e: Employee, ns: number[]) => {
      if (e.id === "grace") throw new Error("the machine is out of disk");
      return attach(t, e, ns);
    };

    expect(await runTicket(p, refundsTicket({ attachments: [chart] }))).toEqual({
      status: "done",
      outcome: "merged",
    });
    const events = await p.store.read("42");
    expect(events.find((e) => e.type === "helper-unavailable")).toMatchObject({
      duty: "review",
      employeeId: "grace",
      reason: "couldn't ready Grace's machine: the machine is out of disk",
    });
    expect(p.agent.callsFor("grace", "review")).toHaveLength(0);
    expect(p.agent.callsFor("juno", "review")[0]?.brief).toContain("- .inc/attachments/1-chart.png");
    expect(events.some((e) => e.type === "failed")).toBe(false);
  });

  it("throws a passing hiccup, so the next tick tries again", async () => {
    const { p, workspace } = withWorkspace();
    workspace.failCheckout = "git fetch failed: unable to access 'https://github.com/owner/repo.git'";
    await expect(runTicket(p, refundsTicket({ attachments: [chart] }))).rejects.toThrow("unable to access");
    expect(fold(await p.store.read("42")).status).not.toBe("failed");
  });
});
