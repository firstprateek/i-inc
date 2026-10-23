// The owner's smoke tool (scripts/converse.ts) against an in-process host with the scripted agent: the turn
// completes, tool calls and permission requests are printed and answered, the conversation is archived, the
// exit codes mean what they say, and the token is never printed.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { converse, parseArgs, type SocketLike, urlProblem } from "../../scripts/converse.ts";
import type { Socket } from "../../src/ahp/host.ts";
import { ActionType } from "../../src/ahp/wire.ts";
import { createApp } from "../../src/app.ts";
import { seedDemo } from "../../src/demo.ts";
import { type Any, ScriptedBackend } from "../ahp/support.ts";
import { testApp } from "../setup.ts";

const TOKEN = "s3cret-token-value";
const HOST = "127.0.0.1:7420";

async function rig() {
  const base = await testApp();
  const backend = new ScriptedBackend();
  let registry: { engines(): { id: string }[] } | undefined;
  backend.providers = () => registry?.engines().map((e) => e.id) ?? [];
  const app = await createApp({
    dbPath: ":memory:",
    knowledgeDir: mkdtempSync(join(tmpdir(), "converse-knowledge-")),
    clock: base.clock,
    agent: base.agent,
    harness: base.harness,
    helper: base.helper,
    chat: base.chat,
    machines: base.deps.machines,
    ahpBackend: backend,
    token: TOKEN,
    hosts: [HOST],
  });
  seedDemo(app.deps.registry);
  registry = app.deps.registry;
  const fetchFn = ((url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("host", HOST);
    return app.handle(new Request(url, { ...init, headers }));
  }) as typeof fetch;
  /** A socket into the in-process host, with the same bearer check the upgrade makes. */
  const openSocket = (_url: string, headers: Record<string, string>): SocketLike => {
    const ws: SocketLike = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send: () => {},
      close: () => {},
    };
    const authed = headers.authorization === `Bearer ${TOKEN}`;
    const sock: Socket = {
      send: (text) => void queueMicrotask(() => ws.onmessage?.({ data: text })),
      close: () => void queueMicrotask(() => ws.onclose?.({})),
      bufferedAmount: () => 0,
      ping: () => {},
    };
    setTimeout(() => {
      if (!authed) return void ws.onerror?.({});
      const conn = app.ahp.host.connect(sock, true);
      ws.send = (text) => void app.ahp.host.receive(conn as Any, text);
      ws.close = () => {
        if (conn) app.ahp.host.disconnect(conn);
      };
      ws.onopen?.({});
    }, 0);
    return ws;
  };
  const lines: string[] = [];
  const run = (over: Partial<Parameters<typeof converse>[0]> = {}) =>
    converse({
      baseUrl: `http://${HOST}`,
      token: TOKEN,
      employee: "ada",
      message: "hello there",
      fetch: fetchFn,
      openSocket,
      out: (t) => void lines.push(t),
      timeoutMs: 3000,
      ...over,
    });
  return { app, backend, run, lines, text: () => lines.join(""), fetchFn };
}

const usage = (run: Any, inputTokens: number, outputTokens: number) =>
  run.emit({ type: ActionType.ChatUsage, turnId: run.turnId, usage: { inputTokens, outputTokens } });

describe("converse.ts", () => {
  it("sends the message, streams the reply, prints a summary and archives the conversation (exit 0)", async () => {
    const t = await rig();
    t.backend.script = async (run, b) => {
      b.text(run, "Hello from ");
      b.delta(run, "the fake agent");
      b.tool(run, "t1", "read", "Read notes.md");
      b.done(run, "t1");
      usage(run, 120, 30);
      return { kind: "complete" };
    };
    const r = await t.run();
    expect(r).toMatchObject({ code: 0, status: "complete", parts: 2, inputTokens: 120, outputTokens: 30 });
    const out = t.text();
    expect(out).toContain("Hello from the fake agent");
    expect(out).toContain("[tool] Read notes.md");
    expect(out).toMatch(/turn: complete · parts: 2 · tokens: 120 in, 30 out · conversation [0-9a-f]{8}/);
    // the agent got the message, and the conversation is put away
    expect(t.backend.runs[0]?.message.text).toBe("hello there");
    const archived = await (
      await t.fetchFn(`http://${HOST}/api/conversations?archived=true`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).json();
    expect(archived.conversations.map((c: Any) => c.id)).toEqual([r.conversation]);
  });

  it("never prints the token", async () => {
    const t = await rig();
    await t.run();
    await t.run({ employee: "nobody" });
    expect(t.text()).not.toContain(TOKEN);
  });

  it("keeps the conversation with --keep", async () => {
    const t = await rig();
    const r = await t.run({ keep: true });
    expect(r.code).toBe(0);
    expect(t.text()).toContain("(kept)");
    const live = await (
      await t.fetchFn(`http://${HOST}/api/conversations`, { headers: { authorization: `Bearer ${TOKEN}` } })
    ).json();
    expect(live.conversations.map((c: Any) => c.id)).toEqual([r.conversation]);
  });

  it("denies a permission request unless --allow, and says so", async () => {
    for (const allow of [false, true]) {
      const t = await rig();
      t.backend.script = async (run, b) => {
        const a = await b.ask(run, "p1");
        b.text(run, a.approved ? "went ahead" : "left alone");
        return { kind: "complete" };
      };
      const r = await t.run({ allow });
      expect(r.code).toBe(0);
      expect(t.backend.answers).toHaveLength(1);
      expect(t.backend.answers[0]?.answer.approved).toBe(allow);
      expect(t.text()).toContain(allow ? "went ahead" : "left alone");
      expect(t.text()).toContain(`[permission] Run rm -rf build -> ${allow ? "allowed" : "denied"}`);
    }
  });

  it("exits 1 when the agent fails, with its reason", async () => {
    const t = await rig();
    t.backend.script = async () => ({
      kind: "error",
      errorType: "agent_exited",
      message: "The agent is not running.",
    });
    const r = await t.run();
    expect(r).toMatchObject({ code: 1, status: "error" });
    expect(t.text()).toContain("turn: error");
  });

  it("exits 2 on a timeout and cancels the turn", async () => {
    const t = await rig();
    t.backend.script = () => new Promise(() => {});
    const r = await t.run({ timeoutMs: 150 });
    expect(r).toMatchObject({ code: 2, status: "timeout" });
    expect(t.backend.cancelled).toHaveLength(1);
    expect(t.text()).toContain("turn: timeout");
  });

  it("exits non-zero when the daemon refuses: a wrong token, or an employee who isn't there", async () => {
    const t = await rig();
    expect((await t.run({ token: "wrong" })).code).not.toBe(0);
    const r = await t.run({ employee: "nobody" });
    expect(r.code).toBe(1);
    expect(t.text()).toContain("no employee");
  });
});

describe("converse.ts on a failed connection", () => {
  it("archives the conversation it made even when the socket never opens (exit 2)", async () => {
    const t = await rig();
    const refused = (): SocketLike => {
      const ws: SocketLike = {
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        send: () => {},
        close: () => {},
      };
      setTimeout(() => ws.onerror?.({}), 0);
      return ws;
    };
    const r = await t.run({ openSocket: refused });
    expect(r.code).toBe(2);
    expect(r.conversation).toMatch(/^[0-9a-f]{8}$/);
    const archived = await (
      await t.fetchFn(`http://${HOST}/api/conversations?archived=true`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).json();
    expect(archived.conversations.map((c: Any) => c.id)).toEqual([r.conversation]);
    // and with --keep it is left
    const kept = await t.run({ openSocket: refused, keep: true });
    const live = await (
      await t.fetchFn(`http://${HOST}/api/conversations`, { headers: { authorization: `Bearer ${TOKEN}` } })
    ).json();
    expect(live.conversations.map((c: Any) => c.id)).toEqual([kept.conversation]);
  });
});

describe("converse.ts and the token's road", () => {
  it("sends the token only over https, or over http to this machine", () => {
    for (const ok of [
      "http://127.0.0.1:7420",
      "http://localhost:7420",
      "http://[::1]:7420",
      "https://mini.tail1234.ts.net:8443",
    ]) {
      expect(urlProblem(ok), ok).toBeNull();
    }
    for (const bad of [
      "http://192.168.1.20:7420",
      "http://mini.tail1234.ts.net:7420",
      "http://example.com",
      "ftp://127.0.0.1",
      "nonsense",
    ]) {
      expect(urlProblem(bad), bad).not.toBeNull();
    }
    expect(parseArgs(["--employee", "pip", "--url", "http://10.0.0.2:7420", "hi"])).toContain("in the clear");
  });

  it("refuses before making any request", async () => {
    const t = await rig();
    const seen: string[] = [];
    const r = await t.run({
      baseUrl: "http://10.0.0.2:7420",
      fetch: (async (u: string) => void seen.push(u)) as never,
    });
    expect(r.code).toBe(2);
    expect(seen).toEqual([]);
    expect(t.text()).toContain("in the clear");
  });
});

describe("converse.ts command line", () => {
  it("reads the options and the message", () => {
    expect(
      parseArgs([
        "--employee",
        "pip",
        "--project",
        "Duet",
        "--allow",
        "--keep",
        "--timeout",
        "30",
        "what",
        "is",
        "up",
      ]),
    ).toMatchObject({
      employee: "pip",
      project: "Duet",
      allow: true,
      keep: true,
      timeoutMs: 30_000,
      message: "what is up",
      url: "http://127.0.0.1:7420",
    });
    expect(String(parseArgs(["--employee", "pip", "--token-file", "/x/y"]))).toContain("message");
    expect(parseArgs(["hi"])).toBe("--employee is required");
    expect(parseArgs(["--employee", "pip", "--nope", "hi"])).toBe("unknown option --nope");
    const p = parseArgs(["--employee", "pip", "hi"]);
    expect(typeof p === "object" && p.tokenFile).toMatch(/\.config\/i-inc\/web-token$/);
  });
});

describe.skipIf(spawnSync("bun", ["--version"]).status !== 0)(
  "converse.ts on Bun, against the end-to-end daemon",
  () => {
    it("talks to a real daemon over a real socket, and its exit codes are the process's", async () => {
      const home = mkdtempSync(join(tmpdir(), "converse-e2e-"));
      mkdirSync(join(home, "config"));
      const tokenFile = join(home, "config", "web-token");
      writeFileSync(tokenFile, "tok-for-converse-test\n", { mode: 0o600 });
      const port = 20_000 + Math.floor(Math.random() * 20_000);
      const dir = dirname(fileURLToPath(import.meta.url));
      const server = spawn("bun", [join(dir, "../ahp/e2e-server.ts")], {
        env: { ...process.env, I_INC_HOME: home, PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        await new Promise<void>((resolve, reject) => {
          server.stdout?.on("data", (d) => String(d).includes("e2e daemon on") && resolve());
          server.on("exit", (c) => reject(new Error(`server exited ${c}`)));
          setTimeout(() => reject(new Error("server did not start")), 20_000);
        });
        const cli = (...args: string[]) =>
          spawnSync(
            "bun",
            [
              join(dir, "../../scripts/converse.ts"),
              "--url",
              `http://127.0.0.1:${port}`,
              "--token-file",
              tokenFile,
              ...args,
            ],
            {
              encoding: "utf8",
              timeout: 30_000,
            },
          );
        const ok = cli("--employee", "ada", "plain hello");
        expect(ok.status).toBe(0);
        expect(ok.stdout).toContain("You said: plain hello");
        expect(ok.stdout).toMatch(/turn: complete · parts: 1/);
        expect(ok.stdout + ok.stderr).not.toContain("tok-for-converse-test");
        const denied = cli("--employee", "ada", "bidi");
        expect(denied.stdout).toContain("-> denied");
        expect(denied.stdout).not.toMatch(/[‪-‮]/);
        expect(cli("--employee", "nobody", "hi").status).toBe(1);
        expect(cli("hi").status).toBe(64);
      } finally {
        server.kill();
      }
    }, 60_000);
  },
);
