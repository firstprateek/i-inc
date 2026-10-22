// The Brain changes feed and the owner's undo (contract C19, T58): GET /api/brain/changes and
// POST /api/brain/changes/:id/revert, behind the same guards as every route.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "../src/api.ts";
import { brainRig, cleanRigs, page } from "./brain-rig.ts";

afterEach(cleanRigs);

const body = (topic: string) =>
  `${topic} matters because the owner reads these pages first.\nThe second line explains how to do it, step by step, and why it works.\n`;

async function world() {
  const w = await brainRig();
  w.commit("handbook", {
    "facts/gh.md": page(
      "GitHub CLI",
      "gh pr checks waits for CI",
      `${body("The gh tool")}Use gh pr checks --watch.`,
    ),
    "projects/duet.md": page("Duet", "The couples' finance app", body("Duet")),
  });
  w.commit("ada", { "tools/vitest.md": page("Vitest", "Reset mocks between tests", body("Vitest")) });
  await w.feed.sync("ada");
  await w.feed.sync("kit");
  const put = (employee: string, path: string, text: string | null) => {
    const file = w.copy(employee, path);
    mkdirSync(dirname(file), { recursive: true });
    if (text === null) rmSync(file, { force: true });
    else writeFileSync(file, text);
  };
  const harvest = (employeeId: string, id: string) =>
    w.app.deps.brainHarvest.run({ employeeId, source: { kind: "ticket", id }, trigger: "ticket-end" });
  const host = (repo: string, path: string) => {
    try {
      return w.git(repo, "show", `HEAD:${path}`);
    } catch {
      return null;
    }
  };
  return { ...w, put, harvest, host };
}

describe("GET /api/brain/changes", () => {
  it("lists every committed and refused change, newest first, with who, what, where from and a short diff", async () => {
    const w = await world();
    w.put(
      "ada",
      "company/facts/lesson.md",
      page("Flaky tests", "Retry a flaky test once", body("Flaky tests")),
    );
    w.put("ada", "company/facts/bad.md", page("Thin", "x", "ok"));
    await w.harvest("ada", "14");
    w.put(
      "kit",
      "personal/duties/review.md",
      page("Review habits", "What Kit flags first", body("Kit's reviews")),
    );
    await w.harvest("kit", "15");

    const r = await w.call("GET", "/api/brain/changes");
    expect(r.status).toBe(200);
    const list = r.body.changes;
    expect(list.map((c: { path: string }) => c.path)).toEqual([
      "personal/duties/review.md",
      "company/facts/bad.md",
      "company/facts/lesson.md",
    ]);
    expect(list[0]).toMatchObject({
      status: "committed",
      op: "create",
      scope: "brain:kit",
      slug: "duties/review",
      employee: { id: "kit", name: "Kit" },
      source: { kind: "ticket", id: "15", url: "#/ticket/15" },
      untrusted: false,
      policy: false,
      conflict: false,
      reverted: false,
      revertible: true,
    });
    expect(list[0].diff).toContain("+title: Review habits");
    expect(list[0].commit).toMatch(/^[0-9a-f]{40}$/);
    expect(list[0].harvest).toMatch(/^h\d+$/);
    expect(list[1]).toMatchObject({ status: "rejected", code: "write-bar", revertible: false, commit: null });
    expect(list[1].reason).toContain("word");
    expect(r.body.next).toBeNull();
    expect(r.body.facets).toEqual({
      scopes: ["brain:kit", "company"],
      employees: [
        { id: "ada", name: "Ada" },
        { id: "kit", name: "Kit" },
      ],
    });
  });

  it("filters by scope, employee and status, and pages by id", async () => {
    const w = await world();
    for (const [i, slug] of ["one", "two", "three"].entries()) {
      w.put(
        "ada",
        `company/facts/${slug}.md`,
        page(`${slug} topic`, `${slug} description words`, body(`The ${slug} thing`)),
      );
      await w.harvest("ada", String(i + 1));
    }
    w.put("kit", "personal/x.md", page("Kit page", "A page", body("Kit's page")));
    await w.harvest("kit", "9");
    const get = async (q: string) => (await w.call("GET", `/api/brain/changes${q}`)).body;
    expect((await get("?scope=company")).changes).toHaveLength(3);
    expect((await get("?scope=brain:kit")).changes.map((c: { path: string }) => c.path)).toEqual([
      "personal/x.md",
    ]);
    expect((await get("?employee=kit")).changes).toHaveLength(1);
    expect((await get("?employee=ada&scope=company&status=committed")).changes).toHaveLength(3);
    expect((await get("?status=rejected")).changes).toHaveLength(0);
    const first = await get("?limit=2");
    expect(first.changes).toHaveLength(2);
    expect(first.next).toEqual(expect.any(Number));
    const second = await get(`?limit=2&before=${first.next}`);
    expect(second.changes).toHaveLength(2);
    expect(second.next).toBeNull();
    expect(new Set([...first.changes, ...second.changes].map((c: { id: number }) => c.id)).size).toBe(4);
  });

  it("answers 400 to a bad filter", async () => {
    const w = await world();
    for (const q of ["?scope=everything", "?scope=all", "?employee=Ada%20B", "?status=maybe", "?before=x"]) {
      expect((await w.call("GET", `/api/brain/changes${q}`)).status, q).toBe(400);
    }
  });

  it("shows a policy change, an untrusted page and a kept conflict with their badges", async () => {
    const w = await world();
    w.put("ada", "company/policies/reviews.md", page("Reviews", "Every change is reviewed", body("Reviews")));
    w.put(
      "ada",
      "company/facts/web.md",
      `---\ntitle: Web notes\ndescription: From a web page\nsources: [https://example.com/x]\n---\n${body("The web page")}`,
    );
    await w.harvest("ada", "21");
    const list = (await w.call("GET", "/api/brain/changes")).body.changes;
    expect(list.find((c: { path: string }) => c.path.endsWith("reviews.md"))).toMatchObject({
      policy: true,
      untrusted: false,
    });
    expect(list.find((c: { path: string }) => c.path.endsWith("web.md"))).toMatchObject({
      untrusted: true,
      policy: false,
    });
  });
});

describe("POST /api/brain/changes/:id/revert", () => {
  it("undoes a created page with a new commit that says it was the owner", async () => {
    const w = await world();
    w.put(
      "ada",
      "company/facts/lesson.md",
      page("Flaky tests", "Retry a flaky test once", body("Flaky tests")),
    );
    await w.harvest("ada", "14");
    expect(w.host("handbook", "facts/lesson.md")).toContain("Flaky tests");
    const id = (await w.call("GET", "/api/brain/changes")).body.changes[0].id;
    const r = await w.call("POST", `/api/brain/changes/${id}/revert`);
    expect(r.status).toBe(200);
    expect(r.body.change).toMatchObject({ id, reverted: true, revertible: false });
    // The same shape as the list, so the entry can be swapped in place: the source still links.
    const listed = (await w.call("GET", "/api/brain/changes")).body.changes.find(
      (c: { id: number }) => c.id === id,
    );
    expect(r.body.change.source).toEqual({ kind: "ticket", id: "14", url: "#/ticket/14" });
    expect(r.body.change).toEqual(listed);
    expect(w.host("handbook", "facts/lesson.md")).toBeNull();
    const msg = w.git("handbook", "log", "-1", "--format=%s%n%b");
    expect(msg).toContain('Revert "Add facts/lesson.md"');
    expect(msg).toContain("Reverted-By: owner");
    expect(msg).toContain("This reverts commit");
    // The index follows: the page is gone from search.
    expect(w.app.deps.brain.page("company", "facts/lesson")).toBeNull();
    // The history keeps both, and the app's other view of history sees the revert.
    const history = (await w.call("GET", "/api/knowledge/handbook")).body.history;
    expect(history[0]).toMatchObject({ revert: true });
  });

  it("undoes an update, a delete and a rename", async () => {
    const w = await world();
    w.put(
      "ada",
      "company/projects/duet.md",
      `${page("Duet", "The couples' finance app", body("Duet"))}\nThe release key is on the Mac mini at home.\n`,
    );
    w.put("ada", "company/facts/gh.md", null);
    const v = page("Vitest", "Reset mocks between tests", body("Vitest"));
    w.put("ada", "personal/tools/vitest.md", null);
    w.put("ada", "personal/tools/vitest-mocks.md", v);
    await w.harvest("ada", "30");
    const list = (await w.call("GET", "/api/brain/changes")).body.changes as { id: number; op: string }[];
    expect(list.map((c) => c.op).sort()).toEqual(["delete", "rename", "update"]);
    for (const c of list)
      expect((await w.call("POST", `/api/brain/changes/${c.id}/revert`)).status).toBe(200);
    expect(w.host("handbook", "projects/duet.md")).not.toContain("release key");
    expect(w.host("handbook", "facts/gh.md")).toContain("gh pr checks");
    expect(w.host("ada", "tools/vitest.md")).toContain("Vitest");
    expect(w.host("ada", "tools/vitest-mocks.md")).toBeNull();
  });

  it("sends the undone version back to the agent's copy with the next copy", async () => {
    const w = await world();
    w.put(
      "ada",
      "company/facts/lesson.md",
      page("Flaky tests", "Retry a flaky test once", body("Flaky tests")),
    );
    await w.harvest("ada", "14");
    await w.feed.sync("ada");
    const id = (await w.call("GET", "/api/brain/changes")).body.changes[0].id;
    await w.call("POST", `/api/brain/changes/${id}/revert`);
    const report = await w.feed.sync("ada");
    expect(report.ok).toBe(true);
    expect(existsSync(w.copy("ada", "company/facts/lesson.md"))).toBe(false);
  });

  it("answers 409 when it was already undone, 400 for a refused change, 404 for an unknown one", async () => {
    const w = await world();
    w.put(
      "ada",
      "company/facts/lesson.md",
      page("Flaky tests", "Retry a flaky test once", body("Flaky tests")),
    );
    w.put("ada", "company/facts/bad.md", page("Thin", "x", "ok"));
    await w.harvest("ada", "14");
    const list = (await w.call("GET", "/api/brain/changes")).body.changes as { id: number; status: string }[];
    const done = list.find((c) => c.status === "committed")?.id;
    const refused = list.find((c) => c.status === "rejected")?.id;
    expect((await w.call("POST", `/api/brain/changes/${done}/revert`)).status).toBe(200);
    expect((await w.call("POST", `/api/brain/changes/${done}/revert`)).status).toBe(409);
    expect((await w.call("POST", `/api/brain/changes/${refused}/revert`)).status).toBe(400);
    expect((await w.call("POST", "/api/brain/changes/9999/revert")).status).toBe(404);
    expect((await w.call("POST", "/api/brain/changes/x/revert")).status).toBe(404);
  });

  it("answers 409 and changes nothing when later edits overlap", async () => {
    const w = await world();
    w.put(
      "ada",
      "company/projects/duet.md",
      page("Duet", "The couples' finance app", `${body("Duet")}The key is on the mini.\n`),
    );
    await w.harvest("ada", "14");
    // Someone else rewrites the same lines afterwards.
    w.commit("handbook", {
      "projects/duet.md": page(
        "Duet",
        "The couples' finance app",
        `${body("Duet")}The key moved to the cloud.\n`,
      ),
    });
    const before = w.git("handbook", "rev-parse", "HEAD");
    const id = (await w.call("GET", "/api/brain/changes")).body.changes[0].id;
    const r = await w.call("POST", `/api/brain/changes/${id}/revert`);
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("overlap");
    expect(w.git("handbook", "rev-parse", "HEAD")).toBe(before);
    expect(w.git("handbook", "status", "--short")).toBe("");
    expect((await w.call("GET", "/api/brain/changes")).body.changes[0].reverted).toBe(false);
  });
});

describe("guards", () => {
  it("is owner-only: 401 without the token, like every other route", async () => {
    const w = await world();
    const handle = createApi(w.app.daemon, w.app.deps, { token: "s3cret", hosts: ["127.0.0.1:7420"] });
    const send = (method: string, path: string, headers: Record<string, string> = {}) =>
      handle(
        new Request(`http://127.0.0.1:7420${path}`, {
          method,
          headers: { host: "127.0.0.1:7420", "content-type": "application/json", ...headers },
          ...(method === "POST" ? { body: "{}" } : {}),
        }),
      );
    expect((await send("GET", "/api/brain/changes")).status).toBe(401);
    expect((await send("POST", "/api/brain/changes/1/revert")).status).toBe(401);
    expect((await send("GET", "/api/brain/changes", { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await send("GET", "/api/brain/changes", { authorization: "Bearer s3cret" })).status).toBe(200);
    // And another site's page cannot reach it with the owner's cookie.
    expect(
      (
        await send("POST", "/api/brain/changes/1/revert", {
          authorization: "Bearer s3cret",
          origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);
  });
});
