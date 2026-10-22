// A local daemon for the Brain changes feed's end-to-end run (T58): the real API and web app over an in-memory
// database, with brain copies in a scratch folder instead of a sandbox (the harvest scripts run in bash on it),
// and a brain that agents have already written to: a created, an updated, a deleted and a moved page, a policy
// change, a page from a web page, a conflict, and changes that were refused. Run with Bun, in a scratch HOME:
//
//   pnpm --filter @i-inc/web build
//   HOME=$(mktemp -d) PORT=7451 bun apps/daemon/scripts/e2e-brain-server.ts
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { FakeAgent, FakeChat, FakeHarness, FakeHelper, FakeMachines } from "@i-inc/core/testing";
import type { WsData } from "../src/ahp/transport.ts";
import { createApp } from "../src/app.ts";
import { seedDemo } from "../src/demo.ts";
import { FakePushService } from "../src/push.ts";

const port = Number(process.env.PORT ?? 7451);
const web = join(import.meta.dir, "../../web/dist");
const knowledgeDir = mkdtempSync(join(tmpdir(), "i-inc-e2e-knowledge-"));
const sandbox = mkdtempSync(join(tmpdir(), "i-inc-e2e-sandbox-"));

const page = (title: string, description: string, body: string, extra = "") =>
  `---\ntitle: ${title}\ndescription: ${description}\ntags: []\nupdated: 2026-10-01\nsources: []\n${extra}---\n${body}\n`;
const prose = (topic: string) =>
  `${topic} matters because the owner reads these pages first.\nThe second line explains how to do it, step by step, and why it works.`;

const app = await createApp({
  dbPath: ":memory:",
  knowledgeDir,
  configDir: join(knowledgeDir, "config"),
  brainHome: sandbox,
  clock: { now: () => Date.now() },
  machines: new FakeMachines(),
  agent: new FakeAgent(),
  harness: new FakeHarness(),
  helper: new FakeHelper(),
  chat: new FakeChat(),
});
seedDemo(app.deps.registry);
app.deps.registry.addTeam({ id: "engineering", name: "Engineering", members: ["ada", "kit"] });
app.deps.registry.addTeam({ id: "home-pip", name: "Pip's home", members: ["pip"] });
app.daemon.ensureKnowledge();
app.deps.push = new FakePushService(app.deps.registry);
const feed = app.deps.brainFeed;
feed.deliver = async (_employee, script) => {
  const r = spawnSync("bash", ["-s"], { input: script, encoding: "utf8", maxBuffer: 1 << 28 });
  return { code: r.status ?? 1, output: `${r.stdout}${r.stderr}` };
};
feed.isUp = async () => true;

const { knowledge } = app.deps;
knowledge.commitFiles(
  { kind: "handbook" },
  {
    "facts/gh.md": page(
      "GitHub CLI",
      "gh pr checks waits for CI",
      `${prose("The gh tool")}\nUse gh pr checks --watch.`,
    ),
    "facts/signing.md": page("Release signing", "The signing step only the owner can do", prose("Signing")),
    "facts/old-ci.md": page("Old CI notes", "How CI worked before the move", prose("The old CI")),
    "projects/duet.md": page("Duet", "The couples' finance app", prose("Duet")),
    "facts/deploy.md": page(
      "Deploys",
      "How deploys go",
      `Deploys go out on merge.\nThe first line is original text here.\nThe last line is original text here.`,
    ),
  },
  "Seed the handbook",
  {},
);
knowledge.commitFiles(
  { kind: "brain", id: "ada" },
  { "tools/vitest.md": page("Vitest", "Reset mocks between tests", prose("Vitest mocks")) },
  "Seed Ada's brain",
  {},
);

const copy = (employee: string, path: string, text: string | null) => {
  const file = join(sandbox, employee, path);
  mkdirSync(dirname(file), { recursive: true });
  if (text === null) rmSync(file, { force: true });
  else writeFileSync(file, text);
};
const read = (employee: string, path: string) => Bun.file(join(sandbox, employee, path)).text();
const harvest = (employeeId: string, kind: "ticket" | "conversation", id: string) =>
  app.deps.brainHarvest.run({
    employeeId,
    source: { kind, id },
    trigger: kind === "ticket" ? "ticket-end" : "idle",
  });

await feed.sync("ada");
await feed.sync("kit");

// Ticket 14: Ada adds a lesson, rewrites a page, moves one, deletes one, and writes a page from a web page.
copy(
  "ada",
  "company/facts/flaky-tests.md",
  page("Flaky tests", "Retry a flaky test once before blaming it", prose("Flaky tests")),
);
copy(
  "ada",
  "company/projects/duet.md",
  `${await read("ada", "company/projects/duet.md")}\nThe release signing key lives on the Mac mini at home, so releases are cut from there.\n`,
);
copy("ada", "company/facts/old-ci.md", null);
const vitest = await read("ada", "personal/tools/vitest.md");
copy("ada", "personal/tools/vitest.md", null);
copy("ada", "personal/tools/vitest-mocks.md", vitest);
copy(
  "ada",
  "company/facts/vendor-limits.md",
  `---\ntitle: Vendor rate limits\ndescription: What the vendor's docs say about rate limits\nsources: [https://vendor.example/docs/limits]\n---\n${prose("The vendor's limits")}\n`,
);
await harvest("ada", "ticket", "14");

// Ticket 15: Ada tries a near-duplicate, a thin page and a log line; a policy changes.
copy(
  "ada",
  "company/facts/github-cli.md",
  page("GitHub CLI", "gh pr checks waits for CI", prose("The gh tool again")),
);
copy("ada", "company/facts/thin.md", page("Thin", "Nothing", "ok"));
copy(
  "ada",
  "company/policies/reviews.md",
  page("Reviews", "Every change gets a fresh review", prose("Reviews")),
);
symlinkSync("/etc/hosts", join(sandbox, "ada", "company/facts/evil.md"));
await harvest("ada", "ticket", "15");

// A conversation of Kit's: a conflict with a concurrent edit.
await feed.sync("kit");
const deploy = (first: string) =>
  page(
    "Deploys",
    "How deploys go",
    `Deploys go out on merge.\n${first}\nThe last line is original text here.`,
  );
knowledge.commitFiles(
  { kind: "handbook" },
  { "facts/deploy.md": deploy("The first line is the other version of it.") },
  "Edit meanwhile",
  {},
);
copy("kit", "company/facts/deploy.md", deploy("The first line is Kit's version of it."));
copy(
  "kit",
  "personal/duties/review.md",
  page("Review habits", "What Kit flags first in a review", prose("Kit's review habits")),
);
await harvest("kit", "conversation", "3f2a9c01");

Bun.serve<WsData>({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 60,
  fetch: async (req, server) => {
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
console.log(`ready http://127.0.0.1:${port}`);
