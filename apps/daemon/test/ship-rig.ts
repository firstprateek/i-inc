// A daemon in real mode with nothing real behind it: the sandbox's scripts run in real bash against real
// git (a local bare repo stands in for GitHub's remote, and a folder for the machine's home), the agents
// are the scripted ACP fake (conversations) and the core's FakeAgent (ticket stages), and GitHub's pull
// request API is `FakePrs`. It is what "make this a ticket" and "open a PR" are tested against.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FakeAgent, FakeChat, FakeClock, FakeHelper, FakeMachines } from "@i-inc/core/testing";
import { createApp } from "../src/app.ts";
import { seedDemo } from "../src/demo.ts";
import type { PullRequests } from "../src/github.ts";
import type { RunScript } from "../src/harness.ts";
import { defaultMachineSettings } from "../src/machines.ts";
import { realPorts } from "../src/real.ts";
import { FakeSandbox } from "./ahp/fake-acp.ts";
import { until } from "./ahp/session-rig.ts";
import { type Any, TestClient, turnStarted } from "./ahp/support.ts";

const { wallsMarker: _, ...noWalls } = defaultMachineSettings;

export { until };

/** Stands in for the bot's pull request API. Every call is kept. */
export class FakePrs {
  prs: {
    number: number;
    head: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
    state: "open" | "closed" | "merged";
  }[] = [];
  calls: string[] = [];
  /** What GitHub says about the checks on the PR's commit. */
  checkState = {
    state: "pending" as "none" | "pending" | "success" | "failure",
    total: 2,
    passed: 1,
    failed: 0,
    pending: 1,
  };
  /** Set to make every call fail the way GitHub does when it is down. */
  failWith: Error | null = null;
  constructor(private readonly origin: string | ((repo: string) => string)) {}

  private guard() {
    if (this.failWith) throw this.failWith;
  }
  private url = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;
  async find(repo: string, branch: string) {
    this.guard();
    this.calls.push(`find ${branch}`);
    const pr = this.prs.find((p) => p.head === branch && p.state === "open");
    return pr ? { number: pr.number, url: this.url(repo, pr.number), nodeId: `PR_${pr.number}` } : null;
  }
  async openDraft(repo: string, pr: { head: string; base: string; title: string; body: string }) {
    this.guard();
    this.calls.push(`openDraft ${pr.head}`);
    const number = this.prs.length + 1;
    this.prs.push({ number, ...pr, draft: true, state: "open" });
    return { number, url: this.url(repo, number), nodeId: `PR_${number}` };
  }
  async get(repo: string, number: number) {
    this.guard();
    this.calls.push(`get ${number}`);
    const pr = this.prs.find((p) => p.number === number);
    if (!pr) throw new Error("no such PR");
    const sha = execFileSync(
      "git",
      [
        "--git-dir",
        typeof this.origin === "function" ? this.origin(repo) : this.origin,
        "rev-parse",
        `refs/heads/${pr.head}`,
      ],
      {
        encoding: "utf8",
      },
    ).trim();
    return {
      number,
      url: this.url(repo, number),
      nodeId: `PR_${number}`,
      state: pr.state,
      draft: pr.draft,
      headSha: sha,
    };
  }
  async checks(_repo: string, sha: string) {
    this.guard();
    this.calls.push(`checks ${sha.slice(0, 7)}`);
    return this.checkState;
  }
  async close(_repo: string, number: number) {
    this.guard();
    this.calls.push(`close ${number}`);
    const pr = this.prs.find((p) => p.number === number);
    if (pr) pr.state = "closed";
  }
  async isDraft(_repo: string, number: number) {
    return this.prs.find((p) => p.number === number)?.draft ?? false;
  }
  async setBody(_repo: string, number: number, body: string) {
    this.calls.push(`setBody ${number}`);
    const pr = this.prs.find((p) => p.number === number);
    if (pr) pr.body = body;
  }
  async markReady(_repo: string, nodeId: string) {
    this.calls.push(`markReady ${nodeId}`);
    const pr = this.prs.find((p) => `PR_${p.number}` === nodeId);
    if (pr) pr.draft = false;
  }
}

export interface RigOptions {
  mode: "direct" | "owner-merges";
  /** The project's check recipe. Default: one that passes. */
  checks?: string[];
  protectedPaths?: string[];
  /** Files in the project's first commit. */
  files?: Record<string, string>;
  /** Left out: GitHub's App isn't set up. */
  github?: boolean;
}

/** A conversation on the project, its working copy ready on disk, and the clients to talk to it. */
export async function shipRig(o: RigOptions) {
  const root = mkdtempSync(join(tmpdir(), "inc-ship-"));
  const home = join(root, "home");
  const work = join(root, "work");
  const origin = join(root, "origin.git");
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const seed = join(root, "seed");
  git(root, "init", "-q", "-b", "main", seed);
  for (const [path, text] of Object.entries({ "README.md": "duet\n", ...o.files })) {
    mkdirSync(dirname(join(seed, path)), { recursive: true });
    writeFileSync(join(seed, path), text);
  }
  git(seed, "add", "-A");
  git(seed, "-c", "user.name=o", "-c", "user.email=o@example.invalid", "commit", "-q", "-m", "base");
  git(root, "clone", "-q", "--bare", seed, origin);

  const calls: { employeeId: string; script: string; env: Record<string, string> | undefined }[] = [];
  const local = (script: string, extra: Record<string, string> = {}) =>
    new Promise<{ code: number; output: string }>((resolve) => {
      const child = spawn("bash", ["-s"], { env: { ...env, ...extra }, stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (c) => {
        output += c;
      });
      child.stderr.on("data", (c) => {
        output += c;
      });
      child.on("exit", (code) => resolve({ code: code ?? 1, output }));
      child.stdin.end(script);
    });
  const runScript: RunScript = async (employeeId, script, extra) => {
    calls.push({ employeeId, script, env: extra });
    if (script.includes("gh auth login")) return { code: 0, output: "@@signed-in\n" };
    if (script.includes(".inc-agents")) return { code: 0, output: "" };
    // The machine's home is a folder, and GitHub is the bare repo next to it.
    return local(
      script.replaceAll("/home/employee/work", work).replaceAll("https://github.com/acme/duet.git", origin),
      extra,
    );
  };

  const sandbox = new FakeSandbox();
  const prs = new FakePrs(origin);
  const ciOn: string[] = [];
  const logs: string[] = [];
  const ports = realPorts({
    credentials: { "claude-pro": { CLAUDE_CODE_OAUTH_TOKEN: "sk-x" } },
    machine: noWalls,
    exec: async () => "",
    launch: sandbox.launch,
    runScript,
    ...(o.github === false
      ? {}
      : {
          github: {
            tokens: { token: async () => "ghs_stub_token_0123456789" },
            slug: "i-inc-bot",
            prs: prs as unknown as PullRequests,
          },
        }),
    identity: async (e) => ({
      name: `${e.name} (i.inc)`,
      email: "1+i-inc-bot[bot]@users.noreply.github.com",
    }),
    ci: async (_repo, sha) => {
      ciOn.push(sha);
      return { ok: true };
    },
    log: (m) => logs.push(m),
  });
  const agent = new FakeAgent();
  const clock = new FakeClock();
  const app = await createApp({
    dbPath: ":memory:",
    knowledgeDir: mkdtempSync(join(tmpdir(), "inc-knowledge-")),
    clock,
    ...ports,
    machines: new FakeMachines(),
    agent,
    helper: new FakeHelper(),
    chat: new FakeChat(),
  });
  seedDemo(app.deps.registry);
  app.deps.registry.addProject({
    id: "Duet",
    repo: "acme/duet",
    checks: o.checks ?? ["true"],
    mode: o.mode,
    ...(o.protectedPaths ? { protectedPaths: o.protectedPaths } : {}),
  });

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.handle(
      new Request(`http://i.inc${path}`, {
        method,
        ...(method === "GET"
          ? {}
          : {
              body: typeof body === "string" ? body : JSON.stringify(body ?? {}),
              headers: { "content-type": "application/json" },
            }),
      }),
    );
    return { status: res.status, body: (await res.json()) as Any };
  };

  /** A conversation with Ada on the project, after one message so it has something to be titled by. */
  async function conversation(project: string | null = "Duet", say = "plain add a greeting file") {
    const made = await call("POST", "/api/conversations", {
      employeeId: "ada",
      ...(project ? { project } : {}),
    });
    if (made.status !== 201) throw new Error(`couldn't make the conversation: ${JSON.stringify(made.body)}`);
    const conv = made.body.conversation;
    const client = new TestClient(app.ahp.host);
    await client.init(["ahp-root://", conv.ahpSession, conv.ahpChat]);
    if (say) {
      client.dispatch(conv.ahpChat, turnStarted(say, "t1"));
      await until(() => app.ahp.host.chatState(conv.ahpChat)?.turns.length === 1);
      await until(() => !app.ahp.host.hasActiveTurn(conv.ahpChat));
    }
    const dir = join(work, `conv-${conv.id}`);
    return {
      conv,
      client,
      dir,
      /** What the agent did to the files: the test writes them, since the fake agent writes nothing. */
      write(path: string, text: string) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
      },
      read: (path: string) => readFileSync(join(dir, path), "utf8"),
      exists: (path: string) => existsSync(join(dir, path)),
      git: (...args: string[]) => git(dir, ...args),
      say(text: string, id: string) {
        client.dispatch(conv.ahpChat, turnStarted(text, id));
      },
    };
  }

  return {
    app,
    clock,
    call,
    conversation,
    sandbox,
    prs,
    agent,
    calls,
    logs,
    ciOn,
    root,
    work,
    origin,
    git,
    originGit: (...args: string[]) =>
      execFileSync("git", ["--git-dir", origin, ...args], { env, encoding: "utf8" }).trim(),
    /** Runs the pipeline until nothing is running. */
    async settle() {
      await app.daemon.tick();
      await app.daemon.idle();
    },
  };
}

export type ShipRig = Awaited<ReturnType<typeof shipRig>>;
