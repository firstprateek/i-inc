// A local daemon for the end-to-end run of "Open the session" (T69), under Bun, in a scratch HOME:
//
//   pnpm --filter @i-inc/web build
//   I_INC_HOME=$(mktemp -d) PORT=7462 bun apps/daemon/scripts/e2e-session-server.ts
//
// The real daemon (API, AHP host and transport, the ticket pipeline) over the core's fakes, with the demo cast. The
// plan stage's agent is scripted to work in three steps, each waiting for the run:
//   1. a plan, some thinking and a few words;  2. a read and an edit with a diff;  3. the answer, usage, the end.
// Control, for the run only: POST /__e2e {"op": "run"} makes a ticket and starts it; {"op": "step"} lets the plan
// stage take its next step; anything else says how many steps were taken. The run restarts this process itself.
import { existsSync, mkdirSync } from "node:fs";
import { join, normalize } from "node:path";
import type { Agent, SessionOutcome, SessionRequest } from "@i-inc/core";
import { FakeAgent, FakeChat, FakeHarness, FakeHelper, FakeMachines } from "@i-inc/core/testing";
import type { WsData } from "../src/ahp/transport.ts";
import { createApp } from "../src/app.ts";
import { seedDemo } from "../src/demo.ts";
import { FakePushService } from "../src/push.ts";

const home = process.env.I_INC_HOME;
if (!home || home.includes(".i-inc")) throw new Error("set I_INC_HOME to a scratch folder");
const port = Number(process.env.PORT ?? 7462);
const web = process.env.I_INC_WEB ?? join(import.meta.dir, "../../web/dist");
mkdirSync(home, { recursive: true });
const log = (m: string) => console.log(new Date().toISOString(), m);

// The plan stage waits at each gate until the run says "step".
const gates: (() => void)[] = [];
const wait = () => new Promise<void>((r) => gates.push(r));
const steps = { taken: 0 };

const fake = new FakeAgent();
const agent: Agent = {
  async run(req: SessionRequest): Promise<SessionOutcome> {
    if (req.stage !== "plan") return fake.run(req);
    const say = (u: Record<string, unknown>) => req.onAgentUpdate?.(u);
    say({
      sessionUpdate: "plan",
      entries: [
        { content: "Find where refunds are counted", status: "in_progress", priority: "high" },
        { content: "Change the sum and add a test", status: "pending", priority: "high" },
      ],
    });
    say({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Refunds are negative cents." },
    });
    say({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Looking at the spending sum. " },
    });
    steps.taken = 1;
    await wait();
    say({
      sessionUpdate: "tool_call",
      toolCallId: "read-1",
      title: "Read src/spending.ts",
      kind: "read",
      status: "completed",
      locations: [{ path: "src/spending.ts" }],
      content: [
        {
          type: "content",
          content: { type: "text", text: "export const sum = (xs) => xs.reduce((a, b) => a + b, 0);\n" },
        },
      ],
    });
    say({
      sessionUpdate: "tool_call",
      toolCallId: "edit-1",
      title: "Edit src/spending.ts",
      kind: "edit",
      status: "pending",
    });
    say({
      sessionUpdate: "tool_call_update",
      toolCallId: "edit-1",
      status: "completed",
      content: [
        {
          type: "diff",
          path: "/home/employee/work/inc-1/src/spending.ts",
          oldText: "export const sum = (xs) => xs.reduce((a, b) => a + b, 0);\n",
          newText: "export const sum = (xs) => xs.filter((x) => x > 0).reduce((a, b) => a + b, 0);\n",
        },
      ],
    });
    steps.taken = 2;
    await wait();
    say({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Approach: ignore refunds in the sum." },
    });
    say({ sessionUpdate: "usage_update", used: 4200, size: 200000 });
    req.onAgentUsage?.({ inputTokens: 1800, outputTokens: 240 });
    steps.taken = 3;
    return { kind: "done", output: "Approach: ignore refunds in the sum." };
  },
};

const app = await createApp({
  knowledgeDir: join(home, "knowledge"),
  clock: { now: () => Date.now() },
  hosts: [`127.0.0.1:${port}`, `localhost:${port}`],
  log,
  configDir: join(home, "config"),
  dbPath: join(home, "e2e.db"),
  machines: new FakeMachines(),
  agent,
  harness: new FakeHarness(),
  helper: new FakeHelper(),
  chat: new FakeChat(),
  push: (registry) => new FakePushService(registry),
});
if (app.deps.registry.employees().length === 0) {
  seedDemo(app.deps.registry);
  app.daemon.ensureKnowledge();
}
app.ahp.transport.start();

async function control(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { op?: string };
  if (body.op === "run") {
    const made = await app.handle(
      new Request(`http://127.0.0.1:${port}/api/tickets`, {
        method: "POST",
        headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
        body: JSON.stringify({
          title: "Refunds are counted as spending",
          project: "Duet",
          type: "fix",
          effort: "medium",
          doneWhen: ["August drops by the refund"],
          assignee: "ada",
        }),
      }),
    );
    const id = ((await made.json()) as { ticket: { id: string } }).ticket.id;
    app.daemon.run(id);
    return Response.json({ id });
  }
  if (body.op === "step") {
    gates.shift()?.();
    return Response.json({ taken: steps.taken, waiting: gates.length });
  }
  return Response.json({ taken: steps.taken, waiting: gates.length });
}

async function serveWeb(req: Request): Promise<Response> {
  const path = normalize(new URL(req.url).pathname).replace(/^(\.\.[/\\])+/, "");
  const file = Bun.file(join(web, path === "/" ? "index.html" : path));
  if (await file.exists()) return new Response(file);
  return new Response(Bun.file(join(web, "index.html")));
}

Bun.serve<WsData>({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 60,
  fetch: (req, server) => {
    if (app.ahp.transport.matches(req)) {
      const g = app.ahp.transport.guard(req);
      if ("refusal" in g) return g.refusal;
      if (server.upgrade(req, { data: g.data })) return undefined;
      return new Response("websocket upgrade failed", { status: 400 });
    }
    if (new URL(req.url).pathname === "/__e2e") return control(req);
    return new URL(req.url).pathname.startsWith("/api/") || !existsSync(web)
      ? app.handle(req)
      : serveWeb(req);
  },
  websocket: app.ahp.transport.websocket,
});
console.log(`e2e daemon on http://127.0.0.1:${port} (home ${home})`);
