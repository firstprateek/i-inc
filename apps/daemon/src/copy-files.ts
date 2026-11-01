// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell scripts, not templates
// The Files and Search tabs' reads (docs/design/conversations.md, "Files"): everything in a conversation's working
// copy, one file as it is on disk, and a literal search of its contents. The same rules as the review's reads
// (copy-read.ts): nothing in the copy is written, what comes back is believed for nothing, and no machine is booted.
import {
  check,
  diskSide,
  enter,
  fenced,
  isReviewPath,
  LIST_LIMIT,
  open,
  type ReviewCopy,
  readSides,
  scratchIndex,
  servedNever,
} from "./copy-read.ts";
import { marker, quote, redactFile, section } from "./ship-git.ts";
import type { FileSide, SearchHit } from "./view-types.ts";

/** The most files listed. The web app holds them all, so a list stays fast. */
export const MAX_TREE = 20_000;
export const MAX_QUERY = 200;
/** The most lines a search returns, and from one file: a word in every line of a log says nothing more at 20. */
export const MAX_HITS = 500;
export const MAX_FILE_HITS = 20;
/** How much of a search's output is read, and how much of any line: one minified line can't use it all up. */
const SEARCH_LIMIT = 1_000_000;
const LINE_BYTES = 2000;
/** The characters of a line shown. */
export const LINE_SHOWN = 400;
/**
 * The lines read before each match. A value can sit on the line after its label (`aws_secret_access_key:` in YAML),
 * so a line alone can't always be redacted.
 */
const CONTEXT_LINES = 2;
/** What goes from the end of a line that was cut, since a credential the cut split matches no pattern. */
const CUT_MARGIN = 512;
/** How much memory a search may use, in KiB: git holds each file it reads, and this runs beside the agent's turn. */
const SEARCH_MEMORY_KB = 2_097_152;
/** A folder with no `.gitignore` to speak for it is walked this deep, and its dependencies aren't. */
const FIND_DEPTH = 24;

const NOT_WALKED = ["node_modules"];
/** Where a repository's paths stop: `.inc` holds the owner's images, which are never part of the work. */
const HERE = "-- . ':(exclude).inc'";
/**
 * Files that aren't searched, whatever is asked: a key's body or a `.netrc` login's password has nothing near it for
 * redaction to go on. Which files these are depends on nothing typed, so the count of them says nothing about a query.
 */
const SPREAD_SECRET =
  "PRIVATE KEY|^[[:space:]]*machine[[:space:]]+[^[:space:]]+([[:space:]]+login[[:space:]]+[^[:space:]]+)?[[:space:]]*$";

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
  skipped: number;
  /** Files not searched, for what they hold. */
  withheld: number;
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
  return !/[\u0000-\u001f\u007f]/.test(q);
}

/**
 * The files. In a repository: what the commit tracks and what is new, by the scratch index, less what has gone from
 * the folder. With no commit to go on: a bounded `find`. Links are listed and not followed.
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
    `  G ls-files -z -d ${HERE} > "$W/gone" || ${fail}`,
    `  G ls-files -z -o --exclude-standard ${HERE} > "$W/new" || ${fail}`,
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
 * A literal search. In a repository: `git grep -F` over the folder, tracked and new, with the scratch index and its
 * empty config, so nothing of the copy's runs; otherwise a bounded `grep`. The query is one quoted word after `-e`,
 * so it can't be a flag or a pattern. Binary files aren't looked in, and a pipe or a link isn't opened.
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
  const short = `LC_ALL=C cut -b 1-${LINE_BYTES}`;
  const cap = `head -c ${SEARCH_LIMIT + 1}`;
  const plain = `grep -r -I -s -D skip --null ${skip}`;
  const context = `-n -B ${CONTEXT_LINES}`;
  return [
    ...open(copy),
    ...scratchIndex(fail),
    // Every step of the pipe is looked at: a `cut` that dies leaves git with a closed pipe, and no matches to show.
    "seen() {",
    `  [ "$3" -eq 0 ] && { [ "$2" -eq 0 ] || [ "$2" -eq 141 ]; } || ${fail}`,
    `  case "$1" in 0|1) [ "$2" -eq 0 ] || ${fail} ;; 141) [ "$(wc -c < "$W/hits")" -gt ${SEARCH_LIMIT} ] || ${fail} ;; *) ${fail} ;; esac`,
    "}",
    'if [ -n "$head" ]; then',
    `  ( ${limit}; G grep -I -z --threads=2 --untracked ${context} ${fold}-F -e ${quote(query)} ${HERE} ) | ${short} | ${cap} > "$W/hits"; p=("\${PIPESTATUS[@]}")`,
    `  ( ${limit}; G grep --text -l -z --threads=2 --untracked -E -e ${quote(SPREAD_SECRET)} ${HERE} ) > "$W/keys"; k=$?`,
    '  seen "${p[0]}" "${p[1]}" "${p[2]}"',
    `  case "$k" in 0|1) ;; *) ${fail} ;; esac`,
    "else",
    `  ${plain} ${context} ${fold}-F -e ${quote(query)} . | ${short} | ${cap} > "$W/hits"; p=("\${PIPESTATUS[@]}")`,
    `  ${plain.replace(" -I", " -a")} -l -E -e ${quote(SPREAD_SECRET)} . > "$W/keys"; k=$?`,
    // 2: a file it couldn't read, which grep says while it carries on; what it could read is there.
    `  [ "\${p[0]}" -ne 2 ] || { echo ${m("partial")}; p[0]=0; }`,
    '  seen "${p[0]}" "${p[1]}" "${p[2]}"',
    `  case "$k" in 0|1|2) ;; *) ${fail} ;; esac`,
    "fi",
    // A list of what mustn't be searched that doesn't fit is no list: the search fails rather than show those files.
    `[ "$(wc -c < "$W/keys")" -le ${LIST_LIMIT} ] || ${fail}`,
    `[ "$(wc -c < "$W/hits")" -le ${SEARCH_LIMIT} ] || echo ${m("cut")}`,
    `echo ${m("hits-begin")}`,
    `head -c ${SEARCH_LIMIT} "$W/hits"`,
    "echo",
    `echo ${m("hits-end")}`,
    ...fenced(nonce, "keys"),
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

interface ReadLine {
  text: string;
  /** The cut took the end of it. */
  cut: boolean;
}

/**
 * The rows of a search's output, by file and line number: `path NUL number NUL text` from git, `path NUL number:text`
 * or `-text` from grep, with `--` between runs. Text has no newline in it, but a name can: one that has is left out
 * and counted. What follows the last newline is a row the cap cut in two.
 */
function readRows(found: string): { files: Map<string, Map<number, ReadLine>>; skipped: number } {
  const files = new Map<string, Map<number, ReadLine>>();
  let skipped = 0;
  let from = 0;
  for (;;) {
    const nul = found.indexOf("\0", from);
    const end = nul < 0 ? -1 : found.indexOf("\n", nul);
    if (end < 0) break;
    const name = found.slice(from, nul).replace(/^(?:--\n)+/, "");
    const m = /^(\d+)[\0:-]([\s\S]*)$/.exec(found.slice(nul + 1, end));
    const bytes = Buffer.byteLength(found.slice(from, end));
    from = end + 1;
    if (!m) continue;
    const path = named(name);
    if (!isReviewPath(path)) {
      skipped++;
      continue;
    }
    const lines = files.get(path) ?? new Map<number, ReadLine>();
    files.set(path, lines);
    lines.set(Number(m[1]), { text: (m[2] ?? "").replace(/\r$/, ""), cut: bytes >= LINE_BYTES });
  }
  return { files, skipped };
}

/** A line that was cut, less its end: what the cut split has no pattern left to match, so it can't be shown. */
const uncut = (l: ReadLine) =>
  l.cut ? l.text.slice(0, -CUT_MARGIN).replace(/[^\s"'`,;()<>]*$/, "") : l.text;

/**
 * The line to show, redacted and cut around the match, or null when it can't be shown: the match has gone with what
 * was taken out, or redaction reaches this line from the lines before it. To count such a line would tell what is
 * hidden, a letter at a time, so nothing does.
 */
function excerpt(
  lines: Map<number, ReadLine>,
  n: number,
  line: ReadLine,
  query: string,
  matchCase: boolean,
): string | null {
  // A NUL means a binary file got past `-I`.
  if (line.text.includes("\0")) return null;
  const own = uncut(line);
  const before: string[] = [];
  for (let i = n - 1; i >= n - CONTEXT_LINES && lines.has(i); i--)
    before.unshift(uncut(lines.get(i) as ReadLine));
  const text = redactFile(own);
  if (before.length) {
    const lead = before.join("\n");
    if (redactFile(`${lead}\n${own}`) !== `${redactFile(lead)}\n${text}`) return null;
  }
  const fold = (s: string) => (matchCase ? s : s.toLowerCase());
  const at = fold(text).indexOf(fold(query));
  if (at < 0) return null;
  const from = at + query.length > LINE_SHOWN ? Math.max(0, at - 100) : 0;
  const shown = text.slice(from, from + LINE_SHOWN);
  return `${from ? "…" : ""}${shown}${from + LINE_SHOWN < text.length ? "…" : ""}`;
}

/** Reads `searchScript`'s output. Git doesn't mark which rows matched, so a row is a match if it shows the query. */
export function readSearch(output: string, nonce: string, query: string, matchCase: boolean): SearchListing {
  const done = output.includes(marker(nonce, "done"));
  const empty = { hits: [], skipped: 0, withheld: 0, truncated: false, partial: false };
  if (/^@@nocopy$/m.test(output) && !done) return { present: false, ...empty };
  const found = section(output, nonce, "hits");
  const keys = section(output, nonce, "keys");
  if (found === undefined || keys === undefined || !done) throw new Error("the search could not be read");
  const spread = new Set(
    keys
      .split(/[\0\n]/)
      .filter(Boolean)
      .map(named),
  );
  const { files, skipped } = readRows(found);
  let truncated = output.includes(marker(nonce, "cut"));
  const hits: SearchHit[] = [];
  for (const [path, lines] of files) {
    if (spread.has(path) || servedNever(path)) continue;
    let inFile = 0;
    for (const [n, line] of [...lines].sort((a, b) => a[0] - b[0])) {
      const text = excerpt(lines, n, line, query, matchCase);
      if (text === null) continue;
      if (inFile >= MAX_FILE_HITS || hits.length >= MAX_HITS) {
        truncated = true;
        break;
      }
      inFile++;
      hits.push({ path, line: n, text });
    }
  }
  return {
    present: true,
    hits,
    skipped,
    withheld: spread.size,
    truncated,
    partial: output.includes(marker(nonce, "partial")),
  };
}
