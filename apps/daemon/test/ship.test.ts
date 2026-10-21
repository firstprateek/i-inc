// Shipping a conversation's work (T62b): "Make this a ticket" and "Open a PR". The sandbox's scripts run in
// real bash against real git (a local bare repo is GitHub's remote), so a commit, a push, a rebase onto main
// and a protected path are the real thing. The agents and GitHub's pull request API are fakes.
import { afterEach, describe, expect, it } from "vitest";
import { type ShipRig, shipRig, until } from "./ship-rig.ts";

const rigs: ShipRig[] = [];
const make = async (...a: Parameters<typeof shipRig>) => {
  const r = await shipRig(...a);
  rigs.push(r);
  return r;
};
afterEach(() => {
  rigs.length = 0;
});

const ticketEvents = async (rig: ShipRig, id: string) =>
  (await rig.app.deps.store.read(id)).map((e) => e.type);

describe("make this a ticket, in direct mode", () => {
  it("commits what the agent left, enters the pipeline at the checks, and pushes to main after the review", async () => {
    const rig = await make({ mode: "direct" });
    const c = await rig.conversation();
    c.write("hello.txt", "hello\n");
    const base = rig.originGit("rev-parse", "main");

    const r = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {
      title: "Add a greeting file",
      doneWhen: ["hello.txt says hello"],
    });
    expect(r.status).toBe(201);
    expect(r.body.created).toBe(true);
    const id = r.body.ticket.id;
    expect(r.body.ticket).toMatchObject({
      title: "Add a greeting file",
      project: "Duet",
      conversation: c.conv.id,
      branch: `conv/${c.conv.id}`,
      assignee: "ada",
      doneWhen: ["hello.txt says hello"],
    });
    // The copy was committed on the conversation's branch, by the employee, with a plain message.
    expect(c.git("log", "-1", "--format=%an|%s")).toMatch(/^Ada \(i\.inc\)\|feat: Add a greeting file$/);
    expect(c.git("status", "--porcelain")).toBe("");

    await rig.settle();
    // Plan and build were done by the conversation; the pipeline began at the checks.
    const events = await ticketEvents(rig, id);
    expect(events.slice(0, 5)).toEqual([
      "ticket-created",
      "pr-opened",
      "stage-finished",
      "stage-finished",
      "stage-finished",
    ]);
    const s = await rig.app.daemon.state(id);
    expect(s.finished.slice(0, 3)).toEqual(["pickup", "plan", "build"]);
    expect(s.finished).toContain("checks");
    expect(s.finished).toContain("review");
    expect(s.finished).toContain("gates");
    expect(s.outcome).toBe("merged");
    // No session was spent on plan or build.
    expect(rig.agent.calls.map((x) => x.stage)).not.toContain("plan");
    expect(rig.agent.calls.map((x) => x.stage)).not.toContain("build");
    // The reviewed work is on main, and the ticket worked in the conversation's folder.
    expect(rig.originGit("rev-parse", "main")).not.toBe(base);
    expect(rig.originGit("show", "main:hello.txt")).toBe("hello");
    expect(rig.ciOn).toHaveLength(1);
  });
});
