// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the script is shell, and its ${var} is not a template
// The script that cleans one team machine (T52), and the reader of what it prints. One script per
// machine per run, sent on stdin to `container machine run -i … -- bash -s` (machines.ts: `machine
// run` re-splits arguments, so nothing goes on a command line). It is built from fixed text and
// ticket ids that match [A-Za-z0-9_-], so no outside value is ever run as shell.
//
// The whole body is one function, called with its own stdin on /dev/null: bash reads this script
// from stdin, and a command inside it that read stdin (git, docker, sudo) would eat the script.
//
// What it may delete, and nothing else:
//   - <work>/inc-<id> and <work>/inc-<id>.pre-checkout for the ids it is given: a ticket's worktree,
//     a reviewer's copy of the branch, and the ticket's images under .inc/attachments (all in that
//     folder). Never a symlink, never a folder whose real path isn't exactly that path.
//   - <work>/conv-<id> for the archived conversations it is given (T59): the same rules as a ticket's
//     copy, with unpushed commits and uncommitted changes kept until `aged`. A conversation with no
//     project is a plain folder, which goes only when empty or aged.
//   - A checkout stays whenever git can't tell it the copy is safe: any git failure, a missing git,
//     unpushed commits, or uncommitted changes. Two lists relax that, and only that:
//       `aged`   the ticket ended past unpushedKeepDays: the owner's policy says it goes (a copy git
//                can't read still stays);
//       `merged` the owner approved the ticket: uncommitted noise may go, but only after a fresh
//                `git fetch` shows HEAD is already in a remote branch. Unpushed commits never go on
//                this basis, and a failed fetch keeps the copy.
//     A folder with no .git is the launcher's empty folder with images: it goes only if it holds
//     nothing but `.inc`.
//   - rebuildable package caches: whole folders named in a fixed list under ~/.cache (only while
//     ~/.cache is over the cap), ~/.npm/_cacache (only over the cap), `pnpm store prune`, and, when
//     asked, Docker's stopped containers, dangling images and week-old build cache.
// A dry run prints what each step would remove and changes nothing.
import type { Id } from "@i-inc/core";

export const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
const workPattern = /^\/[A-Za-z0-9._/-]+$/;

/** ~/.cache folders that tools rebuild on their own, in the order they are removed. */
export const rebuildableCaches = ["pip", "go-build", "yarn", "node-gyp", "typescript", "pnpm", "electron"];

export interface CleanupScriptOptions {
  /** The folder with the worktrees, such as /home/employee/work. */
  work: string;
  /** Closed tickets whose copies this machine may hold. */
  ids: Id[];
  /** Of those, the ones past unpushedKeepDays: they go even with unpushed or uncommitted work (git must still work). */
  aged?: Id[];
  /** Of those, the ones the owner approved: uncommitted noise may go once a fetch shows HEAD is on a remote. */
  merged?: Id[];
  /**
   * Archived conversations whose copies (<work>/conv-<id>) this machine may hold, under the same rules
   * as a ticket's: a copy stays on any git doubt, with unpushed commits or with uncommitted changes.
   */
  convs?: Id[];
  /** Of those, the ones past unpushedKeepDays: they go even with unpushed or uncommitted work (git must still work). */
  convsAged?: Id[];
  /** Of those, the ones with no project: a plain folder, no git, removable once aged (or if empty). */
  convsScratch?: Id[];
  dryRun: boolean;
  /** The cap for ~/.cache, ~/.npm's cache and the pnpm store, in KB. */
  cacheCapKb: number;
  docker: boolean;
  /** Ask the machine to hand freed blocks back to the host (`fstrim`), if its disk supports it. */
  trim: boolean;
}

export function cleanupScript(o: CleanupScriptOptions): string {
  if (!workPattern.test(o.work) || o.work.includes("..") || o.work.endsWith("/")) {
    throw new Error(`not a work folder: ${o.work}`);
  }
  const ids = [...new Set(o.ids)];
  const aged = new Set(o.aged ?? []);
  const merged = new Set(o.merged ?? []);
  const convs = [...new Set(o.convs ?? [])];
  for (const id of [...ids, ...aged, ...merged])
    if (!idPattern.test(id)) throw new Error(`not a ticket id: ${id}`);
  for (const id of [...convs, ...(o.convsAged ?? []), ...(o.convsScratch ?? [])])
    if (!idPattern.test(id)) throw new Error(`not a conversation id: ${id}`);
  const label = (id: Id) => `conv-${id}`;
  if (!Number.isInteger(o.cacheCapKb) || o.cacheCapKb < 1) throw new Error("the cache cap must be a number");
  const loop = ids.length
    ? [
        `  for id in ${ids.join(" ")}; do`,
        '    for suffix in "" ".pre-checkout"; do',
        '      q="$WORK/inc-$id$suffix"',
        '      if [ -L "$q" ]; then echo "@@refused $id symlink"; continue; fi',
        '      [ -d "$q" ] || continue',
        '      if [ "$(cd "$q" 2>/dev/null && pwd -P)" != "$q" ]; then echo "@@refused $id path"; continue; fi',
        '      if [ -z "$suffix" ]; then',
        '        reason=""',
        '        if ! guard "$q" "$id"; then echo "@@kept $id ${reason:-gitfail}"; continue; fi',
        "      fi",
        '      size=$(kb "$q")',
        '      if [ "$DRY" = 0 ]; then chmod -R u+w "$q" 2>/dev/null; rm -rf $RMFLAGS -- "$q"; fi',
        '      if [ "$DRY" = 0 ] && [ -e "$q" ]; then echo "@@failed $id"; continue; fi',
        '      echo "@@removed $id ${size:-0}"; removed=1',
        "    done",
        "  done",
      ]
    : ["  # No closed tickets to clean here."];
  // An archived conversation's copy: the same guard, reported as conv-<id>. It has no reviewer's twin.
  const convLoop = convs.length
    ? [
        `  for cid in ${convs.join(" ")}; do`,
        '    id="conv-$cid"; q="$WORK/conv-$cid"',
        '    if [ -L "$q" ]; then echo "@@refused $id symlink"; continue; fi',
        '    [ -d "$q" ] || continue',
        '    if [ "$(cd "$q" 2>/dev/null && pwd -P)" != "$q" ]; then echo "@@refused $id path"; continue; fi',
        '    reason=""',
        '    if ! guard "$q" "$id"; then echo "@@kept $id ${reason:-gitfail}"; continue; fi',
        '    size=$(kb "$q")',
        '    if [ "$DRY" = 0 ]; then chmod -R u+w "$q" 2>/dev/null; rm -rf $RMFLAGS -- "$q"; fi',
        '    if [ "$DRY" = 0 ] && [ -e "$q" ]; then echo "@@failed $id"; continue; fi',
        '    echo "@@removed $id ${size:-0}"; removed=1',
        "  done",
      ]
    : [];
  return [
    "set -u",
    `WORK='${o.work}'`,
    `DRY=${o.dryRun ? 1 : 0}`,
    `CAP=${o.cacheCapKb}`,
    `DOCKER=${o.docker ? 1 : 0}`,
    `TRIM=${o.trim ? 1 : 0}`,
    `AGED=' ${[...aged, ...(o.convsAged ?? []).map(label)].join(" ")} '`,
    `SCRATCH=' ${(o.convsScratch ?? []).map(label).join(" ")} '`,
    `MERGED=' ${[...merged].join(" ")} '`,
    "main() {",
    '  export PATH="$HOME/.local/bin:$PATH"',
    // A work folder that isn't exactly this path (a symlink, or not there) is left alone.
    '  cd "$WORK" 2>/dev/null || { echo @@no-work; echo @@done; exit 0; }',
    '  [ "$(pwd -P)" = "$WORK" ] || { echo @@refused work-folder; echo @@done; exit 0; }',
    '  kb() { du -sk "$1" 2>/dev/null | cut -f1; }',
    "  df_line() { df -Pk \"$WORK\" 2>/dev/null | awk 'NR==2 {print $2, $3}'; }",
    "  df_used() { df_line | cut -d' ' -f2; }",
    "  GIT=1; command -v git >/dev/null 2>&1 || GIT=0",
    "  TIMEOUT=''; command -v timeout >/dev/null 2>&1 && TIMEOUT='timeout 60'",
    // Stay on one filesystem while removing, where rm can (GNU rm can).
    "  RMFLAGS=''; rm --help 2>&1 | grep -q -- --one-file-system && RMFLAGS=--one-file-system",
    // Sets `reason` and returns 1 unless the copy is safe to remove. Any git failure keeps it.
    "  guard() {",
    "    gq=$1; gid=$2",
    '    case "$AGED" in *" $gid "*) gaged=1 ;; *) gaged=0 ;; esac',
    '    case "$MERGED" in *" $gid "*) gmerged=1 ;; *) gmerged=0 ;; esac',
    '    if [ ! -e "$gq/.git" ]; then',
    "      # Not a checkout: the launcher's empty folder, which holds at most the images.",
    '      extra=$(ls -A "$gq" | grep -v "^[.]inc$" | head -n 1) || { reason=notcheckout; return 1; }',
    '      [ -z "$extra" ] && return 0',
    // A conversation with no project is a plain folder by design: its files go once they are aged.
    '      case "$SCRATCH" in *" $gid "*) [ "$gaged" = 1 ] && return 0 ;; esac',
    "      reason=notcheckout; return 1",
    "    fi",
    '    [ "$GIT" = 1 ] || { reason=nogit; return 1; }',
    '    git -C "$gq" rev-parse --git-dir >/dev/null || { reason=gitfail; return 1; }',
    '    ahead=$(git -C "$gq" rev-list --count HEAD --not --remotes) || { reason=gitfail; return 1; }',
    '    case "$ahead" in "" | *[!0-9]*) reason=gitfail; return 1 ;; esac',
    '    dirty=$(git -C "$gq" status --porcelain) || { reason=gitfail; return 1; }',
    '    if [ "$gaged" = 1 ]; then return 0; fi',
    '    if [ "$ahead" != 0 ]; then reason=unpushed; return 1; fi',
    '    if [ -n "$dirty" ]; then',
    '      if [ "$gmerged" = 1 ]; then',
    '        GIT_TERMINAL_PROMPT=0 $TIMEOUT git -C "$gq" fetch --quiet origin || { reason=fetchfail; return 1; }',
    '        ahead=$(git -C "$gq" rev-list --count HEAD --not --remotes) || { reason=gitfail; return 1; }',
    '        [ "$ahead" = 0 ] || { reason=unpushed; return 1; }',
    "        return 0",
    "      fi",
    "      reason=uncommitted; return 1",
    "    fi",
    "    return 0",
    "  }",
    '  echo "@@df $(df_line)"',
    "  removed=0",
    ...loop,
    ...convLoop,
    // Branches stay on GitHub. Locally, git forgets the removed worktrees and packs what it can.
    '  if [ "$DRY" = 0 ] && [ "$removed" = 1 ] && [ "$GIT" = 1 ]; then',
    '    for g in "$WORK"/*/.git; do',
    '      [ -d "$g" ] || continue',
    '      git -C "${g%/.git}" worktree prune >/dev/null 2>&1',
    '      git -C "${g%/.git}" gc --auto --quiet >/dev/null 2>&1',
    "    done",
    "  fi",
    // ~/.cache: only the folders tools rebuild, and only while the whole of it is over the cap.
    '  if [ -d "$HOME/.cache" ] && [ ! -L "$HOME/.cache" ]; then',
    '    total=$(kb "$HOME/.cache"); total=${total:-0}',
    '    if [ "$total" -gt "$CAP" ]; then',
    `      for name in ${rebuildableCaches.join(" ")}; do`,
    '        d="$HOME/.cache/$name"',
    '        if [ -L "$d" ] || [ ! -d "$d" ]; then continue; fi',
    '        [ "$total" -gt "$CAP" ] || break',
    '        s=$(kb "$d"); s=${s:-0}',
    '        if [ "$DRY" = 0 ]; then rm -rf $RMFLAGS -- "$d"; fi',
    '        echo "@@cache $name $s"; total=$((total - s))',
    "      done",
    '      if [ "$total" -gt "$CAP" ]; then echo "@@cache-over $total"; fi',
    "    fi",
    "  fi",
    '  if [ -d "$HOME/.npm/_cacache" ] && [ ! -L "$HOME/.npm" ] && [ ! -L "$HOME/.npm/_cacache" ]; then',
    '    s=$(kb "$HOME/.npm/_cacache"); s=${s:-0}',
    '    if [ "$s" -gt "$CAP" ]; then',
    '      if [ "$DRY" = 0 ]; then rm -rf $RMFLAGS -- "$HOME/.npm/_cacache"; fi',
    '      echo "@@cache npm $s"',
    "    fi",
    "  fi",
    // The pnpm store keeps every version any worktree ever installed; prune drops the ones nothing
    // links to. Worth running after worktrees went, or when the store is over the cap.
    "  if command -v pnpm >/dev/null 2>&1; then",
    "    store=$(pnpm store path 2>/dev/null)",
    '    if [ -n "$store" ] && [ -d "$store" ]; then',
    '      before=$(kb "$store"); before=${before:-0}',
    '      if [ "$removed" = 1 ] || [ "$before" -gt "$CAP" ]; then',
    '        if [ "$DRY" = 0 ]; then',
    "          pnpm store prune >/dev/null 2>&1",
    '          after=$(kb "$store"); after=${after:-0}',
    '          echo "@@pnpm-store $((before - after))"',
    '        else echo "@@pnpm-store-would-prune $before"; fi',
    '        if [ "$(kb "$store")" -gt "$CAP" ] 2>/dev/null; then echo "@@cache-over-store $(kb "$store")"; fi',
    "      fi",
    "    fi",
    "  fi",
    '  if [ "$DOCKER" = 1 ] && command -v docker >/dev/null 2>&1 && timeout 20 docker info >/dev/null 2>&1; then',
    '    if [ "$DRY" = 1 ]; then echo "@@docker-present"; else',
    "      b=$(df_used)",
    "      docker container prune -f --filter until=72h >/dev/null 2>&1",
    "      docker image prune -f >/dev/null 2>&1",
    "      docker builder prune -f --filter until=168h >/dev/null 2>&1",
    '      a=$(df_used); echo "@@docker $((b - a))"',
    "    fi",
    "  fi",
    '  if [ "$TRIM" = 1 ] && [ "$DRY" = 0 ]; then sudo -n fstrim / >/dev/null 2>&1 && echo @@trimmed; fi',
    '  echo "@@df-after $(df_line)"',
    "  echo @@done",
    "}",
    // The last line, so there is nothing left in stdin for a command to take.
    "main </dev/null",
    "",
  ].join("\n");
}

const KB = 1024;

export interface CleanupReport {
  /** The script ran to its end. */
  done: boolean;
  /** The folder's disk before and after, in bytes. */
  disk?: { total: number; used: number };
  diskAfter?: { total: number; used: number };
  /** Copies removed (or, in a dry run, that would be), with their sizes in bytes. */
  removed: { ticket: Id; bytes: number }[];
  kept: { ticket: Id; reason: string }[];
  refused: { ticket: Id; reason: string }[];
  failed: Id[];
  /** Bytes freed (or that would be) by category: "worktrees", "cache:pip", "pnpm-store", "docker". */
  freed: Record<string, number>;
  /** A cache is still over the cap after cleaning, in bytes. */
  cacheOver?: number;
  trimmed: boolean;
  dockerSeen: boolean;
}

/** Reads the script's output: lines that begin with @@, ignoring everything else. */
export function readCleanup(output: string): CleanupReport {
  const r: CleanupReport = {
    done: false,
    removed: [],
    kept: [],
    refused: [],
    failed: [],
    freed: {},
    trimmed: false,
    dockerSeen: false,
  };
  const add = (key: string, bytes: number) => {
    if (bytes > 0) r.freed[key] = (r.freed[key] ?? 0) + bytes;
  };
  const num = (s: string | undefined) => {
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  };
  for (const line of output.split("\n")) {
    if (!line.startsWith("@@")) continue;
    const [tag = "", a = "", b = "", c = ""] = line.slice(2).trim().split(/\s+/);
    switch (tag) {
      case "done":
        r.done = true;
        break;
      case "df":
        if (b) r.disk = { total: num(a) * KB, used: num(b) * KB };
        break;
      case "df-after":
        if (b) r.diskAfter = { total: num(a) * KB, used: num(b) * KB };
        break;
      case "removed":
        r.removed.push({ ticket: a, bytes: num(b) * KB });
        add("worktrees", num(b) * KB);
        break;
      case "kept":
        r.kept.push({ ticket: a, reason: b });
        break;
      case "refused":
        r.refused.push({ ticket: a, reason: b });
        break;
      case "failed":
        r.failed.push(a);
        break;
      case "cache":
        add(`cache:${a}`, num(b) * KB);
        break;
      case "cache-over":
      case "cache-over-store":
        r.cacheOver = Math.max(r.cacheOver ?? 0, num(a) * KB);
        break;
      case "pnpm-store":
        add("pnpm-store", num(a) * KB);
        break;
      case "pnpm-store-would-prune":
        add("pnpm-store", 0);
        break;
      case "docker":
        add("docker", num(a) * KB);
        break;
      case "docker-present":
        r.dockerSeen = true;
        break;
      case "trimmed":
        r.trimmed = true;
        break;
      default:
        void c;
    }
  }
  return r;
}
