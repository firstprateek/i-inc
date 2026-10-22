// A local daemon for the projects flow's end-to-end run (T62): the real API and web app over an in-memory
// database, with the real GitHubApp class talking to a stand-in GitHub (apps/daemon/test/github-stub.ts)
// on a second port. No real credentials: the key is made up on the spot. Run with Bun, in a scratch HOME:
//
//   pnpm --filter @i-inc/web build
//   HOME=$(mktemp -d) SCENARIO=org PORT=7431 STUB_PORT=7432 bun apps/daemon/scripts/e2e-projects-server.ts
//
// SCENARIO=org      an organization with Administration: write (the bot can create repos), two projects
// SCENARIO=personal a personal account (the bot can't create repos), no projects yet
// Change GitHub's side while it runs: POST http://127.0.0.1:$STUB_PORT/__stub {"op": "addRepo", ...}
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { FakeAgent, FakeChat, FakeHarness, FakeHelper, FakeMachines } from "@i-inc/core/testing";
import type { WsData } from "../src/ahp/transport.ts";
import { createApp } from "../src/app.ts";
import { seedDemo } from "../src/demo.ts";
import { createGitHubStub, type StubOptions, stubApp } from "../test/github-stub.ts";

const scenario = process.env.SCENARIO === "personal" ? "personal" : "org";
const port = Number(process.env.PORT ?? 7431);
const stubPort = Number(process.env.STUB_PORT ?? 7432);
const web = join(import.meta.dir, "../../web/dist");
const api = `http://127.0.0.1:${stubPort}`;

const repo = (
  name: string,
  files: Record<string, string> | null = {},
  o: Partial<{ language: string; description: string }> = {},
) => ({
  owner: scenario === "org" ? "acme" : "someone",
  name,
  files: files ?? {},
  language: o.language ?? "TypeScript",
  description: o.description ?? null,
});
const node = {
  "package.json": JSON.stringify({ scripts: { check: "biome check .", test: "vitest run" } }),
  "pnpm-lock.yaml": "",
};
const options: StubOptions =
  scenario === "org"
    ? {
        account: "acme",
        accountType: "Organization",
        permissions: { contents: "write", pull_requests: "write", administration: "write" },
        repos: [
          repo("duet", node, { description: "The couples' finance app" }),
          repo("listy", { Makefile: "" }, { language: "Makefile" }),
          repo("notes-api", node, { description: "A small notes service" }),
          repo("sketchbook", {}, { description: "Nothing here yet" }),
        ],
      }
    : {
        account: "someone",
        accountType: "User",
        permissions: { contents: "write", pull_requests: "write" },
        repos: [
          repo("recipes", node, { description: "Family recipes" }),
          repo("garden", { "pyproject.toml": "" }, { language: "Python" }),
        ],
      };
const stub = createGitHubStub(options);

Bun.serve({
  port: stubPort,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/__stub") {
      const b = (await req.json()) as {
        op: string;
        name?: string;
        owner?: string;
        files?: Record<string, string>;
        sizeLag?: boolean;
        fail?: unknown;
      };
      if (b.op === "addRepo" && b.name) {
        stub.state.repos.push({
          owner: b.owner ?? stub.state.account,
          name: b.name,
          files: b.files ?? {},
          ...(b.sizeLag ? { sizeLag: true } : {}),
        });
      }
      if (b.op === "fail") stub.state.fail = (b.fail as typeof stub.state.fail) ?? null;
      if (b.op === "calls") return Response.json({ calls: stub.state.calls });
      return Response.json({ ok: true });
    }
    return stub.handle(req);
  },
});

const knowledgeDir = mkdtempSync(join(tmpdir(), "i-inc-e2e-knowledge-"));
const app = await createApp({
  dbPath: ":memory:",
  knowledgeDir,
  configDir: join(knowledgeDir, "config"),
  clock: { now: () => Date.now() },
  machines: new FakeMachines(),
  agent: new FakeAgent(),
  harness: new FakeHarness(),
  helper: new FakeHelper(),
  chat: new FakeChat(),
  tokens: stubApp(stub, api),
  githubApi: api,
});
seedDemo(app.deps.registry);
for (const p of app.deps.registry.projects()) app.deps.registry.removeProject(p.id);
if (scenario === "org") {
  app.deps.registry.addProject({
    id: "Duet",
    repo: "acme/duet",
    checks: ["pnpm install --frozen-lockfile", "pnpm check", "pnpm test"],
    mode: "owner-merges",
  });
  app.deps.registry.addProject({ id: "listy", repo: "acme/listy", checks: ["make"], mode: "direct" });
  const send = (path: string, body: unknown) =>
    app.handle(
      new Request(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  await send("/api/tickets", {
    title: "Refunds are counted as spending",
    project: "Duet",
    type: "fix",
    effort: "medium",
    doneWhen: ["August drops by the refund"],
    assignee: "ada",
  });
  await send("/api/tickets", {
    title: "Dark mode for the chart",
    project: "Duet",
    type: "feat",
    effort: "low",
    doneWhen: ["Chart follows the theme"],
  });
}
app.deps.registry.recordRelease({
  project: "Duet",
  tag: "v2026-10-18.1",
  at: Date.now() - 2 * 86_400_000,
  ticketIds: [],
  commits: [],
});

Bun.serve<WsData>({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 60,
  fetch: async (req, server) => {
    // The conversations socket: the web app opens it on every page, so without this it logs a console error.
    if (app.ahp.transport.matches(req)) {
      const g = app.ahp.transport.guard(req);
      if ("refusal" in g) return g.refusal;
      if (server.upgrade(req, { data: g.data })) return undefined;
      return new Response("websocket upgrade failed", { status: 400 });
    }
    const path = new URL(req.url).pathname;
    if (path.startsWith("/api/") || !existsSync(web)) return app.handle(req);
    const file = Bun.file(
      join(web, normalize(path).replace(/^(\.\.[/\\])+/, "") === "/" ? "index.html" : normalize(path)),
    );
    return new Response((await file.exists()) ? file : Bun.file(join(web, "index.html")));
  },
  websocket: app.ahp.transport.websocket,
});
console.log(`ready http://127.0.0.1:${port} (${scenario}); stub GitHub on ${api}`);
