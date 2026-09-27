// Brains and the handbook (spec §5, "The brain"). Employees never write knowledge directly: at the
// retro (or orientation) they propose edits, and the daemon applies them. This file is the pure
// part: where an edit may land, and which proposed edits are due or waiting for the owner.
import type { TicketEvent } from "./events.ts";
import type { Id, KnowledgeEdit } from "./model.ts";

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
  const folder = edit.layer === "fact" ? "facts" : "policies";
  const name = parts.length === 2 && parts[0] === folder ? parts[1] : parts.length === 1 ? parts[0] : null;
  return name && slug.test(name) ? `${folder}/${name}.md` : null;
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
