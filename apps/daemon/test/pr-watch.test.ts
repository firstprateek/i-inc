// Owner-merges: the owner merges the PR on GitHub, and i.inc notices (T63 7.1). There is no Approve for a ticket
// whose PR is open; a merged PR records `merged` (so auto-release follows), a PR closed without merging records a
// rejection, and GitHub is asked gently.
import { FakeWorkspace } from "@i-inc/core/testing";
import { describe, expect, it } from "vitest";
import { Daemon } from "../src/daemon.ts";
import { refunds, testApp } from "./setup.ts";

async function ready(o: { mode?: "owner-merges" | "direct"; limited?: { on: boolean } } = {}) {
  const app = await testApp();
  app.deps.registry.addProject({
    id: "Duet",
    repo: "firstprateek/duet",
    checks: [],
    mode: o.mode ?? "owner-merges",
    autoRelease: true,
  });
  const ws = new FakeWorkspace();
  let looks = 0;
  const look = ws.prState.bind(ws);
  ws.prState = async (t) => {
    looks++;
    if (o.limited?.on) {
      throw Object.assign(new Error("GitHub rate limit"), { rateLimited: true, retryAfterSec: 20 * 60 });
    }
    return look(t);
  };
  app.deps.workspace = ws;
  await app.call("POST", "/api/tickets", refunds);
  await app.daemon.idle();
  const status = (await app.call("GET", "/api/tickets/1")).body.ticket.status;
  expect(status).toBe(o.mode === "direct" ? "done" : "ready");
  return { app, ws, looks: () => looks };
}

describe("a ready owner-merges ticket", () => {
  it("shows the PR to merge on GitHub, and refuses Approve while the PR is open", async () => {
    const { app } = await ready();
    const t = (await app.call("GET", "/api/tickets/1")).body.ticket;
    expect(t.mergeOnGitHub).toEqual({ number: 1, url: "https://github.com/owner/repo/pull/1" });
    const board = (await app.call("GET", "/api/board")).body.tickets;
    expect(board.find((x: { id: string }) => x.id === "1").mergeOnGitHub).toMatchObject({ number: 1 });

    const approve = await app.call("POST", "/api/tickets/1/decide", { decision: "approve" });
    expect(approve.status).toBe(409);
    expect(approve.body.error).toContain("merge the PR on GitHub first");
    expect((await app.call("GET", "/api/tickets/1")).body.ticket.status).toBe("ready");
    // Closing without merging is still the owner's call.
    expect((await app.call("POST", "/api/tickets/1/decide", { decision: "reject" })).status).toBe(200);
  });

  it("is recorded as merged, and released, once the PR is seen merged on GitHub", async () => {
    const { app, ws } = await ready();
    ws.prStates.set("1", "merged");
    app.clock.advance(6); // the PR was looked at when the ticket became ready; the next look is 5 minutes on
    await app.daemon.tick();
    await app.daemon.idle();
    const t = (await app.call("GET", "/api/tickets/1")).body.ticket;
    expect(t).toMatchObject({ status: "done", outcome: "merged" });
    expect(t.mergeOnGitHub).toBeUndefined();
    // Auto-release trusts that outcome.
    await app.daemon.tick();
    const releases = app.deps.registry.releases().filter((r) => r.project === "Duet");
    expect(releases.some((r) => r.ticketIds.includes("1"))).toBe(true);
    // An Approve afterwards is for a ticket that is no longer waiting.
    expect((await app.call("POST", "/api/tickets/1/decide", { decision: "approve" })).status).toBe(409);
  });

  it("records merged, and says so, when the owner taps Close without merging after merging on GitHub", async () => {
    const { app, ws } = await ready();
    ws.prStates.set("1", "merged"); // merged on GitHub, within the watch window: the daemon hasn't looked yet
    const res = await app.call("POST", "/api/tickets/1/decide", { decision: "reject" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ merged: true, message: "That PR was already merged" });
    await app.daemon.idle();
    expect((await app.call("GET", "/api/tickets/1")).body.ticket).toMatchObject({
      status: "done",
      outcome: "merged",
    });
    expect(ws.closedPrs).toEqual([]);
    await app.daemon.tick();
    expect(app.deps.registry.releases().some((r) => r.ticketIds.includes("1"))).toBe(true);
  });

  it("closes the open PR, and says nothing special, when Close without merging is tapped on an open PR", async () => {
    const { app, ws } = await ready();
    const res = await app.call("POST", "/api/tickets/1/decide", { decision: "reject" });
    expect(res.body).toEqual({ ok: true });
    await app.daemon.idle();
    expect((await app.call("GET", "/api/tickets/1")).body.ticket.outcome).toBe("rejected");
    expect(ws.closedPrs).toEqual(["1"]);
  });

  it("records a PR closed without merging, and leaves the closed PR alone", async () => {
    const { app, ws } = await ready();
    ws.prStates.set("1", "closed");
    app.clock.advance(6);
    await app.daemon.tick();
    await app.daemon.idle();
    expect((await app.call("GET", "/api/tickets/1")).body.ticket).toMatchObject({
      status: "done",
      outcome: "rejected",
    });
    expect(ws.closedPrs).toEqual([]);
    await app.daemon.tick();
    expect(app.deps.registry.releases().filter((r) => r.project === "Duet")).toEqual([]);
  });

  it("looks at an open PR every 5 minutes, not at every tick", async () => {
    const { app, ws, looks } = await ready();
    await app.daemon.tick();
    await app.daemon.idle();
    const first = looks();
    expect(first).toBeGreaterThanOrEqual(1);
    await app.daemon.tick();
    await app.daemon.tick();
    await app.daemon.idle();
    expect(looks()).toBe(first);
    app.clock.advance((Daemon.prCheckMs - 1_000) / 60_000);
    await app.daemon.tick();
    await app.daemon.idle();
    expect(looks()).toBe(first);
    app.clock.advance(1);
    await app.daemon.tick();
    await app.daemon.idle();
    expect(looks()).toBe(first + 1);
    // A merge in between is seen at the next look.
    ws.prStates.set("1", "merged");
    app.clock.advance(Daemon.prCheckMs / 60_000 + 1);
    await app.daemon.tick();
    await app.daemon.idle();
    expect((await app.call("GET", "/api/tickets/1")).body.ticket.outcome).toBe("merged");
  });

  it("waits as long as GitHub says when it is rate limited, and notices the merge afterwards", async () => {
    const limit = { on: true };
    const { app, ws, looks } = await ready({ limited: limit });
    expect(looks()).toBeGreaterThanOrEqual(1); // refused by the rate limit
    const refused = looks();
    ws.prStates.set("1", "merged");
    limit.on = false;
    // 6 minutes later is past the usual wait, but GitHub asked for 20.
    app.clock.advance(6);
    await app.daemon.tick();
    await app.daemon.idle();
    expect(looks()).toBe(refused);
    expect((await app.call("GET", "/api/tickets/1")).body.ticket.status).toBe("ready");
    app.clock.advance(15);
    await app.daemon.tick();
    await app.daemon.idle();
    expect((await app.call("GET", "/api/tickets/1")).body.ticket.outcome).toBe("merged");
  });

  it("does not watch a direct-mode ticket: it closes without the owner, and there is no PR to merge", async () => {
    const { app, looks } = await ready({ mode: "direct" });
    const t = (await app.call("GET", "/api/tickets/1")).body.ticket;
    expect(t).toMatchObject({ status: "done", outcome: "merged" });
    expect(t.mergeOnGitHub).toBeUndefined();
    await app.daemon.tick();
    await app.daemon.idle();
    expect(looks()).toBe(0);
  });
});
