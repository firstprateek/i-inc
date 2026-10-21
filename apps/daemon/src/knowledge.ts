// Brains and the handbook on the host (spec §5, "The brain"): one git repo per brain and one for the
// handbook, never pushed anywhere. Only the daemon writes them, from edits employees proposed; every
// edit is a commit, so the owner can read, diff or revert what anyone learned.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  clip,
  type Employee,
  firstSentence,
  type Id,
  isoDate,
  type ProposedEdit,
  pagePath,
  parsePage,
  repoFor,
  serializePage,
} from "@i-inc/core";
import type { Change, Page } from "./view-types.ts";

export type { Change, Page };

export type Repo = { kind: "brain"; id: Id } | { kind: "handbook" };

/** "facts/duet-money.md" → "Duet money". */
export function pageTitle(path: string): string {
  const t = path.replace(/^.*\//, "").replace(/\.md$/, "").replace(/-/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const idPattern = /^[a-z0-9-]{1,32}$/;

export class KnowledgeStore {
  /**
   * Called after every commit to a repo, so the brain index can follow (brain-index.ts). `paths` are the
   * files the commit touched when we know them; without them the listener asks git (`changedPaths`).
   */
  onCommit?: (repo: Repo, paths?: string[]) => void;

  /** `now` stamps `updated` on pages (the daemon's clock; the system clock by default). */
  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}

  private dir(repo: Repo): string {
    if (repo.kind === "handbook") return join(this.root, "handbook");
    if (!idPattern.test(repo.id)) throw new Error(`not an employee id: ${repo.id}`);
    return join(this.root, "brains", repo.id);
  }

  private git(repo: Repo, ...args: string[]): string {
    return execFileSync(
      "git",
      ["-c", "user.name=i.inc", "-c", "user.email=daemon@i-inc.local", "-c", "commit.gpgsign=false", ...args],
      { cwd: this.dir(repo), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  }

  exists(repo: Repo): boolean {
    return existsSync(join(this.dir(repo), ".git"));
  }

  private create(repo: Repo, files: Record<string, string>, subject: string): void {
    if (this.exists(repo)) return;
    const dir = this.dir(repo);
    mkdirSync(dir, { recursive: true });
    this.git(repo, "init", "-q", "-b", "main");
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    this.git(repo, "add", "-A");
    this.git(repo, "commit", "-q", "-m", subject);
    this.onCommit?.(repo, Object.keys(files));
  }

  /** The company's shared brain: facts any employee adds, and policies you approve. */
  ensureHandbook(): void {
    this.create(
      { kind: "handbook" },
      {
        "INDEX.md":
          "# Handbook\n\nWhat every employee should know. Facts are added at task boundaries; policies change only with the owner's approval.\n\n## Facts\n\n## Policies\n",
      },
      "Handbook created",
    );
  }

  /** The personality page: frontmatter (the index and the map read it) and the role instructions. */
  private personalityText(
    e: Pick<Employee, "name" | "role"> & { prompt?: string | undefined },
    prior?: ReturnType<typeof parsePage>,
  ): string {
    const body = [
      `# Personality`,
      ``,
      `${e.name} is a ${e.role} at i.inc.`,
      ...(e.prompt ? [``, `## Role Instructions`, ``, e.prompt] : []),
      ``,
    ].join("\n");
    const meta = {
      ...(prior?.meta ?? { tags: [], sources: [] }),
      title: "Personality",
      description: clip(`Who ${e.name} is (${e.role}) and the instructions ${e.name} works by`, 160),
      updated: isoDate(this.now()),
    };
    return serializePage({ meta, body });
  }

  /** A new hire's brain, from the template: a map, a personality page and the wiki's folders. */
  ensureBrain(e: Pick<Employee, "id" | "name" | "role"> & { prompt?: string | undefined }): void {
    this.create(
      { kind: "brain", id: e.id },
      {
        "INDEX.md": `# ${e.name}'s brain\n\n${e.role}. Pages are listed here as they are written.\n\n- [Personality](personality.md)\n`,
        "personality.md": this.personalityText(e),
      },
      `Brain created for ${e.name}`,
    );
  }

  /** Updates an employee's personality and role instructions in their brain repo. */
  updatePersonality(id: Id, name: string, role: string, prompt?: string): void {
    const repo: Repo = { kind: "brain", id };
    if (!this.exists(repo)) {
      this.ensureBrain({ id, name, role, ...(prompt !== undefined ? { prompt } : {}) });
      return;
    }
    const dir = this.dir(repo);
    const file = join(dir, "personality.md");
    const prior = existsSync(file) ? parsePage(readFileSync(file, "utf8"), "personality") : undefined;
    writeFileSync(file, this.personalityText({ name, role, prompt }, prior));
    this.git(repo, "add", "personality.md");
    try {
      this.git(repo, "commit", "-q", "-m", `Update personality and role instructions for ${name}`);
      this.onCommit?.(repo, ["personality.md"]);
    } catch {
      // No changes to commit
    }
  }

  /**
   * Applies one proposed edit: it appends to the page (creating it and listing it on the map), and
   * commits with the edit's id. An edit already applied is skipped, so applying twice is safe.
   */
  apply(p: ProposedEdit, name: (id: Id) => { name: string; role: string }): boolean {
    const path = pagePath(p.edit);
    if (!path) return false;
    const target = repoFor(p.edit, p.author);
    const repo: Repo = target.kind === "brain" ? { kind: "brain", id: target.id } : { kind: "handbook" };
    if (repo.kind === "brain") this.ensureBrain({ id: repo.id, ...name(repo.id) });
    else this.ensureHandbook();
    if (this.git(repo, "log", "--format=%H", "--fixed-strings", `--grep=Edit-Id: ${p.id}`).trim())
      return false;

    const dir = this.dir(repo);
    const file = join(dir, path);
    const text = p.edit.text.trim();
    const isNew = !existsSync(file);
    mkdirSync(dirname(file), { recursive: true });
    const title = pageTitle(path);
    const slug = path.replace(/\.md$/, "");
    const source = `ticket-${p.ticketId}`;
    // Every applied edit stamps `updated` and records its ticket, adding frontmatter to an old page
    // that never had any. The page's own text is only ever appended to.
    const existing = isNew ? null : parsePage(readFileSync(file, "utf8"), slug);
    const body = existing ? `${existing.body.trimEnd()}\n\n${text}\n` : `# ${title}\n\n${text}\n`;
    const meta = existing?.meta ?? {
      title,
      description: firstSentence(text),
      tags: slug.includes("/") ? [slug.slice(0, slug.indexOf("/"))] : [],
      sources: [],
    };
    if (existing && !existing.hasFrontmatter)
      meta.tags = slug.includes("/") ? [slug.slice(0, slug.indexOf("/"))] : [];
    meta.updated = isoDate(this.now());
    if (!meta.sources.includes(source)) meta.sources = [...meta.sources, source];
    if (!meta.description) meta.description = firstSentence(body);
    writeFileSync(file, serializePage({ meta, body }));
    if (isNew) this.list(repo, path, title);

    this.git(repo, "add", "-A");
    const subject = `${isNew ? "Add" : "Update"} ${path}`;
    const trailers = [`Author: ${p.author}`, `Ticket: ${p.ticketId}`, `Edit-Id: ${p.id}`].join("\n");
    this.git(repo, "commit", "-q", "-m", subject, "-m", trailers);
    this.onCommit?.(repo, [path, "INDEX.md"]);
    return true;
  }

  /** Adds a new page to the map: under its section in the handbook, at the end of a brain's. */
  private list(repo: Repo, path: string, title: string): void {
    const index = join(this.dir(repo), "INDEX.md");
    const lines = (existsSync(index) ? readFileSync(index, "utf8") : "").trimEnd().split("\n");
    const entry = `- [${title}](${path})`;
    const section = path.startsWith("facts/")
      ? "## Facts"
      : path.startsWith("policies/")
        ? "## Policies"
        : null;
    const start = section ? lines.indexOf(section) : -1;
    if (start === -1) {
      lines.push(entry);
    } else {
      let end = start + 1;
      while (end < lines.length && !lines[end]?.startsWith("## ")) end++;
      while (end > start + 1 && !lines[end - 1]?.trim()) end--;
      lines.splice(end, 0, ...(end === start + 1 ? ["", entry] : [entry]));
    }
    writeFileSync(index, `${lines.join("\n")}\n`);
  }

  /** Every page, the map first. */
  pages(repo: Repo): Page[] {
    if (!this.exists(repo)) return [];
    const dir = this.dir(repo);
    const out: Page[] = [];
    const walk = (rel: string) => {
      for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".md")) out.push({ path, text: readFileSync(join(dir, path), "utf8") });
      }
    };
    walk("");
    const rank = (p: string) => (p === "INDEX.md" ? 0 : p === "personality.md" ? 1 : 2);
    return out.sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
  }

  /** Recent commits, newest first. */
  history(repo: Repo, limit = 50): Change[] {
    if (!this.exists(repo)) return [];
    const raw = this.git(repo, "log", `-n${limit}`, "--format=%H%x1f%ct%x1f%s%x1f%b%x1e");
    const changes = raw
      .split("\x1e")
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const [commit = "", ct = "0", subject = "", body = ""] = r.split("\x1f");
        const trailer = (k: string) => body.match(new RegExp(`^${k}: (.+)$`, "m"))?.[1]?.trim() ?? null;
        return {
          commit,
          at: Number(ct) * 1000,
          subject,
          author: trailer("Author"),
          ticketId: trailer("Ticket"),
          reverted: false,
          revert: /^Revert "/.test(subject),
          reverts: body.match(/This reverts commit ([0-9a-f]{40})/)?.[1] ?? null,
        };
      });
    const undone = new Set(changes.map((c) => c.reverts).filter(Boolean));
    return changes.map(({ reverts: _, ...c }) => ({ ...c, reverted: undone.has(c.commit) }));
  }

  /** Undoes one edit with a new commit, so the history keeps both. */
  revert(repo: Repo, commit: string): void {
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("not a commit id");
    const change = this.history(repo, 500).find((c) => c.commit === commit);
    if (!change) throw new Error("no such change");
    if (change.reverted) return;
    if (!change.author) throw new Error("only learned edits can be reverted");
    this.git(repo, "revert", "--no-edit", commit);
    this.onCommit?.(repo);
  }

  /** Every brain on the host. */
  brains(): Id[] {
    const dir = join(this.root, "brains");
    return existsSync(dir) ? readdirSync(dir).filter((d) => idPattern.test(d)) : [];
  }

  /** Every repo on the host: the handbook, then each brain. */
  repos(): Repo[] {
    return [
      ...(this.exists({ kind: "handbook" }) ? [{ kind: "handbook" } as Repo] : []),
      ...this.brains().map((id): Repo => ({ kind: "brain", id })),
    ];
  }

  private gitBuffer(repo: Repo, args: string[], input?: string): Buffer {
    // Literal pathspecs: a file called "*.md" or ":(top)x" is that file, not a pattern.
    return execFileSync("git", ["--literal-pathspecs", "-c", "core.quotepath=off", ...args], {
      cwd: this.dir(repo),
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 1 << 30,
      ...(input !== undefined ? { input } : {}),
    });
  }

  /** The committed files at HEAD as path → blob id. Empty for a repo without commits. */
  tree(repo: Repo): Map<string, string> {
    const out = new Map<string, string>();
    if (!this.exists(repo)) return out;
    let raw: string;
    try {
      raw = this.gitBuffer(repo, ["ls-tree", "-r", "-z", "HEAD"]).toString("utf8");
    } catch {
      return out; // no commits yet
    }
    for (const rec of raw.split("\0")) {
      // A symlink is a blob too (mode 120000); its "text" is a path, never a page.
      const m = rec.match(/^(?!120000 )\d+ blob ([0-9a-f]{40})\t([\s\S]+)$/);
      if (m) out.set(m[2] ?? "", m[1] ?? "");
    }
    return out;
  }

  /**
   * HEAD and its first parent (null for a first commit), or null for a repo without commits. The
   * index stores the HEAD it has read, and trusts an incremental update only when this commit's
   * parent is that one.
   */
  head(repo: Repo): { sha: string; parent: string | null } | null {
    if (!this.exists(repo)) return null;
    let raw: string;
    try {
      raw = this.gitBuffer(repo, ["rev-list", "--parents", "-n", "1", "HEAD"]).toString("utf8").trim();
    } catch {
      return null; // no commits yet
    }
    const [sha, parent] = raw.split(/\s+/);
    return sha ? { sha, parent: parent ?? null } : null;
  }

  /** The text of committed blobs, by blob id, in one git process. */
  blobs(repo: Repo, ids: string[]): Map<string, string> {
    return this.catBlobs(repo, ids);
  }

  private catBlobs(repo: Repo, ids: string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (!ids.length) return out;
    const buf = this.gitBuffer(repo, ["cat-file", "--batch"], `${ids.join("\n")}\n`);
    let at = 0;
    while (at < buf.length) {
      const eol = buf.indexOf(10, at);
      if (eol === -1) break;
      const [id = "", type = "", size = "0"] = buf.toString("utf8", at, eol).split(" ");
      if (type !== "blob") {
        at = eol + 1;
        continue;
      }
      const n = Number(size);
      out.set(id, buf.toString("utf8", eol + 1, eol + 1 + n));
      at = eol + 1 + n + 1;
    }
    return out;
  }

  /** The store's clock, in ms. */
  clock(): number {
    return this.now();
  }

  /** When HEAD was committed (ms); 0 for a repo with no commits. */
  headTime(repo: Repo): number {
    const t = this.gitBuffer(repo, ["log", "-1", "--format=%ct"]).toString().trim();
    return t ? Number(t) * 1000 : 0;
  }

  /** The files the latest commit touched (added, changed or deleted). */
  changedPaths(repo: Repo): string[] {
    const raw = this.gitBuffer(repo, [
      "diff-tree",
      "--root",
      "--no-commit-id",
      "--name-only",
      "-r",
      "-z",
      "HEAD",
    ]).toString("utf8");
    return raw.split("\0").filter(Boolean);
  }

  /**
   * The committed text of these files at HEAD, with their blob ids; null for a file that isn't there.
   * Names travel NUL-delimited (`ls-tree -z`, literal pathspecs), so a name with a quote or a newline
   * in it is read as itself and the answers can't shift out of line.
   */
  readAtHead(repo: Repo, paths: string[]): Map<string, { sha: string; text: string } | null> {
    const out = new Map<string, { sha: string; text: string } | null>();
    if (!paths.length) return out;
    const shaOf = new Map<string, string>();
    for (let i = 0; i < paths.length; i += 200) {
      const raw = this.gitBuffer(repo, ["ls-tree", "-z", "HEAD", "--", ...paths.slice(i, i + 200)]).toString(
        "utf8",
      );
      for (const rec of raw.split("\0")) {
        const m = rec.match(/^(?!120000 )\d+ blob ([0-9a-f]{40})\t([\s\S]+)$/);
        if (m) shaOf.set(m[2] ?? "", m[1] ?? "");
      }
    }
    const texts = this.catBlobs(repo, [...new Set(shaOf.values())]);
    for (const path of paths) {
      const sha = shaOf.get(path);
      out.set(path, sha !== undefined && texts.has(sha) ? { sha, text: texts.get(sha) ?? "" } : null);
    }
    return out;
  }

  /** When each given file was last committed (ms). One `git log` per file, or one walk for many. */
  modified(repo: Repo, paths: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (!paths.length || !this.exists(repo)) return out;
    if (paths.length <= 3) {
      for (const path of paths) {
        const t = this.gitBuffer(repo, ["log", "-1", "--format=%ct", "--", path]).toString().trim();
        if (t) out.set(path, Number(t) * 1000);
      }
      return out;
    }
    const want = new Set(paths);
    let when = 0;
    // -z: names are NUL-terminated and never quoted, so a name with a quote or newline in it matches.
    // A commit is "\x01<time>\0", then "\n<first name>\0" and each further name and "\0".
    const log = this.gitBuffer(repo, [
      "log",
      "--format=%x01%ct",
      "--name-only",
      "--no-renames",
      "-z",
    ]).toString("utf8");
    let afterHeader = false;
    for (const rec of log.split("\0")) {
      if (rec.startsWith("\x01")) {
        when = Number(rec.slice(1)) * 1000;
        afterHeader = true;
        continue;
      }
      const name = afterHeader ? rec.replace(/^\n/, "") : rec;
      afterHeader = false;
      if (name && want.has(name) && !out.has(name)) out.set(name, when);
    }
    return out;
  }
}
