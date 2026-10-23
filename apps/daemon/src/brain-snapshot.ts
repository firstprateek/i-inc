// The brain's copy in a sandbox (docs/design/brain.md, "Reading"). This file is the pure half: what a
// snapshot is (files with git blob ids and an id for the whole), and the script that applies one inside
// the sandbox. The copy is a git repository at `<home>/brain/<employee>/` whose baseline commit
// (`refs/inc/baseline`) is the snapshot, so what an agent edits is `git diff refs/inc/baseline`
// (T58 harvests it). A refresh never wipes an agent's edits: a file with local changes keeps them and
// the baseline keeps the old text of that file, so the diff stays exactly the agent's own work.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Scope } from "@i-inc/core";
import { tar } from "./brain-tar.ts";

/** One file of a snapshot, relative to the copy's root. */
export interface SnapshotFile {
  path: string;
  /** The git blob id of its content: the same id `git hash-object` gives it in the sandbox. */
  sha: string;
  /** The shipped command is executable and not part of the baseline. */
  tracked: boolean;
}

export interface Snapshot {
  /** A hash of every path and blob id: two snapshots with the same id are the same files. */
  id: string;
  employeeId: string;
  files: Map<string, SnapshotFile>;
  /** Scope → folder, for T58 and the manifest. */
  dirs: Record<string, string>;
  /** Files left out (too big, too many, or an unsafe name), with why. */
  skipped: string[];
  bytes: number;
}

export const commandPath = ".bin/brain";

/** `git hash-object` of this content. */
export function gitBlobSha(data: Uint8Array): string {
  const h = createHash("sha1");
  h.update(`blob ${data.length}\0`);
  h.update(data);
  return h.digest("hex");
}

export function snapshotId(files: Iterable<SnapshotFile>): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(`${f.path}\0${f.sha}\0${f.tracked ? 1 : 0}\n`);
  }
  return h.digest("hex").slice(0, 16);
}

/** The files whose content differs from what the sandbox was last given (or is not there yet). */
export function changedFiles(next: Snapshot, last: Snapshot | undefined): string[] {
  return [...next.files.values()].filter((f) => last?.files.get(f.path)?.sha !== f.sha).map((f) => f.path);
}

const root = /^\/[A-Za-z0-9/_.-]{1,200}$/;
const idShape = /^[0-9a-f]{16}$/;

export interface ApplyOptions {
  /** The copy's folder in the sandbox, e.g. /home/employee/brain/ada. */
  root: string;
  next: Snapshot;
  /** The snapshot the sandbox is believed to hold, when this is a delta; absent for a full copy. */
  base?: string | undefined;
  /** Path → content of the files to send (all of them for a full copy). */
  contents: Map<string, Uint8Array>;
  /** Written as `.snapshot.json` (what T58 reads: the scopes and their folders). */
  meta: Record<string, unknown>;
  at: number;
}

const wrap = (b64: string) => b64.replace(/(.{76})/g, "$1\n");

/**
 * The logic that runs in the sandbox as `bash -s` (brain-apply.sh, a plain file so it is read as the shell
 * sees it). Prints `@@synced`, `@@kept <path>`, `@@need-full` or `@@fail <why>`.
 */
const applyBody = readFileSync(new URL("./brain-apply.sh", import.meta.url), "utf8");

/**
 * The script that brings a sandbox's copy up to `next`: the archive of the files to send, the whole
 * manifest (so deletions are found), and the logic above. With `base` it is a delta that only applies
 * if the sandbox holds exactly that snapshot; otherwise it answers `@@need-full` and changes nothing.
 */
export function applyScript(o: ApplyOptions): string {
  if (!root.test(o.root)) throw new Error(`not a copy folder: ${o.root}`);
  if (!idShape.test(o.next.id) || (o.base !== undefined && !idShape.test(o.base))) {
    throw new Error("not a snapshot id");
  }
  const files = [...o.contents.entries()].map(([path, data]) => ({
    path,
    data,
    mode: path === commandPath ? 0o755 : 0o644,
  }));
  const manifest = [...o.next.files.values()]
    .filter((f) => f.tracked)
    .map((f) => `${f.path}\t${f.sha}`)
    .join("\n");
  return [
    "set -u",
    `R='${o.root}'`,
    `NEW='${o.next.id}'`,
    `BASE='${o.base ?? ""}'`,
    `MODE=${o.base === undefined ? "full" : "delta"}`,
    "tmp=$(mktemp -d) && trap 'rm -rf \"$tmp\"' EXIT",
    applyBody,
    `base64 -d > "$tmp/in.tar" <<'__INC_TAR__' && B64=1`,
    wrap(tar(files, Math.floor(o.at / 1000)).toString("base64")),
    "__INC_TAR__",
    `cat > "$tmp/manifest" <<'__INC_MANIFEST__'`,
    manifest,
    "__INC_MANIFEST__",
    `cat > "$tmp/meta.json" <<'__INC_META__'`,
    JSON.stringify({ ...o.meta, id: o.next.id }),
    "__INC_META__",
    // The last line: nothing after it for a command inside to read from the script.
    "apply </dev/null",
    "",
  ].join("\n");
}

/** Takes a whole copy out of a sandbox (the employee moved to another team, left, or may not have one). */
/** A copy's name: an employee id, or a PA's second copy (`<id>.code`). */
const copyName = /^[a-z0-9][a-z0-9-]{0,62}(\.code)?$/;

/**
 * Removes exactly `<base>/<copy>` and nothing else: `base` is the brain folder the daemon is configured with
 * (`/home/employee/brain`), `copy` must be a plain copy name. An empty, `.`, `..` or slashed name is refused,
 * so the base itself (every copy, with any edits not yet collected) can never be removed by a mistake.
 */
export function removeScript(base: string, copy: string): string {
  if (!root.test(base) || base === "/" || base.split("/").some((p) => p === ".." || p === ".")) {
    throw new Error(`not a brain folder: ${base}`);
  }
  if (!copyName.test(copy)) throw new Error(`not a copy name: ${copy}`);
  const dir = `${base.replace(/\/+$/, "")}/${copy}`;
  return `rm -rf -- '${dir}' && echo @@removed\n`;
}

/** Asks whether the sandbox still holds exactly this snapshot (it can be wiped by a storage clean-up). */
export function verifyScript(rootDir: string, id: string): string {
  if (!root.test(rootDir) || !idShape.test(id)) throw new Error("not a copy folder or snapshot id");
  return `if [ "$(cat '${rootDir}/.snapshot.id' 2>/dev/null)" = '${id}' ] && [ -x '${rootDir}/.bin/brain' ]; then echo @@current; else echo @@need-full; fi\n`;
}

export interface ApplyResult {
  kind: "synced" | "current" | "need-full" | "failed";
  /** `brain search` works in that sandbox. */
  search: boolean;
  /** ripgrep is on the sandbox's path. Said only by a copy that was applied; absent otherwise. */
  rg?: boolean;
  applied?: number;
  removed?: number;
  /** Files whose local edits were kept (they differ from the baseline). */
  kept: string[];
  detail?: string;
}

export function parseApply(code: number, output: string): ApplyResult {
  const lines = output.split("\n");
  const kept = lines.filter((l) => l.startsWith("@@kept ")).map((l) => l.slice(7));
  const search = !lines.some((l) => l.startsWith("@@warn no-search"));
  if (lines.some((l) => l.startsWith("@@need-full"))) return { kind: "need-full", kept, search };
  const synced = lines.find((l) => l.startsWith("@@synced "));
  if (code === 0 && synced) {
    const n = (k: string) => Number(new RegExp(`${k}=(\\d+)`).exec(synced)?.[1] ?? 0);
    return {
      kind: "synced",
      applied: n("applied"),
      removed: n("removed"),
      kept,
      search,
      rg: lines.some((l) => l.startsWith("@@tool rg")),
    };
  }
  if (code === 0 && lines.some((l) => l.startsWith("@@current"))) return { kind: "current", kept, search };
  const fail = lines.find((l) => l.startsWith("@@fail "));
  return {
    kind: "failed",
    search,
    kept,
    detail: (fail ? fail.slice(7) : output.trim().split("\n").slice(-3).join(" ")).slice(0, 200),
  };
}

export type { Scope };
