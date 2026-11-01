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
} from "./copy-read.ts";
import { marker, quote, redactFile, secretFile, section } from "./ship-git.ts";
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
/** A folder with no `.gitignore` to speak for it is walked this deep, and its dependencies aren't. */
const FIND_DEPTH = 24;

const NOT_WALKED = ["node_modules"];
/** Where a repository's paths stop: `.inc` holds the owner's images, which are never part of the work. */
const HERE = "-- . ':(exclude).inc'";
/**
 * Files whose secrets a single line can't show: a key's body or a `.netrc` login's password has nothing on its own
 * line for redaction to go on. A line from one of these is never returned.
 */
const SPREAD_SECRET =
  "PRIVATE KEY|^[[:space:]]*machine[[:space:]]+[^[:space:]]+([[:space:]]+login[[:space:]]+[^[:space:]]+)?[[:space:]]*$";

export interface FilesListing {
  present: boolean;
  paths: string[];
  skipped: number;
  truncated: boolean;
}

export interface SearchListing {
  present: boolean;
  hits: SearchHit[];
  skipped: number;
  withheld: number;
  truncated: boolean;
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
    `  find . -maxdepth ${FIND_DEPTH} \\( ${prune} -o -path ./.inc \\) -prune -o \\( -type f -o -type l \\) -print0 | head -c ${LIST_LIMIT + 1} > "$W/new"`,
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
  const skip = ["node_modules", ".git", ".inc"].map((d) => `--exclude-dir=${d}`).join(" ");
  const short = `LC_ALL=C cut -b 1-${LINE_BYTES}`;
  const cap = `head -c ${SEARCH_LIMIT + 1}`;
  const plain = `grep -r -n -I -s -D skip --null ${skip}`;
  return [
    ...open(copy),
    ...scratchIndex(fail),
    'if [ -n "$head" ]; then',
    `  G grep -I -n -z --untracked ${fold}-F -e ${quote(query)} ${HERE} | ${short} | ${cap} > "$W/hits"; s=\${PIPESTATUS[0]}`,
    `  G grep -I -l -z --untracked -E -e ${quote(SPREAD_SECRET)} ${HERE} > "$W/keys"; k=$?`,
    "else",
    `  ${plain} ${fold}-F -e ${quote(query)} . | ${short} | ${cap} > "$W/hits"; s=\${PIPESTATUS[0]}`,
    `  ${plain} -l -E -e ${quote(SPREAD_SECRET)} . > "$W/keys"; k=$?`,
    "fi",
    // 0: found. 1: nothing found. 141: the cap closed the pipe. Anything else, and "nothing found" would be a lie.
    `case "$s" in 0|1|141) ;; *) ${fail} ;; esac`,
    `case "$k" in 0|1) ;; *) ${fail} ;; esac`,
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
  if (/^@@nocopy$/m.test(output) && !done) return { present: false, paths: [], skipped: 0, truncated: false };
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

/** The line, redacted and cut around the match, or null when the match itself can't be shown. */
function excerpt(line: string, query: string, matchCase: boolean): string | null {
  const text = redactFile(line.replace(/\r$/, ""));
  const fold = (s: string) => (matchCase ? s : s.toLowerCase());
  const at = fold(text).indexOf(fold(query));
  // Gone in redaction or past the cut: to say the line holds it would tell what is hidden, a letter at a time.
  if (at < 0) return null;
  const from = at + query.length > LINE_SHOWN ? Math.max(0, at - 100) : 0;
  const cut = text.slice(from, from + LINE_SHOWN);
  return `${from ? "…" : ""}${cut}${from + LINE_SHOWN < text.length ? "…" : ""}`;
}

/** Reads `searchScript`'s output, one row a line: `path NUL number NUL text`, or `path NUL number:text` from `grep`. */
export function readSearch(output: string, nonce: string, query: string, matchCase: boolean): SearchListing {
  const done = output.includes(marker(nonce, "done"));
  const empty = { hits: [], skipped: 0, withheld: 0, truncated: false };
  if (/^@@nocopy$/m.test(output) && !done) return { present: false, ...empty };
  const found = section(output, nonce, "hits");
  const keys = section(output, nonce, "keys");
  if (found === undefined || keys === undefined || !done) throw new Error("the search could not be read");
  const spread = new Set(keys.split(/[\0\n]/).map(named));
  let truncated = output.includes(marker(nonce, "cut"));
  const hits: SearchHit[] = [];
  const perFile = new Map<string, number>();
  let skipped = 0;
  let withheld = 0;
  // What follows the last newline is a row the cap cut in two.
  for (const row of found.split("\n").slice(0, -1)) {
    const m = /^([^\0]+)\0(\d+)[\0:]([\s\S]*)$/.exec(row);
    if (!m) continue;
    const path = named(m[1] ?? "");
    if (!isReviewPath(path)) {
      skipped++;
      continue;
    }
    if (spread.has(path) || secretFile.some((re) => re.test(path))) {
      withheld++;
      continue;
    }
    const text = excerpt(m[3] ?? "", query, matchCase);
    if (text === null) {
      withheld++;
      continue;
    }
    const n = perFile.get(path) ?? 0;
    if (n >= MAX_FILE_HITS || hits.length >= MAX_HITS) {
      truncated = true;
      if (hits.length >= MAX_HITS) break;
      continue;
    }
    perFile.set(path, n + 1);
    hits.push({ path, line: Number(m[2]), text });
  }
  return { present: true, hits, skipped, withheld, truncated };
}
