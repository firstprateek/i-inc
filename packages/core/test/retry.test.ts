// A failed ticket tried again (the first real ticket needed it), and a report's minutes that count
// working time only.
import { describe, expect, it } from "vitest";
import { fold, retry, runTicket } from "../src/index.ts";
import { FakeWorkspace } from "../src/testing/index.ts";
import { ports, refundsTicket } from "./fixtures.ts";

describe("trying a failed ticket again", () => {
  it("resumes from the stage it failed in, and the days it sat failed don't count as work", async () => {
    const p = ports();
    const workspace = new FakeWorkspace();
    p.workspace = workspace;
    p.agent.on({ stage: "build" }, { kind: "stuck", reason: "the build tool crashed" });
    p.agent.on({ stage: "build" }, { kind: "stuck", reason: "the build tool crashed" });
    const first = await runTicket(p, refundsTicket());
    expect(first.status).toBe("failed");
    p.clock.advance(3 * 24 * 60); // it sits failed for three days
    await expect(retry(p, "42")).resolves.toBeUndefined();
    await expect(runTicket(p, refundsTicket())).resolves.toMatchObject({ status: "ready" });
    const s = fold(await p.store.read("42"));
    expect(s.finished).toContain("build");
    expect(workspace.opened).toEqual(["42"]);
    const builds = p.agent.calls.filter((c) => c.stage === "build");
    expect(builds.at(-1)?.brief).toContain("You are resuming this stage");
    expect(workspace.readied[0]?.report).not.toContain("4320");
    await expect(retry(p, "42")).rejects.toThrow("not failed");
  });

  it("throws rather than failing the ticket on GitHub 502/504 access token or API errors at workspace open", async () => {
    for (const msg of [
      "GitHub POST /app/installations/:id/access_tokens failed with HTTP 502",
      "GitHub GET /users/:slug failed with HTTP 504",
      "git in Ada's machine failed: fatal: the remote end hung up unexpectedly",
      "git in Ada's machine failed: error: RPC failed; curl 56 OpenSSL SSL_read: Connection reset by peer",
      "git in Ada's machine failed: fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
      "git in Ada's machine failed: error: RPC failed; HTTP 503 curl 22 The requested URL returned error: 503",
      "git in Ada's machine failed: fatal: early EOF",
    ]) {
      const p = ports();
      const ws = new FakeWorkspace();
      ws.failOpen = msg;
      p.workspace = ws;
      await expect(runTicket(p, refundsTicket())).rejects.toThrow();
      const events = await p.store.read("42");
      expect(events.some((e) => e.type === "failed")).toBe(false);
    }
  });

  it("throws structured UpstreamGitHubError with status >= 500 or rateLimited without failing ticket", async () => {
    const p = ports();
    const ws = new FakeWorkspace();
    const err = Object.assign(new Error("GitHub API failure"), { status: 502, rateLimited: false });
    ws.open = async () => {
      throw err;
    };
    p.workspace = ws;
    await expect(runTicket(p, refundsTicket())).rejects.toThrow();
    const events = await p.store.read("42");
    expect(events.some((e) => e.type === "failed")).toBe(false);
  });

  it("throws rather than failing ticket when workspace.ready encounters a transient GitHub/network error", async () => {
    const p = ports();
    const ws = new FakeWorkspace();
    ws.ready = async () => {
      throw new Error("GitHub POST /graphql failed with HTTP 502");
    };
    p.workspace = ws;
    await expect(runTicket(p, refundsTicket())).rejects.toThrow();
    const events = await p.store.read("42");
    expect(events.some((e) => e.type === "failed")).toBe(false);
  });

  it("fails the ticket on non-transient workspace errors", async () => {
    const p = ports();
    const ws = new FakeWorkspace();
    ws.failOpen = "400 Bad Request: branch already exists or name invalid";
    p.workspace = ws;
    const r = await runTicket(p, refundsTicket());
    expect(r.status).toBe("failed");
    const events = await p.store.read("42");
    expect(events.some((e) => e.type === "failed")).toBe(true);
  });
});
