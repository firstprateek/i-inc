// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell scripts, not templates
// What every read of a conversation's working copy shares (docs/design/conversations.md, "Review" and "Files"): which
// paths may be touched, how a script gets into the copy with nothing of its index, config or hooks, and how a file on
// disk becomes something to show. What comes back was written by whatever runs in the sandbox, so nothing is believed.
import { posix } from "node:path";
import { redactTokens } from "./ahp/sanitize.ts";
import { marker, quote, redactFile, safeGit } from "./ship-git.ts";
import type { FileSide } from "./view-types.ts";
import { isSafeRefName, isSafeWorkDir } from "./workspace.ts";

/** The biggest file shown: `redactTokens` stops at a million characters, and a bigger file is no use in a diff. */
export const MAX_FILE_BYTES = 1_000_000;
/** The most text the list reads per section; past it the list says it is cut. */
export const LIST_LIMIT = 2_000_000;
export const MAX_PATH = 1024;

/** A conversation's working copy. `base` is the project's main; null: no project, an empty folder that is no repo. */
export interface ReviewCopy {
  employeeId: string;
  cwd: string;
  base: string | null;
  machine?: string;
}

/**
 * A path the review will touch: relative, no `..`, no leading `-`, no control characters, nothing a token could be
 * hiding in, and not in `.git` or `.inc` (the owner's images, which are never part of the work).
 */
export function isReviewPath(path: unknown): path is string {
  if (typeof path !== "string" || path === "" || path.length > MAX_PATH) return false;
  if (path.startsWith("/") || path.startsWith("-") || path.includes("�")) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return false;
  if (parts[0] === ".inc" || parts.some((p) => p.toLowerCase() === ".git")) return false;
  return redactTokens(path) === path;
}

export function check(copy: ReviewCopy): void {
  if (!isSafeWorkDir(copy.cwd)) throw new Error(`not a safe folder: ${String(copy.cwd)}`);
  if (copy.base !== null && !isSafeRefName(copy.base)) throw new Error(`not a branch name: ${copy.base}`);
}

/** How many times the list tries to add the files while they keep going away under it. */
export const LIST_TRIES = 3;

/**
 * Into the copy, with `G` ready and `$mb` set to what the change is measured from: where the branch left main, by
 * the refs already in the machine (never a fetch), or the first commit when they are gone. With no commit to measure
 * from (no project, or a copy with no commits or no repository) a scratch repository outside the folder looks at it,
 * `$mb` is the empty tree, `$head` is empty and every file there is new. Optional locks and lazy fetches are off:
 * reading must not write or reach out. Git's warnings go nowhere: output is what the script says, and a warning
 * in the middle of a section would pass for part of it.
 */
export const open = (copy: ReviewCopy): string[] => {
  const scratch = [
    `W=$(mktemp -d); trap 'rm -rf "$W"' EXIT; mkdir "$W/home"`,
    'BE=(env -i PATH="$PATH" LANG=C.UTF-8 HOME="$W/home" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 GIT_NO_LAZY_FETCH=1)',
    '"${BE[@]}" git init --bare -q --template= "$W/repo" || { echo \'@@fail could not make a scratch repository\'; exit 1; }',
    'GX=(GIT_DIR="$W/repo" GIT_WORK_TREE="$PWD")',
    'G() { "${BE[@]}" "${GX[@]}" git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.pager=cat "$@"; }',
    "mb=$(G hash-object -t tree -w --stdin < /dev/null)",
    'head=""',
  ];
  if (copy.base === null) return [...enter(copy), ...scratch];
  const base = copy.base;
  return [
    ...enter(copy),
    "if env -i PATH=\"$PATH\" HOME=/nonexistent GIT_CONFIG_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 GIT_OPTIONAL_LOCKS=0 git -c core.hooksPath=/dev/null -c core.fsmonitor=false rev-parse --verify --quiet 'HEAD^{commit}' >/dev/null; then",
    ...safeGit(copy),
    "GX=(GIT_OPTIONAL_LOCKS=0 GIT_NO_LAZY_FETCH=1)",
    "head=$(G rev-parse --verify --quiet 'HEAD^{commit}') || { echo '@@fail the working copy has no commit'; exit 1; }",
    `b=$(G rev-parse --verify --quiet ${quote(`refs/remotes/origin/${base}^{commit}`)} || G rev-parse --verify --quiet ${quote(`refs/heads/${base}^{commit}`)} || true)`,
    'if [ -n "$b" ]; then mb=$(G merge-base "$b" "$head" || echo "$b"); else mb=$(G rev-list --max-parents=0 "$head" | tail -n 1); fi',
    "else",
    ...scratch,
    "fi",
  ];
};

/** Into the copy, or a line saying it isn't there. Git's warnings and the like go nowhere: see `open`. */
export const enter = (copy: ReviewCopy): string[] => [
  "set -u",
  "exec 2>/dev/null",
  `[ -d ${quote(copy.cwd)} ] || { echo @@nocopy; exit 0; }`,
  `cd ${quote(copy.cwd)} || { echo @@nocopy; exit 0; }`,
];

/**
 * After `open`, with a commit to work from: a scratch index holding `$head`, so what git says about the folder rests
 * on content and on `.gitignore`, not on the copy's index, config or excludes. `O` runs a command that needs the
 * copy's objects, which stay out of sight of anything that writes.
 */
export const scratchIndex = (fail: string): string[] => [
  'O() { "$@"; }',
  'if [ -n "$head" ]; then',
  "  o=$(G rev-parse --path-format=absolute --git-common-dir)/objects",
  '  "${BE[@]}" GIT_CONFIG_GLOBAL=/dev/null git init --bare -q --template= "$W/repo" || { echo \'@@fail could not make a scratch repository\'; exit 1; }',
  '  GX=(GIT_DIR="$W/repo" GIT_WORK_TREE="$PWD" GIT_CONFIG_GLOBAL=/dev/null GIT_OPTIONAL_LOCKS=0 GIT_NO_LAZY_FETCH=1)',
  '  O() { local GX=("${GX[@]}" GIT_ALTERNATE_OBJECT_DIRECTORIES="$o"); "$@"; }',
  `  O G read-tree "$head" || ${fail}`,
  "fi",
];

/** A scratch file sent back between markers, at most LIST_LIMIT of it; past that the list says it is cut. */
export const fenced = (nonce: string, name: string): string[] => [
  `echo ${marker(nonce, `${name}-begin`)}`,
  `head -c ${LIST_LIMIT} "$W/${name}"`,
  "echo",
  `echo ${marker(nonce, `${name}-end`)}`,
  `[ "$(wc -c < "$W/${name}")" -le ${LIST_LIMIT} ] || echo ${marker(nonce, "cut")}`,
];

/** The file at `$P` on disk, under `head`. A link is never followed: its target is read as text. */
export const diskSide = (head: string): string[] => [
  // Every folder on the way must be inside the copy, however it was reached.
  "root=$(pwd -P)",
  'd=$(cd -P -- "$(dirname -- "./$P")" 2>/dev/null && pwd -P || true)',
  `if [ -z "$d" ]; then echo "${head} none"`,
  `elif ! case "$d/" in "$root/"*) true ;; *) false ;; esac; then echo "${head} outside"`,
  `elif [ -L "./$P" ]; then echo "${head} link"; printf %s "$(readlink -- "./$P")" | head -c ${MAX_PATH} | base64`,
  'elif [ -f "./$P" ]; then',
  `  s=$(wc -c < "./$P" | tr -d ' ')`,
  `  if [ "$s" -gt ${MAX_FILE_BYTES} ]; then echo "${head} too-big"; else echo "${head} blob"; head -c ${MAX_FILE_BYTES + 1} < "./$P" | base64; fi`,
  `elif [ -e "./$P" ]; then echo "${head} other"`,
  `else echo "${head} none"; fi`,
];

/** Bytes made into a side: too big, binary (a NUL, or not UTF-8), or text with its tokens redacted. */
export function sideOf(b64: string): FileSide {
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length > MAX_FILE_BYTES) return { state: "too-big" };
  if (bytes.includes(0)) return { state: "binary" };
  try {
    return { state: "text", text: redactFile(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { state: "binary" };
  }
}

/** Does a link at `path` with this target stay in the copy? Worked out here, from the words alone: nothing follows it. */
export function linkStaysInside(path: string, target: string): boolean {
  if (target === "" || target.startsWith("/")) return false;
  const to = posix.normalize(posix.join(posix.dirname(path), target));
  return to !== ".." && !to.startsWith("../");
}

/** The sides a script wrote under `nonce`'s markers, up to `done`. */
export function readSides(output: string, nonce: string, path: string): Record<string, FileSide> {
  const sides: Record<string, FileSide> = {};
  let at: { name: string; state: string; b64: string[] } | undefined;
  const close = () => {
    if (!at) return;
    const { name, state, b64 } = at;
    if (state === "blob") sides[name] = sideOf(b64.join(""));
    else if (state === "link") {
      const side = sideOf(b64.join(""));
      sides[name] =
        side.text !== undefined && linkStaysInside(path, side.text)
          ? { state: "link", text: side.text }
          : { state: "outside" };
    } else if (["none", "too-big", "other", "outside"].includes(state)) {
      sides[name] = { state: state as FileSide["state"] };
    } else sides[name] = { state: "other" };
    at = undefined;
  };
  const head = new RegExp(`^${marker(nonce, "(before|after)")} ([a-z-]+)$`);
  for (const line of output.split("\n")) {
    const m = head.exec(line);
    if (m) {
      close();
      at = { name: m[1] ?? "", state: m[2] ?? "", b64: [] };
    } else if (line === marker(nonce, "done")) close();
    else at?.b64.push(line);
  }
  return sides;
}
