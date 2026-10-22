// The two scripts of a harvest (docs/design/brain.md, "Writing"), both run in the employee's sandbox with
// `machine run` and nothing else (a stopped machine is never started for them):
//
//   harvestScript: reads what the agent changed in its copy, `git diff refs/inc/baseline` plus the files it
//     made, and prints one line a change. It writes each changed file into the copy's git object store
//     (`hash-object -w`), so the baseline can move to exactly the text that was read even if the agent keeps
//     editing. It reads only plain files: a symlink, a link anywhere on the way, a special file or a file over
//     the size cap is reported, never read.
//   advanceScript: moves the baseline. Every change the daemon dealt with (committed, or no change) becomes
//     part of the baseline, so the same diff is not harvested twice, and an edit the agent makes after the
//     harvest stays a diff. A change that was refused is undone in the copy (the file goes back to the
//     baseline text) unless the agent is meant to deal with it (a duplicate to merge).
import type { RawChange } from "./brain-check.ts";

const root = /^\/[A-Za-z0-9/_.-]{1,200}$/;
const sha40 = /^[0-9a-f]{40}$/;
const harvestId = /^h[0-9]{1,12}$/;

/** The largest file the harvest reads, and the most it will print. */
export const harvestFileCap = 256 * 1024;
export const harvestOutputCap = 6_000_000;
export const harvestChangeCap = 400;

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** The script that prints a copy's changes: `@@employee`, one `@@c` line a change, and `@@done`. */
export function harvestScript(copyRoot: string): string {
  if (!root.test(copyRoot)) throw new Error(`not a copy folder: ${copyRoot}`);
  return `set -u
export LC_ALL=C GIT_LITERAL_PATHSPECS=1 GIT_OPTIONAL_LOCKS=0
R='${copyRoot}'
MAXF=${harvestFileCap}; MAXOUT=${harvestOutputCap}; MAXN=${harvestChangeCap}
cd "$R" 2>/dev/null && [ -d .git ] || { echo "@@missing"; exit 0; }
BR=refs/inc/baseline
git rev-parse -q --verify "$BR" >/dev/null 2>&1 || { echo "@@missing"; exit 0; }
tmp=$(mktemp -d) && trap 'rm -rf "$tmp"' EXIT
echo "@@employee $(sed -n 's/.*"employee": *"\\([^"]*\\)".*/\\1/p' .snapshot.json 2>/dev/null | head -n 1)"
enc() { base64 | tr -d '\\n'; }
# The baseline in a scratch index: the agent's staging, if it did any, plays no part.
export GIT_INDEX_FILE="$tmp/index"
git read-tree "$BR" || { echo "@@fail the baseline can't be read"; exit 0; }
git diff --name-status -z --no-renames > "$tmp/ns" 2>/dev/null
git ls-files -o --exclude-standard -z > "$tmp/new" 2>/dev/null
n=0; out=0
emit() { out=$((out + \${#1})); printf '%s\\n' "$1"; }
change() {
  st=$1; p=$2
  n=$((n + 1))
  if [ "$n" -gt "$MAXN" ]; then return 0; fi
  if [ "$out" -gt "$MAXOUT" ]; then return 0; fi
  bp=$(printf %s "$p" | enc)
  d=$p
  while [ "$d" != . ] && [ "$d" != / ]; do
    if [ -L "$d" ]; then emit "@@c $st $bp - - - link 0"; return 0; fi
    d=$(dirname "$d")
  done
  if [ "$st" = D ]; then
    base="_$(git cat-file blob "$BR:$p" 2>/dev/null | enc)"
    emit "@@c D $bp - $base - ok 0"
    return 0
  fi
  if [ ! -e "$p" ]; then return 0; fi
  if [ ! -f "$p" ]; then emit "@@c $st $bp - - - special 0"; return 0; fi
  size=$(wc -c < "$p" | tr -d ' ')
  if [ "$size" -gt "$MAXF" ]; then emit "@@c $st $bp - - - big $size"; return 0; fi
  sha=$(git hash-object -w --no-filters -- "$p") || return 0
  text="_$(git cat-file blob "$sha" | enc)"
  base=-
  if [ "$st" != A ]; then base="_$(git cat-file blob "$BR:$p" 2>/dev/null | enc)"; fi
  emit "@@c $st $bp $sha $base $text ok $size"
}
while IFS= read -r -d '' st && IFS= read -r -d '' p; do
  case "$st" in D) change D "$p";; *) change M "$p";; esac
done < "$tmp/ns"
while IFS= read -r -d '' p; do change A "$p"; done < "$tmp/new"
if [ "$n" -gt "$MAXN" ] || [ "$out" -gt "$MAXOUT" ]; then echo "@@truncated $n"; fi
echo "@@done $n"
`;
}

/** What `harvestScript` printed. */
export interface Harvested {
  kind: "ok" | "missing" | "failed";
  /** The employee the copy says it is for (`.snapshot.json`). */
  employee: string;
  changes: RawChange[];
  /** More changes than the script reports: the rest wait for the next harvest. */
  truncated: boolean;
  detail?: string;
}

const unb64 = (s: string) => (s === "-" ? null : Buffer.from(s.replace(/^_/, ""), "base64").toString("utf8"));

export function parseHarvest(code: number, output: string): Harvested {
  const lines = output.split("\n");
  if (lines.some((l) => l.startsWith("@@missing")))
    return { kind: "missing", employee: "", changes: [], truncated: false };
  const fail = lines.find((l) => l.startsWith("@@fail "));
  const done = lines.some((l) => l.startsWith("@@done "));
  if (code !== 0 || !done || fail) {
    return {
      kind: "failed",
      employee: "",
      changes: [],
      truncated: false,
      detail:
        (fail ? fail.slice(7) : output.trim().split("\n").slice(-2).join(" ")).slice(0, 200) ||
        "the harvest script did not finish",
    };
  }
  const employee = (lines.find((l) => l.startsWith("@@employee"))?.slice(10) ?? "").trim();
  const changes: RawChange[] = [];
  for (const line of lines) {
    if (!line.startsWith("@@c ")) continue;
    const [, st, bp, sha, base, text, flag, size] = line.split(" ");
    if (!st || !bp || !sha || !base || !text || !flag) continue;
    if (st !== "A" && st !== "M" && st !== "D") continue;
    const path = Buffer.from(bp, "base64").toString("utf8");
    changes.push({
      path,
      status: st,
      base: unb64(base),
      text: unb64(text),
      sha: sha === "-" ? null : sha,
      size: Number(size ?? 0) || 0,
      ...(flag === "link" || flag === "special" || flag === "big" ? { bad: flag } : {}),
    });
  }
  return { kind: "ok", employee, changes, truncated: lines.some((l) => l.startsWith("@@truncated")) };
}

export interface AdvanceInput {
  root: string;
  harvest: string;
  /** Paths whose baseline becomes this blob (the text that was read), or is removed (null: the page is gone). */
  accept: { path: string; sha: string | null }[];
  /** Paths that go back to the baseline text (a change that was refused). */
  discard: string[];
}

/** The script that moves the baseline. Prints `@@advanced <n>`, or `@@missing`. */
export function advanceScript(a: AdvanceInput): string {
  if (!root.test(a.root)) throw new Error(`not a copy folder: ${a.root}`);
  if (!harvestId.test(a.harvest)) throw new Error("not a harvest id");
  for (const x of a.accept) {
    if (x.sha !== null && !sha40.test(x.sha)) throw new Error("not a blob id");
    if (x.path.length > 300 || x.path.includes("\0")) throw new Error("not a path of the copy");
  }
  const accept = a.accept.map((x) => `${b64(x.path)} ${x.sha ?? "-"}`).join("\n");
  const discard = a.discard
    .filter((p) => p.length <= 300 && !p.includes("\0"))
    .map((p) => b64(p))
    .join("\n");
  return `set -u
export LC_ALL=C GIT_LITERAL_PATHSPECS=1
R='${a.root}'
cd "$R" 2>/dev/null && [ -d .git ] || { echo "@@missing"; exit 0; }
BR=refs/inc/baseline
old=$(git rev-parse -q --verify "$BR") || { echo "@@missing"; exit 0; }
head=$(git rev-parse -q --verify HEAD || true)
tmp=$(mktemp -d) && trap 'rm -rf "$tmp"' EXIT
dec() { p=$(printf %s "$1" | base64 -d; echo x); p=\${p%x}; }
export GIT_INDEX_FILE="$tmp/index"
git read-tree "$BR" || { echo "@@fail the baseline can't be read"; exit 0; }
n=0
while read -r bp sha; do
  [ -n "$bp" ] || continue
  dec "$bp"
  if [ "$sha" = - ]; then
    printf '0 0000000000000000000000000000000000000000\\t%s\\0' "$p" | git update-index -z --index-info || continue
  else
    git cat-file -e "$sha" 2>/dev/null || continue
    printf '100644 %s\\t%s\\0' "$sha" "$p" | git update-index -z --index-info || continue
  fi
  n=$((n + 1))
done <<'__INC_ACCEPT__'
${accept}
__INC_ACCEPT__
while read -r bp; do
  [ -n "$bp" ] || continue
  dec "$bp"
  if [ -L "$p" ]; then rm -f -- "$p"; fi
  ok=1; d=$(dirname "$p")
  while [ "$d" != . ] && [ "$d" != / ]; do if [ -L "$d" ]; then ok=0; fi; d=$(dirname "$d"); done
  [ "$ok" = 1 ] || continue
  if git cat-file -e "$BR:$p" 2>/dev/null; then mkdir -p -- "$(dirname "$p")" && git cat-file blob "$BR:$p" > "$p"
  else rm -f -- "$p"; fi
done <<'__INC_DISCARD__'
${discard}
__INC_DISCARD__
tree=$(git write-tree)
if [ "$tree" != "$(git rev-parse "$old^{tree}")" ]; then
  ci=$(git -c user.name=i.inc -c user.email=daemon@i-inc.local -c commit.gpgsign=false commit-tree "$tree" -p "$old" -m "harvest ${a.harvest}")
  git update-ref "$BR" "$ci"
  if [ -z "$head" ] || [ "$head" = "$old" ]; then git update-ref HEAD "$ci"; fi
fi
unset GIT_INDEX_FILE
git read-tree "$BR" 2>/dev/null
echo "@@advanced $n"
`;
}

export function parseAdvance(code: number, output: string): { ok: boolean; advanced: number } {
  const m = /@@advanced (\d+)/.exec(output);
  return { ok: code === 0 && m !== null, advanced: m ? Number(m[1]) : 0 };
}
