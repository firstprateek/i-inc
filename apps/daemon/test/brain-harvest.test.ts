// Harvesting an agent's edits from a fake sandbox copy (a real git folder, scripts run in bash): create,
// update, delete and rename; every check on real files; provenance; merges and conflicts; the baseline
// moving so nothing is collected twice; policy notices; untrusted marking; machines that are stopped.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakePushService } from "../src/push.ts";
import { brainRig, cleanRigs, page } from "./brain-rig.ts";

afterEach(cleanRigs);

const gitIn = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });

const longBody = (topic: string) =>
  `${topic} matters because the owner reads these pages first.\nThe second line explains how to do it, step by step, and why it works.\n`;

async function world() {
  const w = await brainRig();
  w.commit("handbook", {
    "facts/gh.md": page(
      "GitHub CLI",
      "gh pr checks waits for CI",
      `${longBody("The GitHub CLI")}Use gh pr checks --watch.`,
    ),
    "facts/signing.md": page(
      "Release signing",
      "The signing step only the owner can do",
      longBody("Signing"),
    ),
    "projects/duet.md": page("Duet", "The couples' finance app", `${longBody("Duet")}Tauri and Lit.`),
    "teams/engineering/release.md": page("Release", "How engineering releases", longBody("Releasing")),
    "teams/design/palette.md": page("Palette", "The design team's colours", longBody("Palette")),
  });
  w.commit("ada", {
    "tools/vitest.md": page("Vitest", "Reset mocks between tests", longBody("Vitest mocks")),
  });
  w.commit("kit", {
    "tools/secret.md": page("Kit's notes", "Kit's private habits", longBody("Kit's habits")),
  });
  const copyFile = (employee: string, path: string, text: string | null) => {
    const file = w.copy(employee, path);
    if (text === null) rmSync(file, { force: true });
    else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
  };
  const read = (employee: string, path: string) => readFileSync(w.copy(employee, path), "utf8");
  const host = (repo: string, path: string) => {
    const file = join(w.knowledgeDir, repo === "handbook" ? "handbook" : `brains/${repo}`, path);
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  };
  const harvest = (employeeId: string, id = "14", over: Record<string, unknown> = {}) =>
    w.app.deps.brainHarvest.run({
      employeeId,
      source: { kind: "ticket", id },
      trigger: "ticket-end",
      ...over,
    });
  const changes = async (q = "") =>
    (await w.call("GET", `/api/brain/changes${q}`)).body.changes as {
      status: string;
      op: string;
      path: string;
      code?: string;
      reason?: string;
      conflict: boolean;
      untrusted: boolean;
      policy: boolean;
    }[];
  const push = new FakePushService(w.app.deps.registry);
  w.app.deps.push = push;
  await w.feed.sync("ada");
  return { ...w, copyFile, read, host, harvest, changes, push };
}

describe("collecting the diff", () => {
  it("commits a created, an updated, a deleted and a renamed page, and says who, what and where from", async () => {
    const w = await world();
    w.copyFile(
      "ada",
      "company/facts/lesson.md",
      page("Flaky tests", "Retry a flaky test once before blaming it", longBody("Flaky tests")),
    );
    w.copyFile(
      "ada",
      "company/projects/duet.md",
      `${w.read("ada", "company/projects/duet.md")}\nThe release signing key lives on the Mac mini, so releases are cut from home.\n`,
    );
    w.copyFile("ada", "company/facts/gh.md", null);
    const vitest = w.read("ada", "personal/tools/vitest.md");
    w.copyFile("ada", "personal/tools/vitest.md", null);
    w.copyFile("ada", "personal/tools/vitest-mocks.md", vitest);

    const report = await w.harvest("ada", "14");
    expect(report).toMatchObject({ status: "done", committed: 4, rejected: 0 });
    expect(report.id).toMatch(/^h\d+$/);

    // The shared brain has them, repaired and stamped.
    const lesson = w.host("handbook", "facts/lesson.md");
    expect(lesson).toContain("title: Flaky tests");
    expect(lesson).toMatch(/updated: \d{4}-\d{2}-\d{2}/);
    expect(lesson).toContain("sources: [ticket-14]");
    expect(w.host("handbook", "projects/duet.md")).toContain("cut from home");
    expect(w.host("handbook", "facts/gh.md")).toBeNull();
    expect(w.host("ada", "tools/vitest.md")).toBeNull();
    expect(w.host("ada", "tools/vitest-mocks.md")).toContain("Vitest mocks matters");

    // One commit a change, with the employee, the ticket and the harvest in the message.
    const log = w.git("handbook", "log", "-4", "--format=%s%n%b%x1e");
    expect(log).toContain("Add facts/lesson.md");
    expect(log).toContain("Update projects/duet.md");
    expect(log).toContain("Delete facts/gh.md");
    expect(log).toContain("Author: ada");
    expect(log).toContain("Ticket: 14");
    expect(log).toContain(`Harvest: ${report.id}`);
    expect(w.git("ada", "log", "-1", "--format=%s")).toContain(
      "Rename tools/vitest.md to tools/vitest-mocks.md",
    );

    // And the feed.
    const feed = await w.changes();
    expect(
      feed
        .filter((c) => c.status === "committed")
        .map((c) => `${c.op} ${c.path}`)
        .sort(),
    ).toEqual([
      "create company/facts/lesson.md",
      "delete company/facts/gh.md",
      "rename personal/tools/vitest-mocks.md",
      "update company/projects/duet.md",
    ]);
  });

  it("moves the baseline: the same diff is not collected twice, and a later edit is", async () => {
    const w = await world();
    w.copyFile(
      "ada",
      "company/facts/lesson.md",
      page("Flaky tests", "Retry a flaky test once", longBody("Flaky tests")),
    );
    expect(await w.harvest("ada")).toMatchObject({ committed: 1 });
    const commits = w.git("handbook", "rev-list", "--count", "HEAD").trim();
    expect(await w.harvest("ada")).toMatchObject({ status: "nothing" });
    expect(w.git("handbook", "rev-list", "--count", "HEAD").trim()).toBe(commits);
    expect(gitIn(w.copy("ada"), "diff", "--stat", "refs/inc/baseline")).toBe("");

    // The agent keeps writing: only the new edit is a diff.
    w.copyFile(
      "ada",
      "company/facts/lesson.md",
      `${w.read("ada", "company/facts/lesson.md")}\nRetries hide real races, so open a ticket when a test needed one.\n`,
    );
    expect(await w.harvest("ada", "15")).toMatchObject({ committed: 1 });
    expect(w.host("handbook", "facts/lesson.md")).toContain("open a ticket");
  });

  it("sends the shared brain's version back with the next copy, and the file is no longer an edit", async () => {
    const w = await world();
    w.copyFile("ada", "company/facts/lesson.md", `# Flaky tests\n\n${longBody("Flaky tests")}`);
    await w.harvest("ada");
    const committed = w.host("handbook", "facts/lesson.md");
    expect(committed).toMatch(/^---\ntitle: Flaky tests/);
    expect(w.read("ada", "company/facts/lesson.md")).not.toBe(committed);
    const report = await w.feed.sync("ada");
    expect(report.ok).toBe(true);
    expect(w.read("ada", "company/facts/lesson.md")).toBe(committed);
    expect(gitIn(w.copy("ada"), "status", "--short")).toBe("");
    expect(report.kept).toEqual([]);
  });

  it("collects nothing, and starts no machine, while the machine is stopped, and does it once it is up", async () => {
    const w = await world();
    w.copyFile(
      "ada",
      "company/facts/lesson.md",
      page("Flaky tests", "Retry a flaky test once", longBody("Flaky tests")),
    );
    w.setUp(false);
    const before = w.runs.length;
    const report = await w.harvest("ada");
    expect(report).toMatchObject({ status: "skipped" });
    expect(w.runs.length).toBe(before);
    expect(w.host("handbook", "facts/lesson.md")).toBeNull();
    w.setUp(true);
    await w.app.deps.brainHarvest.catchUp();
    expect(w.host("handbook", "facts/lesson.md")).toContain("Flaky tests");
    expect((await w.changes())[0]).toMatchObject({ status: "committed", path: "company/facts/lesson.md" });
  });

  it("refuses a copy that says it is someone else's", async () => {
    const w = await world();
    writeFileSync(
      w.copy("ada", ".snapshot.json"),
      readFileSync(w.copy("ada", ".snapshot.json"), "utf8").replace('"employee":"ada"', '"employee":"kit"'),
    );
    w.copyFile(
      "ada",
      "company/facts/lesson.md",
      page("Flaky tests", "Retry a flaky test once", longBody("Flaky tests")),
    );
    expect(await w.harvest("ada")).toMatchObject({ status: "failed" });
    expect(w.host("handbook", "facts/lesson.md")).toBeNull();
  });
});

describe("checking what the sandbox gave", () => {
  it("refuses another employee's brain, a team that isn't theirs and a bad path, and undoes them in the copy", async () => {
    const w = await world();
    w.copyFile("ada", "kit/personal/x.md", page("X", "x", longBody("X")));
    w.copyFile("ada", "personal-kit/x.md", page("X", "x", longBody("X")));
    w.copyFile("ada", "team-design/x.md", page("X", "x", longBody("X")));
    w.copyFile("ada", "company/facts/ok.md", page("Fine", "A fine page", longBody("Fine")));
    const report = await w.harvest("ada");
    expect(report).toMatchObject({ committed: 1, rejected: 3 });
    const refused = (await w.changes()).filter((c) => c.status === "rejected");
    expect(refused.map((c) => c.code).sort()).toEqual(["other-brain", "other-brain", "scope"]);
    expect(existsSync(w.copy("ada", "kit/personal/x.md"))).toBe(false);
    expect(existsSync(w.copy("ada", "team-design/x.md"))).toBe(false);
    expect(w.host("kit", "personal/x.md")).toBeNull();
    expect(w.host("handbook", "teams/design/x.md")).toBeNull();
  });

  it("never reads a symlink, a file behind one or a file over the cap", async () => {
    const w = await world();
    writeFileSync(
      join(w.sandbox, "outside.md"),
      "# outside\n\nsecret text outside the copy that must not travel anywhere",
    );
    symlinkSync(join(w.sandbox, "outside.md"), w.copy("ada", "company/facts/evil.md"));
    symlinkSync(w.sandbox, w.copy("ada", "company/linked"));
    w.copyFile("ada", "company/facts/big.md", `# Big\n\n${"word ".repeat(70_000)}\n`);
    const report = await w.harvest("ada");
    expect(report.committed).toBe(0);
    const codes = (await w.changes()).map((c) => c.code).sort();
    expect(codes).toContain("link");
    expect(codes).toContain("oversize");
    expect(w.host("handbook", "facts/evil.md")).toBeNull();
    expect(JSON.stringify(await w.changes())).not.toContain("secret text outside");
    // The links are gone from the copy.
    expect(existsSync(w.copy("ada", "company/facts/evil.md"))).toBe(false);
  });

  it("repairs the frontmatter and redacts credentials before committing", async () => {
    const w = await world();
    const token = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    w.copyFile(
      "ada",
      "company/facts/ci.md",
      `# CI\n\nThe CI bot's token is ${token} and it runs the checks on every push.\n`,
    );
    await w.harvest("ada");
    const text = w.host("handbook", "facts/ci.md") ?? "";
    expect(text).not.toContain(token);
    expect(text).toContain("[redacted]");
    expect(text).toMatch(/^---\ntitle: CI\ndescription: /);
    expect((await w.changes())[0]?.op).toBe("create");
  });

  it("refuses a page that is nearly empty and an edit that only appends noise, and records why", async () => {
    const w = await world();
    w.copyFile("ada", "company/facts/thin.md", page("Thin", "Nothing", "ok"));
    w.copyFile(
      "ada",
      "company/projects/duet.md",
      `${w.read("ada", "company/projects/duet.md")}\n- 2026-10-21: worked on duet today\n`,
    );
    const report = await w.harvest("ada");
    expect(report).toMatchObject({ committed: 0, rejected: 2 });
    const feed = await w.changes();
    expect(feed.every((c) => c.code === "write-bar")).toBe(true);
    expect(feed.map((c) => c.reason).join("\n")).toMatch(/words|log lines/);
    expect(w.host("handbook", "projects/duet.md")).not.toContain("worked on duet");
    // Undone in the copy.
    expect(w.read("ada", "company/projects/duet.md")).not.toContain("worked on duet today");
  });
});

describe("a personal assistant", () => {
  it("writes its own brain from its copy, but never a shared scope", async () => {
    const w = await world();
    await w.feed.sync("pip");
    w.copyFile(
      "pip",
      "personal/dentist.md",
      page("Dentist", "Where the dentist is", longBody("The dentist at 5 Elm St")),
    );
    w.copyFile(
      "pip",
      "company/facts/dentist.md",
      page("Dentist", "Where the dentist is", longBody("The dentist at 5 Elm St")),
    );
    const report = await w.harvest("pip", "9", { allowHome: true });
    expect(report).toMatchObject({ committed: 1, rejected: 1 });
    expect(w.host("pip", "dentist.md")).toContain("Elm St");
    expect(w.host("handbook", "facts/dentist.md")).toBeNull();
    expect((await w.changes()).find((c) => c.status === "rejected")?.code).toBe("home-data");
  });
});

describe("duplicates", () => {
  it("does not create a near-duplicate, records why, and tells the agent which page to update", async () => {
    const w = await world();
    w.copyFile(
      "ada",
      "company/facts/github-cli.md",
      page("GitHub CLI", "gh pr checks waits for CI", longBody("The gh tool")),
    );
    const report = await w.harvest("ada");
    expect(report).toMatchObject({ committed: 0, rejected: 1 });
    expect(w.host("handbook", "facts/github-cli.md")).toBeNull();
    const [c] = await w.changes();
    expect(c).toMatchObject({ status: "rejected", code: "duplicate" });
    expect(c?.reason).toContain("[[facts/gh]]");
    // The file stays in the copy for the agent to merge, and is not told twice.
    expect(existsSync(w.copy("ada", "company/facts/github-cli.md"))).toBe(true);
    expect(await w.harvest("ada")).toMatchObject({ status: "nothing" });
    expect((await w.changes()).length).toBe(1);

    // The next brief carries the hint, once.
    const first = await w.feed.forTicket({
      employeeId: "ada",
      sessionId: null,
      query: { title: "x", project: "Duet", doneWhen: [] },
    });
    expect(first.text).toContain("About your earlier brain edits");
    expect(first.text).toContain("company/facts/gh.md");
    const second = await w.feed.forTicket({
      employeeId: "ada",
      sessionId: null,
      query: { title: "x", project: "Duet", doneWhen: [] },
    });
    expect(second.text).not.toContain("About your earlier brain edits");

    // The agent merges and deletes the duplicate: that is a normal update.
    w.copyFile(
      "ada",
      "company/facts/gh.md",
      `${w.read("ada", "company/facts/gh.md")}\nThe gh tool also prints a table of the PR checks when you pass --watch.\n`,
    );
    w.copyFile("ada", "company/facts/github-cli.md", null);
    expect(await w.harvest("ada")).toMatchObject({ committed: 1, rejected: 0 });
    expect(w.host("handbook", "facts/gh.md")).toContain("prints a table");
  });
});

describe("concurrent edits", () => {
  const twoLines = (a: string, b: string) =>
    page("Deploy", "How deploys go", `${a}\nA middle line that stays the same for both edits.\n${b}`);

  it("merges edits to different parts of a page through git", async () => {
    const w = await world();
    w.commit("handbook", {
      "facts/deploy.md": twoLines("First line, original text here.", "Last line, original text here."),
    });
    await w.feed.sync("ada");
    // Someone else changes the last line in the shared brain first.
    w.commit("handbook", {
      "facts/deploy.md": twoLines("First line, original text here.", "Last line, changed by someone else."),
    });
    // Ada, still on the old text, changes the first line.
    w.copyFile(
      "ada",
      "company/facts/deploy.md",
      twoLines("First line, rewritten by Ada with more detail.", "Last line, original text here."),
    );
    const report = await w.harvest("ada");
    expect(report).toMatchObject({ committed: 1 });
    const text = w.host("handbook", "facts/deploy.md") ?? "";
    expect(text).toContain("rewritten by Ada");
    expect(text).toContain("changed by someone else");
    expect(text).not.toContain("## Conflict");
    expect((await w.changes())[0]?.conflict).toBe(false);
  });

  it("keeps both versions when both changed the same lines, for the tidy-up", async () => {
    const w = await world();
    w.commit("handbook", {
      "facts/deploy.md": twoLines("First line, original text here.", "Last line, original text here."),
    });
    await w.feed.sync("ada");
    w.commit("handbook", {
      "facts/deploy.md": twoLines("First line, the other version of it.", "Last line, original text here."),
    });
    w.copyFile(
      "ada",
      "company/facts/deploy.md",
      twoLines("First line, Ada's version of it.", "Last line, original text here."),
    );
    const report = await w.harvest("ada");
    expect(report).toMatchObject({ committed: 1 });
    const text = w.host("handbook", "facts/deploy.md") ?? "";
    expect(text).toContain("the other version of it");
    expect(text).toContain("## Conflict");
    expect(text).toContain("> First line, Ada's version of it.");
    expect(text).toContain("needs-tidy: true");
    expect((await w.changes())[0]).toMatchObject({ status: "committed", conflict: true });
    // The index sees it, so the tidy-up finds it.
    expect(w.app.deps.brain.needingTidy().map((p) => p.slug)).toContain("facts/deploy");
  });

  it("does not delete a page that someone edited after the copy was made", async () => {
    const w = await world();
    w.commit("handbook", {
      "facts/gh.md": page("GitHub CLI", "gh pr checks waits for CI", longBody("Edited meanwhile")),
    });
    w.copyFile("ada", "company/facts/gh.md", null);
    const report = await w.harvest("ada");
    expect(report).toMatchObject({ committed: 0, rejected: 1 });
    expect(w.host("handbook", "facts/gh.md")).toContain("Edited meanwhile");
    expect((await w.changes())[0]?.code).toBe("stale");
  });
});

describe("policies and untrusted pages", () => {
  it("tells the owner by push when a company policy page changes, with no approval", async () => {
    const w = await world();
    w.copyFile(
      "ada",
      "company/policies/reviews.md",
      page("Reviews", "Every change gets a fresh review", longBody("Reviews")),
    );
    w.copyFile("ada", "company/facts/other.md", page("Other", "Not a policy", longBody("Other things")));
    await w.harvest("ada", "21");
    expect(w.host("handbook", "policies/reviews.md")).toContain("Every change");
    expect(w.push.sent).toHaveLength(1);
    expect(w.push.sent[0]).toMatchObject({ url: "#/company/brain/changes" });
    expect(w.push.sent[0]?.title).toContain("reviews");
    const feed = await w.changes();
    expect(feed.find((c) => c.path === "company/policies/reviews.md")?.policy).toBe(true);
    expect(feed.find((c) => c.path === "company/facts/other.md")?.policy).toBe(false);
  });

  it("marks a page built from a web page as external, in the file, the index and the feed", async () => {
    const w = await world();
    w.copyFile(
      "ada",
      "company/facts/vendor.md",
      `---\ntitle: Vendor docs\ndescription: What the vendor's docs say about rate limits\nsources: [https://vendor.example/docs/limits]\n---\n${longBody("The vendor limits")}`,
    );
    w.copyFile(
      "ada",
      "company/facts/marked.md",
      page("Issue notes", "From an issue", longBody("The issue says so"), [], "source: external\n"),
    );
    await w.harvest("ada");
    expect(w.host("handbook", "facts/vendor.md")).toContain("source: external");
    expect(w.host("handbook", "facts/marked.md")).toContain("source: external");
    const feed = await w.changes();
    expect(feed.filter((c) => c.untrusted)).toHaveLength(2);
    expect(w.app.deps.brain.page("company", "facts/vendor")?.external).toBe(true);
    // Once external, an edit that drops the marker does not make it trusted.
    await w.feed.sync("ada");
    w.copyFile(
      "ada",
      "company/facts/vendor.md",
      `---\ntitle: Vendor docs\ndescription: What the vendor's docs say about rate limits\n---\n${longBody("The vendor limits")}And the burst limit is 20 a second, which the docs do not say.\n`,
    );
    await w.harvest("ada", "22");
    expect(w.host("handbook", "facts/vendor.md")).toContain("source: external");
  });
});

describe("a shared sandbox: edits that may not be the employee's own", () => {
  const edit = async () => {
    const w = await world();
    w.copyFile("ada", "personal/tools/secret.md", page("Notes", "Ada's notes", longBody("Ada's notes")));
    w.copyFile(
      "ada",
      "company/policies/reviews.md",
      page("Reviews", "Every change is reviewed", longBody("Reviews")),
    );
    return w;
  };

  it("marks the changes untrusted, in the file, the feed and the policy push, when a teammate had a session meanwhile", async () => {
    const w = await edit();
    // Kit is in the middle of a ticket stage in the same machine.
    w.app.deps.sessions.start("99", "build", "kit", "sonnet");
    await w.harvest("ada", "14");
    const feed = await w.changes();
    expect(feed.filter((c) => c.status === "committed")).toHaveLength(2);
    for (const c of feed) {
      expect(c.untrusted).toBe(true);
      expect((c as unknown as { notes: string[] }).notes).toContain(
        "possibly edited by a teammate (shared sandbox)",
      );
    }
    expect(w.host("ada", "tools/secret.md")).toContain("source: external");
    expect(w.host("handbook", "policies/reviews.md")).toContain("source: external");
    expect(w.push.sent[0]?.body).toContain("teammate");
  });

  it("counts a conversation turn of a teammate too", async () => {
    const w = await edit();
    const end = w.app.deps.brainHarvest.beginActivity("kit");
    await w.harvest("ada", "14");
    end();
    expect((await w.changes()).every((c) => c.untrusted)).toBe(true);
  });

  it("leaves them trusted when nobody else worked there since the copy was delivered", async () => {
    const w = await world();
    // Kit's session is over before Ada's copy is brought up to date.
    const id = w.app.deps.sessions.start("99", "build", "kit", "sonnet");
    w.app.deps.sessions.finish(id);
    w.clock.advance(10);
    w.commit("handbook", { "facts/news.md": page("News", "Something new", longBody("News")) });
    await w.feed.sync("ada");
    w.clock.advance(5);
    w.copyFile("ada", "personal/tools/secret.md", page("Notes", "Ada's notes", longBody("Ada's notes")));
    // Ada's own session, and a session that ended before the delivery, don't count.
    w.app.deps.sessions.start("100", "build", "ada", "opus");
    await w.harvest("ada", "14");
    const [c] = await w.changes();
    expect(c).toMatchObject({ status: "committed", untrusted: false });
    expect(w.host("ada", "tools/secret.md")).not.toContain("source: external");
  });

  it("marks the changes when the session handled external content", async () => {
    const w = await edit();
    w.app.deps.brainHarvest.noteExternal({ kind: "ticket", id: "14" }, "a web fetch");
    await w.harvest("ada", "14");
    const feed = await w.changes();
    expect(feed.every((c) => c.untrusted)).toBe(true);
    expect(feed[0] && (feed[0] as unknown as { notes: string[] }).notes.join(" ")).toContain(
      "external content (a web fetch)",
    );
  });
});

describe("what the daemon takes as the base of a change", () => {
  it("is its own record, not the copy's baseline ref: a forged ref can't hide someone else's edit", async () => {
    const w = await world();
    const original = w.read("ada", "company/projects/duet.md");
    // Someone else edits the page in the shared brain after Ada's copy was made.
    const theirs = original.replace("Tauri and Lit.", "Tauri and Lit. Someone else's important line.");
    w.commit("handbook", { "projects/duet.md": theirs });
    // Ada rewrites the page, and points the copy's baseline at the new shared text, so that "nothing changed
    // upstream" looks true to anyone who trusts it.
    const mine = original.replace("Duet matters", "Duet really matters");
    w.copyFile("ada", "company/projects/duet.md", mine);
    const copy = w.copy("ada");
    const git = (a: string[], env: Record<string, string> = {}) =>
      execFileSync("git", ["-C", copy, "-c", "user.name=a", "-c", "user.email=a@a", ...a], {
        encoding: "utf8",
        env: { ...process.env, ...env },
      }).trim();
    const blob = execFileSync("git", ["-C", copy, "hash-object", "-w", "--stdin"], {
      input: theirs,
      encoding: "utf8",
    }).trim();
    const idx = join(w.sandbox, "forged-index");
    git(["read-tree", "refs/inc/baseline"], { GIT_INDEX_FILE: idx });
    git(["update-index", "--cacheinfo", `100644,${blob},company/projects/duet.md`], { GIT_INDEX_FILE: idx });
    const tree = git(["write-tree"], { GIT_INDEX_FILE: idx });
    const forged = git(["commit-tree", tree, "-p", "refs/inc/baseline", "-m", "forged"]);
    git(["update-ref", "refs/inc/baseline", forged]);

    await w.harvest("ada", "14");
    const text = w.host("handbook", "projects/duet.md") ?? "";
    // Both edits survive (merged, or kept side by side), instead of Ada's text replacing the other.
    expect(text).toContain("Someone else's important line");
    expect(text).toContain("Duet really matters");
  });

  it("treats a page the daemon never delivered as new, whatever the copy says", async () => {
    const w = await world();
    // A page in the baseline that the daemon has no record of: the copy's ref is all that says it existed.
    w.app.deps.db.run("DELETE FROM brain_synced");
    w.copyFile(
      "ada",
      "company/facts/gh.md",
      `${w.read("ada", "company/facts/gh.md")}\nA real new detail about waiting for CI.\n`,
    );
    const report = await w.harvest("ada", "14");
    expect(report.committed).toBe(1);
    // Not an update over the old text: a concurrent create, merged with what is there.
    expect(w.host("handbook", "facts/gh.md")).toContain("A real new detail");
    expect(w.host("handbook", "facts/gh.md")).toContain("## Conflict");
  });
});

describe("merging", () => {
  it("does not make a conflict of a missing final newline", async () => {
    const w = await world();
    const raw = (first: string, last: string) =>
      `---\ntitle: Notes\ndescription: Some notes\n---\n${first}\nA middle line that stays the same here.\n${last}`;
    w.commit("handbook", {
      "facts/nonl.md": raw("First line, original text here.", "Last line, original text here."),
    });
    await w.feed.sync("ada");
    // Someone else rewrites the last line (the shared brain keeps the normal final newline).
    w.commit("handbook", {
      "facts/nonl.md": `${raw("First line, original text here.", "Last line, changed by someone else.")}\n`,
    });
    // Ada, on the old text, rewrites the first line.
    w.copyFile(
      "ada",
      "company/facts/nonl.md",
      raw("First line, rewritten by Ada with detail.", "Last line, original text here."),
    );
    await w.harvest("ada", "14");
    const text = w.host("handbook", "facts/nonl.md") ?? "";
    expect(text).toContain("rewritten by Ada");
    expect(text).toContain("changed by someone else");
    expect(text).not.toContain("## Conflict");
  });
});

describe("a machine that stops mid-collection", () => {
  it("is collected later, for the session that made the edits", async () => {
    const w = await world();
    w.copyFile(
      "ada",
      "company/facts/lesson.md",
      page("Flaky tests", "Retry a flaky test once", longBody("Flaky tests")),
    );
    w.failing.next = true;
    expect(await w.harvest("ada", "14")).toMatchObject({ status: "failed" });
    const due = w.app.deps.db.all<{ ref_kind: string; ref_id: string }>(
      "SELECT ref_kind, ref_id FROM brain_harvest_due",
    );
    expect(due).toEqual([{ ref_kind: "ticket", ref_id: "14" }]);
    // Another ticket asks while it is still down: the first one's name stays.
    expect(await w.harvest("ada", "15")).toMatchObject({ status: "failed" });
    expect(w.app.deps.db.all("SELECT ref_id FROM brain_harvest_due")).toEqual([{ ref_id: "14" }]);
    w.failing.next = false;
    await w.app.deps.brainHarvest.catchUp();
    expect(w.host("handbook", "facts/lesson.md")).toContain("sources: [ticket-14]");
    expect(w.git("handbook", "log", "-1", "--format=%b")).toContain("Ticket: 14");
    expect(w.app.deps.db.all("SELECT * FROM brain_harvest_due")).toEqual([]);
  });

  it("is collected later when the script itself throws", async () => {
    const w = await world();
    w.copyFile(
      "ada",
      "company/facts/lesson.md",
      page("Flaky tests", "Retry a flaky test once", longBody("Flaky tests")),
    );
    const real = w.feed.deliver;
    w.feed.deliver = async () => {
      throw new Error("the machine stopped");
    };
    expect(await w.harvest("ada", "14")).toMatchObject({ status: "failed" });
    expect(w.app.deps.db.all("SELECT ref_id FROM brain_harvest_due")).toEqual([{ ref_id: "14" }]);
    w.feed.deliver = real;
    await w.app.deps.brainHarvest.catchUp();
    expect(w.host("handbook", "facts/lesson.md")).toContain("Flaky tests");
  });
});

describe("the retro with a copy that is not there", () => {
  it("is asked for lessons as JSON, for that employee only", async () => {
    const w = await world();
    expect(w.feed.copyUsable("kit")).toBe(true);
    w.failing.next = true;
    await w.feed.sync("kit");
    expect(w.feed.copyUsable("kit")).toBe(false);
    expect(w.feed.copyUsable("ada")).toBe(true);
    w.failing.next = false;
    await w.feed.sync("kit");
    expect(w.feed.copyUsable("kit")).toBe(true);
  });
});
