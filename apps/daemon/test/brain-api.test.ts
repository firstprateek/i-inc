// The brain's read API (contract C19): search and maps over the index, owner-only.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { json } from "@i-inc/core/testing";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api.ts";
import { refunds, testApp } from "./setup.ts";

describe("GET /api/brain/search and /api/brain/map", () => {
  async function seeded() {
    const app = await testApp();
    app.agent.on(
      { employee: "ada", stage: "retro" },
      {
        kind: "done",
        output: json({
          edits: [{ layer: "fact", page: "gh-cli", text: "gh pr checks --watch waits for CI to finish." }],
        }),
      },
    );
    app.agent.on(
      { employee: "kit", stage: "retro" },
      {
        kind: "done",
        output: json({
          edits: [{ layer: "brain", page: "duties/review", text: "Kit checks date maths first." }],
        }),
      },
    );
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    await app.call("POST", "/api/tickets/1/decide", { decision: "approve" });
    await app.daemon.idle();
    return app;
  }

  it("finds pages the retro just wrote, with a snippet, as soon as they are committed", async () => {
    const app = await seeded();
    const r = await app.call("GET", "/api/brain/search?q=wait%20for%20CI");
    expect(r.status).toBe(200);
    expect(r.body.results[0]).toMatchObject({
      scope: "company",
      slug: "facts/gh-cli",
      title: "Gh cli",
      description: "gh pr checks --watch waits for CI to finish.",
    });
    expect(r.body.results[0].snippet).toContain("CI");
    expect(r.body.results[0].updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(r.body.results[0]).sort()).toEqual([
      "description",
      "scope",
      "slug",
      "snippet",
      "title",
      "updated",
    ]);
  });

  it("limits a search to one scope", async () => {
    const app = await seeded();
    const q = "date maths";
    expect((await app.call("GET", `/api/brain/search?q=${q}&scope=company`)).body.results).toEqual([]);
    const kit = await app.call("GET", `/api/brain/search?q=${q}&scope=brain:kit`);
    expect(kit.body.results.map((x: { slug: string }) => x.slug)).toEqual(["duties/review"]);
    const all = await app.call("GET", `/api/brain/search?q=${q}&scope=all`);
    expect(all.body.results.map((x: { scope: string }) => x.scope)).toEqual(["brain:kit"]);
  });

  it("answers 400 for a missing query or a malformed scope, 404 for an unknown brain or team", async () => {
    const app = await testApp();
    for (const path of [
      "/api/brain/search",
      "/api/brain/search?q=",
      "/api/brain/search?q=%20%20",
      "/api/brain/search?q=x&scope=nonsense",
      "/api/brain/search?q=x&scope=brain:",
      "/api/brain/search?q=x&scope=brain:..%2Fetc",
      "/api/brain/map",
      "/api/brain/map?scope=all",
      "/api/brain/map?scope=%00",
    ]) {
      expect((await app.call("GET", path)).status, path).toBe(400);
    }
    expect((await app.call("GET", "/api/brain/search?q=x&scope=brain:nobody")).status).toBe(404);
    expect((await app.call("GET", "/api/brain/map?scope=team:nobody")).status).toBe(404);
  });

  it("survives FTS syntax and a huge query", async () => {
    const app = await seeded();
    for (const q of ['"', "NEAR(", "a*", "title:x OR (", "x".repeat(50_000)]) {
      const r = await app.call("GET", `/api/brain/search?q=${encodeURIComponent(q)}`);
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body.results)).toBe(true);
    }
  });

  it("serves a scope's map, one line per page", async () => {
    const app = await seeded();
    const m = await app.call("GET", "/api/brain/map?scope=brain:kit");
    expect(m.status).toBe(200);
    expect(m.body.scope).toBe("brain:kit");
    expect(m.body.sections).toEqual([]);
    expect(m.body.lines).toContain("- [[duties/review]] — Kit checks date maths first.");
    expect(m.body.lines.some((l: string) => l.startsWith("- [[personality]] — "))).toBe(true);
    const c = await app.call("GET", "/api/brain/map?scope=company");
    expect(c.body.lines).toContain("- [[facts/gh-cli]] — gh pr checks --watch waits for CI to finish.");
    expect((await app.call("GET", "/api/brain/map?scope=company&section=nope")).status).toBe(404);
  });

  it("answers 404 for sections that aren't own properties: constructor, __proto__, toString, hasOwnProperty", async () => {
    const app = await seeded();
    for (const section of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "nope"]) {
      const r = await app.call("GET", `/api/brain/map?scope=company&section=${section}`);
      expect(r.status, section).toBe(404);
      expect(r.body).toEqual({ error: "no such section" });
    }
  });

  it("serves a real section of a split map", async () => {
    const knowledgeDir = mkdtempSync(join(tmpdir(), "i-inc-knowledge-"));
    const app = await testApp(":memory:", knowledgeDir);
    const dir = join(knowledgeDir, "handbook");
    mkdirSync(join(dir, "facts"), { recursive: true });
    for (let i = 0; i < 200; i++) {
      writeFileSync(
        join(dir, "facts", `p${i}.md`),
        `---\ntitle: P${i}\ndescription: page ${i}\ntags: []\nsources: []\n---\nx\n`,
        { flag: "w" },
      );
    }
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: dir });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-m",
        "many",
      ],
      { cwd: dir },
    );
    app.deps.brain.sync({ kind: "handbook" });
    const root = (await app.call("GET", "/api/brain/map?scope=company")).body;
    expect(root.sections).toEqual(["facts", "facts#2"]);
    expect(root.lines.length).toBeLessThanOrEqual(150);
    const sec = (await app.call("GET", "/api/brain/map?scope=company&section=facts%232")).body;
    expect(sec.section).toBe("facts#2");
    expect(sec.lines[0]).toBe("## facts#2");
  });

  it("keeps /api/knowledge/* working", async () => {
    const app = await seeded();
    const handbook = (await app.call("GET", "/api/knowledge/handbook")).body;
    expect(handbook.pages.some((p: { path: string }) => p.path === "facts/gh-cli.md")).toBe(true);
    expect((await app.call("GET", "/api/knowledge/brains/kit")).status).toBe(200);
  });

  it("is owner-only: 401 without the token, like every other route", async () => {
    const app = await testApp();
    const handle = createApi(app.daemon, app.deps, { token: "s3cret", hosts: ["127.0.0.1:7420"] });
    const send = (path: string, headers: Record<string, string> = {}) =>
      handle(
        new Request(`http://127.0.0.1:7420${path}`, { headers: { host: "127.0.0.1:7420", ...headers } }),
      );
    expect((await send("/api/brain/search?q=x")).status).toBe(401);
    expect((await send("/api/brain/map?scope=company")).status).toBe(401);
    expect((await send("/api/brain/search?q=x", { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await send("/api/brain/search?q=x", { authorization: "Bearer s3cret" })).status).toBe(200);
    expect((await send("/api/brain/map?scope=company", { authorization: "Bearer s3cret" })).status).toBe(200);
  });
});
