import { PassThrough } from "node:stream";
import type { Engine, SessionRequest } from "@i-inc/core";
import { describe, expect, it } from "vitest";
import { AcpAgent, type AgentProcess } from "../src/acp.ts";
import { createApi } from "../src/api.ts";
import { openDb } from "../src/db.ts";
import { migrate } from "../src/schema.ts";
import { capText, redactSecrets, SessionStore } from "../src/sessions.ts";
import { refunds, testApp } from "./setup.ts";

type Json = Record<string, unknown>;
type Script = (method: string, params: Json, reply: (m: Json) => void, id: number | undefined) => void;

function server(script: Script) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let exit: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((r) => {
    exit = r;
  });
  let buf = "";
  stdin.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const m = JSON.parse(buf.slice(0, i)) as Json;
      buf = buf.slice(i + 1);
      const id = m.id as number | undefined;
      const reply = (r: Json) => stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...r })}\n`);
      script(String(m.method ?? ""), (m.params ?? {}) as Json, reply, "method" in m ? id : undefined);
    }
  });
  const proc: AgentProcess = { stdin, stdout, stderr, kill: () => exit(null), exited };
  return { proc, exit: (code: number) => exit(code) };
}

const claude: Engine = {
  id: "opus",
  harness: "claude-code",
  model: "Claude Opus",
  accountId: "claude-pro",
  local: false,
};

function sampleRequest(over: Partial<SessionRequest> = {}): SessionRequest {
  return {
    ticket: {
      id: "42",
      title: "Refunds",
      project: "Duet",
      type: "fix",
      effort: "medium",
      doneWhen: [],
      assignee: "ada",
    },
    stage: "build",
    duty: "build",
    employee: {
      id: "ada",
      name: "Ada",
      role: "Senior Engineer",
      duties: ["build"],
      engines: { default: "opus", fallbacks: [] },
      switchRules: { outOfTokens: { action: "wait" }, onStuck: "fail", checksFailedBeforeSwitch: 3 },
    } as unknown as SessionRequest["employee"],
    engine: claude,
    brief: "Ticket #42: do the thing",
    ...over,
  };
}

describe("SessionStore (Contract C4)", () => {
  it("records session lifecycle and items, returning newest last with 4 KB caps", async () => {
    const db = await openDb(":memory:");
    migrate(db);
    let time = 1_000;
    const store = new SessionStore(db, { now: () => time });

    // Session 1: plan
    const s1 = store.start("ticket-1", "plan", "ada", "opus");
    expect(s1).toBe(1);

    store.recordItem(s1, { id: "text-1", kind: "text", text: "Planning...", at: 1_005 });
    // Coalesce into text-1
    store.recordItem(s1, { id: "text-1", kind: "text", text: "Planning... Done.", at: 1_005 });
    time = 1_100;
    store.finish(s1);

    // Session 2: build
    time = 2_000;
    const s2 = store.start("ticket-1", "build", "ada", "opus");
    expect(s2).toBe(2);

    store.recordItem(s2, {
      id: "t-1",
      kind: "tool",
      title: "Read src/index.ts",
      status: "pending",
      at: 2_005,
    });
    // Update tool call status
    store.recordItem(s2, {
      id: "t-1",
      kind: "tool",
      title: "Read src/index.ts",
      status: "completed",
      at: 2_010,
    });

    // Oversized text capped at 4096 bytes
    const huge = "A".repeat(5000);
    store.recordItem(s2, { id: "text-2", kind: "text", text: huge, at: 2_020 });
    time = 2_500;
    store.finish(s2);

    const list = store.list("ticket-1");
    expect(list).toHaveLength(2);

    // Order is newest last
    expect(list[0]).toEqual({
      stage: "plan",
      employeeId: "ada",
      engineId: "opus",
      startedAt: 1_000,
      endedAt: 1_100,
      items: [{ kind: "text", text: "Planning... Done.", at: 1_005 }],
    });

    expect(list[1]?.stage).toBe("build");
    expect(list[1]?.startedAt).toBe(2_000);
    expect(list[1]?.endedAt).toBe(2_500);
    expect(list[1]?.items).toHaveLength(2);
    expect(list[1]?.items[0]).toEqual({
      kind: "tool",
      title: "Read src/index.ts",
      status: "completed",
      at: 2_005,
    });
    expect(list[1]?.items[1]?.kind).toBe("text");
    expect(list[1]?.items[1]?.text?.length).toBe(4096);
    expect(Buffer.byteLength(list[1]?.items[1]?.text ?? "", "utf8")).toBe(4096);
  });

  it("capText caps UTF-8 string at 4096 bytes without broken code units", () => {
    expect(capText("hello", 10)).toBe("hello");
    expect(capText("abcdefghij", 5)).toBe("abcde");
    // Multi-byte emoji: '🚀' is 4 bytes
    const text = `a${"🚀".repeat(10)}`;
    const capped = capText(text, 6);
    expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(6);
  });
});

describe("AcpAgent transcript streaming", () => {
  it("coalesces consecutive text chunks and emits tool items and updates", async () => {
    const update = (sessionUpdate: string, rest: Json = {}) => ({
      method: "session/update",
      params: { sessionId: "s1", update: { sessionUpdate, ...rest } },
    });

    const s = server((method, _params, reply, id) => {
      if (method === "initialize")
        reply({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
      if (method === "session/new") {
        reply({
          id,
          result: {
            sessionId: "s1",
            modes: { currentModeId: "default", availableModes: [{ id: "default" }] },
          },
        });
      }
      if (method === "session/prompt" && id !== undefined) {
        reply(update("agent_message_chunk", { content: { type: "text", text: "Step 1: " } }));
        reply(update("agent_message_chunk", { content: { type: "text", text: "analyzing" } }));
        reply(update("tool_call", { toolCallId: "call_1", title: "grep", status: "pending" }));
        reply(update("tool_call_update", { toolCallId: "call_1", status: "done" }));
        reply(update("agent_message_chunk", { content: { type: "text", text: "All good." } }));
        setTimeout(() => reply({ id, result: { stopReason: "end_turn" } }), 5);
      }
    });

    const agent = new AcpAgent({
      launch: () => s.proc,
      credentials: () => ({}),
      cwdFor: () => "/tmp",
      now: () => 5_000,
    });

    const items: unknown[] = [];
    const out = await agent.run(
      sampleRequest({
        onTranscriptItem: (item) => items.push(item),
      }),
    );
    expect(out).toEqual({ kind: "done", output: "All good." });

    // Should have emitted text-1 (coalesced), tool call_1 (and update), and text-2
    expect(items).toContainEqual(
      expect.objectContaining({ id: "text-1", kind: "text", text: "Step 1: analyzing" }),
    );
    expect(items).toContainEqual(
      expect.objectContaining({ id: "call_1", kind: "tool", title: "grep", status: "pending" }),
    );
    expect(items).toContainEqual(expect.objectContaining({ id: "call_1", kind: "tool", status: "done" }));
    expect(items).toContainEqual(expect.objectContaining({ id: "text-2", kind: "text", text: "All good." }));
  });
});

describe("GET /api/tickets/:id/sessions (Contract C4)", () => {
  it("returns 404 for nonexistent ticket", async () => {
    const app = await testApp();
    const res = await app.call("GET", "/api/tickets/nonexistent/sessions");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "no such ticket" });
  });

  it("returns empty sessions array for ticket with no sessions yet", async () => {
    const app = await testApp();
    const created = await app.call("POST", "/api/tickets", refunds);
    const ticketId = created.body.ticket.id;

    const res = await app.call("GET", `/api/tickets/${ticketId}/sessions`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessions: [] });
  });

  it("returns recorded sessions newest last after ticket runs through daemon", async () => {
    const app = await testApp();
    const created = await app.call("POST", "/api/tickets", refunds);
    const ticketId = created.body.ticket.id;

    // Run ticket through build stage
    app.daemon.run(ticketId);
    await new Promise((r) => setTimeout(r, 50));

    const res = await app.call("GET", `/api/tickets/${ticketId}/sessions`);
    expect(res.status).toBe(200);
    expect(res.body.sessions).toBeInstanceOf(Array);
    expect(res.body.sessions.length).toBeGreaterThanOrEqual(1);

    const first = res.body.sessions[0];
    expect(first).toMatchObject({
      stage: "plan",
      employeeId: "ada",
      engineId: "opus",
      startedAt: expect.any(Number),
      endedAt: expect.any(Number),
    });
    expect(first.items).toBeInstanceOf(Array);
    expect(first.items.length).toBeGreaterThanOrEqual(1);
    expect(first.items[0]).toMatchObject({
      kind: "text",
      at: expect.any(Number),
    });
  });

  it("returns 401 without auth when token is configured", async () => {
    const app = await testApp();
    const created = await app.call("POST", "/api/tickets", refunds);
    const ticketId = created.body.ticket.id;

    const handle = createApi(app.daemon, app.deps, {
      token: "s3cret-token",
      hosts: ["127.0.0.1:7420"],
    });

    const unauth = await handle(
      new Request(`http://127.0.0.1:7420/api/tickets/${ticketId}/sessions`, {
        method: "GET",
        headers: { host: "127.0.0.1:7420" },
      }),
    );
    expect(unauth.status).toBe(401);
    const body = (await unauth.json()) as { error: string };
    expect(body.error).toBe("unauthorized");

    const authed = await handle(
      new Request(`http://127.0.0.1:7420/api/tickets/${ticketId}/sessions`, {
        method: "GET",
        headers: {
          host: "127.0.0.1:7420",
          authorization: "Bearer s3cret-token",
        },
      }),
    );
    expect(authed.status).toBe(200);
    const authedBody = (await authed.json()) as { sessions: unknown[] };
    expect(Array.isArray(authedBody.sessions)).toBe(true);
  });
});

describe("Failure isolation (Daemon agent wrapper)", () => {
  it("does not fail the agent run when sessions.start, recordItem, or finish throw", async () => {
    const app = await testApp();
    const created = await app.call("POST", "/api/tickets", refunds);
    const ticketId = created.body.ticket.id;

    // Force sessions methods to throw
    app.deps.sessions.start = () => {
      throw new Error("simulated DB failure on start");
    };
    app.deps.sessions.recordItem = () => {
      throw new Error("simulated DB failure on recordItem");
    };
    app.deps.sessions.finish = () => {
      throw new Error("simulated DB failure on finish");
    };

    // Agent run must complete without throwing and ticket outcome must not be altered
    app.daemon.run(ticketId);
    await new Promise((r) => setTimeout(r, 50));

    const state = await app.daemon.state(ticketId);
    expect(state.status).not.toBe("stuck");
  });

  it("does not fail when only recordItem throws during streaming", async () => {
    const app = await testApp();
    const created = await app.call("POST", "/api/tickets", refunds);
    const ticketId = created.body.ticket.id;

    app.deps.sessions.recordItem = () => {
      throw new Error("simulated disk full on recordItem");
    };

    app.daemon.run(ticketId);
    await new Promise((r) => setTimeout(r, 50));

    const state = await app.daemon.state(ticketId);
    expect(state.status).not.toBe("stuck");
  });

  it("does not fail when only finish throws", async () => {
    const app = await testApp();
    const created = await app.call("POST", "/api/tickets", refunds);
    const ticketId = created.body.ticket.id;

    app.deps.sessions.finish = () => {
      throw new Error("simulated disk full on finish");
    };

    app.daemon.run(ticketId);
    await new Promise((r) => setTimeout(r, 50));

    const state = await app.daemon.state(ticketId);
    expect(state.status).not.toBe("stuck");
  });
});

describe("Secret redaction", () => {
  it("redacts Authorization headers with any scheme or raw token", () => {
    expect(redactSecrets("Authorization: Bearer my-token-123")).toBe("Authorization: [redacted]");
    expect(redactSecrets("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: [redacted]");
    expect(redactSecrets("Authorization: custom-secret")).toBe("Authorization: [redacted]");
    expect(redactSecrets("authorization: token-abc")).toBe("authorization: [redacted]");
    expect(redactSecrets('curl -H "Authorization: Bearer tok123" https://api.com')).toBe(
      'curl -H "Authorization: [redacted]" https://api.com',
    );
    expect(redactSecrets("curl -H 'Authorization: Bearer tok123' https://api.com")).toBe(
      "curl -H 'Authorization: [redacted]' https://api.com",
    );
  });

  it("redacts standalone Bearer tokens", () => {
    expect(redactSecrets("Bearer secret-token-xyz")).toBe("Bearer [redacted]");
    expect(redactSecrets("bearer 1234567890abcdef")).toBe("bearer [redacted]");
    expect(redactSecrets('curl -H "Bearer secret-token-xyz"')).toBe('curl -H "Bearer [redacted]"');
  });

  it("redacts GitHub tokens (ghp_, gho_, ghs_, github_pat_)", () => {
    expect(redactSecrets("ghp_1234567890abcdef1234567890abcdef1234")).toBe("[redacted]");
    expect(redactSecrets("gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345")).toBe("[redacted]");
    expect(redactSecrets("ghs_serverToken1234567890")).toBe("[redacted]");
    expect(redactSecrets("github_pat_11AAAAAAA_0123456789abcdef0123456789")).toBe("[redacted]");
  });

  it("redacts sk-... keys while preserving words like sk-learn", () => {
    expect(redactSecrets("sk-proj-abc123def456ghi789jkl012")).toBe("[redacted]");
    expect(redactSecrets("sk-ant-api03-abcdef1234567890")).toBe("[redacted]");
    expect(redactSecrets("sk-1234567890abcdef")).toBe("[redacted]");
    expect(redactSecrets("sk-learn is a python library")).toBe("sk-learn is a python library");
  });

  it("redacts Google Cloud AIza API keys", () => {
    expect(redactSecrets("AIzaSyD-1234567890abcdefGhIjKlMnOpQrSt")).toBe("[redacted]");
  });

  it("redacts Slack xoxb- and xoxp- tokens", () => {
    expect(redactSecrets("xoxb-1234567890-1234567890-abcdef")).toBe("[redacted]");
    expect(redactSecrets("xoxp-1234567890-1234567890-abcdef")).toBe("[redacted]");
  });

  it("redacts JWT-like eyJ tokens", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(redactSecrets(jwt)).toBe("[redacted]");
  });

  it("redacts password, token, secret, and api_key query/env values", () => {
    expect(redactSecrets("https://example.com/api?token=secret123&user=42")).toBe(
      "https://example.com/api?token=[redacted]&user=42",
    );
    expect(redactSecrets("curl https://example.com?password=supersecret&other=val")).toBe(
      "curl https://example.com?password=[redacted]&other=val",
    );
    expect(redactSecrets("export API_KEY=my_secret_key")).toBe("export API_KEY=[redacted]");
    expect(redactSecrets('export API_KEY="my_secret_key"')).toBe("export API_KEY=[redacted]");
    expect(redactSecrets("TOKEN=my_env_token npm start")).toBe("TOKEN=[redacted] npm start");
    expect(redactSecrets("SECRET=xyz123")).toBe("SECRET=[redacted]");
    expect(redactSecrets("api_key=mykey12345")).toBe("api_key=[redacted]");
  });

  it("redacts JSON-style password and api_key fields", () => {
    expect(redactSecrets('{"password": "hunter2", "api_key": "abcd1234"}')).toBe(
      '{"password": "[redacted]", "api_key": "[redacted]"}',
    );
  });

  it("redacts curl credentials (-u / --user with or without space)", () => {
    expect(redactSecrets("curl -u user:pass https://example.com")).toBe(
      "curl -u user:[redacted] https://example.com",
    );
    expect(redactSecrets("curl -uadmin:secret123 https://example.com")).toBe(
      "curl -uadmin:[redacted] https://example.com",
    );
    expect(redactSecrets("curl --user admin:secret123 https://example.com")).toBe(
      "curl --user admin:[redacted] https://example.com",
    );
  });

  it("redacts URL credentials (scheme://user:pass@host)", () => {
    expect(redactSecrets("git clone https://bot:ghp_secret@github.com/org/repo.git")).toBe(
      "git clone https://bot:[redacted]@github.com/org/repo.git",
    );
    expect(redactSecrets("postgres://admin:supersecret@127.0.0.1:5432/mydb")).toBe(
      "postgres://admin:[redacted]@127.0.0.1:5432/mydb",
    );
  });

  it("redacts AWS Access Key IDs (AKIA...)", () => {
    expect(redactSecrets("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE")).toBe("AWS_ACCESS_KEY_ID=[redacted]");
    expect(redactSecrets("access key is AKIAIOSFODNN7EXAMPLE in config")).toBe(
      "access key is [redacted] in config",
    );
  });

  it("redacts CLI flags and YAML/config password/token values", () => {
    expect(redactSecrets("app --password mySecretPassword --host localhost")).toBe(
      "app --password [redacted] --host localhost",
    );
    expect(redactSecrets("cli --token 'my-cli-token'")).toBe("cli --token [redacted]");
    expect(redactSecrets("password: superSecretValue\nhost: localhost")).toBe(
      "password: [redacted]\nhost: localhost",
    );
    expect(redactSecrets("api_key: 'conf-api-key'")).toBe("api_key: [redacted]");
  });

  it("redacts single-quoted JSON and Python dicts", () => {
    expect(redactSecrets("{'password': 'hunter2', 'api_key': 'abcd1234'}")).toBe(
      "{'password': '[redacted]', 'api_key': '[redacted]'}",
    );
  });

  it("redacts generalized token/key env variables while preserving words like keyboard=on", () => {
    expect(redactSecrets("GITHUB_TOKEN=abc123 curl -u user:pass x")).toBe(
      "GITHUB_TOKEN=[redacted] curl -u user:[redacted] x",
    );
    expect(redactSecrets("MY_SECRET=shh export ACCESS_KEY=123")).toBe(
      "MY_SECRET=[redacted] export ACCESS_KEY=[redacted]",
    );
    expect(redactSecrets("settings: keyboard=on mouse=off key=secret123")).toBe(
      "settings: keyboard=on mouse=off key=[redacted]",
    );
  });

  it("redacts long hex strings (32+ chars) and padded/unpadded base64 strings while preserving paths", () => {
    expect(
      redactSecrets("key aaaaaaaaaa0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
    ).toBe("key [redacted]");
    expect(redactSecrets("Z2l0aHViX3NlY3JldF9iYXNlNjRfdmFsdWVfdGhhdF9pc19sb25nX2Vub3VnaA==")).toBe(
      "[redacted]",
    );
    // Unpadded base64 string (32+ chars, mixed casing and digits)
    expect(redactSecrets("token: dGhpcyBpcyBhIHNhbXBsZSB1bnBhZGRlZCBiYXNlNjQ")).toBe("token: [redacted]");
    expect(
      redactSecrets("/Users/padi/Documents/projects/ai-projects/i-inc/apps/daemon/src/sessions.ts"),
    ).toBe("/Users/padi/Documents/projects/ai-projects/i-inc/apps/daemon/src/sessions.ts");
  });

  it("redacts items stored in SessionStore automatically", async () => {
    const db = await openDb(":memory:");
    migrate(db);
    const store = new SessionStore(db, { now: () => 1000 });
    const s = store.start("ticket-1", "build", "ada", "opus");

    store.recordItem(s, {
      kind: "tool",
      title: "curl -H 'Authorization: Bearer secret-token' https://api.com",
      status: "token=abc12345",
      at: 1000,
    });
    store.recordItem(s, {
      kind: "text",
      text: "OpenAI key: sk-proj-1234567890abcdef and gh: ghp_1234567890abcdef1234567890abcdef1234",
      at: 1005,
    });
    store.finish(s);

    const list = store.list("ticket-1");
    expect(list[0]?.items[0]?.title).toBe("curl -H 'Authorization: [redacted]' https://api.com");
    expect(list[0]?.items[0]?.status).toBe("token=[redacted]");
    expect(list[0]?.items[1]?.text).toBe("OpenAI key: [redacted] and gh: [redacted]");
  });
});

describe("Item cap and retention", () => {
  it("caps items at 500 per session, drops further items, and records [truncated]", async () => {
    const db = await openDb(":memory:");
    migrate(db);
    const store = new SessionStore(db, { now: () => 1000 });
    const s = store.start("ticket-1", "plan", "ada", "opus");

    // Record 550 items
    for (let i = 0; i < 550; i++) {
      store.recordItem(s, {
        kind: "text",
        text: `Item ${i}`,
        at: 1000 + i,
      });
    }
    store.finish(s);

    const list = store.list("ticket-1");
    expect(list).toHaveLength(1);
    const items = list[0]?.items ?? [];

    // First 500 items are recorded
    expect(items[0]).toEqual({ kind: "text", text: "Item 0", at: 1000 });
    expect(items[499]).toEqual({ kind: "text", text: "Item 499", at: 1499 });

    // Item 500 was dropped and replaced by [truncated]
    expect(items).toHaveLength(501);
    expect(items[500]).toEqual({ kind: "text", text: "[truncated]", at: 1500 });
  });

  it("keeps at most 50 sessions per ticket, deleting oldest", async () => {
    const db = await openDb(":memory:");
    migrate(db);
    let time = 1000;
    const store = new SessionStore(db, { now: () => ++time });

    // Start 55 sessions for ticket-1
    for (let i = 1; i <= 55; i++) {
      const s = store.start("ticket-1", `stage-${i}`, "ada", "opus");
      store.recordItem(s, { kind: "text", text: `session ${i} note`, at: time });
      store.finish(s);
    }

    const list = store.list("ticket-1");
    expect(list).toHaveLength(50);
    // Oldest 5 sessions (stage-1 to stage-5) were deleted, remaining are stage-6 to stage-55
    expect(list[0]?.stage).toBe("stage-6");
    expect(list[49]?.stage).toBe("stage-55");
  });
});
