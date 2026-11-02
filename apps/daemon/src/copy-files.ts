// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell scripts, not templates
// The Files and Search tabs' reads (docs/design/conversations.md, "Files"): everything in a conversation's working
// copy, one file as it is on disk, and a literal search of what the viewer would show. The same rules as the review's
// reads (copy-read.ts): nothing in the copy is written, what comes back is believed for nothing, and no machine is booted.
import {
  check,
  diskSide,
  enter,
  fenced,
  isReviewPath,
  LIST_LIMIT,
  MAX_FILE_BYTES,
  open,
  type ReviewCopy,
  readSides,
  scratchIndex,
  servedNever,
  sideOf,
} from "./copy-read.ts";
import { marker, quote, section } from "./ship-git.ts";
import type { FileSide, SearchHit } from "./view-types.ts";

/** The most files listed. The web app holds them all, so a list stays fast. */
export const MAX_TREE = 20_000;
export const MAX_QUERY = 200;
/** The most lines a search returns, and from one file: a word in every line of a log says nothing more at 20. */
export const MAX_HITS = 500;
export const MAX_FILE_HITS = 20;
/** The most files, and bytes of them, a search brings out to look through. */
export const MAX_SEARCH_FILES = 200;
export const SEARCH_BYTES = 6_000_000;
/** The characters of a line shown. */
export const LINE_SHOWN = 400;
/** How much memory a search may use, in KiB: git holds each file it reads, and this runs beside the agent's turn. */
const SEARCH_MEMORY_KB = 2_097_152;
/** A folder with no `.gitignore` to speak for it is walked this deep, and its dependencies aren't. */
const FIND_DEPTH = 24;

const NOT_WALKED = ["node_modules"];
/** Where a repository's paths stop: `.inc` holds the owner's images, which are never part of the work. */
const HERE = "-- . ':(exclude).inc'";

export interface FilesListing {
  present: boolean;
  paths: string[];
  skipped: number;
  truncated: boolean;
  /** Something in the folder couldn't be read, so the list may be missing files. */
  partial: boolean;
}

export interface SearchListing {
  present: boolean;
  hits: SearchHit[];
  truncated: boolean;
  /** Something in the folder couldn't be read, so there may be more. */
  partial: boolean;
}

const checkNonce = (nonce: string) => {
  if (!/^[0-9a-f]{16,64}$/.test(nonce)) throw new Error("not a nonce");
};

/** What may be searched for: a line of words, not a script or a whole file. */
export function isSearchQuery(q: unknown): q is string {
  if (typeof q !== "string" || q.trim() === "" || q.length > MAX_QUERY) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
  return !/[\u0000-\u001f\u007f\uffff]/.test(q);
}

/**
 * The files. In a repository: what the commit tracks and what is new, by the scratch index, less what has gone from
 * the folder. With no commit to go on: a bounded `find`. Links are listed and not followed. What is behind a folder that
 * can't be entered is missing either way, tracked files too, so the list says it may be.
 */
export function treeScript(copy: ReviewCopy, nonce: string): string {
  check(copy);
  checkNonce(nonce);
  const fail = "{ echo '@@fail the list could not be read'; exit 1; }";
  const prune = [...NOT_WALKED, ".git"].map((n) => `-name ${n}`).join(" -o ");
  return [
    ...open(copy),
    ...scratchIndex(fail),
    ': > "$W/tracked"; : > "$W/gone"',
    'if [ -n "$head" ]; then',
    `  G ls-files -z -c ${HERE} > "$W/tracked" || ${fail}`,
    `  G ls-files -z -d ${HERE} > "$W/gone" 2>> "$W/said" || ${fail}`,
    `  G ls-files -z -o --exclude-standard ${HERE} > "$W/new" 2>> "$W/said" || ${fail}`,
    // Git passes over a folder it can't enter with a warning and a good exit status.
    `  ! grep -q -E 'could not open|cannot lstat' "$W/said" || echo ${marker(nonce, "partial")}`,
    "else",
    `  find . -maxdepth ${FIND_DEPTH} \\( ${prune} -o -path ./.inc \\) -prune -o \\( -type f -o -type l \\) -print0 | head -c ${LIST_LIMIT + 1} > "$W/new"; p=("\${PIPESTATUS[@]}")`,
    // 1: a folder it couldn't read. 141: the cap closed the pipe. Anything else, and an empty list would be a lie.
    `  [ "\${p[1]}" -eq 0 ] || ${fail}`,
    `  case "\${p[0]}" in 0) ;; 1) echo ${marker(nonce, "partial")} ;; 141) [ "$(wc -c < "$W/new")" -gt ${LIST_LIMIT} ] || ${fail} ;; *) ${fail} ;; esac`,
    "fi",
    ...fenced(nonce, "tracked"),
    ...fenced(nonce, "gone"),
    ...fenced(nonce, "new"),
    `echo ${marker(nonce, "done")}`,
  ].join("\n");
}

/** One file as it is on disk, base64 so any bytes survive. No repository is needed for that. */
export function fileScript(copy: ReviewCopy, path: string, nonce: string): string {
  check(copy);
  if (!isReviewPath(path)) throw new Error("not a path in the copy");
  checkNonce(nonce);
  return [
    ...enter(copy),
    `P=${quote(path)}`,
    ...diskSide(marker(nonce, "after")),
    `echo ${marker(nonce, "done")}`,
  ].join("\n");
}

/**
 * A literal search, in two steps. `git grep -F --untracked` over the folder, in the scratch repository so nothing of the
 * copy's runs, or a bounded `grep` with no commit, only says which files may hold the query. `--untracked` looks at the
 * folder and not an index, so it follows no link to a folder, and leaves out what `.gitignore` does, tracked or not. The query is one
 * quoted word after `-e`, so it can't be a flag or a pattern. Then each of those files comes out as the viewer would
 * read it, and `readSearch` looks in the text the viewer would show. A file is what is redacted, never a line of one:
 * a value can sit lines from its label, and a key has nothing near it at all, so what search shows can't be other
 * than what the viewer shows. Binary files aren't looked in, and a pipe or a link isn't opened.
 */
export function searchScript(copy: ReviewCopy, query: string, matchCase: boolean, nonce: string): string {
  check(copy);
  if (!isSearchQuery(query)) throw new Error("not something to search for");
  checkNonce(nonce);
  const fail = "{ echo '@@fail the search could not be run'; exit 1; }";
  const m = (name: string) => marker(nonce, name);
  const fold = matchCase ? "" : "-i ";
  const limit = `ulimit -v ${SEARCH_MEMORY_KB} 2>/dev/null`;
  const skip = ["node_modules", ".git", ".inc"].map((d) => `--exclude-dir=${d}`).join(" ");
  return [
    ...open(copy),
    ...scratchIndex(fail),
    'if [ -n "$head" ]; then',
    // `-I` goes by what the file holds, not by what the copy's attributes say it is.
    `  mkdir -p "$W/repo/info"; echo '* !diff' > "$W/repo/info/attributes"`,
    `  ( ${limit}; G grep -I -l -z --threads=2 --untracked ${fold}-F -e ${quote(query)} ${HERE} ) > "$W/found" 2> "$W/said"; s=$?`,
    `  case "$s" in 0|1) ;; *) ${fail} ;; esac`,
    // Git carries on past a file it can't read, and only says so.
    `  ! grep -q -E 'failed to|could not open|Permission denied' "$W/said" || echo ${m("partial")}`,
    "else",
    `  ( ${limit}; LC_ALL=C.UTF-8 grep -r -l -I -s -D skip --null ${skip} ${fold}-F -e ${quote(query)} . ) > "$W/found"; s=$?`,
    // 2: a file it couldn't read, which grep says while it carries on; what it could read is there.
    `  case "$s" in 0|1) ;; 2) echo ${m("partial")} ;; *) ${fail} ;; esac`,
    "fi",
    `[ -f "$W/found" ] || ${fail}`,
    `echo ${m("files-begin")}`,
    "n=0; t=0; root=$(pwd -P)",
    "while IFS= read -r -d '' f; do",
    '  [ -f "./$f" ] && [ ! -L "./$f" ] || continue',
    // The folder may have become a link since grep went through it.
    `  d=$(cd -P -- "$(dirname -- "./$f")" 2>/dev/null && pwd -P || true)`,
    `  case "$d/" in "$root/.git/"* | "$root/"*"/.git/"* | "$root/.inc/"*) continue ;; "$root/"*) ;; *) continue ;; esac`,
    `  z=$(wc -c < "./$f" | tr -d ' ')`,
    `  [ -n "$z" ] || { echo ${m("partial")}; continue; }`,
    `  [ "$z" -le ${MAX_FILE_BYTES} ] || continue`,
    `  n=$((n + 1)); t=$((t + z))`,
    `  if [ "$n" -gt ${MAX_SEARCH_FILES} ] || [ "$t" -gt ${SEARCH_BYTES} ]; then echo ${m("cut")}; break; fi`,
    `  echo "${m("file")} $(printf %s "$f" | base64 | tr -d '\\n')"`,
    `  head -c ${MAX_FILE_BYTES + 1} < "./$f" | base64; p=("\${PIPESTATUS[@]}")`,
    `  [ "\${p[0]}" -eq 0 ] && [ "\${p[1]}" -eq 0 ] || echo ${m("partial")}`,
    'done < "$W/found"',
    "echo",
    `echo ${m("files-end")}`,
    `echo ${m("done")}`,
  ].join("\n");
}

/** A name as a tool wrote it: `find` and `grep` start theirs with `./`. */
const named = (p: string) => (p.startsWith("./") ? p.slice(2) : p);

/** Reads `treeScript`'s output. A name it can't show is left out and counted, never passed on. */
export function readTree(output: string, nonce: string): FilesListing {
  const done = output.includes(marker(nonce, "done"));
  if (/^@@nocopy$/m.test(output) && !done) {
    return { present: false, paths: [], skipped: 0, truncated: false, partial: false };
  }
  const [tracked, gone, added] = ["tracked", "gone", "new"].map((n) => section(output, nonce, n));
  if (tracked === undefined || gone === undefined || added === undefined || !done) {
    throw new Error("the list could not be read");
  }
  const rows = (s: string) => s.split("\0").slice(0, -1).map(named);
  const away = new Set(rows(gone));
  const seen = new Set<string>();
  let skipped = 0;
  for (const p of [...rows(tracked), ...rows(added)]) {
    // A name ending in `/` is a nested repository, not a file.
    if (away.has(p) || p.endsWith("/")) continue;
    if (isReviewPath(p)) seen.add(p);
    else skipped++;
  }
  const paths = [...seen].sort();
  return {
    present: true,
    paths: paths.slice(0, MAX_TREE),
    skipped,
    truncated: output.includes(marker(nonce, "cut")) || paths.length > MAX_TREE,
    partial: output.includes(marker(nonce, "partial")),
  };
}

/** Reads `fileScript`'s output: the file, or null when the copy isn't there. */
export function readOpenFile(output: string, nonce: string, path: string): FileSide | null {
  if (!output.includes(marker(nonce, "done"))) {
    if (/^@@nocopy$/m.test(output)) return null;
    throw new Error("the file could not be read");
  }
  const { after } = readSides(output, nonce, path);
  if (!after) throw new Error("the file could not be read");
  return after;
}

const MASK = "\uffff";

/** The part of a line shown from `from`, with its edges off any pair of surrogates. */
function excerpt(line: string, from: number): string {
  const low = (i: number) => /[\udc00-\udfff]/.test(line[i] ?? "");
  const start = from > 0 && low(from) ? from + 1 : from;
  const end =
    start + LINE_SHOWN < line.length && low(start + LINE_SHOWN) ? start + LINE_SHOWN - 1 : start + LINE_SHOWN;
  return `${start ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
}

/** The hits in a text as the viewer would show it, at most what one file may have, and whether there were more. */
function hitsIn(path: string, text: string, match: RegExp): { hits: SearchHit[]; more: boolean } {
  // What redaction put there isn't in the file: a query that finds it would tell what kind of thing went.
  const seen = text.replace(/\[redacted\]|\[private key\]/g, (w) => MASK.repeat(w.length));
  const lines = text.split("\n");
  const looked = seen.split("\n");
  const hits: SearchHit[] = [];
  for (let i = 0; i < looked.length; i++) {
    const at = match.exec(looked[i] ?? "");
    if (!at) continue;
    if (hits.length === MAX_FILE_HITS) return { hits, more: true };
    const line = (lines[i] ?? "").replace(/\r$/, "");
    const from = at.index + at[0].length > LINE_SHOWN ? Math.max(0, at.index - 100) : 0;
    hits.push({ path, line: i + 1, text: excerpt(line, from) });
  }
  return { hits, more: false };
}

/**
 * Reads `searchScript`'s output: each file by its name in base64, then its bytes. A file no name-based rule lets out,
 * or with no text to show, is passed over, and nothing counts those: a count that moved with the query would tell what
 * is hidden, a letter at a time.
 */
export function readSearch(output: string, nonce: string, query: string, matchCase: boolean): SearchListing {
  const done = output.includes(marker(nonce, "done"));
  const empty = { hits: [], truncated: false, partial: false };
  if (/^@@nocopy$/m.test(output) && !done) return { present: false, ...empty };
  const body = section(output, nonce, "files");
  if (body === undefined || !done) throw new Error("the search could not be read");
  const words = query.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
  const match = new RegExp(words, matchCase ? "u" : "iu");
  const files = new Map<string, FileSide>();
  const head = `${marker(nonce, "file")} `;
  let at: { name: string; b64: string[] } | undefined;
  const close = () => {
    if (!at) return;
    const path = named(Buffer.from(at.name, "base64").toString("utf8"));
    if (isReviewPath(path) && !servedNever(path)) files.set(path, sideOf(at.b64.join("")));
    at = undefined;
  };
  // A note can fall after a file's last line: it isn't part of the file.
  const notes = new Set([marker(nonce, "cut"), marker(nonce, "partial")]);
  for (const line of body.split("\n")) {
    if (line.startsWith(head)) {
      close();
      at = { name: line.slice(head.length), b64: [] };
    } else if (!notes.has(line)) at?.b64.push(line);
  }
  close();
  let truncated = output.includes(marker(nonce, "cut"));
  const hits: SearchHit[] = [];
  for (const [path, side] of [...files].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (side.text === undefined) continue;
    const found = hitsIn(path, side.text, match);
    if (found.more || hits.length + found.hits.length > MAX_HITS) truncated = true;
    hits.push(...found.hits.slice(0, MAX_HITS - hits.length));
  }
  return { present: true, hits, truncated, partial: output.includes(marker(nonce, "partial")) };
}
