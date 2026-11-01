// The review pane's model: line comments, and what a file's two versions can show.
//
// Comments collect per conversation in this browser, kept across reloads the way drafts are (and forgotten with
// them at sign-out), and nothing here talks to the daemon: a comment leaves only inside the owner's next message.
import type { FileView } from "../api.ts";
import { draftMemo } from "../drafts.ts";
import { newId } from "./actions.ts";

export interface LineComment {
  id: string;
  path: string;
  /** The line's number on its side. */
  line: number;
  /** "old": a line the change removed, numbered as it was. */
  side: "new" | "old";
  /** The line as the diff showed it. */
  quote: string;
  text: string;
}

export const COMMENT_MAX = 4000;
const QUOTE_MAX = 300;
const key = (conversationId: string) => `comments:${conversationId}`;

/** Lists too big for drafts' storage cap, which stay for this page only. */
const memory = new Map<string, LineComment[]>();
const listeners = new Set<(conversationId: string) => void>();
draftMemo.onClearAll(() => memory.clear());

const isComment = (c: unknown): c is LineComment => {
  const x = c as Partial<LineComment> | null;
  return (
    typeof x?.id === "string" &&
    typeof x.path === "string" &&
    typeof x.line === "number" &&
    (x.side === "new" || x.side === "old") &&
    typeof x.quote === "string" &&
    typeof x.text === "string"
  );
};

function save(conversationId: string, list: LineComment[]): void {
  const json = list.length ? JSON.stringify(list) : "";
  draftMemo.set(key(conversationId), json);
  if (list.length && draftMemo.get(key(conversationId)) !== json) memory.set(conversationId, list);
  else memory.delete(conversationId);
  for (const fn of listeners) fn(conversationId);
}

export const reviewComments = {
  list(conversationId: string): LineComment[] {
    const held = memory.get(conversationId);
    if (held) return held;
    try {
      const parsed: unknown = JSON.parse(draftMemo.get(key(conversationId)) ?? "[]");
      return Array.isArray(parsed) ? parsed.filter(isComment) : [];
    } catch {
      return [];
    }
  },
  add(conversationId: string, c: Omit<LineComment, "id">): LineComment {
    const added = {
      ...c,
      id: newId(),
      quote: c.quote.length > QUOTE_MAX ? `${c.quote.slice(0, QUOTE_MAX)}…` : c.quote,
      text: c.text.trim().slice(0, COMMENT_MAX),
    };
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

/** The comments as the agent reads them: `path:line`, the quoted line, then the comment. */
export function commentsBlock(list: LineComment[]): string {
  if (!list.length) return "";
  const each = list.map((c) => {
    const where = `${c.path}:${c.line}${c.side === "old" ? " (removed line)" : ""}`;
    return `${where}\n> ${c.quote}\n${c.text}`;
  });
  return `Comments on the changes:\n\n${each.join("\n\n")}`;
}

/** The owner's message with the comments added after what they typed. */
export function withComments(typed: string, list: LineComment[]): string {
  return [typed.trim(), commentsBlock(list)].filter(Boolean).join("\n\n");
}

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
