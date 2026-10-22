// Brains and the handbook (spec §5, "The brain"). Employees never write knowledge directly: at the
// retro (or orientation) they propose edits, and the daemon applies them. This file is the pure
// part: where an edit may land, and which proposed edits are due or waiting for the owner.
import type { TicketEvent } from "./events.ts";
import type { Employee, Id, KnowledgeEdit } from "./model.ts";

/** A proposed edit with where it came from. Its id is stable, so applying it twice is a no-op. */
export interface ProposedEdit {
  id: string;
  ticketId: Id;
  author: Id;
  at: number;
  edit: KnowledgeEdit;
}

/** Where a brain's pages live, after the owner's own LLM wiki: a map plus these folders. */
export const brainFolders = ["tools", "patterns", "projects", "reference", "duties"] as const;

const slug = /^[a-z0-9][a-z0-9-]{0,63}$/;
const teamId = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * The page an edit writes to, relative to its repo, or null when the name isn't allowed. Edits come
 * from agent sessions, so a page is only ever a known folder and a plain slug: no `..`, no absolute
 * paths, nothing outside the brain or the handbook.
 */
export function pagePath(edit: KnowledgeEdit): string | null {
  const parts = edit.page
    .trim()
    .toLowerCase()
    .replace(/\.md$/, "")
    .split("/")
    .map((p) => p.trim().replace(/\s+/g, "-"));
  if (edit.layer === "brain") {
    if (parts.length === 1 && parts[0] === "personality") return "personality.md";
    const [folder, name] = parts;
    if (parts.length !== 2 || !brainFolders.includes(folder as never) || !slug.test(name ?? "")) return null;
    return `${folder}/${name}.md`;
  }
  if (edit.layer === "fact") {
    const [folder, a, b] = parts;
    // facts/<name> (or a bare name), projects/<repo>, teams/<teamId>/<name>
    if (parts.length === 1) return slug.test(folder ?? "") ? `facts/${folder}.md` : null;
    if ((folder === "facts" || folder === "projects") && parts.length === 2) {
      return slug.test(a ?? "") ? `${folder}/${a}.md` : null;
    }
    if (folder === "teams" && parts.length === 3) {
      return teamId.test(a ?? "") && slug.test(b ?? "") ? `teams/${a}/${b}.md` : null;
    }
    return null;
  }
  const name =
    parts.length === 2 && parts[0] === "policies" ? parts[1] : parts.length === 1 ? parts[0] : null;
  return name && slug.test(name) ? `policies/${name}.md` : null;
}

/** Which repo an edit belongs to: the author's brain, or the handbook. */
export function repoFor(edit: KnowledgeEdit, author: Id): { kind: "brain"; id: Id } | { kind: "handbook" } {
  return edit.layer === "brain" ? { kind: "brain", id: author } : { kind: "handbook" };
}

export interface KnowledgeLog {
  /** Brain edits, handbook facts, and policy changes the owner approved. */
  due: ProposedEdit[];
  /** Policy changes waiting for the owner. */
  awaiting: ProposedEdit[];
  /** Edits whose page name isn't allowed. They're kept for the audit, never applied. */
  refused: ProposedEdit[];
}

/** Every edit a ticket's employees proposed, sorted into due, awaiting the owner, and refused. */
export function knowledgeLog(ticketId: Id, events: TicketEvent[]): KnowledgeLog {
  const out: KnowledgeLog = { due: [], awaiting: [], refused: [] };
  const decided = new Map<string, boolean>();
  for (const e of events) if (e.type === "policy-decided") decided.set(e.editId, e.approved);

  events.forEach((e, n) => {
    if (e.type !== "knowledge-proposed") return;
    const make = (edit: KnowledgeEdit, i: number, kind: string): ProposedEdit => ({
      id: `${ticketId}:${n}:${kind}${i}`,
      ticketId,
      author: e.employeeId,
      at: e.at,
      edit,
    });
    e.apply.forEach((edit, i) => {
      const p = make(edit, i, "a");
      (pagePath(edit) ? out.due : out.refused).push(p);
    });
    e.awaitOwner.forEach((edit, i) => {
      const p = make(edit, i, "p");
      if (!pagePath(edit)) out.refused.push(p);
      else if (!decided.has(p.id)) out.awaiting.push(p);
      else if (decided.get(p.id)) out.due.push(p);
    });
  });
  return out;
}

// ---- Scopes (docs/design/brain.md, "Scopes") -------------------------------------------------------
//
// Three kinds of scope. The handbook repo holds two of them: the company's pages (facts/, policies/,
// projects/<repo>) and, under teams/<teamId>/, each team's section. A brain repo is one employee's.

/** `company`, `team:<teamId>` or `brain:<employeeId>`. */
export type Scope = "company" | `team:${string}` | `brain:${string}`;

export type ScopeKind = "company" | "team" | "brain";

/** A team, as far as scopes care: who is on it. */
export interface ScopeTeam {
  id: Id;
  members: Id[];
}

/** Where a scope's pages live. */
export type RepoRef = { kind: "brain"; id: Id } | { kind: "handbook" };

const idShape = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const brainScope = (id: Id): Scope => `brain:${id}`;
export const teamScope = (id: Id): Scope => `team:${id}`;

/** Reads "team:engineering" and friends; null for anything that isn't a well-formed scope. */
export function parseScope(s: string): { kind: ScopeKind; id?: Id } | null {
  if (s === "company") return { kind: "company" };
  const m = s.match(/^(team|brain):(.+)$/);
  if (!m || !idShape.test(m[2] ?? "")) return null;
  return { kind: m[1] as "team" | "brain", id: m[2] as Id };
}

export const scopeKind = (s: Scope): ScopeKind =>
  s === "company" ? "company" : (parseScope(s)?.kind ?? "company");

/**
 * The scopes an employee may read, nearest first: their own brain, their teams' sections, the
 * company's pages. Nobody else's brain is ever in the list, so a PA's home data, which lives only in
 * its own brain, can't be read by anyone but the PA (spec §5: the errand rule).
 */
export function readableScopes(employee: Pick<Employee, "id">, teams: ScopeTeam[]): Scope[] {
  const mine = teams.filter((t) => t.members.includes(employee.id)).map((t) => teamScope(t.id));
  return [brainScope(employee.id), ...[...new Set(mine)].sort(), "company"];
}

/** Whether `employee` may read `scope`. */
export function mayRead(employee: Pick<Employee, "id">, scope: Scope, teams: ScopeTeam[]): boolean {
  return readableScopes(employee, teams).includes(scope);
}

/** The repo a scope's pages live in. */
export function repoOfScope(scope: Scope): RepoRef | null {
  const p = parseScope(scope);
  if (!p) return null;
  return p.kind === "brain" && p.id ? { kind: "brain", id: p.id } : { kind: "handbook" };
}

/**
 * Which scope a file belongs to and its slug there (the path without ".md", relative to the scope's
 * root). null for files that aren't pages: the old INDEX.md map, dotfiles, anything not markdown.
 */
export function scopeOfPath(repo: RepoRef, path: string): { scope: Scope; slug: string } | null {
  if (!path.endsWith(".md") || path.split("/").some((p) => !p || p.startsWith("."))) return null;
  // A name with a control character in it (a newline, say) can't be a page: it would break the map,
  // the line-based tools around it, and the snapshot.
  if (/\p{Cc}/u.test(path)) return null;
  const rel = path.slice(0, -3);
  if (rel === "INDEX") return null;
  if (repo.kind === "brain") return { scope: brainScope(repo.id), slug: rel };
  const m = rel.match(/^teams\/([^/]+)\/(.+)$/);
  if (m) return idShape.test(m[1] ?? "") ? { scope: teamScope(m[1] ?? ""), slug: m[2] ?? "" } : null;
  if (rel.startsWith("teams/")) return null;
  return { scope: "company", slug: rel };
}

/** The file for a slug in a scope, relative to its repo. */
export function pathOfSlug(scope: Scope, slugPath: string): string {
  const p = parseScope(scope);
  return p?.kind === "team" ? `teams/${p.id}/${slugPath}.md` : `${slugPath}.md`;
}
