// Brains and the handbook on the host (spec §5, "The brain"): one git repo per brain and one for the
// handbook, never pushed anywhere. Only the daemon writes them, from edits employees proposed; every
// edit is a commit, so the owner can read, diff or revert what anyone learned.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Employee, type Id, type ProposedEdit, pagePath, repoFor } from "@i-inc/core";
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
  constructor(private readonly root: string) {}

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

  /** A new hire's brain, from the template: a map, a personality page and the wiki's folders. */
  ensureBrain(e: Pick<Employee, "id" | "name" | "role">): void {
    this.create(
      { kind: "brain", id: e.id },
      {
        "INDEX.md": `# ${e.name}'s brain\n\n${e.role}. Pages are listed here as they are written.\n\n- [Personality](personality.md)\n`,
        "personality.md": `# Personality\n\n${e.name} is a ${e.role} at i.inc.\n`,
      },
      `Brain created for ${e.name}`,
    );
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
    const body = isNew ? `# ${title}\n\n${text}\n` : `${readFileSync(file, "utf8").trimEnd()}\n\n${text}\n`;
    writeFileSync(file, body);
    if (isNew) this.list(repo, path, title);

    this.git(repo, "add", "-A");
    const subject = `${isNew ? "Add" : "Update"} ${path}`;
    const trailers = [`Author: ${p.author}`, `Ticket: ${p.ticketId}`, `Edit-Id: ${p.id}`].join("\n");
    this.git(repo, "commit", "-q", "-m", subject, "-m", trailers);
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
  }

  /** Every brain on the host. */
  brains(): Id[] {
    const dir = join(this.root, "brains");
    return existsSync(dir) ? readdirSync(dir).filter((d) => idPattern.test(d)) : [];
  }
}
