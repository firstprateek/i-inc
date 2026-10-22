// No write credential in any sandbox (T68), end to end: the real pipeline, the real scripts in real bash, a local
// bare repo as GitHub, and a fake token source whose write token is told apart from the read-only one. Every call
// that put anything into a sandbox (a script, an environment, an agent launch) is searched for the write token,
// and the sandbox's scripts are searched for a `git push`: the host makes every push.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "@i-inc/core/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { seedDemo } from "../src/demo.ts";
import { defaultMachineSettings, type ExecOptions } from "../src/machines.ts";
import { realPorts } from "../src/real.ts";
import { fakeTokens, leaksOf, READ_TOKEN, type SandboxCall, WRITE_TOKEN } from "./fake-tokens.ts";
import { type ShipRig, shipRig } from "./ship-rig.ts";

const all = (rig: ShipRig): SandboxCall[] => [
  ...rig.calls.map((c) => ({ via: "run", employeeId: c.employeeId, script: c.script, env: c.env })),
  ...rig.launched.map((l) => ({ via: "launch", employeeId: l.employeeId, env: l.env })),
];

function expectNoWriteToken(rig: ShipRig) {
  const calls = all(rig);
  expect(calls.length).toBeGreaterThan(3);
  expect(leaksOf(calls)).toEqual([]);
  // Nor a push: the sandbox's scripts only fetch and hand over bundles.
  expect(
    rig.calls
      .filter((c) => /(?:^|[\s;&|(])(?:git|NC|G|C)\s+(?:-\S+\s+\S*\s*)*push(?:\s|$)/m.test(c.script))
      .map((c) => c.script.slice(0, 80)),
  ).toEqual([]);
  // The only write tokens minted were the host's own, and none for a sandbox.
  expect(rig.tokens.minted.filter((m) => m.kind === "read").length).toBeGreaterThan(0);
}

describe("no write token in any sandbox", () => {
  it("direct mode: a conversation becomes a ticket and goes to main, pushed by the host and written to the ledger", async () => {
    const rig = await shipRig({ mode: "direct" });
    const c = await rig.conversation();
    c.write("hello.txt", "hello\n");
    const r = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, { title: "Greeting" });
    expect(r.status).toBe(201);
    await rig.settle();
    expect((await rig.app.daemon.state(r.body.ticket.id)).outcome).toBe("merged");
    expect(rig.originGit("show", "main:hello.txt")).toBe("hello");
    expectNoWriteToken(rig);
    // The sandbox's token was asked for read-only, limited to this ticket's repo.
    expect(
      rig.tokens.minted.filter((m) => m.kind === "read").every((m) => m.repos.join() === "acme/duet"),
    ).toBe(true);
    // The session's sign-in used the read-only token.
    const login = rig.calls.find((x) => x.script.includes("gh auth login"));
    expect(login?.env).toEqual({ I_INC_GH: READ_TOKEN });
    // Every commit that reached main is in the ledger, with the ticket.
    const main = rig.originGit("rev-parse", "main");
    const lines = (await import("node:fs"))
      .readFileSync(rig.ledger, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.sha)).toContain(main);
    expect(lines.find((l) => l.sha === main)).toMatchObject({
      repo: "acme/duet",
      branch: "main",
      ticket: r.body.ticket.id,
      tip: true,
    });
  });

  it("owner-merges: the ticket's branch and the rebased push come from the host, and nothing reaches main", async () => {
    const rig = await shipRig({ mode: "owner-merges" });
    const c = await rig.conversation();
    c.write("hello.txt", "hello\n");
    const before = rig.originGit("rev-parse", "main");
    const r = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, { title: "Greeting" });
    expect(r.status).toBe(201);
    await rig.settle();
    const branch = `conv/${c.conv.id}`;
    expect(rig.originGit("show", `${branch}:hello.txt`)).toBe("hello");
    expect(rig.originGit("rev-parse", "main")).toBe(before);
    expectNoWriteToken(rig);
  });

  it("the quick PR: the branch is pushed by the host, never by the sandbox", async () => {
    const rig = await shipRig({ mode: "owner-merges" });
    const c = await rig.conversation();
    c.write("hello.txt", "hello\n");
    const r = await rig.call("POST", `/api/conversations/${c.conv.id}/pr`, {});
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    expect(rig.originGit("show", `conv/${c.conv.id}:hello.txt`)).toBe("hello");
    expectNoWriteToken(rig);
  });

  it("a session that needs no GitHub is given none: no project, no sign-in", async () => {
    const rig = await shipRig({ mode: "direct" });
    await rig.conversation(null);
    expect(rig.calls.some((x) => x.script.includes("gh auth login"))).toBe(false);
    expect(rig.tokens.minted).toEqual([]);
    expect(leaksOf(all(rig))).toEqual([]);
    expect(JSON.stringify(all(rig))).not.toContain(READ_TOKEN);
    expect(WRITE_TOKEN).not.toBe(READ_TOKEN);
  });
});

describe("signing sandboxes in", () => {
  it("finds a leak when there is one (the check itself works)", () => {
    expect(
      leaksOf([
        { via: "a", env: { GH_TOKEN: WRITE_TOKEN } },
        { via: "b", script: "echo hi" },
      ]),
    ).toEqual(["a"]);
    expect(leaksOf([{ via: "c", script: `printf ${WRITE_TOKEN}` }])).toEqual(["c"]);
    expect(leaksOf([{ via: "d", args: ["-e", WRITE_TOKEN] }])).toEqual(["d"]);
    expect(leaksOf([{ via: "e", env: { I_INC_GH: READ_TOKEN } }])).toEqual([]);
  });

  /** realPorts over a stand-in `container` CLI that lists the given machines and records what is run in them. */
  async function setup(listing: string[]) {
    const tokens = fakeTokens();
    const inputs: { args: string[]; input: string | undefined }[] = [];
    const logs: string[] = [];
    const ports = realPorts({
      credentials: {},
      machine: (({ wallsMarker: _, ...rest }) => rest)(defaultMachineSettings),
      github: { tokens, slug: "i-inc-bot" },
      exec: async (_bin: string, args: string[], opts?: ExecOptions) => {
        if (args[0] === "machine" && args[1] === "ls") {
          return [
            "NAME     CREATED              IP             CPUS  MEMORY  DISK  STATE    DEFAULT",
            ...listing,
          ].join("\n");
        }
        inputs.push({ args, input: opts?.input });
        return "";
      },
      log: (m) => logs.push(m),
    });
    const app = await createApp({
      dbPath: ":memory:",
      knowledgeDir: mkdtempSync(join(tmpdir(), "inc-knowledge-")),
      clock: new FakeClock(),
      ...ports,
    });
    seedDemo(app.deps.registry);
    app.deps.registry.addProject({ id: "Duet", repo: "acme/duet", checks: ["true"] });
    app.deps.registry.addProject({ id: "Notes", repo: "acme/notes", checks: ["true"] });
    return { ports, app, tokens, inputs, logs };
  }

  it("at startup signs every running sandbox out of GitHub, and signs none in: the first session does, for its own repo", async () => {
    const { ports, tokens, inputs, logs } = await setup([
      "inc-company     2026-10-01 10:00:00  192.168.64.5  4     8G      20.4G  running  false",
      "inc-engineering 2026-10-01 10:00:00  192.168.64.6  4     8G      20.4G  stopped  false",
    ]);
    expect(await ports.resignAll()).toBe(1);
    // Only the running one was touched; it is logged out, and nothing is logged in again.
    expect(inputs).toHaveLength(1);
    const script = inputs[0]?.input ?? "";
    expect(inputs[0]?.args).toContain("inc-company");
    expect(script).toContain("gh auth logout");
    expect(script).toContain("hosts.yml");
    expect(script).not.toContain("gh auth login");
    expect(leaksOf([{ via: "resign", script, args: inputs[0]?.args ?? [] }])).toEqual([]);
    // No token of any kind was minted for it: not one for every project, not a read-only one.
    expect(tokens.minted).toEqual([]);
    expect(JSON.stringify(inputs)).not.toContain(READ_TOKEN);
    expect(logs).toEqual([]);
  });

  it("signs a running sandbox out with one fixed script", async () => {
    const { ports, inputs, logs } = await setup([
      "inc-company     2026-10-01 10:00:00  192.168.64.5  4     8G      20.4G  running  false",
    ]);
    expect(await ports.resignAll()).toBe(1);
    expect(inputs[0]?.input).toContain("gh auth logout");
    expect(logs).toEqual([]);
  });
});
