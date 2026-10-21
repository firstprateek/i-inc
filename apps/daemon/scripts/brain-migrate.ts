// Moves the existing brain and handbook pages to the V1 page format (docs/design/brain.md,
// "Migration"): frontmatter on every page, the title and description derived from what's there,
// `updated` and `sources` from git, and `needs-tidy: true` on pages that are piles of appended
// fragments, for the tidy-up to merge later. It never deletes or rewrites a page's text: the body
// after the frontmatter is byte-for-byte what was there.
//
//   bun apps/daemon/scripts/brain-migrate.ts                  # dry run: print what would change
//   bun apps/daemon/scripts/brain-migrate.ts --apply          # write it, one commit per repo
//   bun apps/daemon/scripts/brain-migrate.ts --home ~/.i-inc  # (default: $I_INC_HOME or ~/.i-inc)
//   bun apps/daemon/scripts/brain-migrate.ts --knowledge <dir>  # the knowledge directory itself
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isoDate, type PageMeta, parsePage, scopeOfPath, serializePage } from "@i-inc/core";
import { KnowledgeStore, type Repo } from "../src/knowledge.ts";

/** A page edited by this many learned edits (the first one creates it) is a pile of fragments. */
export const tidyAfterEdits = 3;

export interface PageReport {
  repo: string;
  path: string;
  action: "migrate" | "unchanged";
  /** Frontmatter fields this run adds. */
  adds: string[];
  needsTidy: boolean;
}

export interface MigrationReport {
  pages: PageReport[];
  /** Repos that were skipped, with why (an uncommitted working tree on --apply). */
  skipped: string[];
  applied: boolean;
  commits: string[];
}

const repoName = (r: Repo) => (r.kind === "handbook" ? "handbook" : `brain:${r.id}`);

function dirOf(root: string, repo: Repo): string {
  return repo.kind === "handbook" ? join(root, "handbook") : join(root, "brains", repo.id);
}

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=i.inc", "-c", "user.email=daemon@i-inc.local", "-c", "commit.gpgsign=false", ...args],
    { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 },
  );
}

/** The ticket ids that learned edits to this file came from, in order: ["ticket-14", …]. */
function ticketSources(dir: string, path: string): { sources: string[]; edits: number } {
  const log = git(dir, "log", "--reverse", "--format=%x00%B", "--", path);
  const sources: string[] = [];
  let edits = 0;
  for (const message of log.split("\0")) {
    if (/^Edit-Id: /m.test(message)) edits++;
    const t = message.match(/^Ticket: (.+)$/m)?.[1]?.trim();
    if (t && !sources.includes(`ticket-${t}`)) sources.push(`ticket-${t}`);
  }
  return { sources, edits };
}

/**
 * Plans (and, with `apply`, writes and commits) the migration for every repo under `knowledgeDir`.
 */
export function migrateKnowledge(knowledgeDir: string, o: { apply?: boolean } = {}): MigrationReport {
  const store = new KnowledgeStore(knowledgeDir);
  const report: MigrationReport = { pages: [], skipped: [], applied: o.apply === true, commits: [] };

  for (const repo of store.repos()) {
    const dir = dirOf(knowledgeDir, repo);
    if (o.apply && git(dir, "status", "--porcelain").trim()) {
      report.skipped.push(`${repoName(repo)}: uncommitted changes; commit or discard them first`);
      continue;
    }
    const files = [...store.tree(repo)].filter(([path]) => scopeOfPath(repo, path) !== null);
    const texts = store.blobs(repo, [...new Set(files.map(([, sha]) => sha))]);
    const dates = store.modified(
      repo,
      files.map(([path]) => path),
    );

    const writes: [string, string][] = [];
    for (const [path, sha] of files) {
      const at = scopeOfPath(repo, path);
      if (!at) continue;
      const old = texts.get(sha) ?? "";
      const page = parsePage(old, at.slug);
      const { sources, edits } = ticketSources(dir, path);
      const adds: string[] = [];
      const meta: PageMeta = { ...page.meta };

      if (page.derived.title) adds.push("title");
      if (page.derived.description) adds.push("description");
      const writtenFront = page.hasFrontmatter;
      if (!writtenFront || !page.meta.updated) {
        const ms = dates.get(path);
        if (ms !== undefined) {
          meta.updated = isoDate(ms);
          adds.push("updated");
        }
      }
      if (!meta.sources.length && sources.length) {
        meta.sources = sources;
        adds.push("sources");
      }
      const folder = at.slug.includes("/") ? at.slug.slice(0, at.slug.indexOf("/")) : "";
      if (!meta.tags.length && folder) {
        meta.tags = [folder];
        adds.push("tags");
      }
      const pile = edits >= tidyAfterEdits && at.slug !== "personality" && !meta.needsTidy;
      if (pile) {
        meta.needsTidy = true;
        adds.push("needs-tidy");
      }
      if (!writtenFront) adds.unshift("frontmatter");

      const migrate = adds.length > 0;
      report.pages.push({
        repo: repoName(repo),
        path,
        action: migrate ? "migrate" : "unchanged",
        adds,
        needsTidy: meta.needsTidy === true,
      });
      if (!migrate) continue;
      const text = serializePage({ meta, body: page.body });
      // Nothing is ever lost: the body must survive untouched.
      if (!text.endsWith(page.body) || parsePage(text, at.slug).body !== page.body) {
        throw new Error(`refusing to migrate ${repoName(repo)}/${path}: its text would change`);
      }
      writes.push([path, text]);
    }

    if (o.apply && writes.length) {
      for (const [path, text] of writes) writeFileSync(join(dir, path), text);
      git(dir, "add", "-A");
      git(
        dir,
        "commit",
        "-q",
        "-m",
        "Migrate pages to the brain format",
        "-m",
        `Adds frontmatter (title, description, tags, updated, sources) to ${writes.length} pages. Page text is unchanged.`,
      );
      report.commits.push(`${repoName(repo)}: ${git(dir, "rev-parse", "--short", "HEAD").trim()}`);
    }
  }
  return report;
}

/** The report as lines for the terminal. */
export function summarize(r: MigrationReport): string[] {
  const out: string[] = [];
  const repos = [...new Set(r.pages.map((p) => p.repo))];
  for (const repo of repos) {
    const mine = r.pages.filter((p) => p.repo === repo);
    const todo = mine.filter((p) => p.action === "migrate");
    out.push(
      `${repo}: ${mine.length} pages, ${todo.length} ${r.applied ? "migrated" : "to migrate"}, ${
        mine.filter((p) => p.needsTidy).length
      } needing a tidy`,
    );
    for (const p of todo) {
      out.push(
        `  ${r.applied ? "~" : "+"} ${p.path}  (${p.adds.join(", ")})${p.needsTidy ? "  needs-tidy" : ""}`,
      );
    }
  }
  for (const s of r.skipped) out.push(`skipped ${s}`);
  const total = r.pages.filter((p) => p.action === "migrate").length;
  out.push(
    "",
    `${r.pages.length} pages in ${repos.length} repos; ${total} ${r.applied ? "migrated" : "would be migrated"}; ${
      r.pages.filter((p) => p.needsTidy).length
    } flagged needs-tidy; no page text is changed or deleted.`,
  );
  if (r.applied) for (const c of r.commits) out.push(`committed ${c}`);
  else out.push("Dry run: nothing was written. Pass --apply to commit the migration.");
  return out;
}

export function main(argv: string[], env: Record<string, string | undefined> = process.env): number {
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const unknown = argv.filter((a) => a.startsWith("-") && !["--apply", "--home", "--knowledge"].includes(a));
  if (unknown.length) {
    console.error(
      `unknown option ${unknown[0]}. Usage: brain-migrate [--apply] [--home <dir> | --knowledge <dir>]`,
    );
    return 2;
  }
  const knowledge =
    flag("--knowledge") ?? join(flag("--home") ?? env.I_INC_HOME ?? join(homedir(), ".i-inc"), "knowledge");
  if (!existsSync(knowledge)) {
    console.error(`no knowledge directory at ${knowledge}`);
    return 1;
  }
  console.log(`${argv.includes("--apply") ? "Applying to" : "Dry run on"} ${knowledge}`);
  for (const line of summarize(migrateKnowledge(knowledge, { apply: argv.includes("--apply") })))
    console.log(line);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
