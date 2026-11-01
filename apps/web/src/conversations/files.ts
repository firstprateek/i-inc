// The Files and Search tabs' model, and `@file`: the working copy's paths as a tree, what matches what is typed, and
// a file's lines. Pure, apart from the short memory of a conversation's paths. Nothing here reaches a machine by
// itself: a list that says a machine is asleep is an answer like any other.
import { api, type FilesView, type OpenFileView, type SearchHit, type SearchView } from "../api.ts";
import { draftMemo } from "../drafts.ts";
import { highlight, type Token } from "./highlight.ts";

export interface TreeNode {
  dirs: Map<string, TreeNode>;
  files: string[];
}

export interface TreeRow {
  kind: "dir" | "file";
  /** The whole path; a folder's has no trailing slash. */
  path: string;
  name: string;
  /** 1 at the top, as `aria-level` counts. */
  level: number;
}

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { dirs: new Map(), files: [] };
  for (const p of paths) {
    const parts = p.split("/");
    const name = parts.pop() ?? p;
    let at = root;
    for (const dir of parts) {
      let next = at.dirs.get(dir);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        at.dirs.set(dir, next);
      }
      at = next;
    }
    at.files.push(name);
  }
  return root;
}

/** The rows showing with these folders open: folders first, each kind by name. */
export function treeRows(root: TreeNode, open: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (node: TreeNode, prefix: string, level: number) => {
    for (const name of [...node.dirs.keys()].sort()) {
      const path = `${prefix}${name}`;
      rows.push({ kind: "dir", path, name, level });
      if (open.has(path)) walk(node.dirs.get(name) as TreeNode, `${path}/`, level + 1);
    }
    for (const name of [...node.files].sort()) {
      rows.push({ kind: "file", path: `${prefix}${name}`, name, level });
    }
  };
  walk(root, "", 1);
  return rows;
}

/** The folders on the way to a path. */
export function foldersOf(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** Paths holding `word`: those whose name starts with it first, then shorter paths. */
export function matchPaths(paths: string[], word: string): string[] {
  const w = word.toLowerCase();
  const rank = (p: string) => (baseName(p).toLowerCase().startsWith(w) ? 0 : 1);
  return paths
    .filter((p) => p.toLowerCase().includes(w))
    .map((p) => ({ p, r: rank(p) }))
    .sort((a, b) => a.r - b.r || a.p.length - b.p.length || (a.p < b.p ? -1 : 1))
    .map((x) => x.p);
}

/** How far into a message `@file` is: an `@` at the start or after a space, up to the cursor. */
export function mentionQuery(text: string, cursor: number): { word: string; start: number } | undefined {
  const upto = text.slice(0, cursor);
  const m = /(?:^|\s)@([^\s@]*)$/.exec(upto);
  if (!m) return undefined;
  const word = m[1] ?? "";
  return { word, start: upto.length - word.length - 1 };
}

const REMEMBERED_MS = 30_000;
/** A list that didn't answer is asked for again soon, but not once per key. */
const FAILED_MS = 3000;
const known = new Map<string, { at: number; for: number; list: Promise<FilesView> }>();

/** A conversation's paths, remembered for a moment: typing `@` shouldn't start a script per letter. */
export function pathsFor(conversationId: string): Promise<FilesView> {
  const hit = known.get(conversationId);
  if (hit && Date.now() - hit.at < hit.for) return hit.list;
  const list = api.files(conversationId);
  const entry = { at: Date.now(), for: REMEMBERED_MS, list };
  known.set(conversationId, entry);
  const failed = () => {
    entry.for = FAILED_MS;
  };
  void list.then((v) => {
    if (v.state !== "ok") failed();
  }, failed);
  return list;
}

/** What the agent did may have changed the files: the next `@` asks again. */
export const forgetPaths = (conversationId: string) => known.delete(conversationId);

/** What the Files and Search tabs held when the pane closed. */
export interface PaneMemo {
  filter: string;
  open: Set<string>;
  selected: string | null;
  line: number;
  reading: Record<"files" | "search", boolean>;
  query: string;
  matchCase: boolean;
  result: SearchView | undefined;
  searched: { query: string; matchCase: boolean } | undefined;
}

const MEMOS = 20;
const panes = new Map<string, PaneMemo>();
draftMemo.onClearAll(() => {
  known.clear();
  panes.clear();
});

export function rememberPane(conversationId: string, memo: PaneMemo): void {
  panes.delete(conversationId);
  panes.set(conversationId, memo);
  if (panes.size > MEMOS) panes.delete(panes.keys().next().value as string);
}

export const recallPane = (conversationId: string) => panes.get(conversationId);

/** A tool's path as a path in this conversation's copy, or null when it is anywhere else. */
export function pathInCopy(path: string, conversationId: string): string | null {
  const root = `/home/employee/work/conv-${conversationId}/`;
  const rel = path.startsWith(root) ? path.slice(root.length) : path;
  if (rel.startsWith("/") || rel.startsWith("-") || rel === "") return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
  if (/[\u0000-\u001f\u007f]/.test(rel)) return null;
  const parts = rel.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".." || p.toLowerCase() === ".git")) return null;
  return parts[0] === ".inc" ? null : rel;
}

const LANG_OF: Record<string, string> = {
  htm: "html",
  md: "plain",
  mts: "ts",
  cts: "ts",
  yml: "plain",
  yaml: "plain",
  hpp: "cpp",
};

/** The highlighter's name for a file's language; a name it doesn't know leaves the file plain. */
export function langOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return Object.hasOwn(LANG_OF, ext) ? (LANG_OF[ext] as string) : ext;
}

/** The file as lines of tokens. A token can span lines (a block comment), so it is cut at each line break. */
export function codeLines(text: string, lang: string): Token[][] {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines: Token[][] = [[]];
  for (const t of highlight(body, lang)) {
    const parts = t.s.split("\n");
    parts.forEach((s, i) => {
      if (i) lines.push([]);
      if (s) (lines.at(-1) as Token[]).push(t.t ? { t: t.t, s } : { s });
    });
  }
  return lines;
}

/** Why a file has no lines to show, or null when it has. */
export function openNote(f: Pick<OpenFileView, "side" | "withheld">): string | null {
  if (f.withheld) return "This file usually holds secrets, so it isn't shown here.";
  switch (f.side.state) {
    case "text":
      return f.side.text ? null : "This file is empty.";
    case "none":
      return "This file isn't in the working copy.";
    case "link":
      return `This is a link to ${f.side.text ?? "another file"}.`;
    case "outside":
      return "This is a link that leaves the working copy, so it isn't shown.";
    case "too-big":
      return "This file is over 1 MB, so it isn't shown.";
    case "binary":
      return "This is a binary file, so it has no lines to show.";
    default:
      return "This isn't a regular file, so it has no lines to show.";
  }
}

export interface HitGroup {
  path: string;
  hits: SearchHit[];
}

export function groupHits(hits: SearchHit[]): HitGroup[] {
  const groups = new Map<string, SearchHit[]>();
  for (const h of hits) groups.set(h.path, [...(groups.get(h.path) ?? []), h]);
  return [...groups].map(([path, list]) => ({ path, hits: list }));
}

/** A line cut into what matched and what didn't, so the match can be marked without building HTML. */
export function matchParts(text: string, query: string, matchCase: boolean): { s: string; hit: boolean }[] {
  const fold = (s: string) => (matchCase ? s : s.toLowerCase());
  const [hay, needle] = [fold(text), fold(query)];
  // Folding can change a string's length: then the places don't line up, and nothing is marked.
  if (!needle || hay.length !== text.length) return [{ s: text, hit: false }];
  const out: { s: string; hit: boolean }[] = [];
  let from = 0;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, from)) {
    if (at > from) out.push({ s: text.slice(from, at), hit: false });
    out.push({ s: text.slice(at, at + needle.length), hit: true });
    from = at + needle.length;
  }
  if (from < text.length) out.push({ s: text.slice(from), hit: false });
  return out;
}
