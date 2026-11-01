// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell scripts, not templates
// The review pane's reads (docs/design/conversations.md, "Review"): what a conversation's working copy changes
// against where its branch left the project's main, read from git rather than from tool calls, so a change made
// by a shell command shows too; and one file's two versions.
//
// Everything here only reads. No fetch, no token, and nothing in the copy is written: not its files, its index,
// HEAD, a ref or an object. Untracked files are listed from a scratch copy of the index with `add -N`, which
// records their names, and the diff is taken against the work tree. `add -N` still stores the empty blob, so new
// objects go to a scratch folder and the copy's own are only read, as alternates.
// What comes back was written by whatever runs in the sandbox, so it is treated as an agent's words: every path is
// checked, every size capped, tokens redacted, and the sections fenced by markers that carry a nonce.
// A stopped machine stays stopped: the runner this is given refuses rather than boots (T75), and the pane says so.
import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import { redactTokens } from "./ahp/sanitize.ts";
import { type RunScript, TIMED_OUT } from "./harness.ts";
import { MachineNotRunning } from "./machine-queue.ts";
import type { Registry } from "./registry.ts";
import { marker, quote, safeGit, secretFile, section } from "./ship-git.ts";
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

/**
 * Into the copy, with `G` ready and `$mb` set to what the change is measured from: where the branch left main, by
 * the refs already in the machine (never a fetch), or the first commit when they are gone. With no project there
 * is no repository to read, so a scratch one outside the folder looks at it, and `$mb` is the empty tree.
 * `$head` is empty with no project. Optional locks and lazy fetches are off: reading must not write or reach out.
 */
const open = (copy: ReviewCopy): string[] => {
  const there = `[ -d ${quote(copy.cwd)} ] || { echo @@nocopy; exit 0; }`;
  if (copy.base === null) {
    return [
      "set -u",
      there,
      `cd ${quote(copy.cwd)} || { echo @@nocopy; exit 0; }`,
      `W=$(mktemp -d); trap 'rm -rf "$W"' EXIT; mkdir "$W/home"`,
      'BE=(env -i PATH="$PATH" LANG=C.UTF-8 HOME="$W/home" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 GIT_NO_LAZY_FETCH=1)',
      '"${BE[@]}" git init --bare -q --template= "$W/repo" || { echo \'@@fail could not make a scratch repository\'; exit 1; }',
      'GX=(GIT_DIR="$W/repo" GIT_WORK_TREE="$PWD")',
      'G() { "${BE[@]}" "${GX[@]}" git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.pager=cat "$@"; }',
      "mb=$(G hash-object -t tree -w --stdin < /dev/null)",
      'head=""',
    ];
  }
  const base = copy.base;
  return [
    "set -u",
    there,
    ...safeGit(copy),
    "GX=(GIT_OPTIONAL_LOCKS=0 GIT_NO_LAZY_FETCH=1)",
    "head=$(G rev-parse --verify --quiet 'HEAD^{commit}') || { echo '@@fail the working copy has no commit'; exit 1; }",
    `b=$(G rev-parse --verify --quiet ${quote(`refs/remotes/origin/${base}^{commit}`)} || G rev-parse --verify --quiet ${quote(`refs/heads/${base}^{commit}`)} || true)`,
    'if [ -n "$b" ]; then mb=$(G merge-base "$b" "$head" 2>/dev/null || echo "$b"); else mb=$(G rev-list --max-parents=0 "$head" | tail -n 1); fi',
  ];
};

/** The list, in a fixed number of git commands, against a scratch index: the copy's own is only ever copied. */
export function listScript(copy: ReviewCopy, nonce: string): string {
  check(copy);
  if (!/^[0-9a-f]{16,64}$/.test(nonce)) throw new Error("not a nonce");
  const m = (name: string) => marker(nonce, name);
  const opts = "--no-renames --no-ext-diff --no-textconv --no-color";
  const fenced = (name: string, body: string) => [
    `echo ${m(`${name}-begin`)}`,
    `${body} | head -c ${LIST_LIMIT}`,
    "echo",
    `echo ${m(`${name}-end`)}`,
  ];
  return [
    ...open(copy),
    // A copy of the index keeps its stat cache, so unchanged files aren't read; `--reset` drops what is staged or unmerged.
    `if [ -n "$head" ]; then cp "$(G rev-parse --git-path index)" "$W/index" 2>/dev/null; o=$(G rev-parse --path-format=absolute --git-common-dir)/objects; mkdir "$W/objects"; GX+=(GIT_INDEX_FILE="$W/index" GIT_OBJECT_DIRECTORY="$W/objects" GIT_ALTERNATE_OBJECT_DIRECTORIES="$o"); G read-tree --reset "$head"; else GX+=(GIT_INDEX_FILE="$W/index"); fi`,
    "G add -N -- . ':(exclude).inc' 2>/dev/null",
    ...fenced("numstat", `G diff --numstat -z ${opts} "$mb"`),
    ...fenced("raw", `G diff --raw -z --abbrev=40 ${opts} "$mb"`),
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
    return { present: false, files: [], skipped: 0, truncated: false };
  }
  const numstat = section(output, nonce, "numstat");
  const raw = section(output, nonce, "raw");
  if (numstat === undefined || raw === undefined || !output.includes(marker(nonce, "done"))) {
    throw new Error("the list could not be read");
  }
  let truncated = numstat.length >= LIST_LIMIT || raw.length >= LIST_LIMIT;
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
  return { present: true, files, skipped, truncated };
}

/** Bytes made into a side: too big, binary (a NUL, or not UTF-8), or text with its tokens redacted. */
function sideOf(b64: string): FileSide {
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length > MAX_FILE_BYTES) return { state: "too-big" };
  if (bytes.includes(0)) return { state: "binary" };
  try {
    return { state: "text", text: redactTokens(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
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
    const empty = { files: [], skipped: 0, truncated: false, noProject: copy?.base === null };
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
