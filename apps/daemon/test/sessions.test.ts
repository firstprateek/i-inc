import { PassThrough } from "node:stream";
import type { Engine, SessionRequest } from "@i-inc/core";
import { describe, expect, it } from "vitest";
import { AcpAgent, type AgentProcess } from "../src/acp.ts";
import { openDb } from "../src/db.ts";
import { migrate } from "../src/schema.ts";
import { capText, SessionStore } from "../src/sessions.ts";
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
});
