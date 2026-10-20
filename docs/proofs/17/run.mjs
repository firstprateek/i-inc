// Run with: bun docs/proofs/17/run.mjs
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../../apps/daemon/src/app.ts";
import { seedDemo } from "../../../apps/daemon/src/demo.ts";
import { FineGrainedToken } from "../../../apps/daemon/src/github.ts";
import { GitHubWorkspace } from "../../../apps/daemon/src/workspace.ts";
import {
  FakeAgent,
  FakeChat,
  FakeHarness,
  FakeHelper,
  FakeMachines,
} from "../../../packages/core/src/testing/index.ts";

const root = mkdtempSync(join(tmpdir(), "inc-17-proof-"));
const env = { ...process.env, GIT_CONFIG_GLOBAL: join(root, "gitconfig") };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const origin = join(root, "origin");
git(root, "init", "-q", "-b", "main", origin);
writeFileSync(join(origin, "README.md"), "proof fixture\n");
git(origin, "add", ".");
git(origin, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const images = [
  [
    "chart.png",
    "image/png",
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    ),
  ],
  ["receipt.jpg", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe1, 1, 2, 3, 0xff, 0xd9])],
];
const observations = {
  transport:
    "HTTP daemon; real bash/git; separate filesystem roots replacing remote machine transport; scripted agent and GitHub PR service",
  runs: [],
};
const machine = (employee) =>
  join(root, employee === "ada" ? "builder" : employee === "quinn" ? "verifier" : "reviewer");
const sessions = [];
class ObservingAgent extends FakeAgent {
  async run(request) {
    if (
      (request.duty === "review" && request.stage === "review") ||
      (request.duty === "verify" && request.stage === "prove")
    ) {
      const worktree = join(machine(request.employee.id), `inc-${request.ticket.id}`);
      const paths = images.map(([name], i) => `.inc/attachments/${i + 1}-${name}`);
      const hashes = paths.map((path, i) => {
        assert(request.brief.includes(path), `brief missing ${path}`);
        const bytes = readFileSync(join(worktree, path));
        assert.deepEqual(bytes, images[i][2]);
        return sha(bytes);
      });
      const mode = request.ticket.project;
      const clean = mode === "owner-merges" ? git(worktree, "status", "--porcelain") === "" : null;
      if (mode === "owner-merges") assert(clean);
      sessions.push({
        ticket: request.ticket.id,
        employee: request.employee.id,
        duty: request.duty,
        machine: machine(request.employee.id),
        paths,
        hashes,
        clean,
        brief: request.brief,
      });
    }
    return super.run(request);
  }
}
const agent = new ObservingAgent();
const app = await createApp({
  dbPath: ":memory:",
  knowledgeDir: join(root, "knowledge"),
  configDir: join(root, "config"),
  clock: { now: () => Date.now() },
  machines: new FakeMachines(),
  agent,
  harness: new FakeHarness(),
  helper: new FakeHelper(),
  chat: new FakeChat(),
  hosts: ["127.0.0.1:57400"],
  workspace: (registry, tickets) =>
    new GitHubWorkspace({
      project: (name) => registry.project(name),
      policy: (name) => registry.projectPolicy(name),
      tokens: new FineGrainedToken("fixture-token"),
      prs: {
        find: async () => null,
        openDraft: async () => ({ number: 1, url: "https://github.com/fixture/repo/pull/1", nodeId: "PR_1" }),
        setBody: async () => {},
        isDraft: async () => true,
        markReady: async () => {},
      },
      identity: async (employee) => ({ name: employee.name, email: `${employee.id}@example.invalid` }),
      remote: () => origin,
      worktree: (id) => `/proof-machine/inc-${id}`,
      attachments: (id) => tickets.attachments(id),
      run: (employee, script, extra = {}) =>
        new Promise((resolve, reject) => {
          const child = spawn("bash", ["-s"], { env: { ...env, ...extra }, stdio: ["pipe", "pipe", "pipe"] });
          let output = "";
          child.stdout.on("data", (chunk) => {
            output += chunk;
          });
          child.stderr.on("data", (chunk) => {
            output += chunk;
          });
          child.on("error", reject);
          child.on("exit", (code) => resolve({ code, output }));
          child.stdin.end(script.replaceAll("/proof-machine", machine(employee)));
        }),
    }),
});
seedDemo(app.deps.registry);
for (const employee of app.deps.registry.employees()) {
  app.deps.registry.hire({
    ...employee,
    duties:
      employee.id === "ada"
        ? ["build"]
        : employee.id === "kit"
          ? ["review"]
          : employee.id === "quinn"
            ? ["verify"]
            : [],
  });
}
for (const id of ["ada", "kit", "quinn"]) app.deps.registry.setTeam({ id, name: id, members: [id] });
for (const mode of ["owner-merges", "direct"])
  app.deps.registry.addProject({ id: mode, repo: "fixture/repo", checks: ["true"], mode });
app.daemon.ensureKnowledge();
const server = Bun.serve({ hostname: "127.0.0.1", port: 57400, fetch: app.handle });
const interval = setInterval(() => void app.daemon.tick(), 30);
try {
  for (const mode of ["owner-merges", "direct"]) {
    const form = new FormData();
    form.set(
      "ticket",
      JSON.stringify({
        title: `Images ${mode}`,
        project: mode,
        type: "feat",
        effort: "medium",
        doneWhen: ["images reach review"],
        assignee: "ada",
      }),
    );
    for (const [name, mime, bytes] of images) form.append("image", new Blob([bytes], { type: mime }), name);
    const response = await fetch("http://127.0.0.1:57400/api/tickets", {
      method: "POST",
      headers: { "x-i-inc-upload": "1" },
      body: form,
    });
    assert.equal(response.status, 201);
    const created = await response.json();
    const id = created.ticket.id;
    let result;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      result = await (await fetch(`http://127.0.0.1:57400/api/tickets/${id}`)).json();
      if (["ready", "done", "failed", "needs-you"].includes(result.ticket.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(result.ticket.status, mode === "direct" ? "done" : "ready", JSON.stringify(result));
    const helpers = sessions.filter((session) => session.ticket === id);
    assert.equal(helpers.filter((session) => session.duty === "review").length, 1);
    assert.equal(helpers.filter((session) => session.duty === "verify").length, 1);
    for (const helper of helpers) {
      assert.notEqual(helper.machine, machine("ada"));
      const copied = result.events.findIndex(
        (event) => event.type === "attachments-copied" && event.employeeId === helper.employee,
      );
      const started = result.events.findIndex(
        (event) => event.type === "session-started" && event.employeeId === helper.employee,
      );
      assert(copied >= 0 && started > copied);
    }
    observations.runs.push({
      mode,
      ticket: id,
      status: result.ticket.status,
      sessions: helpers,
      events: result.events.filter((event) => ["attachments-copied", "session-started"].includes(event.type)),
    });
  }
  writeFileSync(new URL("observations.json", import.meta.url), `${JSON.stringify(observations, null, 2)}\n`);
  console.log(
    "PASS: both modes delivered byte-identical images and listed paths before reviewer and verifier sessions",
  );
} finally {
  clearInterval(interval);
  await app.daemon.idle();
  server.stop(true);
  app.db.close();
}
