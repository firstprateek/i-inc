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
import {
  type FilesListing,
  isSearchQuery,
  readOpenFile,
  fileScript as readScript,
  readSearch,
  readTree,
  type SearchListing,
  searchScript,
  treeScript,
} from "./copy-files.ts";
import {
  check,
  diskSide,
  fenced,
  isReviewPath,
  LIST_LIMIT,
  LIST_TRIES,
  linkStaysInside,
  MAX_FILE_BYTES,
  MAX_PATH,
  open,
  type ReviewCopy,
  readSides,
  scratchIndex,
  scratchObjects,
  servedNever,
} from "./copy-read.ts";
import { type RunScript, TIMED_OUT } from "./harness.ts";
import { MachineNotRunning } from "./machine-queue.ts";
import type { Registry } from "./registry.ts";
import { marker, quote, secretFile, section } from "./ship-git.ts";
import type {
  ChangeStatus,
  ChangesState,
  ChangesView,
  FileSide,
  FilesView,
  FileView,
  OpenFileView,
  ReviewFile,
  ReviewListing,
  SearchView,
} from "./view-types.ts";

export type { ReviewCopy } from "./copy-read.ts";
export { isReviewPath, isSearchQuery, LIST_LIMIT, linkStaysInside, MAX_FILE_BYTES, MAX_PATH };
/** The most files listed. */
export const MAX_FILES = 3000;
const LIST_TIMEOUT_MS = 20_000;
const FILE_TIMEOUT_MS = 15_000;
const SEARCH_TIMEOUT_MS = 20_000;
/** How long a read waits for its turn in the machine's queue and its script, whatever holds it up. */
const WAIT_MS = 30_000;

export type { ChangesView, FileSide, FileView, ReviewFile, ReviewListing };

export interface ReviewPort {
  list(copy: ReviewCopy): Promise<ReviewListing>;
  file(copy: ReviewCopy, path: string): Promise<{ before: FileSide; after: FileSide }>;
  /** Every file in the copy. */
  tree(copy: ReviewCopy): Promise<FilesListing>;
  /** One file as it is on disk; null when the copy isn't there. */
  read(copy: ReviewCopy, path: string): Promise<FileSide | null>;
  /** The lines holding `query`, as it is written. */
  search(copy: ReviewCopy, query: string, matchCase: boolean): Promise<SearchListing>;
}

/**
 * The list, in a fixed number of git commands. `ls-files` finds what differs by its content, writing nothing, and
 * only those files are hashed: into the scratch objects, with the copy's out of sight, because git touches an object
 * it is asked to write and already has. `--ignore-errors` keeps going past a file that can't be read and says so in
 * its exit status. A new file that vanishes before it is read stops `add` altogether (128), so that step is
 * tried again, and the tracked files have gone in first, so they aren't lost with it. Either way the list says it
 * may be missing files. `ls-files` passes over a folder it can't enter with a warning and a good exit status, so its
 * warnings are kept to see: what is behind that folder is missing too. The diff reads only objects, so one that
 * fails is a failed read.
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
  return [
    ...open(copy),
    ...scratchIndex(fail),
    // What is tracked under a folder that became a link would stop `add` altogether, taking the tracked files with it.
    // The `/` keeps this to what is under a link: a link's own entry stays, or one `.gitignore` covers would read as deleted.
    'if [ -n "$head" ]; then',
    `  find . -name .git -prune -o -type l -exec printf '%s/\\0' {} + > "$W/links"`,
    `  if [ -s "$W/links" ]; then O G --literal-pathspecs rm -r -q -f --cached --ignore-unmatch --pathspec-from-file="$W/links" --pathspec-file-nul || echo ${m("partial")}; fi`,
    "fi",
    `G ls-files -z -m ${here} > "$W/tracked" 2>> "$W/said" || ${fail}`,
    "a=0",
    `if [ -s "$W/tracked" ]; then ${add("tracked")}; a=$?; fi`,
    `for try in $(seq ${LIST_TRIES}); do`,
    `  G ls-files -z -o --exclude-standard ${here} > "$W/new" 2>> "$W/said" || ${fail}`,
    "  n=0",
    `  if [ -s "$W/new" ]; then ${add("new")}; n=$?; fi`,
    '  [ "$n" -eq 128 ] || break',
    "done",
    `if [ "$a" -ne 0 ] || [ "$n" -ne 0 ] || grep -qE 'could not open|cannot lstat' "$W/said"; then echo ${m("partial")}; fi`,
    `O G diff --cached --numstat -z ${opts} "$mb" > "$W/numstat" || ${fail}`,
    `O G diff --cached --raw -z --abbrev=40 ${opts} "$mb" > "$W/raw" || ${fail}`,
    ...fenced(nonce, "numstat"),
    ...fenced(nonce, "raw"),
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
    ...scratchObjects("{ echo '@@fail the file could not be read'; exit 1; }"),
    `P=${quote(path)}`,
    `t=$(O G cat-file -t "$mb:$P" 2>/dev/null || true)`,
    'if [ "$t" = blob ]; then',
    '  s=$(O G cat-file -s "$mb:$P")',
    `  if [ "$s" -gt ${MAX_FILE_BYTES} ]; then echo "${before} too-big"; else echo "${before} blob"; O G cat-file blob "$mb:$P" | base64; fi`,
    `elif [ -n "$t" ]; then echo "${before} other"; else echo "${before} none"; fi`,
    ...diskSide(after),
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
  const sides = readSides(output, nonce, path);
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
    async tree(copy) {
      const nonce = randomBytes(16).toString("hex");
      return readTree((await exec(copy, treeScript(copy, nonce), LIST_TIMEOUT_MS)).output, nonce);
    },
    async read(copy, path) {
      const nonce = randomBytes(16).toString("hex");
      return readOpenFile(
        (await exec(copy, readScript(copy, path, nonce), FILE_TIMEOUT_MS)).output,
        nonce,
        path,
      );
    },
    async search(copy, query, matchCase) {
      const nonce = randomBytes(16).toString("hex");
      const r = await exec(copy, searchScript(copy, query, matchCase, nonce), SEARCH_TIMEOUT_MS);
      return readSearch(r.output, nonce, query, matchCase);
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
  /** One listing per conversation at a time: pressing Refresh twice doesn't run two scripts side by side. */
  private readonly listing = new Map<string, Promise<ChangesView>>();
  /** The one read that follows a running listing, shared by everyone who asked while that one ran. */
  private readonly nextListing = new Map<string, Promise<ChangesView>>();
  private readonly trees = new Map<string, Promise<FilesView>>();

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

  private failure(
    employeeId: string,
    e: unknown,
    what = "the changes",
  ): { state: ChangesState; reason: string } {
    const name = this.name(employeeId);
    if (e instanceof MachineNotRunning) {
      return {
        state: "asleep",
        reason: `${name}'s machine is asleep, so ${what} can't be read right now.`,
      };
    }
    if (e instanceof ReviewTimeout) {
      return { state: "busy", reason: `${name}'s machine is busy, so ${what} can't be read right now.` };
    }
    this.d.log?.(`review: ${e instanceof Error ? e.message : String(e)}`);
    return { state: "failed", reason: `Couldn't read ${what} in ${name}'s machine.` };
  }

  /** Why a copy that isn't there isn't. */
  private missing(id: string, none: string): string {
    const gone = (this.d.conversations.get(id)?.archivedAt ?? null) !== null;
    return gone ? "This conversation's working copy was cleaned away." : none;
  }

  /**
   * What the copy changes now. A listing that is running may already be past a file, so it can't answer for now: a
   * request made during one gets the read that starts after it, or a turn's last edit could be missing from the
   * refresh that turn's end asked for.
   */
  changes(id: string): Promise<ChangesView> {
    const waiting = this.nextListing.get(id);
    if (waiting) return waiting;
    const running = this.listing.get(id);
    if (!running) return this.startListing(id);
    const next = running.then(
      () => this.followListing(id),
      () => this.followListing(id),
    );
    this.nextListing.set(id, next);
    return next;
  }

  private followListing(id: string): Promise<ChangesView> {
    this.nextListing.delete(id);
    return this.startListing(id);
  }

  private startListing(id: string): Promise<ChangesView> {
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
      return { ...empty, state: "no-copy", reason: this.missing(id, "Nothing has changed yet.") };
    } catch (e) {
      return { ...empty, ...this.failure(copy.employeeId, e) };
    }
  }

  async file(id: string, path: string): Promise<FileView> {
    const none: FileSide = { state: "none" };
    const copy = this.copy(id);
    if (!copy) return { state: "failed", path, before: none, after: none };
    // Ship's rule and no wider: a file ship would push is one the owner must be able to read first.
    if (secretFile.some((re) => re.test(path))) {
      return { state: "ok", path, before: none, after: none, withheld: true };
    }
    try {
      return { state: "ok", path, ...(await this.within(this.d.port.file(copy, path))) };
    } catch (e) {
      return { path, before: none, after: none, ...this.failure(copy.employeeId, e) };
    }
  }

  /** Every file in the working copy, whether or not it changed. */
  files(id: string): Promise<FilesView> {
    const running = this.trees.get(id);
    if (running) return running;
    const work = this.readFiles(id).finally(() => this.trees.delete(id));
    this.trees.set(id, work);
    return work;
  }

  private async readFiles(id: string): Promise<FilesView> {
    const copy = this.copy(id);
    const empty = { paths: [], skipped: 0, truncated: false, partial: false, noProject: copy?.base === null };
    if (!copy) return { ...empty, state: "failed", reason: "There is no such conversation." };
    try {
      const { present, ...listing } = await this.within(this.d.port.tree(copy));
      if (present) return { ...listing, state: "ok", noProject: copy.base === null };
      return { ...empty, state: "no-copy", reason: this.missing(id, "There are no files here yet.") };
    } catch (e) {
      return { ...empty, ...this.failure(copy.employeeId, e, "the files") };
    }
  }

  /** One file as it is now. A file that usually holds secrets is named but never served, by a wider rule than a diff's. */
  async read(id: string, path: string): Promise<OpenFileView> {
    const none: FileSide = { state: "none" };
    const copy = this.copy(id);
    if (!copy) return { state: "failed", path, side: none };
    if (servedNever(path)) return { state: "ok", path, side: none, withheld: true };
    try {
      const side = await this.within(this.d.port.read(copy, path));
      if (side) return { state: "ok", path, side };
      return { state: "no-copy", path, side: none, reason: this.missing(id, "There are no files here yet.") };
    } catch (e) {
      return { path, side: none, ...this.failure(copy.employeeId, e, "this file") };
    }
  }

  /** The lines that hold `query`, as it is written. */
  async search(id: string, query: string, matchCase: boolean): Promise<SearchView> {
    const copy = this.copy(id);
    const empty = { hits: [], truncated: false, partial: false };
    if (!copy) return { ...empty, state: "failed", reason: "There is no such conversation." };
    try {
      const { present, ...found } = await this.within(this.d.port.search(copy, query, matchCase));
      if (present) return { ...found, state: "ok" };
      return { ...empty, state: "no-copy", reason: this.missing(id, "There are no files here yet.") };
    } catch (e) {
      return { ...empty, ...this.failure(copy.employeeId, e, "the files") };
    }
  }
}
