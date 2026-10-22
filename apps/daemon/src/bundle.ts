// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell scripts, not templates
// How a sandbox hands a commit to the host (T68). A sandbox never holds a credential that can write, so it
// can't push. Instead a script in the sandbox packs EXACTLY one commit (and the history GitHub lacks) into a
// git bundle and prints it, base64, between markers only this run knows; the host (host-push.ts) checks the
// bundle and pushes from its own mirror with a token that never leaves the daemon.
//
// The bundle is built from a sha the caller holds, in a clean repository whose only ref is that sha and whose
// objects are the working copy's by alternates (the approach of ship-git.ts's `cleanRepo`): the working copy's
// own config, refs, grafts and replace objects play no part, and a branch that moves while this runs changes
// nothing. The script has no network and no token.
import { randomBytes } from "node:crypto";
import { isSafeRefName, isSafeWorkDir } from "./workspace.ts";

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/**
 * The most a bundle may weigh (before base64): it travels as the script's output, which is capped at 16 MB
 * (harness.ts), and base64 adds a third. Bigger: refused, nothing pushed.
 */
export const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;

/** A fresh marker nonce for one bundling run. */
export const newNonce = (): string => randomBytes(16).toString("hex");

const SHA = /^[0-9a-f]{40}$/;
/** A base the host hints at (a sha it has) or a ref of the working copy's own (`refs/remotes/origin/main`). */
const BASE = /^(?:[0-9a-f]{40}|refs\/remotes\/origin\/[A-Za-z0-9._/-]{1,200})$/;

/** The remote-tracking ref of a branch in a working copy, as a base for a bundle. */
export function originRef(branch: string): string {
  if (!isSafeRefName(branch)) throw new Error(`not a branch name: ${branch}`);
  return `refs/remotes/origin/${branch}`;
}

/**
 * Script lines that bundle `sha` (a shell word: a quoted value, or "$VAR") from the repository the script is in.
 * `bases` that resolve to a commit in the working copy, and don't already contain the sha, are excluded
 * (`^base`), so the bundle holds only what GitHub lacks; none resolving gives a full bundle.
 */
export function bundleLines(o: { sha: string; bases: string[]; nonce: string; maxBytes: number }): string[] {
  if (!/^[0-9a-f]{16,64}$/.test(o.nonce)) throw new Error("not a nonce");
  const m = (name: string) => `@@${o.nonce}-${name}`;
  return [
    '__d=$(mktemp -d) || { echo "@@fail no scratch folder"; exit 1; }',
    '__fail() { rm -rf "$__d"; echo "@@fail $1"; exit 1; }',
    'mkdir "$__d/home"',
    '__BE=(env -i PATH="$PATH" LANG=C.UTF-8 HOME="$__d/home" GIT_CONFIG_NOSYSTEM=1 GIT_ATTR_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0)',
    '__G() { "${__BE[@]}" git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }',
    `__SHA=${o.sha}`,
    '__objs=$(__G rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || __fail "not a git folder"',
    '"${__BE[@]}" GIT_CONFIG_GLOBAL=/dev/null git init --bare -q --template= "$__d/repo" || __fail "could not make a scratch repository"',
    'printf "%s\\n" "$__objs/objects" > "$__d/repo/objects/info/alternates"',
    '__C() { "${__BE[@]}" GIT_DIR="$__d/repo" GIT_CONFIG_GLOBAL=/dev/null git -c core.hooksPath=/dev/null "$@"; }',
    '__C cat-file -e "$__SHA^{commit}" 2>/dev/null || __fail "the commit to push is not in the working copy"',
    '__C update-ref refs/heads/ship "$__SHA" || __fail "could not name the commit"',
    "__excl=()",
    `for __b in ${o.bases.map(quote).join(" ")}; do`,
    '  __r=$(__G rev-parse --verify --quiet "$__b^{commit}" 2>/dev/null) || continue',
    '  __C merge-base --is-ancestor "$__SHA" "$__r" 2>/dev/null && continue',
    '  __excl+=("^$__r")',
    "done",
    '__C bundle create "$__d/b" refs/heads/ship ${__excl[@]+"${__excl[@]}"} >/dev/null 2>"$__d/err" || __fail "could not bundle: $(tail -n 3 "$__d/err" | tr \'\\n\' \' \')"',
    `__n=$(wc -c < "$__d/b" | tr -d ' ')`,
    `[ "$__n" -le ${o.maxBytes} ] || { rm -rf "$__d"; echo "@@toobig $__n"; exit 1; }`,
    `echo ${m("begin")}`,
    `base64 < "$__d/b" | tr -d '\\n'`,
    "echo",
    `echo ${m("end")}`,
    'echo "@@bundled $__SHA"',
    'rm -rf "$__d"',
  ];
}

/** A script that bundles `sha` from a working copy (`/home/employee/work/<conv|inc>-<id>`). */
export function bundleScript(o: {
  worktree: string;
  sha: string;
  bases?: string[];
  nonce: string;
  maxBytes?: number;
}): string {
  if (!isSafeWorkDir(o.worktree)) throw new Error(`not a safe folder: ${String(o.worktree)}`);
  if (!SHA.test(o.sha)) throw new Error(`not a commit: ${o.sha}`);
  const bases = o.bases ?? [];
  for (const b of bases) if (!BASE.test(b)) throw new Error(`not a base: ${b}`);
  return [
    "set -u",
    `cd ${quote(o.worktree)} || { echo '@@fail the working copy is not there'; exit 1; }`,
    ...bundleLines({
      sha: quote(o.sha),
      bases,
      nonce: o.nonce,
      maxBytes: o.maxBytes ?? MAX_BUNDLE_BYTES,
    }),
  ].join("\n");
}

/** Why the sandbox could not hand over a bundle. Never holds the bundle itself. */
export class BundleError extends Error {
  constructor(
    message: string,
    readonly kind: "too-big" | "git" | "unreadable",
  ) {
    super(message);
  }
}

const B64 = /^[A-Za-z0-9+/=\s]*$/;

/** Reads a bundling script's output: the bundle, or a `BundleError` saying why not. */
export function readBundle(r: { code: number; output: string }, nonce: string, sha: string): Buffer {
  const out = r.output;
  const tooBig = /^@@toobig (\d+)/m.exec(out);
  if (tooBig) {
    throw new BundleError(
      `the change is too big to hand over (${Math.round(Number(tooBig[1]) / 1048576)} MB; the most is ${MAX_BUNDLE_BYTES / 1048576} MB)`,
      "too-big",
    );
  }
  const begin = `\n@@${nonce}-begin\n`;
  const at = `\n${out}`.indexOf(begin);
  const from = at < 0 ? -1 : at + begin.length - 1;
  const end = from < 0 ? -1 : out.indexOf(`\n@@${nonce}-end`, from);
  if (r.code !== 0 || from < 0 || end < 0 || !out.includes(`@@bundled ${sha}`)) {
    const fail = /^@@fail (.+)$/m.exec(out)?.[1];
    throw new BundleError(
      fail ?? `the sandbox gave no bundle: ${out.trim().split("\n").slice(-3).join(" ").slice(0, 200)}`,
      "git",
    );
  }
  const body = out.slice(from, end);
  if (!B64.test(body)) throw new BundleError("the sandbox's bundle was not readable", "unreadable");
  return Buffer.from(body.replace(/\s+/g, ""), "base64");
}
