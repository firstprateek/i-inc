// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell scripts, not templates
// The git side of shipping a conversation's work (T62b): look at the conversation's working copy, commit
// what is uncommitted, and push its branch as the bot. Every script runs in the employee's team machine,
// except the push itself: the machine holds no write credential (T68), so the push is the host's, from a
// bundle of exactly the commit that was scanned (bundle.ts, host-push.ts).
// Nothing leaves the sandbox before the daemon has read the change and found no credential in it: the
// scan reuses the patterns that redact transcripts (`redactTokens`, ahp/sanitize.ts), and a file that
// usually holds secrets (.env, a private key) stops it by name. Findings name the file, never the value.
import { randomBytes } from "node:crypto";
import type { Employee } from "@i-inc/core";
import { redactTokens } from "./ahp/sanitize.ts";
import type { DraftPr, PullRequests, TokenSource } from "./github.ts";
import type { RunScript } from "./harness.ts";
import { type HostPush, HostPushError } from "./host-push.ts";
import { isProtected } from "./paths.ts";
import { pushFromSandbox } from "./sandbox-push.ts";
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
export type ShipPrs = Pick<PullRequests, "find" | "openDraft" | "get" | "checks" | "setBody" | "close">;

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
   * nothing is committed. `scanned`: the caller has just inspected the copy and found it clean, so the scan is not
   * done again (the push, or `verify`, still scans everything that is sent on, the new commit included).
   * Returns the commit the copy is on.
   */
  commit(
    copy: ShipCopy,
    message: string,
    opts?: { scanned?: boolean },
  ): Promise<{ committed: boolean; head: string }>;
  /** Scans exactly what will be pushed, then has the host push that commit as the bot, never forcing. */
  push(copy: ShipCopy): Promise<{ head: string }>;
  prs: ShipPrs;
}

/** The remote shipping talks to: GitHub's address of the repo, or (tests) a path. */
const SAFE_REMOTE = /^(https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.git|\/[A-Za-z0-9._/-]+)$/;

function check(copy: ShipCopy, remote?: string): void {
  if (!isSafeWorkDir(copy.cwd)) throw new Error(`not a safe folder: ${String(copy.cwd)}`);
  if (!isSafeRefName(copy.branch)) throw new Error(`not a branch name: ${String(copy.branch)}`);
  if (!isSafeRefName(copy.base)) throw new Error(`not a branch name: ${String(copy.base)}`);
  if (remote !== undefined && !SAFE_REMOTE.test(remote)) throw new Error(`not a remote: ${remote}`);
}

/**
 * What every script starts with: into the copy, on the branch it should be on; then git made safe to run in a
 * folder an agent has been working in. Every git call in the copy goes through `G`: no hooks (`--no-verify`
 * doesn't stop prepare-commit-msg, post-commit or pre-push), no fsmonitor, no signing program, no replace
 * objects (`git replace` can show the scan a different history from the one a push sends), and each `filter.*`
 * driver in the config (an agent's clean or smudge command would run on `git add`) set to nothing. The bot's
 * token is taken out of the environment first and goes to one place only, `NC`: see `cleanRepo`.
 */
const enter = (copy: ShipCopy, remote: string) => [
  'TOK="${GH_TOKEN:-}"; unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GH_HOST',
  `cd ${quote(copy.cwd)} || { echo '@@fail the working copy is not there'; exit 1; }`,
  // Git gets an allow-listed environment, never this script's own: PATH, a locale, a home that is empty, and
  // what is named here. Nothing else (GIT_DIR, GIT_NAMESPACE, GIT_COMMON_DIR, GIT_SSH_COMMAND...) gets through.
  `W=$(mktemp -d); trap 'rm -rf "$W"' EXIT; mkdir "$W/home"`,
  'BE=(env -i PATH="$PATH" LANG=C.UTF-8 HOME="$W/home" GIT_CONFIG_NOSYSTEM=1 GIT_ATTR_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0)',
  "GX=()",
  "\"${BE[@]}\" git -c core.hooksPath=/dev/null rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo '@@fail the working copy is not a git folder'; exit 1; }",
  "FA=()",
  'while IFS= read -r key; do name=${key#filter.}; name=${name%.*}; FA+=(-c "filter.$name.clean=" -c "filter.$name.smudge=" -c "filter.$name.process=" -c "filter.$name.required=false"); done < <("${BE[@]}" git -c core.hooksPath=/dev/null config --name-only --get-regexp \'^filter[.].*[.](clean|smudge|process)$\' 2>/dev/null | sort -u)',
  'G() { "${BE[@]}" ${GX[@]+"${GX[@]}"} git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c commit.gpgsign=false -c core.pager=cat ${FA[@]+"${FA[@]}"} "$@"; }',
  `URL=${quote(remote)}`,
  `[ "$(G branch --show-current)" = ${quote(copy.branch)} ] || { echo "@@fail the working copy is on $(G branch --show-current), not ${copy.branch}"; exit 1; }`,
];

/**
 * A clean repository for everything that reads history or touches the network, so nothing in the copy's own
 * `.git` can reach either: a fresh bare repo with no template and a config this script writes (nothing from the
 * system or the user, an empty home), whose only objects are the copy's, through `objects/info/alternates`, and
 * whose only ref (`refs/heads/ship`) is `sha`: the one commit that is scanned and pushed. `sha` is fixed before
 * the scan (a value the caller holds, or the copy's HEAD read once here) and nothing reads HEAD or the branch
 * again, so the branch moving under the script changes nothing. The copy's config (`url.*.insteadOf`,
 * `core.sshCommand`, `push.followTags`, `push.recurseSubmodules`, credential helpers, proxies), refs (tags),
 * replace objects, grafts and shallow file are not in it. `C` runs git there; `NC` is `C` with the bot's token for
 * one command, as an Authorization header for `$URL`, with no credential helper, no proxy and no ssh.
 */
const cleanRepo = (sha: string) => [
  '"${BE[@]}" GIT_CONFIG_GLOBAL=/dev/null git init --bare -q --template= "$W/repo" || { echo \'@@fail could not make a scratch repository\'; exit 1; }',
  'CE=("${BE[@]}" GIT_DIR="$W/repo" GIT_CONFIG_GLOBAL=/dev/null)',
  'C() { "${CE[@]}" git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.pager=cat "$@"; }',
  'NC() { "${CE[@]}" GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=http.extraheader GIT_CONFIG_VALUE_0="Authorization: Basic $(printf \'x-access-token:%s\' "$TOK" | base64 | tr -d \'\\n\')" GIT_CONFIG_KEY_1=credential.helper GIT_CONFIG_VALUE_1= git -c http.proxy= -c core.hooksPath=/dev/null -c push.followTags=false -c push.recurseSubmodules=no "$@"; }',
  'printf "%s\\n" "$(G rev-parse --path-format=absolute --git-common-dir)/objects" > "$W/repo/objects/info/alternates"',
  "C config push.followTags false; C config push.recurseSubmodules no; C config core.fsmonitor false",
  `SHA=${sha}`,
  'C cat-file -e "$SHA^{commit}" 2>/dev/null && C update-ref refs/heads/ship "$SHA" || { echo \'@@fail the commit to ship is not in the working copy\'; exit 1; }',
];

/** The most scan text read per section; a bigger change or history is refused, as it cannot be checked. */
export const SCAN_LIMIT = 8_000_000;
/** The most commits whose patches are read. */
export const MAX_COMMITS = 500;
/** A binary file this small is not worth a confirmation (an icon, a font subset). */
export const BINARY_SCAN_FREE = 4096;

/** A marker only this run knows: what an agent can put in a file name, a commit message or a patch can't pass for one. */
export const marker = (nonce: string, name: string) => `@@${nonce}-${name}`;

/**
 * Reads the copy without changing it, in a fixed number of git commands however many files changed: the change
 * against main in a scratch index (so the copy's own staging area is untouched), how far ahead it is, and the
 * text for two scans: the change (one `numstat`, one `raw`, one patch, one batch of object sizes) and every
 * commit that would be pushed (one `log -p` in the clean repository, messages and patches). Sections are fenced
 * by markers that carry `nonce`, so no name, message or patch can forge one.
 */
export function inspectScript(copy: ShipCopy, remote: string, nonce: string): string {
  check(copy, remote);
  if (!/^[0-9a-f]{16,64}$/.test(nonce)) throw new Error("not a nonce");
  const m = (name: string) => marker(nonce, name);
  const section = (name: string, body: string) => [
    `echo ${m(`${name}-begin`)}`,
    body,
    "echo",
    `echo ${m(`${name}-end`)}`,
  ];
  const diffOpts = "--no-color --no-renames --no-ext-diff --no-textconv --text";
  return [
    "set -u",
    ...enter(copy, remote),
    ...cleanRepo("$(G rev-parse HEAD)"),
    `NC fetch --quiet "$URL" ${quote(`+refs/heads/${copy.base}:refs/heads/base`)} 2>/dev/null || echo '@@warn could not fetch ${copy.base}'`,
    "if C rev-parse --verify --quiet refs/heads/base >/dev/null; then base=refs/heads/base; else base=$(C rev-list --max-parents=0 refs/heads/ship | tail -n 1); fi",
    'mb=$(C merge-base "$base" refs/heads/ship 2>/dev/null || echo "$base")',
    // The base's objects are in the clean repo: let the copy read them too, without changing the copy.
    'GX=(GIT_ALTERNATE_OBJECT_DIRECTORIES="$W/repo/objects")',
    'echo "@@head $SHA"',
    'echo "@@ahead $(C rev-list --count "$base"..refs/heads/ship 2>/dev/null || echo 0)"',
    `echo "@@remote $(NC ls-remote "$URL" ${quote(`refs/heads/${copy.branch}`)} 2>/dev/null | cut -f1)"`,
    'GX+=(GIT_INDEX_FILE="$W/index")',
    'G read-tree "$SHA"',
    "G add -A -- . ':(exclude).inc'",
    ...section("dirty", 'G diff --cached --name-only -z --no-renames --no-ext-diff "$SHA"'),
    ...section("numstat", 'G diff --cached --numstat -z --no-renames --no-ext-diff "$mb"'),
    'G diff --cached --raw -z --abbrev=40 --no-renames --no-ext-diff "$mb" > "$W/raw"',
    ...section("raw", 'cat "$W/raw"'),
    // New object of each changed file, in the same order: its size, in one command; and which are links to an absolute path.
    ': > "$W/shas"; : > "$W/abs"; i=0',
    "while IFS= read -r -d '' meta && IFS= read -r -d '' _path; do",
    "  set -- $meta",
    '  echo "$4" >> "$W/shas"',
    '  if [ "$2" = 120000 ]; then t=$(G cat-file -p "$4" 2>/dev/null | head -c 1); [ "$t" = "/" ] && echo "$i" >> "$W/abs"; fi',
    "  i=$((i+1))",
    'done < "$W/raw"',
    ...section("sizes", "G cat-file --batch-check='%(objectsize)' < \"$W/shas\""),
    ...section("abs", 'cat "$W/abs"'),
    ...section("patch", `G diff --cached -U0 ${diffOpts} "$mb" | head -c ${SCAN_LIMIT + 1}`),
    // Everything a push would publish: each commit's message and patch, not only where the branch ends up.
    `echo ${m("hist-begin")}`,
    'echo "@@total $(C rev-list --count "$base"..refs/heads/ship 2>/dev/null || echo 0)"',
    `C log -m -U0 ${diffOpts} --max-count=${MAX_COMMITS + 1} --format=${quote(`${m("commit")} %H%n${m("msg-begin")}%n%B%n${m("msg-end")}`)} "$base"..refs/heads/ship 2>/dev/null | head -c ${SCAN_LIMIT + 1}`,
    "echo",
    `echo ${m("hist-end")}`,
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

const tail = (output: string) => output.trim().split("\n").slice(-4).join(" ").slice(0, 300);

/** A file that usually holds secrets, by its name. */
export const secretFile = [
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
export function holdsCredential(added: string): boolean {
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

/** The text between two of this run's markers, or undefined. */
function section(output: string, nonce: string, name: string): string | undefined {
  const begin = `\n${marker(nonce, `${name}-begin`)}\n`;
  const at = `\n${output}`.indexOf(begin);
  if (at < 0) return undefined;
  const from = at + begin.length - 1;
  const end = output.indexOf(`\n${marker(nonce, `${name}-end`)}`, from);
  return end < 0 ? undefined : output.slice(from, end);
}

/** Splits a patch into one block per file, at each `diff --git` header (a content line never starts with one). */
function patchBlocks(patch: string): string[] {
  const blocks: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) blocks.push(line);
    else if (blocks.length) blocks[blocks.length - 1] += `\n${line}`;
  }
  return blocks;
}

/**
 * Reads the history section (`@@total N`, then each commit's `commit` marker, sha, message and patch, fenced by
 * markers that carry `nonce`) for credentials: which commits hold one, which could not be read, and whether
 * there were too many commits to look at. The host's push uses it on the commits a bundle brings (host-push.ts).
 */
export function scanHistory(
  hist: string,
  nonce: string,
): { secrets: { path: string; kind: string }[]; unscanned: string[]; tooBig: boolean } {
  const secrets: { path: string; kind: string }[] = [];
  const unscanned: string[] = [];
  const total = Number(/^@@total (\d+)/m.exec(hist)?.[1] ?? 0);
  const tooBig = total > MAX_COMMITS;
  const commitMark = marker(nonce, "commit");
  for (const block of hist.split(new RegExp(`^${commitMark} `, "m")).slice(1)) {
    const nl = block.indexOf("\n");
    const sha = block.slice(0, nl < 0 ? undefined : nl).trim();
    const rest = nl < 0 ? "" : block.slice(nl + 1);
    const mb = `${marker(nonce, "msg-begin")}\n`;
    const me = `\n${marker(nonce, "msg-end")}`;
    const from = rest.indexOf(mb);
    const to = rest.indexOf(me, from);
    if (!/^[0-9a-f]{7,40}$/.test(sha) || from < 0 || to < 0) {
      unscanned.push("a commit that could not be read");
      continue;
    }
    const message = rest.slice(from + mb.length, to);
    const patchText = rest.slice(to + me.length);
    if (holdsCredential(message) || scanPatch(patchText)) {
      secrets.push({ path: `commit ${sha.slice(0, 7)}`, kind: "a commit in the branch's history" });
    }
  }
  return { secrets, unscanned, tooBig };
}

/**
 * Reads `inspectScript`'s output. Anything it can't read is a reason to stop, never a reason to go on. The
 * files come from `numstat` and `raw` (NUL-separated, so a name is exact), and the patch's blocks are matched
 * to them by position, never by reading a name out of a patch header: the two lists must agree.
 */
export function readInspect(copy: ShipCopy, output: string, nonce: string): CopyReport {
  const head = (tag: string) =>
    new RegExp(`^@@${tag} (.*)$`, "m").exec(
      output.split(`\n${marker(nonce, "dirty-begin")}`)[0] ?? "",
    )?.[1] ?? "";
  const sec = (name: string) => section(output, nonce, name);
  const files: FileChange[] = [];
  const unscanned: string[] = [];
  const unsafe: { path: string; why: string }[] = [];
  const binaries: { path: string; size: number }[] = [];
  const secrets: { path: string; kind: string }[] = [];
  const hist = sec("hist");
  const patch = sec("patch");
  const numstat = sec("numstat");
  const raw = sec("raw");
  const sizes = sec("sizes");
  const abs = sec("abs");
  let tooBig =
    [numstat, raw, sizes, abs, patch, hist].some((x) => x === undefined) ||
    (patch?.length ?? 0) > SCAN_LIMIT ||
    (hist?.length ?? 0) > SCAN_LIMIT;

  // numstat -z: `added TAB removed TAB path NUL`. raw -z: `:modes shas status NUL path NUL`.
  const stat = (numstat ?? "")
    .split("\0")
    .filter((r) => r !== "")
    .map((r) => {
      const t1 = r.indexOf("\t");
      const t2 = r.indexOf("\t", t1 + 1);
      return { a: r.slice(0, t1), d: r.slice(t1 + 1, t2), path: r.slice(t2 + 1) };
    });
  const rawTokens = (raw ?? "").split("\0");
  const entries: { path: string }[] = [];
  for (let i = 0; i + 1 < rawTokens.length; i += 2) {
    if (!(rawTokens[i] ?? "").startsWith(":")) break;
    entries.push({ path: rawTokens[i + 1] ?? "" });
  }
  const blocks = patchBlocks(patch ?? "");
  const agree =
    stat.length === entries.length &&
    stat.every((s, i) => s.path === entries[i]?.path && s.path !== "") &&
    blocks.length === stat.length;
  if (!agree && numstat !== undefined) unscanned.push("the change (its files could not be matched up)");
  const sizeLines = (sizes ?? "").split("\n").filter((l) => l !== "");
  const absAt = new Set((abs ?? "").split("\n").filter(Boolean).map(Number));

  stat.forEach((r, i) => {
    const path = r.path;
    const binary = r.a === "-" || r.d === "-";
    files.push(
      binary
        ? { path, added: 0, removed: 0, binary: true }
        : { path, added: Number(r.a) || 0, removed: Number(r.d) || 0 },
    );
    if (absAt.has(i)) unsafe.push({ path, why: "is a link to an absolute path outside the project" });
    if (binary) {
      const size = Number(sizeLines[i]);
      if (!(size <= BINARY_SCAN_FREE)) binaries.push({ path, size: Number.isFinite(size) ? size : 0 });
    }
    if (secretFile.some((re) => re.test(path))) {
      secrets.push({ path, kind: "a file that usually holds secrets" });
    } else if (agree && (binary || Number(r.a) > 0) && scanPatch(blocks[i] ?? "")) {
      secrets.push({ path, kind: "a token, key or password" });
    }
  });

  // The history, commit by commit.
  const h = scanHistory(hist ?? "", nonce);
  if (h.tooBig) tooBig = true;
  unscanned.push(...h.unscanned);
  secrets.push(...h.secrets);

  return {
    head: head("head").trim(),
    files,
    uncommitted: (sec("dirty") ?? "").split("\0").filter((p) => p !== ""),
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
  /** Where the repo is fetched from; tests use a path. Default: github.com. */
  remote?: (repo: string) => string;
  /** Pushes the bundle a machine hands over. Without it nothing is pushed. */
  host?: HostPush;
}

export function conversationShip(kit: ShipKit): ShipPort {
  const remoteOf = (copy: ShipCopy) => kit.remote?.(copy.repo) ?? `https://github.com/${copy.repo}.git`;
  // A read-only token goes only to a script that talks to GitHub (the inspect's fetch), where the script takes it
  // out of its environment before anything else runs. Nothing in a machine can push.
  const exec = async (copy: ShipCopy, script: string, network: boolean) =>
    kit.run(copy.employee.id, script, network ? { GH_TOKEN: await kit.tokens.readToken([copy.repo]) } : {});
  const why = (r: { output: string }, doing: string) => {
    const fail = /^@@fail (.+)$/m.exec(r.output)?.[1];
    return `Couldn't ${doing}: ${fail ?? tail(r.output)}`;
  };
  const inspect = async (copy: ShipCopy): Promise<CopyReport> => {
    const nonce = randomBytes(16).toString("hex");
    const r = await exec(copy, inspectScript(copy, remoteOf(copy), nonce), true);
    if (r.code !== 0 || !r.output.includes(marker(nonce, "hist-end"))) {
      throw new ShipRefusal(why(r, "look at the working copy"), "git");
    }
    return readInspect(copy, r.output, nonce);
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
    async commit(copy, message, opts) {
      if (opts?.scanned !== true) await verify(copy, "committed");
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
      try {
        await pushFromSandbox({
          host: kit.host,
          run: (script) => kit.run(copy.employee.id, script),
          worktree: copy.cwd,
          sha: report.head,
          req: { repo: copy.repo, branch: copy.branch, defaultBranch: copy.base },
          baseBranches: [copy.base, copy.branch],
        });
      } catch (e) {
        if (!(e instanceof HostPushError)) throw e;
        if (e.kind === "behind") {
          throw new ShipRefusal(
            `GitHub's copy of ${copy.branch} has changes this working copy doesn't, so it wasn't pushed. Nothing was overwritten.`,
            "diverged",
          );
        }
        if (e.kind === "secrets") throw new ShipRefusal(e.message, "secrets");
        if (e.kind === "too-big") throw new ShipRefusal(`Couldn't push the branch: ${e.message}`, "too-big");
        throw new ShipRefusal(`Couldn't push the branch: ${e.message}`, "git");
      }
      return { head: report.head };
    },
  };
}

export type { DraftPr };
