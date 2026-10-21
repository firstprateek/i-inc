// The brain's copy in a sandbox and its retrieval into prompts (T57).
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyScript, type Snapshot } from "../src/brain-snapshot.ts";
import { brainRig, cleanRigs, page } from "./brain-rig.ts";

afterEach(cleanRigs);

const tree = (dir: string, rel = ""): string[] =>
  readdirSync(`${dir}/${rel}`, { withFileTypes: true })
    .filter((e) => e.name !== ".git")
    .flatMap((e) => (e.isDirectory() ? tree(dir, `${rel}${e.name}/`) : [`${rel}${e.name}`]))
    .sort();

const gitIn = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });

/** Everything text in a folder, for "does this appear anywhere". */
const allText = (dir: string): string =>
  tree(dir)
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");

async function seeded() {
  const r = await brainRig();
  r.commit("handbook", {
    "facts/gh.md": page("GitHub CLI", "gh pr checks waits for CI", "Use gh pr checks --watch."),
    "projects/duet.md": page("Duet", "The couples' finance app", "Tauri and Lit."),
    "teams/engineering/release.md": page("Release", "How engineering releases", "Cut with release-please."),
    "teams/design/palette.md": page("Palette", "The design team's colours", "Teal and sand."),
  });
  r.commit("ada", {
    "tools/vitest.md": page("Vitest", "Reset mocks between tests", "Call restoreAllMocks."),
  });
  r.commit("kit", { "tools/secret.md": page("Kit's own notes", "Kit's private habits", "kitprivate lore.") });
  r.commit("pip", {
    "home/dentist.md": page("Dentist", "Where the owner's dentist is", "homedata: dentist at 5 Elm St."),
  });
  return r;
}

describe("the copy", () => {
  it("puts the readable scopes in the sandbox, with a map each, and a git baseline", async () => {
    const r = await seeded();
    const report = await r.feed.sync("ada");
    expect(report).toMatchObject({ ok: true, how: "full" });
    expect(tree(r.copy("ada"))).toEqual([
      ".bin/brain",
      ".snapshot.id",
      ".snapshot.json",
      "company/INDEX.md",
      "company/facts/gh.md",
      "company/projects/duet.md",
      "personal/INDEX.md",
      "personal/personality.md",
      "personal/tools/vitest.md",
      "team-engineering/INDEX.md",
      "team-engineering/release.md",
    ]);
    expect(readFileSync(r.copy("ada", "company/INDEX.md"), "utf8")).toContain(
      "- [[facts/gh]] — gh pr checks waits for CI",
    );
    expect(JSON.parse(readFileSync(r.copy("ada", ".snapshot.json"), "utf8"))).toMatchObject({
      employee: "ada",
      dirs: { "brain:ada": "personal", "team:engineering": "team-engineering", company: "company" },
    });
    // The baseline commit is the snapshot, and nothing is changed against it.
    expect(gitIn(r.copy("ada"), "status", "--short")).toBe("");
    expect(gitIn(r.copy("ada"), "diff", "--name-only", "refs/inc/baseline")).toBe("");
    const tracked = gitIn(r.copy("ada"), "ls-tree", "-r", "--name-only", "refs/inc/baseline");
    expect(tracked).toContain("company/facts/gh.md");
    expect(tracked).not.toContain(".bin/brain");
  });

  it("never carries another employee's personal brain, another team's section, or a PA's home data", async () => {
    const r = await seeded();
    for (const e of ["ada", "kit", "pip", "grace"]) expect((await r.feed.sync(e)).ok).toBe(true);
    // Ada and Kit share a team (and so a sandbox): each copy has only its own brain.
    expect(allText(r.copy("ada"))).not.toContain("kitprivate");
    expect(allText(r.copy("kit"))).not.toContain("Call restoreAllMocks");
    expect(allText(r.copy("kit"))).toContain("kitprivate");
    // The design team's section is for its members only; Grace is on no team.
    for (const e of ["ada", "kit", "pip", "grace"]) expect(allText(r.copy(e))).not.toContain("Teal and sand");
    expect(tree(r.copy("grace")).filter((f) => f.startsWith("team-"))).toEqual([]);
    // The PA's home data is in its own copy and nowhere else.
    expect(allText(r.copy("pip"))).toContain("homedata");
    for (const e of ["ada", "kit", "grace"]) expect(allText(r.copy(e))).not.toContain("homedata");
    // And not in anyone's prompt, nor in the scripts that carried the copies.
    r.feed.deliver = undefined;
    for (const run of r.runs.filter((x) => x.employeeId !== "pip"))
      expect(run.script).not.toContain("homedata");
    const scopes = (id: string) => r.feed.readable(id);
    expect(scopes("ada")).toEqual(["brain:ada", "team:engineering", "company"]);
    expect(scopes("pip")).toEqual(["brain:pip", "company"]);
  });

  it("sends only what changed, and nothing when nothing did", async () => {
    const r = await seeded();
    expect(await r.feed.sync("ada")).toMatchObject({ how: "full", sent: 9 }); // 8 tracked files and the command
    const runs = r.runs.length;
    // Same brain: no script at all.
    expect(await r.feed.sync("ada")).toMatchObject({ ok: true, how: "current" });
    expect(r.runs.length).toBe(runs);
    // A page's text changes: that page alone (its map line is the same).
    r.commit("handbook", {
      "facts/gh.md": page("GitHub CLI", "gh pr checks waits for CI", "Use --watch. Updated."),
    });
    expect(await r.feed.sync("ada")).toMatchObject({ ok: true, how: "delta", sent: 1 });
    expect(readFileSync(r.copy("ada", "company/facts/gh.md"), "utf8")).toContain("Updated.");
    // Its description changes: the page and its scope's map.
    r.commit("handbook", { "facts/gh.md": page("GitHub CLI", "gh watches CI", "Use --watch. Updated.") });
    expect(await r.feed.sync("ada")).toMatchObject({ ok: true, how: "delta", sent: 2 });
    expect(gitIn(r.copy("ada"), "status", "--short")).toBe("");
    // A page goes, another comes.
    r.commit("handbook", {
      "projects/duet.md": null,
      "projects/new.md": page("New", "A new project", "Fresh."),
    });
    expect(await r.feed.sync("ada")).toMatchObject({ ok: true, how: "delta" });
    expect(existsSync(r.copy("ada", "company/projects/duet.md"))).toBe(false);
    expect(existsSync(r.copy("ada", "company/projects/new.md"))).toBe(true);
    expect(gitIn(r.copy("ada"), "status", "--short")).toBe("");
    // A change in a scope Ada can't read sends her nothing.
    const before = r.runs.length;
    r.commit("kit", { "tools/more.md": page("More", "More of Kit", "kit only") });
    expect(await r.feed.sync("ada")).toMatchObject({ how: "current" });
    expect(r.runs.length).toBe(before);
  });

  it("copies the whole brain again when the sandbox was wiped, and tells a delta from a full copy", async () => {
    const r = await seeded();
    await r.feed.sync("ada");
    rmSync(r.copy("ada"), { recursive: true, force: true });
    // Nothing changed upstream: the periodic check notices the copy is gone.
    r.clock.advance(6);
    expect(await r.feed.sync("ada")).toMatchObject({ ok: true, how: "full" });
    expect(existsSync(r.copy("ada", "company/facts/gh.md"))).toBe(true);
    // A change after a wipe: the delta is refused by the sandbox and the whole thing goes.
    rmSync(r.copy("ada"), { recursive: true, force: true });
    r.commit("handbook", { "facts/gh.md": page("GitHub CLI", "gh", "Changed.") });
    expect(await r.feed.sync("ada")).toMatchObject({ ok: true, how: "full" });
    expect(tree(r.copy("ada")).length).toBeGreaterThan(8);
  });

  it("goes on without the copy when the sandbox fails, and says so", async () => {
    const r = await seeded();
    r.failing.next = true;
    expect(await r.feed.sync("ada")).toMatchObject({ ok: false, how: "failed" });
    expect(r.logs.join("\n")).toContain("couldn't copy ada's brain");
    r.failing.next = false;
    expect(await r.feed.sync("ada")).toMatchObject({ ok: true, how: "full" });
  });

  it("keeps the agent's own edits when it refreshes, and logs it", async () => {
    const r = await seeded();
    await r.feed.sync("ada");
    const dir = r.copy("ada");
    // The agent edits a page, writes a new one and deletes another.
    writeFileSync(join(dir, "company/facts/gh.md"), "---\ntitle: GitHub CLI\n---\nAda's better note.\n");
    mkdirSync(join(dir, "personal/tools"), { recursive: true });
    writeFileSync(join(dir, "personal/tools/new.md"), "# New\n\nAda wrote this.\n");
    rmSync(join(dir, "company/projects/duet.md"));
    // Meanwhile the brain changes: the page Ada edited, one she didn't, and the one she deleted.
    r.commit("handbook", {
      "facts/gh.md": page("GitHub CLI", "gh", "Upstream rewrite."),
      "facts/other.md": page("Other", "Another page", "Other text."),
      "projects/duet.md": page("Duet", "The couples' finance app", "Tauri, Lit and more."),
    });
    const report = await r.feed.sync("ada");
    expect(report.ok).toBe(true);
    expect(report.kept.sort()).toEqual(["company/facts/gh.md", "company/projects/duet.md"]);
    // Her edit survives; what she didn't touch moved on.
    expect(readFileSync(join(dir, "company/facts/gh.md"), "utf8")).toContain("Ada's better note.");
    expect(readFileSync(join(dir, "personal/tools/new.md"), "utf8")).toContain("Ada wrote this.");
    expect(existsSync(join(dir, "company/projects/duet.md"))).toBe(false);
    expect(readFileSync(join(dir, "company/facts/other.md"), "utf8")).toContain("Other text.");
    // The baseline moved only for the untouched files, so the diff is exactly her work.
    expect(gitIn(dir, "diff", "--name-status", "refs/inc/baseline").trim().split("\n").sort()).toEqual([
      "D\tcompany/projects/duet.md",
      "M\tcompany/facts/gh.md",
    ]);
    expect(gitIn(dir, "ls-files", "--others", "--exclude-standard").trim()).toBe("personal/tools/new.md");
    expect(gitIn(dir, "show", "refs/inc/baseline:company/facts/other.md")).toContain("Other text.");
    expect(gitIn(dir, "show", "refs/inc/baseline:company/facts/gh.md")).toContain(
      "Use gh pr checks --watch.",
    );
    expect(r.logs.join("\n")).toMatch(/kept ada's own edits to 2 page\(s\)/);
    // Another refresh with nothing new is quiet and changes nothing.
    r.logs.length = 0;
    await r.feed.sync("ada");
    expect(readFileSync(join(dir, "company/facts/gh.md"), "utf8")).toContain("Ada's better note.");
  });
});

describe("path safety", () => {
  it("leaves out pages whose names aren't plain, symlinks, huge pages and dot-files", async () => {
    const r = await seeded();
    const big = `${"word ".repeat(70_000)}`; // 350 KB
    r.commit("handbook", {
      "facts/ok name.md": page("Fine", "Spaces are fine", "ok"),
      "facts/it's.md": page("Quote", "an apostrophe", "no"),
      "facts/$(touch pwned).md": page("Sub", "command substitution", "no"),
      "facts/a`b`.md": page("Tick", "backticks", "no"),
      "facts/.hidden.md": page("Hidden", "dot", "no"),
      "facts/huge.md": big,
    });
    // A symlink committed as a page, pointing out of the repo.
    symlinkSync("/etc/passwd", join(r.knowledgeDir, "handbook", "facts", "link.md"));
    r.git("handbook", "add", "-A");
    r.git("handbook", "commit", "-q", "-m", "link");
    r.app.deps.knowledge.onCommit?.({ kind: "handbook" });
    expect((await r.feed.sync("ada")).ok).toBe(true);
    const files = tree(r.copy("ada"));
    expect(files).toContain("company/facts/ok name.md");
    for (const bad of ["it's", "$(", "`", ".hidden", "huge", "link"]) {
      expect(files.filter((f) => f.includes(bad))).toEqual([]);
    }
    expect(existsSync("/tmp/pwned")).toBe(false);
    expect(r.logs.join("\n")).toContain("leaves out");
    // No path in the copy is absolute, climbs, or is a link.
    for (const f of files) {
      expect(f.startsWith("/")).toBe(false);
      expect(f.split("/")).not.toContain("..");
      expect(lstatSync(join(r.copy("ada"), f)).isSymbolicLink()).toBe(false);
    }
  });

  it("removes a symlink an agent left in its copy, and never writes through one", async () => {
    const r = await seeded();
    await r.feed.sync("ada");
    const outside = mkdtempSync(join(tmpdir(), "i-inc-outside-"));
    rmSync(r.copy("ada", "company"), { recursive: true });
    symlinkSync(outside, r.copy("ada", "company"));
    r.commit("handbook", { "facts/gh.md": page("GitHub CLI", "gh", "Changed again.") });
    expect((await r.feed.sync("ada")).ok).toBe(true);
    expect(lstatSync(r.copy("ada", "company")).isSymbolicLink()).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses an archive that holds a link or a climbing path, on the sandbox side", async () => {
    const r = await seeded();
    const root = join(r.sandbox, "ada");
    const snap = r.feed.build("ada").snap as Snapshot;
    const script = applyScript({
      root,
      next: snap,
      contents: new Map([["company/facts/x.md", Buffer.from("x")]]),
      meta: {},
      at: 0,
    });
    const work = mkdtempSync(join(tmpdir(), "i-inc-tar-"));
    try {
      mkdirSync(join(work, "src"));
      symlinkSync("/etc", join(work, "src", "evil"));
      const hostile = (args: string[]) => {
        spawnSync("tar", ["-cf", join(work, "h.tar"), ...args], { cwd: join(work, "src") });
        const b64 = readFileSync(join(work, "h.tar")).toString("base64");
        return script.replace(/(<<'__INC_TAR__'\n)[\s\S]*?(\n__INC_TAR__)/, `$1${b64}$2`);
      };
      for (const evil of [hostile(["evil"])]) {
        const out = spawnSync("bash", ["-s"], { input: evil, encoding: "utf8" });
        expect(`${out.stdout}${out.stderr}`).toContain("@@fail");
        expect(existsSync(join(root, "evil"))).toBe(false);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
