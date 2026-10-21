// The git side of shipping a conversation's work (T62b): look at the conversation's working copy, commit
// what is uncommitted, and push its branch as the bot. Every script runs in the employee's team machine.
// Nothing leaves the sandbox before the daemon has read the change and found no credential in it: the
// scan reuses the patterns that redact transcripts (`redactTokens`, ahp/sanitize.ts), and a file that
// usually holds secrets (.env, a private key) stops it by name. Findings name the file, never the value.
import type { Employee } from "@i-inc/core";
import { redactTokens } from "./ahp/sanitize.ts";
import type { DraftPr, PullRequests, TokenSource } from "./github.ts";
import type { RunScript } from "./harness.ts";
import { isProtected } from "./harness.ts";
import { isSafeRefName, isSafeWorkDir } from "./workspace.ts";

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** A conversation's working copy, with what shipping needs to know about its project. */
export interface ShipCopy {
  employee: Employee;
  /** "owner/name". */
  repo: string;
  /** The project's default branch (main, master...). */
  base: string;
  protectedPaths: string[];
  /** `conv/<id>`. */
  branch: string;
  /** The working copy in the machine: `/home/employee/work/conv-<id>`. */
  cwd: string;
}

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  /** Binary files have no line counts. */
  binary?: true;
}

/** What the branch changes against the project's main, committed or not. */
export interface CopyReport {
  /** The commit the working copy is on. */
  head: string;
  /** Everything that differs from where the branch left main, uncommitted work included. */
  files: FileChange[];
  /** Paths with changes that are not committed yet (modified, staged or new). */
  uncommitted: string[];
  /** Commits on the branch that main lacks. */
  ahead: number;
  /** GitHub's copy of the branch, when it has one (empty: not pushed). */
  remote: string;
  /** Changed files under one of the project's protected paths. */
  protectedPaths: string[];
  /** Files that seem to hold a credential: the file and what kind, never the value. */
  secrets: { path: string; kind: string }[];
  /** The change was too big to read for credentials. */
  tooBig: boolean;
}

/** Why the daemon would not go on, said for the owner. */
export class ShipRefusal extends Error {
  constructor(
    message: string,
    readonly code: "secrets" | "too-big" | "git" | "diverged" | "nothing",
  ) {
    super(message);
  }
}

/** The pull requests shipping uses: the bot's, with a few more reads than pick-up needs. */
export type ShipPrs = Pick<PullRequests, "find" | "openDraft" | "get" | "checks" | "setBody">;

export interface ShipPort {
  /** Reads the copy: the change, the uncommitted files, the protected paths and the scan. */
  inspect(copy: ShipCopy): Promise<CopyReport>;
  /**
   * Commits what is uncommitted with `message`, after the scan: a copy with a credential in it is
   * refused (`ShipRefusal`) and nothing is committed. Returns the commit the copy is on.
   */
  commit(copy: ShipCopy, message: string): Promise<{ committed: boolean; head: string }>;
  /** Pushes the branch as the bot, never forcing. */
  push(copy: ShipCopy): Promise<{ head: string }>;
  prs: ShipPrs;
}

const SAFE_BASE = /^[A-Za-z0-9_.-]{1,100}$/;

function check(copy: ShipCopy): void {
  if (!isSafeWorkDir(copy.cwd)) throw new Error(`not a safe folder: ${String(copy.cwd)}`);
  if (!isSafeRefName(copy.branch)) throw new Error(`not a branch name: ${String(copy.branch)}`);
  if (!SAFE_BASE.test(copy.base)) throw new Error(`not a branch name: ${String(copy.base)}`);
}

/** The common start: into the copy, on the branch it should be on. */
const enter = (copy: ShipCopy) => [
  `cd ${quote(copy.cwd)} || { echo '@@fail the working copy is not there'; exit 1; }`,
  "git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo '@@fail the working copy is not a git folder'; exit 1; }",
  `[ "$(git branch --show-current)" = ${quote(copy.branch)} ] || { echo "@@fail the working copy is on $(git branch --show-current), not ${copy.branch}"; exit 1; }`,
];

/** The most diff text read for the scan; a bigger change is refused, as it cannot be checked. */
export const SCAN_LIMIT = 8_000_000;

/**
 * Reads the copy without changing it: the change against main in a scratch index (so the copy's own
 * staging area is untouched), the uncommitted paths, how far ahead it is, and the diff text for the scan.
 */
export function inspectScript(copy: ShipCopy): string {
  check(copy);
  return [
    "set -u",
    ...enter(copy),
    `git fetch --quiet origin ${copy.base} || echo '@@warn could not fetch ${copy.base}'`,
    `base=origin/${copy.base}`,
    'git rev-parse --verify --quiet "$base" >/dev/null || base=$(git rev-list --max-parents=0 HEAD | tail -n 1)',
    'mb=$(git merge-base "$base" HEAD 2>/dev/null || echo "$base")',
    'echo "@@head $(git rev-parse HEAD)"',
    'echo "@@ahead $(git rev-list --count "$base"..HEAD 2>/dev/null || echo 0)"',
    `echo "@@remote $(git ls-remote origin refs/heads/${copy.branch} 2>/dev/null | cut -f1)"`,
    "git -c core.quotepath=off status --porcelain -uall | grep -v '^.. [.]inc/' | sed 's/^/@@dirty /' || true",
    "idx=$(mktemp); trap 'rm -f \"$idx\"' EXIT",
    'export GIT_INDEX_FILE="$idx"',
    "git read-tree HEAD",
    "git add -A -- . ':(exclude).inc'",
    "git -c core.quotepath=off diff --cached --numstat --no-renames \"$mb\" | sed 's/^/@@file /'",
    "echo @@diff-begin",
    `git -c core.quotepath=off diff --cached -U0 --no-color --no-renames --diff-filter=AM "$mb" | head -c ${SCAN_LIMIT + 1}`,
    "echo",
    "echo @@diff-end",
  ].join("\n");
}

/** Stages everything but `.inc/` (the owner's images) and commits it; says whether there was anything to commit. */
export function commitScript(copy: ShipCopy, message: string): string {
  check(copy);
  const b64 = Buffer.from(message, "utf8").toString("base64");
  return [
    "set -e",
    ...enter(copy),
    "git add -A -- . ':(exclude).inc'",
    "if git diff --cached --quiet; then",
    "  echo @@nothing",
    "else",
    // The checks and the review that follow are the gate; a hook of the project's must not stop a checkpoint.
    `  git commit --quiet --no-verify -m "$(printf %s ${quote(b64)} | base64 -d)"`,
    "  echo @@committed",
    "fi",
    'echo "@@head $(git rev-parse HEAD)"',
  ].join("\n");
}

/** Pushes the branch. A branch GitHub has moved on is never overwritten. */
export function pushScript(copy: ShipCopy): string {
  check(copy);
  return [
    "set -u",
    ...enter(copy),
    `if out=$(git push --quiet -u origin ${quote(copy.branch)} 2>&1); then`,
    '  echo "@@pushed $(git rev-parse HEAD)"',
    "else",
    '  echo "$out" | tail -n 5',
    '  case "$out" in *"fetch first"*|*non-fast-forward*|*rejected*) echo "@@diverged"; exit 7 ;; esac',
    "  exit 1",
    "fi",
  ].join("\n");
}

const tail = (output: string) => output.trim().split("\n").slice(-4).join(" ").slice(0, 300);

/** A file that usually holds secrets, by its name. */
const secretFile = [
  /(^|\/)\.env(\.(?!example$|sample$|template$|dist$)[^/]+)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
];

/** `redactTokens` stops at a million characters, so a long text is looked at in pieces of whole lines. */
function holdsCredential(added: string): boolean {
  const piece = 400_000;
  let chunk = "";
  const looks = (t: string) => t.length > 0 && redactTokens(t) !== t;
  for (const line of added.split("\n")) {
    if (chunk.length + line.length + 1 > piece) {
      if (looks(chunk)) return true;
      chunk = "";
    }
    chunk += `${line}\n`;
  }
  return looks(chunk);
}

/** Reads the diff of the added and modified files, and names the files that hold a credential. */
export function scanDiff(diff: string): { path: string; kind: string }[] {
  const found: { path: string; kind: string }[] = [];
  let path = "";
  let added: string[] = [];
  const flush = () => {
    if (path && added.length && holdsCredential(added.join("\n")))
      found.push({ path, kind: "a token, key or password" });
    added = [];
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      path = "";
    } else if (line.startsWith("+++ ")) {
      path = line.startsWith("+++ b/") ? line.slice(6) : "";
    } else if (line.startsWith("+") && path) {
      added.push(line.slice(1));
    }
  }
  flush();
  return found;
}

/** Reads `inspectScript`'s output. */
export function readInspect(copy: ShipCopy, output: string): CopyReport {
  const lines = output.split("\n");
  const one = (tag: string) => lines.find((l) => l.startsWith(`@@${tag} `))?.slice(tag.length + 3) ?? "";
  const all = (tag: string) =>
    lines.filter((l) => l.startsWith(`@@${tag} `)).map((l) => l.slice(tag.length + 3));
  const files: FileChange[] = all("file").flatMap((row) => {
    const [a, r, ...rest] = row.split("\t");
    const path = rest.join("\t");
    if (!path) return [];
    return a === "-" || r === "-"
      ? [{ path, added: 0, removed: 0, binary: true as const }]
      : [{ path, added: Number(a) || 0, removed: Number(r) || 0 }];
  });
  const marker = /(^|\n)@@diff-begin\n/.exec(output);
  const end = output.lastIndexOf("\n@@diff-end");
  const diff = marker ? output.slice(marker.index + marker[0].length, end >= 0 ? end : undefined) : "";
  const tooBig = diff.length > SCAN_LIMIT;
  const byName = files
    .filter((f) => secretFile.some((re) => re.test(f.path)))
    .map((f) => ({ path: f.path, kind: "a file that usually holds secrets" }));
  const byContent = scanDiff(diff).filter((s) => !byName.some((b) => b.path === s.path));
  return {
    head: one("head").trim(),
    files,
    uncommitted: all("dirty")
      .map((l) => l.slice(3))
      .filter((p) => p.length > 0),
    ahead: Number(one("ahead")) || 0,
    remote: one("remote").trim(),
    protectedPaths: files.map((f) => f.path).filter((p) => isProtected(p, copy.protectedPaths)),
    secrets: [...byName, ...byContent],
    tooBig,
  };
}

/** The sentence for a change the scan stopped. */
export function secretsSentence(report: Pick<CopyReport, "secrets" | "tooBig">): string {
  if (report.secrets.length) {
    const names = report.secrets.map((s) => s.path).join(", ");
    return `Nothing was committed: ${names} look${report.secrets.length === 1 ? "s" : ""} like ${report.secrets.length === 1 ? "it holds" : "they hold"} a credential. Take it out (keep secrets in the environment, never in files), then try again.`;
  }
  return "Nothing was committed: the change is too big to check for credentials. Split it up, then try again.";
}

export interface ShipKit {
  tokens: TokenSource;
  run: RunScript;
  prs: ShipPrs;
}

export function conversationShip(kit: ShipKit): ShipPort {
  const exec = async (copy: ShipCopy, script: string): Promise<{ code: number; output: string }> => {
    const token = await kit.tokens.token(copy.repo);
    return kit.run(copy.employee.id, script, { GH_TOKEN: token });
  };
  const why = (r: { output: string }, doing: string) => {
    const fail = /^@@fail (.+)$/m.exec(r.output)?.[1];
    return `Couldn't ${doing}: ${fail ?? tail(r.output)}`;
  };
  const inspect = async (copy: ShipCopy): Promise<CopyReport> => {
    const r = await exec(copy, inspectScript(copy));
    if (r.code !== 0 || !r.output.includes("@@diff-end")) {
      throw new ShipRefusal(why(r, "look at the working copy"), "git");
    }
    return readInspect(copy, r.output);
  };
  return {
    inspect,
    prs: kit.prs,
    async commit(copy, message) {
      const report = await inspect(copy);
      if (report.secrets.length || report.tooBig) throw new ShipRefusal(secretsSentence(report), "secrets");
      const r = await exec(copy, commitScript(copy, message));
      const head = /^@@head ([0-9a-f]{7,40})$/m.exec(r.output)?.[1];
      if (r.code !== 0 || !head) throw new ShipRefusal(why(r, "commit the changes"), "git");
      return { committed: r.output.includes("@@committed"), head };
    },
    async push(copy) {
      const r = await exec(copy, pushScript(copy));
      if (r.output.includes("@@diverged")) {
        throw new ShipRefusal(
          `GitHub's copy of ${copy.branch} has changes this working copy doesn't, so it wasn't pushed. Nothing was overwritten.`,
          "diverged",
        );
      }
      const head = /^@@pushed ([0-9a-f]{7,40})$/m.exec(r.output)?.[1];
      if (r.code !== 0 || !head) throw new ShipRefusal(why(r, "push the branch"), "git");
      return { head };
    },
  };
}

export type { DraftPr };
