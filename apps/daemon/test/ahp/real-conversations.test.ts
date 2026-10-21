// Conversations in real mode: the wiring in realPorts (launch, credentials, working copy), and the
// working-copy scripts themselves. The sandbox is a fake; nothing touches GitHub or a machine.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Employee } from "@i-inc/core";
import { FakeClock } from "@i-inc/core/testing";
import { describe, expect, it } from "vitest";
import { SessionHost } from "../../src/ahp/session-host.ts";
import { createApp } from "../../src/app.ts";
import { seedDemo } from "../../src/demo.ts";
import { defaultMachineSettings } from "../../src/machines.ts";
import { realPorts } from "../../src/real.ts";
import { openScript, prepareConversationCopy } from "../../src/workspace.ts";
import { FakeSandbox } from "./fake-acp.ts";
import { until } from "./session-rig.ts";
import { type Any, TestClient, turnStarted } from "./support.ts";

const { wallsMarker: _, ...noWalls } = defaultMachineSettings;

async function realApp() {
  const sandbox = new FakeSandbox();
  const scripts: { employeeId: string; script: string; env?: Record<string, string> | undefined }[] = [];
  const logs: string[] = [];
  const ports = realPorts({
    credentials: { "claude-pro": { CLAUDE_CODE_OAUTH_TOKEN: "sk-x" } },
    machine: noWalls,
    exec: async () => "",
    launch: sandbox.launch,
    runScript: async (employeeId, script, env) => {
      scripts.push({ employeeId, script, env });
      return { code: 0, output: "@@ready\n" };
    },
    log: (m) => logs.push(m),
  });
  const base = await import("@i-inc/core/testing");
  const app = await createApp({
    dbPath: ":memory:",
    knowledgeDir: mkdtempSync(join(tmpdir(), "inc-knowledge-")),
    clock: new FakeClock(),
    ...ports,
    helper: new base.FakeHelper(),
    chat: new base.FakeChat(),
  });
  seedDemo(app.deps.registry);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.handle(
      new Request(`http://i.inc${path}`, {
        method,
        ...(method === "GET"
          ? {}
          : { body: JSON.stringify(body ?? {}), headers: { "content-type": "application/json" } }),
      }),
    );
    return { status: res.status, body: (await res.json()) as Any };
  };
  return { app, sandbox, scripts, logs, call };
}

describe("conversations in real mode", () => {
  it("runs the session host behind the AHP host, launching in the team sandbox with the account's credential and its own ports", async () => {
    const { app, sandbox, scripts, call } = await realApp();
    expect(app.ahp.backend).toBeInstanceOf(SessionHost);
    expect(app.ahp.host.agents().map((a) => a.provider)).toContain("opus");
    const made = await call("POST", "/api/conversations", { employeeId: "ada" });
    expect(made.status).toBe(201);
    const c = made.body.conversation;
    // no project: an empty folder in Ada's sandbox, made by a script run as her
    expect(scripts[0]).toMatchObject({ employeeId: "ada" });
    expect(scripts[0]?.script).toContain(`mkdir -p '/home/employee/work/conv-${c.id}'`);
    expect(sandbox.launches[0]).toMatchObject({ employeeId: "ada", cwd: `/home/employee/work/conv-${c.id}` });
    expect(sandbox.launches[0]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-x");
    expect(sandbox.launches[0]?.env.I_INC_PORTS).toMatch(/^\d{5}-\d{5}$/);
    // the agent's own modes are the conversation's, in its bypass mode
    expect(c.mode).toBe("bypassPermissions");
    // a message goes through to the agent and comes back
    const client = new TestClient(app.ahp.host);
    await client.init(["ahp-root://", c.ahpSession, c.ahpChat]);
    client.dispatch(c.ahpChat, turnStarted("plain hello", "t1"));
    await until(() => app.ahp.host.chatState(c.ahpChat)?.turns.length === 1);
    expect(app.ahp.host.chatState(c.ahpChat)?.turns[0]?.state).toBe("complete");
    const row = (await call("GET", `/api/conversations/${c.id}`)).body.conversation;
    expect(row).toMatchObject({ title: "plain hello", mode: "bypassPermissions", running: false });
    // Ticket sessions still use their own path
    expect(app.deps.agent).not.toBe(app.ahp.backend);
  });

  it("can't put a conversation on a project until the GitHub App is set up, and says so", async () => {
    const { call, sandbox } = await realApp();
    const r = await call("POST", "/api/conversations", { employeeId: "ada", project: "Duet" });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/GitHub App isn't set up/);
    expect(sandbox.live).toHaveLength(0);
  });
});

describe("a conversation's working copy", () => {
  const ada = { id: "ada", name: "Ada" } as Employee;
  const kit = (run: Any) => ({
    project: (name: string) =>
      name === "Duet" ? { id: "Duet", repo: "firstprateek/duet", checks: [] } : undefined,
    tokens: { token: async () => "ghs_token" },
    identity: async () => ({ name: "Ada (i.inc)", email: "bot@users.noreply.github.com" }),
    run,
  });

  it("is a branch worktree of the project's repo, next to the ticket worktrees, never pushed", async () => {
    const calls: Any[] = [];
    await prepareConversationCopy(
      kit(async (employeeId: string, script: string, env: Any) => {
        calls.push({ employeeId, script, env });
        return { code: 0, output: "@@ready\n" };
      }),
      { employee: ada, project: "Duet", branch: "conv/ab12cd34", cwd: "/home/employee/work/conv-ab12cd34" },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].employeeId).toBe("ada");
    expect(calls[0].env).toEqual({ GH_TOKEN: "ghs_token" });
    const s: string = calls[0].script;
    expect(s).toContain(
      "git clone --quiet 'https://github.com/firstprateek/duet.git' '/home/employee/work/duet'",
    );
    expect(s).toContain(
      "git worktree add --quiet -b 'conv/ab12cd34' '/home/employee/work/conv-ab12cd34' \"$BASE_REF\"",
    );
    expect(s).toContain("git config --worktree user.name 'Ada (i.inc)'");
    expect(s).not.toContain("git push");
    expect(s).not.toContain("rev-list"); // the "start work" commit a ticket makes for its PR
    expect(s).not.toContain("push");
    expect(s.trimEnd().endsWith("echo @@ready")).toBe(true);
  });

  it("is an empty folder with no project", async () => {
    const calls: string[] = [];
    await prepareConversationCopy(
      kit(async (_e: string, script: string) => {
        calls.push(script);
        return { code: 0, output: "@@ready" };
      }),
      { employee: ada, project: null, branch: null, cwd: "/home/employee/work/conv-x1" },
    );
    expect(calls[0]).toBe("set -e\nmkdir -p '/home/employee/work/conv-x1'\necho @@ready");
    await expect(
      prepareConversationCopy(
        kit(async () => ({ code: 0, output: "@@ready" })),
        { employee: ada, project: null, branch: null, cwd: "/home/x; rm -rf /" },
      ),
    ).rejects.toThrow(/not a safe folder/);
  });

  it("fails with the tail of git's output, and for a project that is gone", async () => {
    await expect(
      prepareConversationCopy(
        kit(async () => ({ code: 128, output: "fatal: could not read from remote\n" })),
        {
          employee: ada,
          project: "Duet",
          branch: "conv/x",
          cwd: "/home/employee/work/conv-x",
        },
      ),
    ).rejects.toThrow(/Ada's machine failed: fatal: could not read from remote/);
    await expect(
      prepareConversationCopy(
        kit(async () => ({ code: 0, output: "@@ready" })),
        { employee: ada, project: "Gone", branch: "conv/x", cwd: "/home/employee/work/conv-x" },
      ),
    ).rejects.toThrow(/no project Gone/);
    await expect(
      prepareConversationCopy(
        kit(async () => ({ code: 0, output: "@@ready" })),
        { employee: ada, project: "Duet", branch: "conv/x y", cwd: "/home/employee/work/conv-x" },
      ),
    ).rejects.toThrow(/not a branch name/);
  });
});

describe("hostile branch names and folders never reach a script", () => {
  const ada = { id: "ada", name: "Ada" } as Employee;
  const ran: string[] = [];
  const kit = {
    project: () => ({ id: "Duet", repo: "firstprateek/duet", checks: [] }),
    tokens: { token: async () => "t" },
    identity: async () => ({ name: "Ada", email: "a@b.c" }),
    run: async (_e: string, script: string) => {
      ran.push(script);
      return { code: 0, output: "@@ready" };
    },
  };
  const okDir = "/home/employee/work/conv-ab12cd34";

  const branches = [
    "..",
    "-x",
    "-",
    "conv/../x",
    "../../etc",
    "conv/..",
    "a..b",
    "x y",
    "x\ny",
    "x\ty",
    "x\u0000y",
    "x~1",
    "x^",
    "x:y",
    "x?",
    "x*",
    "x[0]",
    "x\\y",
    "x@{1}",
    "@",
    "conv/",
    "/conv",
    "conv//x",
    "conv/.hidden",
    ".x",
    "conv/x.lock",
    "x.lock",
    "x.",
    "conv/x.lock/y",
    "$(id)",
    "x;rm -rf /",
    "`id`",
    "",
    " x",
    "x ",
    "a".repeat(201),
  ];
  for (const branch of branches) {
    it(`refuses the branch ${JSON.stringify(branch).slice(0, 40)}`, async () => {
      const n = ran.length;
      await expect(
        prepareConversationCopy(kit, { employee: ada, project: "Duet", branch, cwd: okDir }),
      ).rejects.toThrow(/not a branch name/);
      expect(ran.length).toBe(n);
      expect(() =>
        openScript({
          remote: "r",
          repoDir: "/home/employee/work/duet",
          worktree: okDir,
          branch,
          name: "n",
          email: "e",
          message: "m",
        }),
      ).toThrow(/not a branch name/);
    });
  }

  const dirs = [
    "/etc/x",
    "/etc",
    "../..",
    "..",
    "-rf",
    "conv-x",
    "/home/employee/work",
    "/home/employee/work/",
    "/home/employee/work/conv-",
    "/home/employee/work/../../etc",
    "/home/employee/work/conv-x/../conv-y",
    "/home/employee/work/conv-x/",
    "/home/employee/work/conv-x/sub",
    "/home/employee/work//conv-x",
    "/home/employee/work/conv-x y",
    "/home/employee/work/conv-x\nrm",
    "/home/employee/work/conv-$(id)",
    "/home/employee/work/conv-`id`",
    "/home/employee/work/conv-x;ls",
    "/home/employee/work/other-x",
    "/home/employee/workshop/conv-x",
    "/home/employee/work/conv-./x",
    "/home/other/work/conv-x",
    `/home/employee/work/conv-${"a".repeat(65)}`,
    "/home/employee/work/-rf",
  ];
  for (const cwd of dirs) {
    it(`refuses the folder ${JSON.stringify(cwd).slice(0, 50)}`, async () => {
      const n = ran.length;
      for (const project of [null, "Duet"]) {
        await expect(
          prepareConversationCopy(kit, { employee: ada, project, branch: project ? "conv/ok" : null, cwd }),
        ).rejects.toThrow(/not a safe folder/);
      }
      expect(ran.length).toBe(n);
    });
  }

  it("takes the names it makes itself, and the ticket worktrees", async () => {
    for (const cwd of [okDir, "/home/employee/work/inc-42", "/home/employee/work/conv-A_b-9"]) {
      await prepareConversationCopy(kit, { employee: ada, project: null, branch: null, cwd });
    }
    for (const branch of ["conv/ab12cd34", "inc/42-fix-refunds", "feature/x_y-1.2"]) {
      await prepareConversationCopy(kit, { employee: ada, project: "Duet", branch, cwd: okDir });
    }
  });

  it("refuses a session whose metadata names a hostile folder or branch, before any agent starts", async () => {
    const { sessionRig } = await import("./session-rig.ts");
    const t = await sessionRig();
    const make = (workingDirectories: string[], branch?: string) =>
      t.host.createSession({
        provider: "opus",
        workingDirectories,
        meta: {
          "iinc.conversation": "c1",
          "iinc.employee": "ada",
          ...(branch ? { "iinc.project": "Duet", "iinc.branch": branch } : {}),
        },
      });
    await expect(make(["file:///etc/x"])).rejects.toThrow(/not a safe working directory/);
    await expect(make(["file:///home/employee/work/conv-c1"], "../../etc")).rejects.toThrow(
      /not a branch name/,
    );
    expect(t.sandbox.launches).toEqual([]);
    expect(t.copies).toEqual([]);
  });
});
