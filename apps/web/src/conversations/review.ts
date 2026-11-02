// The review pane's model: line comments, and what a file's two versions can show.
//
// Comments collect per conversation in this browser, kept across reloads the way drafts are (and forgotten with
// them at sign-out), and nothing here talks to the daemon: a comment leaves only inside a message.
import type { DiffRow } from "@i-inc/core";
import type { FileView } from "../api.ts";
import { draftKey, draftMemo } from "../drafts.ts";
import { newId } from "./actions.ts";

/** A line of a file on one side of the diff, and how it read. */
export interface LineSpot {
  path: string;
  /** The line's number on its side. */
  line: number;
  /** "old": a line the change removed, numbered as it was. */
  side: "new" | "old";
  /** The line as the diff showed it. */
  quote: string;
}

export interface LineComment extends LineSpot {
  id: string;
  text: string;
}

/** A comment still being written. It stays until it is added or the owner says to discard it. */
export interface LineDraft extends LineSpot {
  text: string;
}

export const COMMENT_MAX = 4000;
/** What a conversation's comments may take in storage: fifty long ones, and a reader's browser has room. */
export const COMMENTS_CAP = 200 * 1024;
const QUOTE_MAX = 300;
const COMMENTS_HEAD = "Comments on the changes:";
const key = (conversationId: string) => `comments:${conversationId}`;
const draftsKey = (conversationId: string) => `comment-drafts:${conversationId}`;

/** Lists too big for storage in full, kept whole for this page only. */
const memory = new Map<string, LineComment[]>();
/** The comments being written. Storage is only so a reload keeps them. */
const open = new Map<string, LineDraft[]>();
const listeners = new Set<(conversationId: string) => void>();
draftMemo.onClearAll(() => {
  memory.clear();
  open.clear();
});

const isSpot = (c: unknown): c is LineSpot => {
  const x = c as Partial<LineSpot> | null;
  return (
    typeof x?.path === "string" &&
    typeof x.line === "number" &&
    (x.side === "new" || x.side === "old") &&
    typeof x.quote === "string"
  );
};
const isDraft = (c: unknown): c is LineDraft => isSpot(c) && typeof (c as LineDraft).text === "string";
const isComment = (c: unknown): c is LineComment => isDraft(c) && typeof (c as LineComment).id === "string";

function stored<T>(name: string, is: (c: unknown) => c is T): T[] {
  try {
    const parsed: unknown = JSON.parse(draftMemo.get(name) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(is) : [];
  } catch {
    return [];
  }
}

const notify = (conversationId: string) => {
  for (const fn of listeners) fn(conversationId);
};

// Another tab sent or added comments: its list is the list now.
addEventListener("storage", (e) => {
  const at = draftKey(key(""));
  if (e.key?.startsWith(at)) notify(e.key.slice(at.length));
});

/** As many comments as fit are stored, the oldest first: going over the cap never loses the ones already kept. */
function save(conversationId: string, list: LineComment[]): void {
  let kept = list;
  while (kept.length && JSON.stringify(kept).length > COMMENTS_CAP) kept = kept.slice(0, -1);
  const json = kept.length ? JSON.stringify(kept) : "";
  draftMemo.set(key(conversationId), json, COMMENTS_CAP);
  const whole = kept.length === list.length && (draftMemo.get(key(conversationId)) ?? "") === json;
  if (whole) memory.delete(conversationId);
  else memory.set(conversationId, list);
  notify(conversationId);
}

export const reviewComments = {
  list(conversationId: string): LineComment[] {
    return memory.get(conversationId) ?? stored(key(conversationId), isComment);
  },
  /** How many of these comments a reload would lose: storage is full, or the list is past the cap. */
  unsaved(conversationId: string): number {
    const held = memory.get(conversationId);
    return held ? held.length - stored(key(conversationId), isComment).length : 0;
  },
  add(conversationId: string, c: Omit<LineComment, "id">): LineComment {
    const added = { ...c, id: newId(), quote: quoteOf(c.quote), text: c.text.trim().slice(0, COMMENT_MAX) };
    save(conversationId, [...reviewComments.list(conversationId), added]);
    return added;
  },
  /** Takes these out, and only these: a comment written while a message was going stays for the next one. */
  remove(conversationId: string, ids: string[]): void {
    save(
      conversationId,
      reviewComments.list(conversationId).filter((c) => !ids.includes(c.id)),
    );
  },
  subscribe(fn: (conversationId: string) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

const sameLine = (a: LineSpot, b: LineSpot) => a.path === b.path && a.side === b.side && a.line === b.line;

function keepDrafts(conversationId: string, list: LineDraft[]): void {
  open.set(conversationId, list);
  const worth = list.filter((d) => d.text.trim());
  draftMemo.set(draftsKey(conversationId), worth.length ? JSON.stringify(worth) : "", COMMENTS_CAP);
}

/** The comments being written, per conversation: they outlast picking another line or file, and closing the pane. */
export const commentDrafts = {
  list(conversationId: string): LineDraft[] {
    let list = open.get(conversationId);
    if (!list) {
      list = stored(draftsKey(conversationId), isDraft);
      open.set(conversationId, list);
    }
    return list;
  },
  /** A box on this line: the one already there, with what is in it, or an empty one. */
  start(conversationId: string, at: LineSpot): void {
    const list = commentDrafts.list(conversationId);
    if (!list.some((d) => sameLine(d, at))) keepDrafts(conversationId, [...list, { ...at, text: "" }]);
  },
  write(conversationId: string, at: LineSpot, text: string): void {
    const list = commentDrafts.list(conversationId);
    keepDrafts(
      conversationId,
      list.map((d) => (sameLine(d, at) ? { ...d, text } : d)),
    );
  },
  drop(conversationId: string, at: LineSpot): void {
    keepDrafts(
      conversationId,
      commentDrafts.list(conversationId).filter((d) => !sameLine(d, at)),
    );
  },
};

/** The line as a comment quotes it. */
export function quoteOf(text: string): string {
  const q = text.trim();
  return q.length > QUOTE_MAX ? `${q.slice(0, QUOTE_MAX)}…` : q;
}

type LineRow = Exclude<DiffRow, { kind: "gap" }>;

/** The side and number a comment on this row is about. */
export const placeOf = (r: LineRow): { side: "new" | "old"; line: number } =>
  r.kind === "del" ? { side: "old", line: r.oldNo ?? 0 } : { side: "new", line: r.newNo ?? 0 };

/**
 * Which row of a diff each comment is on now. A comment belongs to its number only while that line still reads as
 * it quoted it: after a turn moves the lines, a comment under whatever took the number would be about the wrong code.
 */
export function anchor<T extends LineSpot>(
  rows: DiffRow[],
  items: T[],
): { at: Map<number, T[]>; moved: T[] } {
  const rowAt = new Map<string, number>();
  rows.forEach((r, i) => {
    if (r.kind === "gap") return;
    const p = placeOf(r);
    rowAt.set(`${p.side}-${p.line}-${quoteOf(r.text)}`, i);
  });
  const at = new Map<number, T[]>();
  const moved: T[] = [];
  for (const c of items) {
    const i = rowAt.get(`${c.side}-${c.line}-${c.quote}`);
    if (i === undefined) moved.push(c);
    else at.set(i, [...(at.get(i) ?? []), c]);
  }
  return { at, moved };
}

/** The comments as the agent reads them: `path:line`, the quoted line, then the comment. */
export function commentsBlock(list: LineComment[]): string {
  if (!list.length) return "";
  const each = list.map((c) => {
    const where = `${c.path}:${c.line}${c.side === "old" ? " (removed line)" : ""}`;
    return `${where}\n> ${c.quote}\n${c.text}`;
  });
  return `${COMMENTS_HEAD}\n\n${each.join("\n\n")}`;
}

/** The owner's message with the comments added after what they typed. */
export function withComments(typed: string, list: LineComment[]): string {
  return [typed.trim(), commentsBlock(list)].filter(Boolean).join("\n\n");
}

/** A message that is one command: what follows it is the command's, so comments wait for the next message. */
export const isCommand = (typed: string) => /^\s*\/[A-Za-z][\w:-]*(\s|$)/.test(typed);

/** Does this queued message carry comments? Then it is all that is left of them. */
export const holdsComments = (text: string) => text.includes(`${COMMENTS_HEAD}\n\n`);

/** Why a file has no lines to show, or null when it has. */
export function fileNote(f: Pick<FileView, "before" | "after" | "withheld">): string | null {
  if (f.withheld) return "This file usually holds secrets, so it isn't shown here.";
  const states = [f.before.state, f.after.state];
  if (states.includes("outside")) return "This is a link that leaves the working copy, so it isn't shown.";
  if (states.includes("too-big")) return "This file is over 1 MB, so it isn't shown.";
  if (states.includes("binary")) return "This is a binary file, so it has no lines to show.";
  if (states.includes("other")) return "This isn't a regular file, so it has no lines to show.";
  return null;
}
