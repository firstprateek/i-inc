// Real mode's wiring, with stand-ins for the `container` CLI: which machine a session starts in, with
// which credentials, which recipe the harness runs, and where usage reports go.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Ticket } from "@i-inc/core";
import { FakeClock } from "@i-inc/core/testing";
import { describe, expect, it } from "vitest";
import type { AgentProcess, LaunchRequest } from "../src/acp.ts";
import { createApp } from "../src/app.ts";
import { readCredentials } from "../src/config.ts";
import { seedDemo } from "../src/demo.ts";
import { realPorts } from "../src/real.ts";
import { testApp } from "./setup.ts";

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

describe("credentials on the host", () => {
  it("reads each account's environment, from a file only its owner can read", () => {
    const dir = tmp("inc-config-");
    const path = join(dir, "credentials.json");
    expect(readCredentials(dir)).toEqual({});
    writeFileSync(path, JSON.stringify({ "claude-pro": { CLAUDE_CODE_OAUTH_TOKEN: "sk-x" } }));
    chmodSync(path, 0o644);
    expect(() => readCredentials(dir)).toThrow("chmod 600");
    chmodSync(path, 0o600);
    expect(readCredentials(dir)).toEqual({ "claude-pro": { CLAUDE_CODE_OAUTH_TOKEN: "sk-x" } });
    writeFileSync(path, JSON.stringify({ "claude-pro": { "A=B": "x" } }));
    expect(() => readCredentials(dir)).toThrow("isn't a variable");
  });
});

describe("projects", () => {
  it("keeps each project's repo and check recipe, and refuses a bad one", async () => {
    const app = await testApp();
    const duet = { repo: "firstprateek/duet", checks: ["pnpm install --frozen-lockfile", "pnpm test"] };
    expect((await app.call("PUT", "/api/projects/Duet", duet)).body.project).toEqual({ id: "Duet", ...duet });
    expect((await app.call("GET", "/api/projects")).body.projects).toEqual([{ id: "Duet", ...duet }]);
    expect((await app.call("PUT", "/api/projects/Duet", { ...duet, repo: "duet" })).status).toBe(400);
    expect((await app.call("PUT", "/api/projects/Duet", { ...duet, checks: [] })).status).toBe(400);
    expect((await app.call("PUT", "/api/projects/..%2Fx", duet)).status).toBe(400);
  });
});

describe("real mode", () => {
  async function realApp() {
    const exec: string[][] = [];
    const launched: LaunchRequest[] = [];
    const scripts: { employeeId: string; script: string }[] = [];
    const app = await createApp({
      dbPath: ":memory:",
      knowledgeDir: tmp("inc-knowledge-"),
      clock: new FakeClock(),
      ...realPorts({
        credentials: { "claude-pro": { CLAUDE_CODE_OAUTH_TOKEN: "sk-x" } },
        exec: async (_bin, args) => {
          exec.push(args);
          return "";
        },
        // The ACP server reports Claude's limits, then dies before initialize is answered.
        launch: (r) => {
          launched.push(r);
          const stdout = new PassThrough();
          stdout.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                update: {
                  sessionUpdate: "usage_update",
                  _meta: { "_claude/rateLimit": { status: "allowed", resetsAt: 1_900_000_000 } },
                },
              },
            })}\n`,
          );
          const proc: AgentProcess = {
            stdin: new PassThrough(),
            stdout,
            stderr: new PassThrough(),
            kill: () => {},
            exited: new Promise((resolve) => setTimeout(() => resolve(1), 20)),
          };
          return proc;
        },
        runScript: async (employeeId, script) => {
          scripts.push({ employeeId, script });
          return { code: 0, output: "@@ok pnpm test\n@@green\n" };
        },
      }),
    });
    seedDemo(app.deps.registry);
    return { app, exec, launched, scripts };
  }

  const ticket: Ticket = {
    id: "7",
    title: "x",
    project: "Duet",
    type: "fix",
    effort: "low",
    doneWhen: [],
    assignee: "ada",
  };

  it("boots the employee's machine, and starts its session there with the account's credentials", async () => {
    const { app, exec, launched } = await realApp();
    const { registry } = app.deps;
    await app.deps.machines.ensureUp("ada");
    expect(exec[0]).toEqual(["machine", "run", "-n", "inc-ada", "--", "true"]);

    const outcome = await app.deps.agent.run({
      ticket,
      stage: "build",
      duty: "build",
      employee: registry.employee("ada"),
      engine: registry.engine("opus"),
      brief: "b",
    });
    expect(outcome.kind).toBe("stuck");
    expect(launched[0]).toMatchObject({
      employeeId: "ada",
      cwd: "/home/employee/work/inc-7",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-x" },
    });
    expect(registry.usage()).toEqual([
      { accountId: "claude-pro", status: "allowed", resetsAt: 1_900_000_000_000, windows: [] },
    ]);

    // Antigravity signs in inside the machine, so its account has no entry and its session gets none.
    await app.deps.agent.run({
      ticket,
      stage: "build",
      duty: "build",
      employee: registry.employee("ada"),
      engine: registry.engine("gemini"),
      brief: "b",
    });
    expect(launched[1]?.env).toEqual({});
  });

  it("runs the project's recipe from the registry in the ticket's worktree", async () => {
    const { app, scripts } = await realApp();
    await expect(app.deps.harness.runChecks(ticket)).rejects.toThrow("no check recipe for Duet");
    app.deps.registry.addProject({ id: "Duet", repo: "firstprateek/duet", checks: ["pnpm test"] });
    expect(await app.deps.harness.runChecks(ticket)).toEqual({ green: true, failures: [] });
    expect(scripts[0]?.employeeId).toBe("ada");
    expect(scripts[0]?.script).toContain("cd '/home/employee/work/inc-7'");
    expect(scripts[0]?.script).toContain("pnpm test");
  });
});
