// A local daemon for driving the Conversations screen end to end (run by hand, with `bun`):
//
//   I_INC_HOME=<scratch dir> PORT=7611 bun apps/daemon/test/ahp/e2e-server.ts
//
// It is the real daemon (REST, the AHP host and transport, the session host) over a fake Exec: the agents
// behind conversations are the scripted fake ACP agent of the session-host tests, so nothing touches a
// container, a sandbox or the network. It serves the web build from I_INC_WEB. The prompt picks what the
// fake agent does (see fake-acp.ts); two more scenarios are added here for the screen:
//   "burst N"     N message chunks as fast as the loop turns, then the end (the streaming performance test);
//                 "blob N" is the same as one enormous paragraph
//   "markdown"    a reply with headings, lists, a table, a link and highlighted code, streamed in small chunks
//   "longtools"   thirty read calls, for a long turn
import { existsSync, mkdirSync } from "node:fs";
import { join, normalize } from "node:path";
import { FakeAgent, FakeChat, FakeHarness, FakeHelper, FakeMachines } from "@i-inc/core/testing";
import { agentsFromRegistry } from "../../src/ahp/conversations.ts";
import { SessionHost } from "../../src/ahp/session-host.ts";
import type { WsData } from "../../src/ahp/transport.ts";
import { createApp } from "../../src/app.ts";
import { seedDemo } from "../../src/demo.ts";
import { FakeAcpAgent, FakeSandbox } from "./fake-acp.ts";

type Any = any; // biome-ignore lint/suspicious/noExplicitAny: patching the fake agent

const home = process.env.I_INC_HOME;
if (!home || home.includes(".i-inc")) throw new Error("set I_INC_HOME to a scratch folder");
const port = Number(process.env.PORT ?? 7611);
const web = process.env.I_INC_WEB ?? join(import.meta.dir, "../../../web/dist");
mkdirSync(home, { recursive: true });

const MARKDOWN = [
  "## What I found\n\n",
  "The constant lives in `src/app.ts`. Here is the **short version**:\n\n",
  "- it is read once at start-up\n- it is *not* configurable yet\n- tests pin it\n\n",
  "```ts\n// before\nexport const answer = 41;\nfunction check(n: number): boolean {\n  return n === answer; // compare\n}\n```\n\n",
  "| file | change |\n|:--|--:|\n| `src/app.ts` | 1 line |\n| `test/app.test.ts` | 2 lines |\n\n",
  "See [the docs](https://example.com/docs) and ~~the old plan~~. A <script>alert(1)</script> tag stays text.\n\n",
  "1. read the file\n2. change the constant\n3. run the tests\n",
];

const proto = FakeAcpAgent.prototype as Any;
const original = proto.prompt;
proto.prompt = async function (this: Any, sessionId: string, blocks: Any[]): Promise<Any> {
  const text = blocks
    .filter((b: Any) => b.type === "text")
    .map((b: Any) => String(b.text))
    .join(" ");
  const said = text.split("The owner's new message:").pop()?.trim() ?? text;
  const chunk = (t: string) =>
    this.update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });
  if (said.startsWith("burst") || said.startsWith("blob")) {
    const n = Number(said.split(/\s+/)[1] ?? 2000);
    for (let i = 0; i < n; i++) {
      // "burst": paragraphs of sixty words; "blob": one enormous paragraph (the worst case for a parser)
      chunk(`word${i} ${said.startsWith("burst") && i % 60 === 59 ? "\n\n" : ""}`);
      if (i % 50 === 49) await new Promise((r) => setTimeout(r, 2));
    }
    return { stopReason: "end_turn", _meta: { usage: { inputTokens: 900, outputTokens: n } } };
  }
  if (said.startsWith("markdown")) {
    for (const part of MARKDOWN) {
      for (let i = 0; i < part.length; i += 7) {
        chunk(part.slice(i, i + 7));
        await new Promise((r) => setTimeout(r, 4));
      }
    }
    return { stopReason: "end_turn", _meta: { usage: { inputTokens: 1500, outputTokens: 220 } } };
  }
  if (said.startsWith("longtools")) {
    for (let i = 0; i < 30; i++) {
      this.update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: `lt-${i}`,
        title: `Read src/file${i}.ts`,
        kind: "read",
        status: "completed",
        rawInput: { path: `src/file${i}.ts` },
        locations: [{ path: `src/file${i}.ts` }],
        content: [{ type: "content", content: { type: "text", text: `// file ${i}\nexport const n${i} = ${i};\n` } }],
      });
    }
    chunk("Read thirty files.");
    return { stopReason: "end_turn" };
  }
  return original.call(this, sessionId, blocks);
};

const sandbox = new FakeSandbox();
const log = (m: string) => console.log(new Date().toISOString(), m);
const app = await createApp({
  knowledgeDir: join(home, "knowledge"),
  clock: { now: () => Date.now() },
  hosts: [`127.0.0.1:${port}`, `localhost:${port}`],
  log,
  configDir: join(home, "config"),
  dbPath: join(home, "e2e.db"),
  machines: new FakeMachines(),
  agent: new FakeAgent(),
  harness: new FakeHarness(),
  helper: new FakeHelper(),
  chat: new FakeChat(),
  ahpBackend: (registry) =>
    new SessionHost({
      launch: sandbox.launch,
      agents: () => agentsFromRegistry(registry),
      engine: (id) => registry.engines().find((e) => e.id === id),
      teamOf: (employeeId) => registry.teamOf(employeeId).id,
      workingCopy: async () => {},
      credentials: () => ({}),
      effort: () => "medium",
      cancelGraceMs: 300,
      startTimeoutMs: 5000,
      log,
    }),
});
if (app.deps.registry.employees().length === 0) {
  seedDemo(app.deps.registry);
  app.daemon.ensureKnowledge();
}
app.ahp.transport.start();
if (app.ahp.backend instanceof SessionHost) app.ahp.backend.start();

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
    return new URL(req.url).pathname.startsWith("/api/") || !existsSync(web) ? app.handle(req) : serveWeb(req);
  },
  websocket: app.ahp.transport.websocket,
});
console.log(`e2e daemon on http://127.0.0.1:${port} (home ${home})`);
