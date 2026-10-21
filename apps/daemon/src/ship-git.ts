// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell scripts, not templates
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

/** What the branch changes against the project's main, committed or not, and what stops it from going on. */
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
  /**
   * What seems to hold a credential: a file in the change (by its path), or a commit in the branch's history
   * (`commit abc1234`: a credential committed and then taken out is still published by a push). Never the value.
   */
  secrets: { path: string; kind: string }[];
  /** Changed files that could not be read for the scan: the scan fails closed on them. */
  unscanned: string[];
  /** Changed links to an absolute path (outside the project). */
  unsafe: { path: string; why: string }[];
  /** Binary files over BINARY_SCAN_FREE bytes: they can't be scanned, so the owner confirms them. */
  binaries: { path: string; size: number }[];
  /** The change or its history was too big to read for credentials. */
  tooBig: boolean;
}

/** Why the daemon would not go on, said for the owner. */
export class ShipRefusal extends Error {
  constructor(
    message: string,
    readonly code: "secrets" | "too-big" | "git" | "diverged" | "nothing" | "binary",
  ) {
    super(message);
  }
}

/** The pull requests shipping uses: the bot's, with a few more reads than pick-up needs. */
export type ShipPrs = Pick<PullRequests, "find" | "openDraft" | "get" | "checks" | "setBody">;

export interface ShipPort {
  /** Reads the copy: the change, the uncommitted files, the protected paths, and the scans (the change and the history). */
  inspect(copy: ShipCopy): Promise<CopyReport>;
  /**
   * Inspects the copy and refuses (`ShipRefusal`) when the change or any commit that would be pushed holds a
   * credential, a file could not be scanned, or a link points outside the project. The last gate before a copy
   * passes to a ticket or to GitHub.
   */
  verify(copy: ShipCopy): Promise<CopyReport>;
  /**
   * Commits what is uncommitted with `message`, after the scan: a copy with a credential in it is refused and
   * nothing is committed. Returns the commit the copy is on.
   */
  commit(copy: ShipCopy, message: string): Promise<{ committed: boolean; head: string }>;
  /** Scans exactly what will be pushed, then pushes that commit as the bot, never forcing. */
  push(copy: ShipCopy): Promise<{ head: string }>;
  prs: ShipPrs;
}

const SAFE_BASE = /^[A-Za-z0-9_.-]{1,100}$/;
/** The remote shipping talks to: GitHub's address of the repo, or (tests) a path. */
const SAFE_REMOTE = /^(https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.git|\/[A-Za-z0-9._/-]+)$/;

function check(copy: ShipCopy, remote?: string): void {
  if (!isSafeWorkDir(copy.cwd)) throw new Error(`not a safe folder: ${String(copy.cwd)}`);
  if (!isSafeRefName(copy.branch)) throw new Error(`not a branch name: ${String(copy.branch)}`);
  if (!SAFE_BASE.test(copy.base)) throw new Error(`not a branch name: ${String(copy.base)}`);
  if (remote !== undefined && !SAFE_REMOTE.test(remote)) throw new Error(`not a remote: ${remote}`);
}

/**
 * What every script starts with: into the copy, on the branch it should be on; then git made safe to run in a
 * folder an agent has been working in. Every git call goes through `G`: no hooks (`--no-verify` doesn't stop
 * prepare-commit-msg, post-commit or pre-push), no fsmonitor, no signing program, and each `filter.*` driver
 * in the config (an agent's clean or smudge command would run on `git add`) set to nothing. `N` is `G` for the
 * network, and the only place the bot's token goes: it is taken out of the environment first, handed to git for
 * that one command through `GIT_CONFIG_*` (an Authorization header, no credential helper, no proxy) and used with
 * the repo's address, never the `origin` an agent could have repointed.
 */
const enter = (copy: ShipCopy, remote: string) => [
  'TOK="${GH_TOKEN:-}"; unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GH_HOST',
  `cd ${quote(copy.cwd)} || { echo '@@fail the working copy is not there'; exit 1; }`,
  "git -c core.hooksPath=/dev/null rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo '@@fail the working copy is not a git folder'; exit 1; }",
  "export GIT_ATTR_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0",
  "FA=()",
  'while IFS= read -r key; do name=${key#filter.}; name=${name%.*}; FA+=(-c "filter.$name.clean=" -c "filter.$name.smudge=" -c "filter.$name.process=" -c "filter.$name.required=false"); done < <(git -c core.hooksPath=/dev/null config --name-only --get-regexp \'^filter[.].*[.](clean|smudge|process)$\' 2>/dev/null | sort -u)',
  'G() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c commit.gpgsign=false -c core.pager=cat ${FA[@]+"${FA[@]}"} "$@"; }',
  'N() { GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=http.extraheader GIT_CONFIG_VALUE_0="Authorization: Basic $(printf \'x-access-token:%s\' "$TOK" | base64 | tr -d \'\\n\')" GIT_CONFIG_KEY_1=credential.helper GIT_CONFIG_VALUE_1= G -c http.proxy= "$@"; }',
  `URL=${quote(remote)}`,
  `[ "$(G branch --show-current)" = ${quote(copy.branch)} ] || { echo "@@fail the working copy is on $(G branch --show-current), not ${copy.branch}"; exit 1; }`,
];

/** The most scan text read per section; a bigger change or history is refused, as it cannot be checked. */
export const SCAN_LIMIT = 8_000_000;
/** The most commits whose patches are read. */
export const MAX_COMMITS = 500;
/** A binary file this small is not worth a confirmation (an icon, a font subset). */
export const BINARY_SCAN_FREE = 4096;

const B64 = String.raw`$(printf %s "$f" | base64 | tr -d '\n')`;

/**
 * Reads the copy without changing it: the change against main in a scratch index (so the copy's own staging area
 * is untouched), how far ahead it is, and the text for two scans: the change (per file, with paths as base64, so a
 * name with a quote, a tab or a newline is exact) and every commit that would be pushed (messages and patches).
 */
export function inspectScript(copy: ShipCopy, remote: string): string {
  check(copy, remote);
  return [
    "set -u",
    ...enter(copy, remote),
    `N fetch --quiet "$URL" ${quote(`+refs/heads/${copy.base}:refs/remotes/origin/${copy.base}`)} 2>/dev/null || echo '@@warn could not fetch ${copy.base}'`,
    `base=origin/${copy.base}`,
    'G rev-parse --verify --quiet "$base" >/dev/null || base=$(G rev-list --max-parents=0 HEAD | tail -n 1)',
    'mb=$(G merge-base "$base" HEAD 2>/dev/null || echo "$base")',
    'echo "@@head $(G rev-parse HEAD)"',
    'echo "@@ahead $(G rev-list --count "$base"..HEAD 2>/dev/null || echo 0)"',
    `echo "@@remote $(N ls-remote "$URL" ${quote(`refs/heads/${copy.branch}`)} 2>/dev/null | cut -f1)"`,
    "idx=$(mktemp); trap 'rm -f \"$idx\"' EXIT",
    'export GIT_INDEX_FILE="$idx"',
    "G read-tree HEAD",
    "G add -A -- . ':(exclude).inc'",
    // What is not committed yet: the scratch index against HEAD.
    `G diff --cached --name-only -z --no-renames --no-ext-diff HEAD | while IFS= read -r -d '' f; do printf '@@dirty %s\\n' "${B64}"; done`,
    "echo @@net-begin",
    "{",
    "  while IFS= read -r -d '' rec; do",
    "    a=${rec%%$'\\t'*}; rest=${rec#*$'\\t'}; d=${rest%%$'\\t'*}; f=${rest#*$'\\t'}",
    `    printf '@@file %s %s %s\\n' "$a" "$d" "${B64}"`,
    '    if [ "$a" = "-" ]; then',
    '      size=$(G cat-file -s ":0:$f" 2>/dev/null || echo 0)',
    `      printf '@@binary %s %s\\n' "${B64}" "$size"`,
    "    fi",
    '    mode=$(G ls-files -s -- ":(literal)$f" | cut -c1-6)',
    '    if [ "$mode" = 120000 ]; then',
    '      t=$(G cat-file -p ":0:$f" 2>/dev/null)',
    `      case "$t" in /*) printf '@@abslink %s\\n' "${B64}" ;; esac`,
    "    fi",
    '    if [ "$a" != "-" ] && [ "$a" != 0 ]; then',
    `      printf '@@scan %s\\n' "${B64}"`,
    '      G diff --cached -U0 --no-color --no-renames --no-ext-diff --no-textconv "$mb" -- ":(literal)$f"',
    "      echo",
    "    fi",
    '  done < <(G diff --cached --numstat -z --no-renames --no-ext-diff "$mb")',
    `} | head -c ${SCAN_LIMIT + 1}`,
    "echo",
    "echo @@net-end",
    // Everything a push would publish: each commit's message and patch, not only where the branch ends up.
    "echo @@hist-begin",
    'echo "@@commits-total $(G rev-list --count "$base"..HEAD 2>/dev/null || echo 0)"',
    "{",
    `  G rev-list "$base"..HEAD 2>/dev/null | head -n ${MAX_COMMITS} | while IFS= read -r sha; do`,
    "    printf '@@commit %s\\n' \"$sha\"",
    "    printf '@@msg %s\\n' \"$(G log -1 --format=%B \"$sha\" | base64 | tr -d '\\n')\"",
    '    G show -m -U0 --no-color --no-renames --no-ext-diff --no-textconv --format= "$sha" --',
    "  done",
    `} | head -c ${SCAN_LIMIT + 1}`,
    "echo",
    "echo @@hist-end",
  ].join("\n");
}

/** Stages everything but `.inc/` (the owner's images) and commits it; says whether there was anything to commit. */
export function commitScript(copy: ShipCopy, remote: string, message: string): string {
  check(copy, remote);
  const b64 = Buffer.from(message, "utf8").toString("base64");
  return [
    "set -e",
    ...enter(copy, remote),
    "G add -A -- . ':(exclude).inc'",
    "if G diff --cached --quiet; then",
    "  echo @@nothing",
    "else",
    // The checks and the review that follow are the gate; a hook of the project's must not run here at all.
    `  G commit --quiet --no-verify -m "$(printf %s ${quote(b64)} | base64 -d)"`,
    "  echo @@committed",
    "fi",
    'echo "@@head $(G rev-parse HEAD)"',
  ].join("\n");
}

/**
 * Pushes `sha`, the commit that was scanned, to the branch: if the copy has moved on since, it doesn't. A branch
 * GitHub has moved on is never overwritten.
 */
export function pushScript(copy: ShipCopy, remote: string, sha: string): string {
  check(copy, remote);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a commit: ${sha}`);
  return [
    "set -u",
    ...enter(copy, remote),
    `[ "$(G rev-parse HEAD)" = ${quote(sha)} ] || { echo '@@fail the working copy changed after it was checked, so nothing was pushed'; exit 1; }`,
    `if out=$(N push --quiet "$URL" ${quote(`${sha}:refs/heads/${copy.branch}`)} 2>&1); then`,
    `  echo ${quote(`@@pushed ${sha}`)}`,
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
  /(^|\/)[._]netrc$/,
  /(^|\/)\.pypirc$/,
];

/** More kinds of credential than the transcript redactor names: live payment keys, npm auth, .netrc logins. */
const extraCredential = [
  /\b[sr]k_live_[A-Za-z0-9]{16,}/,
  /_authToken\s*=\s*(?!\$\{)[^\s"']{8,}/,
  /\bmachine\s+\S+\s+(?:login\s+\S+\s+)?password\s+\S{4,}/,
];

/** `redactTokens` stops at a million characters, so a long text is looked at in pieces of whole lines. */
function holdsCredential(added: string): boolean {
  const piece = 400_000;
  let chunk = "";
  const looks = (t: string) =>
    t.length > 0 && (redactTokens(t) !== t || extraCredential.some((re) => re.test(t)));
  for (const line of added.split("\n")) {
    if (chunk.length + line.length + 1 > piece) {
      if (looks(chunk)) return true;
      chunk = "";
    }
    chunk += `${line}\n`;
  }
  return looks(chunk);
}

/**
 * The added lines of a patch, joined. File headers (`---`, `+++`, `index`, `diff --git`) are skipped by state,
 * not by looking at what a line says: they come before a hunk's first `@@ ` line, and a content line always
 * starts with `+`, `-`, a space or a backslash, so no content can pass itself off as a header or the reverse.
 */
export function addedLines(patch: string): string {
  const out: string[] = [];
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("diff --cc ") ||
      line.startsWith("diff --combined ")
    ) {
      inHunk = false;
    } else if (!inHunk) {
      if (line.startsWith("@@ ")) inHunk = true;
    } else if (line.startsWith("@@ ")) {
      // the next hunk
    } else if (line.startsWith("+")) {
      out.push(line.slice(1));
    }
  }
  return out.join("\n");
}

/** Does this patch add a credential? */
export const scanPatch = (patch: string): boolean => holdsCredential(addedLines(patch));

const decode = (b64: string): string | undefined =>
  /^[A-Za-z0-9+/]*={0,2}$/.test(b64) ? Buffer.from(b64, "base64").toString("utf8") : undefined;

/** The text between two markers, or undefined. */
function section(output: string, name: string): string | undefined {
  const begin = new RegExp(`(^|\\n)@@${name}-begin\\n`).exec(output);
  if (!begin) return undefined;
  const from = begin.index + begin[0].length;
  const end = output.indexOf(`\n@@${name}-end`, from);
  return end < 0 ? undefined : output.slice(from, end);
}

/** Reads `inspectScript`'s output. Anything it can't read is a reason to stop, never a reason to go on. */
export function readInspect(copy: ShipCopy, output: string): CopyReport {
  const head = (tag: string) =>
    new RegExp(`^@@${tag} (.*)$`, "m").exec(output.split("\n@@net-begin")[0] ?? "")?.[1] ?? "";
  const net = section(output, "net");
  const hist = section(output, "hist");
  const files: FileChange[] = [];
  const unscanned: string[] = [];
  const unsafe: { path: string; why: string }[] = [];
  const binaries: { path: string; size: number }[] = [];
  const secrets: { path: string; kind: string }[] = [];
  let tooBig = net === undefined || hist === undefined || net.length > SCAN_LIMIT || hist.length > SCAN_LIMIT;

  // The change, file by file.
  const scanned = new Map<string, string[]>();
  let current: string[] | undefined;
  const wanted = new Set<string>();
  for (const line of (net ?? "").split("\n")) {
    const m = /^@@(file|binary|abslink|scan) (.*)$/.exec(line);
    if (!m) {
      current?.push(line);
      continue;
    }
    current = undefined;
    const rest = (m[2] ?? "").split(" ");
    if (m[1] === "file") {
      const [a = "", d = "", b64 = ""] = rest;
      const path = decode(b64);
      if (path === undefined || path === "") {
        unscanned.push("a file whose name could not be read");
        continue;
      }
      const added = Number(a);
      files.push(
        a === "-" || d === "-"
          ? { path, added: 0, removed: 0, binary: true }
          : { path, added: added || 0, removed: Number(d) || 0 },
      );
      if (a !== "-" && added > 0) wanted.add(path);
    } else if (m[1] === "binary") {
      const path = decode(rest[0] ?? "");
      const size = Number(rest[1]);
      if (path === undefined) unscanned.push("a binary file whose name could not be read");
      else if (!(size <= BINARY_SCAN_FREE)) binaries.push({ path, size: Number.isFinite(size) ? size : 0 });
    } else if (m[1] === "abslink") {
      const path = decode(rest[0] ?? "");
      unsafe.push({ path: path ?? "a link", why: "is a link to an absolute path outside the project" });
    } else {
      const path = decode(rest[0] ?? "");
      if (path === undefined) {
        unscanned.push("a file whose name could not be read");
        continue;
      }
      current = [];
      scanned.set(path, current);
    }
  }
  for (const path of wanted) if (!scanned.has(path)) unscanned.push(path);
  for (const f of files) {
    if (secretFile.some((re) => re.test(f.path)))
      secrets.push({ path: f.path, kind: "a file that usually holds secrets" });
  }
  for (const [path, lines] of scanned) {
    if (secrets.some((s) => s.path === path)) continue;
    if (scanPatch(lines.join("\n"))) secrets.push({ path, kind: "a token, key or password" });
  }

  // The history, commit by commit.
  const total = Number(/^@@commits-total (\d+)/m.exec(hist ?? "")?.[1] ?? 0);
  if (total > MAX_COMMITS) tooBig = true;
  for (const block of (hist ?? "").split(/^@@commit /m).slice(1)) {
    const nl = block.indexOf("\n");
    const sha = block.slice(0, nl < 0 ? undefined : nl).trim();
    const body = nl < 0 ? "" : block.slice(nl + 1);
    const msgLine = /^@@msg (.*)$/m.exec(body);
    const message = msgLine ? decode(msgLine[1] ?? "") : undefined;
    const patch = body.replace(/^@@msg .*\n?/m, "");
    if (!/^[0-9a-f]{7,40}$/.test(sha) || message === undefined) {
      unscanned.push("a commit that could not be read");
      continue;
    }
    if (holdsCredential(message) || scanPatch(patch)) {
      secrets.push({ path: `commit ${sha.slice(0, 7)}`, kind: "a commit in the branch's history" });
    }
  }

  return {
    head: head("head").trim(),
    files,
    uncommitted: [...output.matchAll(/^@@dirty (\S*)$/gm)].flatMap((m) => {
      const p = decode(m[1] ?? "");
      return p ? [p] : [];
    }),
    ahead: Number(head("ahead")) || 0,
    remote: head("remote").trim(),
    protectedPaths: files.map((f) => f.path).filter((p) => isProtected(p, copy.protectedPaths)),
    secrets,
    unscanned,
    unsafe,
    binaries,
    tooBig,
  };
}

/** What stops a copy from being shipped, one sentence each (never a value). Empty: nothing does. */
export function blockers(r: Pick<CopyReport, "secrets" | "unscanned" | "unsafe" | "tooBig">): string[] {
  const out: string[] = [];
  const files = r.secrets.filter((s) => !s.path.startsWith("commit "));
  const commits = r.secrets.filter((s) => s.path.startsWith("commit "));
  if (files.length) {
    out.push(
      `${files.map((s) => s.path).join(", ")} look${files.length === 1 ? "s" : ""} like ${files.length === 1 ? "it holds" : "they hold"} a credential`,
    );
  }
  if (commits.length) {
    out.push(
      `${commits.map((s) => s.path).join(", ")} in the branch's history ${commits.length === 1 ? "holds" : "hold"} a credential (a push publishes every commit, even one a later commit undid)`,
    );
  }
  if (r.unscanned.length) out.push(`${r.unscanned.join(", ")} could not be read to check for credentials`);
  for (const u of r.unsafe) out.push(`${u.path} ${u.why}`);
  if (r.tooBig) out.push("the change or its history is too big to check for credentials");
  return out;
}

/** The sentence for a change the scan stopped. */
export function secretsSentence(
  r: Pick<CopyReport, "secrets" | "unscanned" | "unsafe" | "tooBig">,
  did = "committed",
): string {
  const history = r.secrets.some((s) => s.path.startsWith("commit "));
  const fix = history
    ? "Take the credential out of the branch's history (or start the work again on a fresh branch) and revoke it: it was written down."
    : "Take it out (keep secrets in the environment, never in files), then try again.";
  return `Nothing was ${did}: ${blockers(r).join("; ")}. ${fix}`;
}

export interface ShipKit {
  tokens: TokenSource;
  run: RunScript;
  prs: ShipPrs;
  /** Where the repo is fetched from and pushed to; tests use a path. Default: github.com. */
  remote?: (repo: string) => string;
}

export function conversationShip(kit: ShipKit): ShipPort {
  const remoteOf = (copy: ShipCopy) => kit.remote?.(copy.repo) ?? `https://github.com/${copy.repo}.git`;
  // The token goes only to a script that talks to GitHub (the inspect's fetch, and the push), where the script
  // takes it out of its environment before anything else runs.
  const exec = async (copy: ShipCopy, script: string, network: boolean) =>
    kit.run(copy.employee.id, script, network ? { GH_TOKEN: await kit.tokens.token(copy.repo) } : {});
  const why = (r: { output: string }, doing: string) => {
    const fail = /^@@fail (.+)$/m.exec(r.output)?.[1];
    return `Couldn't ${doing}: ${fail ?? tail(r.output)}`;
  };
  const inspect = async (copy: ShipCopy): Promise<CopyReport> => {
    const r = await exec(copy, inspectScript(copy, remoteOf(copy)), true);
    if (r.code !== 0 || !r.output.includes("@@hist-end")) {
      throw new ShipRefusal(why(r, "look at the working copy"), "git");
    }
    return readInspect(copy, r.output);
  };
  const verify = async (copy: ShipCopy, did = "committed"): Promise<CopyReport> => {
    const report = await inspect(copy);
    if (blockers(report).length) throw new ShipRefusal(secretsSentence(report, did), "secrets");
    return report;
  };
  return {
    inspect,
    verify: (copy) => verify(copy, "shipped"),
    prs: kit.prs,
    async commit(copy, message) {
      await verify(copy, "committed");
      const r = await exec(copy, commitScript(copy, remoteOf(copy), message), false);
      const head = /^@@head ([0-9a-f]{7,40})$/m.exec(r.output)?.[1];
      if (r.code !== 0 || !head) throw new ShipRefusal(why(r, "commit the changes"), "git");
      return { committed: r.output.includes("@@committed"), head };
    },
    async push(copy) {
      // The last gate: what is about to be published, commit by commit, and the exact commit that is pushed.
      const report = await verify(copy, "pushed");
      if (!/^[0-9a-f]{40}$/.test(report.head))
        throw new ShipRefusal("Couldn't read the working copy's commit.", "git");
      const r = await exec(copy, pushScript(copy, remoteOf(copy), report.head), true);
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
