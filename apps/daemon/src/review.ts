// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell scripts, not templates
// The review pane's reads (docs/design/conversations.md, "Review"): what a conversation's working copy changes
// against where its branch left the project's main, read from git rather than from tool calls, so a change made
// by a shell command shows too; and one file's two versions.
//
// Everything here only reads. No fetch, no token, and nothing in the copy is written: not its files, its index,
// HEAD, a ref or an object. The list is made in a scratch repository outside the folder, which sees the copy's
// objects and its files, and nothing else of it: not its index (an agent can tell an index to hide a change, and a
// copy of one can write to the real .git), config, excludes or hooks. What changed is hashed into the scratch
// index and objects and the diff is between those and the measure, so a file that changes or goes away during the
// read can't stop the diff, and one that can't be read costs that file, not the list.
// What comes back was written by whatever runs in the sandbox, so it is treated as an agent's words: every path is
// checked, every size capped, tokens redacted, and the sections fenced by markers that carry a nonce.
// A stopped machine stays stopped: the runner this is given refuses rather than boots (T75), and the pane says so.
import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import { redactTokens } from "./ahp/sanitize.ts";
import { type RunScript, TIMED_OUT } from "./harness.ts";
import { MachineNotRunning } from "./machine-queue.ts";
import type { Registry } from "./registry.ts";
import { marker, quote, redactFile, safeGit, secretFile, section } from "./ship-git.ts";
import type {
  ChangeStatus,
  ChangesState,
  ChangesView,
  FileSide,
  FileView,
  ReviewFile,
  ReviewListing,
} from "./view-types.ts";
import { isSafeRefName, isSafeWorkDir } from "./workspace.ts";

export type { ChangesView, FileSide, FileView, ReviewFile, ReviewListing };

/** The biggest file shown: `redactTokens` stops at a million characters, and a bigger file is no use in a diff. */
export const MAX_FILE_BYTES = 1_000_000;
/** The most files listed. */
export const MAX_FILES = 3000;
/** The most text the list reads per section; past it the list says it is cut. */
export const LIST_LIMIT = 2_000_000;
export const MAX_PATH = 1024;
const LIST_TIMEOUT_MS = 20_000;
const FILE_TIMEOUT_MS = 15_000;
/** How long a read waits for its turn in the machine's queue and its script, whatever holds it up. */
const WAIT_MS = 30_000;

/** A conversation's working copy. `base` is the project's main; null: no project, an empty folder that is no repo. */
export interface ReviewCopy {
  employeeId: string;
  cwd: string;
  base: string | null;
  machine?: string;
}

export interface ReviewPort {
  list(copy: ReviewCopy): Promise<ReviewListing>;
  file(copy: ReviewCopy, path: string): Promise<{ before: FileSide; after: FileSide }>;
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

function check(copy: ReviewCopy): void {
  if (!isSafeWorkDir(copy.cwd)) throw new Error(`not a safe folder: ${String(copy.cwd)}`);
  if (copy.base !== null && !isSafeRefName(copy.base)) throw new Error(`not a branch name: ${copy.base}`);
}

/** How many times the list tries to add the files while they keep going away under it. */
const LIST_TRIES = 3;

/**
 * Into the copy, with `G` ready and `$mb` set to what the change is measured from: where the branch left main, by
 * the refs already in the machine (never a fetch), or the first commit when they are gone. With no commit to measure
 * from (no project, or a copy with no commits or no repository) a scratch repository outside the folder looks at it,
 * `$mb` is the empty tree, `$head` is empty and every file there is new. Optional locks and lazy fetches are off:
 * reading must not write or reach out. Git's warnings go nowhere: output is what the script says, and a warning
 * in the middle of a section would pass for part of it.
 */
const open = (copy: ReviewCopy): string[] => {
  const enter = [
    "set -u",
    "exec 2>/dev/null",
    `[ -d ${quote(copy.cwd)} ] || { echo @@nocopy; exit 0; }`,
    `cd ${quote(copy.cwd)} || { echo @@nocopy; exit 0; }`,
  ];
  const scratch = [
    `W=$(mktemp -d); trap 'rm -rf "$W"' EXIT; mkdir "$W/home"`,
    'BE=(env -i PATH="$PATH" LANG=C.UTF-8 HOME="$W/home" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 GIT_NO_LAZY_FETCH=1)',
    '"${BE[@]}" git init --bare -q --template= "$W/repo" || { echo \'@@fail could not make a scratch repository\'; exit 1; }',
    'GX=(GIT_DIR="$W/repo" GIT_WORK_TREE="$PWD")',
    'G() { "${BE[@]}" "${GX[@]}" git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.pager=cat "$@"; }',
    "mb=$(G hash-object -t tree -w --stdin < /dev/null)",
    'head=""',
  ];
  if (copy.base === null) return [...enter, ...scratch];
  const base = copy.base;
  return [
    ...enter,
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

/**
 * The list, in a fixed number of git commands. `ls-files` finds what differs by its content, writing nothing, and
 * only those files are hashed: into the scratch objects, with the copy's out of sight, because git touches an object
 * it is asked to write and already has. `--ignore-errors` keeps going past a file that can't be read and says so in
 * its exit status. A new file that vanishes before it is read stops `add` altogether (128), so that step is
 * tried again, and the tracked files have gone in first, so they aren't lost with it. Either way the list says it
 * may be missing files. The diff reads only objects, so one that fails is a failed read.
 */
export function listScript(copy: ReviewCopy, nonce: string): string {
  check(copy);
  if (!/^[0-9a-f]{16,64}$/.test(nonce)) throw new Error("not a nonce");
  const m = (name: string) => marker(nonce, name);
  const opts = "--no-renames --no-ext-diff --no-textconv --no-color";
  const here = "-- . ':(exclude).inc'";
  // A name is a name here, whatever it looks like: `:(top)x` and `*` are pathspec magic otherwise.
  const add = (list: string) =>
    `G --literal-pathspecs add -A --ignore-errors --pathspec-from-file="$W/${list}" --pathspec-file-nul`;
  const fail = "{ echo '@@fail the list could not be read'; exit 1; }";
  const fenced = (name: string) => [
    `echo ${m(`${name}-begin`)}`,
    `head -c ${LIST_LIMIT} "$W/${name}"`,
    "echo",
    `echo ${m(`${name}-end`)}`,
    `[ "$(wc -c < "$W/${name}")" -le ${LIST_LIMIT} ] || echo ${m("cut")}`,
  ];
  return [
    ...open(copy),
    'O() { "$@"; }',
    'if [ -n "$head" ]; then',
    "  o=$(G rev-parse --path-format=absolute --git-common-dir)/objects",
    '  "${BE[@]}" GIT_CONFIG_GLOBAL=/dev/null git init --bare -q --template= "$W/repo" || { echo \'@@fail could not make a scratch repository\'; exit 1; }',
    '  GX=(GIT_DIR="$W/repo" GIT_WORK_TREE="$PWD" GIT_CONFIG_GLOBAL=/dev/null GIT_OPTIONAL_LOCKS=0 GIT_NO_LAZY_FETCH=1)',
    '  O() { local GX=("${GX[@]}" GIT_ALTERNATE_OBJECT_DIRECTORIES="$o"); "$@"; }',
    `  O G read-tree "$head" || ${fail}`,
    "fi",
    `G ls-files -z -m ${here} > "$W/tracked" || ${fail}`,
    "a=0",
    `if [ -s "$W/tracked" ]; then ${add("tracked")}; a=$?; fi`,
    `for try in $(seq ${LIST_TRIES}); do`,
    `  G ls-files -z -o --exclude-standard ${here} > "$W/new" || ${fail}`,
    "  n=0",
    `  if [ -s "$W/new" ]; then ${add("new")}; n=$?; fi`,
    '  [ "$n" -eq 128 ] || break',
    "done",
    `[ "$a" -eq 0 ] && [ "$n" -eq 0 ] || echo ${m("partial")}`,
    `O G diff --cached --numstat -z ${opts} "$mb" > "$W/numstat" || ${fail}`,
    `O G diff --cached --raw -z --abbrev=40 ${opts} "$mb" > "$W/raw" || ${fail}`,
    ...fenced("numstat"),
    ...fenced("raw"),
    `echo ${m("done")}`,
  ].join("\n");
}

/** One file's two versions, base64 so any bytes survive. A link is never followed: its target is read as text. */
export function fileScript(copy: ReviewCopy, path: string, nonce: string): string {
  check(copy);
  if (!isReviewPath(path)) throw new Error("not a path in the change");
  if (!/^[0-9a-f]{16,64}$/.test(nonce)) throw new Error("not a nonce");
  const before = marker(nonce, "before");
  const after = marker(nonce, "after");
  return [
    ...open(copy),
    `P=${quote(path)}`,
    `t=$(G cat-file -t "$mb:$P" 2>/dev/null || true)`,
    'if [ "$t" = blob ]; then',
    '  s=$(G cat-file -s "$mb:$P")',
    `  if [ "$s" -gt ${MAX_FILE_BYTES} ]; then echo "${before} too-big"; else echo "${before} blob"; G cat-file blob "$mb:$P" | base64; fi`,
    `elif [ -n "$t" ]; then echo "${before} other"; else echo "${before} none"; fi`,
    // Every folder on the way must be inside the copy, however it was reached.
    "root=$(pwd -P)",
    'd=$(cd -P -- "$(dirname -- "./$P")" 2>/dev/null && pwd -P || true)',
    `if [ -z "$d" ]; then echo "${after} none"`,
    `elif ! case "$d/" in "$root/"*) true ;; *) false ;; esac; then echo "${after} outside"`,
    `elif [ -L "./$P" ]; then echo "${after} link"; printf %s "$(readlink -- "./$P")" | head -c ${MAX_PATH} | base64`,
    'elif [ -f "./$P" ]; then',
    `  s=$(wc -c < "./$P" | tr -d ' ')`,
    `  if [ "$s" -gt ${MAX_FILE_BYTES} ]; then echo "${after} too-big"; else echo "${after} blob"; head -c ${MAX_FILE_BYTES + 1} < "./$P" | base64; fi`,
    `elif [ -e "./$P" ]; then echo "${after} other"`,
    `else echo "${after} none"; fi`,
    `echo ${marker(nonce, "done")}`,
  ].join("\n");
}

const STATUS: Record<string, ChangeStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  T: "type-changed",
};

/** Reads `listScript`'s output. A row it can't read is left out and counted, never passed on. */
export function readList(output: string, nonce: string): ReviewListing {
  if (/^@@nocopy$/m.test(output) && !output.includes(marker(nonce, "done"))) {
    return { present: false, files: [], skipped: 0, truncated: false, partial: false };
  }
  const numstat = section(output, nonce, "numstat");
  const raw = section(output, nonce, "raw");
  if (numstat === undefined || raw === undefined || !output.includes(marker(nonce, "done"))) {
    throw new Error("the list could not be read");
  }
  let truncated = output.includes(marker(nonce, "cut"));
  // raw -z: `:modes shas status NUL path NUL`.
  const status = new Map<string, ChangeStatus>();
  const tokens = raw.split("\0");
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const meta = tokens[i] ?? "";
    if (!meta.startsWith(":")) break;
    status.set(tokens[i + 1] ?? "", STATUS[meta.trim().split(" ").at(-1) ?? ""] ?? "modified");
  }
  const files: ReviewFile[] = [];
  let skipped = 0;
  // numstat -z: `added TAB removed TAB path NUL`. What follows the last NUL is a row the cap cut in two.
  for (const row of numstat.split("\0").slice(0, -1)) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(row);
    if (!m || !isReviewPath(m[3])) {
      skipped++;
      continue;
    }
    if (files.length >= MAX_FILES) {
      truncated = true;
      break;
    }
    const path = m[3];
    const binary = m[1] === "-" || m[2] === "-";
    files.push({
      path,
      added: binary ? 0 : Number(m[1]),
      removed: binary ? 0 : Number(m[2]),
      ...(binary ? { binary: true as const } : {}),
      status: status.get(path) ?? "modified",
    });
  }
  return { present: true, files, skipped, truncated, partial: output.includes(marker(nonce, "partial")) };
}

/** Bytes made into a side: too big, binary (a NUL, or not UTF-8), or text with its tokens redacted. */
function sideOf(b64: string): FileSide {
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

/** Reads `fileScript`'s output. */
export function readFile(
  output: string,
  nonce: string,
  path: string,
): { before: FileSide; after: FileSide } | null {
  if (!output.includes(marker(nonce, "done"))) {
    if (/^@@nocopy$/m.test(output)) return null;
    throw new Error("the file could not be read");
  }
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
  if (!sides.before || !sides.after) throw new Error("the file could not be read");
  return { before: sides.before, after: sides.after };
}

/** The port over a script runner. Give it the runner that never boots a machine. */
export function reviewPort(run: RunScript): ReviewPort {
  const exec = async (copy: ReviewCopy, script: string, timeoutMs: number) => {
    const r = await run(
      copy.employeeId,
      script,
      {},
      {
        timeoutMs,
        ...(copy.machine ? { machine: copy.machine } : {}),
      },
    );
    if (r.code === TIMED_OUT) throw new ReviewTimeout();
    return r;
  };
  return {
    async list(copy) {
      const nonce = randomBytes(16).toString("hex");
      return readList((await exec(copy, listScript(copy, nonce), LIST_TIMEOUT_MS)).output, nonce);
    },
    async file(copy, path) {
      const nonce = randomBytes(16).toString("hex");
      const r = await exec(copy, fileScript(copy, path, nonce), FILE_TIMEOUT_MS);
      return readFile(r.output, nonce, path) ?? { before: { state: "none" }, after: { state: "none" } };
    },
  };
}

/** A read ran out of time, in the machine or in the queue for it. */
export class ReviewTimeout extends Error {}

export interface ReviewDeps {
  conversations: {
    get(id: string): { employeeId: string; project: string | null; archivedAt: number | null } | undefined;
    machineFor(id: string): string | null;
  };
  registry: Pick<Registry, "project" | "employees">;
  port: ReviewPort;
  /** How long a read may take in all (tests shorten it). */
  waitMs?: number;
  log?: (msg: string) => void;
}

/** What the routes call: finds the copy, and turns every way a read can fail into a state and a sentence. */
export class ConversationReview {
  /** One listing per conversation at a time: pressing Refresh twice doesn't start a second script. */
  private readonly listing = new Map<string, Promise<ChangesView>>();

  constructor(private readonly d: ReviewDeps) {}

  private copy(id: string): ReviewCopy | undefined {
    const conv = this.d.conversations.get(id);
    if (!conv) return undefined;
    const machine = this.d.conversations.machineFor(id);
    return {
      employeeId: conv.employeeId,
      cwd: `/home/employee/work/conv-${id}`,
      base: conv.project === null ? null : this.d.registry.project(conv.project)?.defaultBranch || "main",
      ...(machine ? { machine } : {}),
    };
  }

  private name(employeeId: string): string {
    return this.d.registry.employees().find((e) => e.id === employeeId)?.name ?? "The employee";
  }

  /** A read, bounded however long the machine's queue holds it: a stop going on waits for leases, so a read can too. */
  private within<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new ReviewTimeout()), this.d.waitMs ?? WAIT_MS);
      t.unref?.();
      work.then(resolve, reject).finally(() => clearTimeout(t));
    });
  }

  private failure(employeeId: string, e: unknown): { state: ChangesState; reason: string } {
    const name = this.name(employeeId);
    if (e instanceof MachineNotRunning) {
      return {
        state: "asleep",
        reason: `${name}'s machine is asleep, so the changes can't be read right now.`,
      };
    }
    if (e instanceof ReviewTimeout) {
      return { state: "busy", reason: `${name}'s machine is busy, so the changes can't be read right now.` };
    }
    this.d.log?.(`review: ${e instanceof Error ? e.message : String(e)}`);
    return { state: "failed", reason: `Couldn't read the changes in ${name}'s machine.` };
  }

  changes(id: string): Promise<ChangesView> {
    const running = this.listing.get(id);
    if (running) return running;
    const work = this.readChanges(id).finally(() => this.listing.delete(id));
    this.listing.set(id, work);
    return work;
  }

  private async readChanges(id: string): Promise<ChangesView> {
    const copy = this.copy(id);
    const empty = {
      files: [],
      skipped: 0,
      truncated: false,
      partial: false,
      noProject: copy?.base === null,
    };
    if (!copy) return { ...empty, state: "failed", reason: "There is no such conversation." };
    try {
      const { present, ...listing } = await this.within(this.d.port.list(copy));
      if (present) return { ...listing, state: "ok", noProject: copy.base === null };
      const gone = (this.d.conversations.get(id)?.archivedAt ?? null) !== null;
      return {
        ...empty,
        state: "no-copy",
        reason: gone ? "This conversation's working copy was cleaned away." : "Nothing has changed yet.",
      };
    } catch (e) {
      return { ...empty, ...this.failure(copy.employeeId, e) };
    }
  }

  async file(id: string, path: string): Promise<FileView> {
    const none: FileSide = { state: "none" };
    const copy = this.copy(id);
    if (!copy) return { state: "failed", path, before: none, after: none };
    if (secretFile.some((re) => re.test(path))) {
      return { state: "ok", path, before: none, after: none, withheld: true };
    }
    try {
      return { state: "ok", path, ...(await this.within(this.d.port.file(copy, path))) };
    } catch (e) {
      return { path, before: none, after: none, ...this.failure(copy.employeeId, e) };
    }
  }
}
