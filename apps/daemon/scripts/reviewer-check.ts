// A device check for #26: a reviewer's checkout and the ticket's images, in a real machine. It runs ON THE HOST:
//
//   bun apps/daemon/scripts/reviewer-check.ts --runtime container --machine inc-<team> [--images 6] [--mb 10] [--keep]
//   bun apps/daemon/scripts/reviewer-check.ts --runtime docker --machine <container>    (a Linux stand-in)
//
// It sends the daemon's own scripts (checkoutScript, attachmentScript and openScript from src/workspace.ts) to
// the machine the way the daemon does, as `bash -s` on stdin: `container machine run -i -u employee -n <machine>
// -- bash -s` on the mini, `docker exec -i -u employee <container> bash -s` on Linux. GitHub stands in as a bare
// repo inside the machine, filled from a bundle the host makes, so nothing leaves the walls and no token is needed.
// Everything it makes is in one folder under /tmp in the machine, removed at the end unless --keep.
//
// What it checks, as one line per check (`ok` or `FAIL`):
//   A. a reviewer on another team: images copied into the launcher's plain folder before the checkout are kept, the
//      checkout lands on the branch's pushed commit, marked as a review copy and with no author, every image arrives
//      with the uploaded SHA-256 (timed per image), git status stays clean, and a later push moves the copy along;
//   B. a reviewer on the builder's team (a shared machine): the builder's worktree, author and unpushed commit are
//      left alone, and the images still land.
// Exit code: 0 when every check passed, 1 when one failed, 2 when the machine couldn't be reached, 64 on a bad
// command line.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AttachmentFile } from "../src/tickets.ts";
import { attachmentScript, checkoutScript, openScript } from "../src/workspace.ts";

/** One script into the machine, as the daemon sends it: `bash -s` with the script on stdin. */
export type Run = (script: string) => Promise<{ code: number; output: string }>;

export interface CheckOptions {
  run: Run;
  /** A folder in the machine for everything the check makes. */
  base: string;
  images: number;
  bytes: number;
  /** Leave the folder in the machine, to look at by hand. */
  keep?: boolean;
  log?: (line: string) => void;
}

export interface CheckResult {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
  /** How long each image's copy took, in ms (the attachmentScript round trip). */
  imageMs: number[];
}

const BRANCH = "inc/26-reviewer-check";

/** Runs a command on the host and fails loudly: the host side is ours, so any error there is a bug. */
function host(cmd: string, args: string[], cwd?: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** Reads `@@key value` lines. */
const field = (output: string, key: string) => new RegExp(`^@@${key} ?(.*)$`, "m").exec(output)?.[1]?.trim();

export async function runCheck(o: CheckOptions): Promise<CheckResult> {
  const log = o.log ?? (() => {});
  const checks: CheckResult["checks"] = [];
  const check = (name: string, ok: boolean, detail?: string) => {
    checks.push({ name, ok, ...(detail ? { detail } : {}) });
    // What the machine said is for a failure: on success git's warnings would only be noise.
    log(
      `${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? `\n     ${detail.replaceAll("\n", "\n     ")}` : ""}`,
    );
  };
  const origin = `${o.base}/origin.git`;
  const reviewer = `${o.base}/work/inc-26`;
  // The builder's team machine: its own clone, like another machine.
  const shared = `${o.base}/team/inc-26`;

  // The host's stand-in for GitHub: main, and the builder's branch with one commit.
  const hostDir = mkdtempSync(join(tmpdir(), "inc-reviewer-check-"));
  const repo = join(hostDir, "repo");
  const g = (...args: string[]) =>
    host("git", ["-c", "user.name=Builder", "-c", "user.email=b@example.invalid", ...args], repo);
  host("git", ["init", "-q", "-b", "main", repo]);
  g("commit", "-q", "--allow-empty", "-m", "base");
  g("checkout", "-q", "-b", BRANCH);
  g("commit", "-q", "--allow-empty", "-m", "feat: round one");

  /** Copies the host repo's branches into the machine's bare origin, the way a push to GitHub would. */
  const publish = async () => {
    const bundle = join(hostDir, "o.bundle");
    host("git", ["bundle", "create", "-q", bundle, "--branches"], repo);
    const data = readFileSync(bundle).toString("base64");
    const r = await o.run(
      [
        "set -e",
        `mkdir -p ${q(o.base)}; [ -d ${q(origin)} ] || git init -q --bare -b main ${q(origin)}; base64 -d > ${q(`${o.base}/o.bundle`)}; git -C ${q(origin)} fetch -q --force ${q(`${o.base}/o.bundle`)} '+refs/heads/*:refs/heads/*'; echo @@published`,
        data,
      ].join("\n"),
    );
    if (!r.output.includes("@@published"))
      throw new Error(`couldn't fill the origin in the machine: ${r.output}`);
    return g("rev-parse", "HEAD");
  };

  const files: AttachmentFile[] = Array.from({ length: o.images }, (_, i) => ({
    n: i + 1,
    name: `photo-${i + 1}.jpg`,
    mime: "image/jpeg",
    size: o.bytes,
    data: new Uint8Array(randomBytes(o.bytes)),
  }));
  const sha = (f: AttachmentFile) => createHash("sha256").update(f.data).digest("hex");
  const imageMs: number[] = [];
  const attach = async (worktree: string, f: AttachmentFile) => {
    const t = performance.now();
    const r = await o.run(attachmentScript({ worktree, file: f }));
    const ms = performance.now() - t;
    return { ok: r.code === 0 && r.output.includes("@@attached"), ms, output: r.output };
  };
  /** What the worktree looks like, read in the machine. */
  const look = async (worktree: string) => {
    const w = q(worktree);
    const r = await o.run(
      [
        `cd ${w} || exit 1`,
        'echo "@@head $(git rev-parse HEAD)"',
        'echo "@@branch $(git branch --show-current)"',
        'echo "@@copy $(git config --worktree --get i-inc.copy || true)"',
        'echo "@@name $(git config --worktree --get user.name || true)"',
        'echo "@@status $(git status --porcelain | tr "\\n" " ")"',
        `echo "@@aside $([ -e ${q(`${worktree}.pre-checkout`)} ] && echo yes || echo no)"`,
        'for f in .inc/attachments/*; do [ -f "$f" ] && echo "@@sha $(sha256sum "$f")"; done',
        "echo @@looked",
      ].join("\n"),
    );
    const shas = new Map(
      [...r.output.matchAll(/^@@sha ([0-9a-f]{64}) {2}\.inc\/attachments\/(.+)$/gm)].map((m) => [m[2], m[1]]),
    );
    return {
      ok: r.output.includes("@@looked"),
      head: field(r.output, "head"),
      branch: field(r.output, "branch"),
      copy: field(r.output, "copy"),
      name: field(r.output, "name"),
      status: field(r.output, "status") ?? "?",
      aside: field(r.output, "aside"),
      shas,
    };
  };
  const imagesMatch = (shas: Map<string | undefined, string | undefined>, list: AttachmentFile[]) =>
    list.every((f) => shas.get(`${f.n}-${f.name}`) === sha(f));

  try {
    const reach = await o.run("echo @@up; command -v git base64 sha256sum >/dev/null && echo @@tools");
    if (!reach.output.includes("@@up")) throw new MachineUnreachable(reach.output.trim().slice(-300));
    check("the machine has git, base64 and sha256sum", reach.output.includes("@@tools"));
    await o.run(`rm -rf ${q(o.base)}`);
    const round1 = await publish();
    const checkout = (worktree: string) =>
      o.run(
        checkoutScript({ remote: origin, repoDir: `${dirname(worktree)}/repo`, worktree, branch: BRANCH }),
      );

    // A. A reviewer on another team: the launcher's plain folder, an image, then the checkout.
    const [first, ...rest] = files as [AttachmentFile, ...AttachmentFile[]];
    const early = await attach(reviewer, first);
    imageMs.push(early.ms);
    check(
      "A1 an image copies into the plain folder before the checkout",
      early.ok,
      early.ok ? "" : early.output,
    );
    const c1 = await checkout(reviewer);
    check(
      "A2 the checkout finishes",
      c1.code === 0 && c1.output.includes("@@ready"),
      c1.output.trim().slice(-300),
    );
    for (const f of rest) {
      const a = await attach(reviewer, f);
      imageMs.push(a.ms);
      if (!a.ok) check(`A3 ${f.name} copies`, false, a.output.trim().slice(-300));
    }
    const again = await attach(reviewer, first);
    check("A4 an image that's already there is left alone", again.ok, again.ok ? "" : again.output);
    const a = await look(reviewer);
    check(
      "A5 on the branch's pushed commit",
      a.head === round1 && a.branch === BRANCH,
      `${a.branch} ${a.head}`,
    );
    check(
      "A6 marked as a review copy, with no author",
      a.copy === "review" && a.name === "",
      `${a.copy}/${a.name}`,
    );
    check(
      `A7 all ${files.length} images arrive with the uploaded SHA-256`,
      imagesMatch(a.shas, files),
      `${a.shas.size} found`,
    );
    check("A8 git status is clean and nothing is left aside", a.status === "" && a.aside === "no", a.status);

    // The builder pushes again: a later round moves the review copy along and keeps the images.
    g("commit", "-q", "--allow-empty", "-m", "fix: the findings");
    const round2 = await publish();
    const c2 = await checkout(reviewer);
    const b = await look(reviewer);
    check(
      "A9 a later push moves the copy to the new commit, images kept",
      c2.code === 0 && b.head === round2 && imagesMatch(b.shas, files) && b.status === "",
      `${b.head} ${b.status}`,
    );

    // B. A reviewer on the builder's team: the same machine, so the same folder as the builder's worktree.
    const opened = await o.run(
      openScript({
        remote: origin,
        repoDir: `${o.base}/team/repo`,
        worktree: shared,
        branch: BRANCH,
        name: "Builder (i.inc)",
        email: "b@example.invalid",
        message: "unused",
        push: false,
      }),
    );
    const wip = await o.run(
      `set -e; cd ${q(shared)}; git commit -q --allow-empty -m wip; echo "@@head $(git rev-parse HEAD)"`,
    );
    const builderHead = field(wip.output, "head");
    check(
      "B1 the builder's worktree opens",
      opened.output.includes("@@ready") && !!builderHead,
      opened.output,
    );
    const c3 = await checkout(shared);
    const s1 = await attach(shared, first);
    imageMs.push(s1.ms);
    const s = await look(shared);
    check(
      "B2 the checkout leaves the builder's commit, author and unmarked worktree alone",
      c3.code === 0 && s.head === builderHead && s.name === "Builder (i.inc)" && s.copy === "",
      `${s.head} ${s.name} ${s.copy}`,
    );
    check(
      "B3 the image still lands, out of git's sight",
      s1.ok && imagesMatch(s.shas, [first]) && s.status === "",
      s.status,
    );
  } catch (e) {
    if (e instanceof MachineUnreachable) throw e;
    check("the check ran to the end", false, e instanceof Error ? e.message.slice(0, 300) : String(e));
  } finally {
    rmSync(hostDir, { recursive: true, force: true });
    if (!o.keep) await o.run(`rm -rf ${q(o.base)}`).catch(() => {});
  }
  return { ok: checks.every((c) => c.ok), checks, imageMs };
}

export class MachineUnreachable extends Error {}

/** `bash -s` with the script on stdin, through the given command. */
export function stdinRunner(cmd: string, args: string[]): Run {
  return (script) =>
    new Promise((resolve) => {
      const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (c) => {
        output += c;
      });
      child.stderr.on("data", (c) => {
        output += c;
      });
      child.on("error", (e) => resolve({ code: 127, output: String(e) }));
      child.on("close", (code) => resolve({ code: code ?? 1, output }));
      child.stdin.on("error", () => {});
      child.stdin.end(script);
    });
}

export interface Parsed {
  runtime: "container" | "docker" | "local";
  machine: string;
  user: string;
  images: number;
  mb: number;
  keep: boolean;
}

export function parseArgs(argv: string[]): Parsed | string {
  const p: Parsed = { runtime: "container", machine: "", user: "employee", images: 6, mb: 10, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keep") {
      p.keep = true;
      continue;
    }
    const v = argv[++i] ?? "";
    if (a === "--runtime" && (v === "container" || v === "docker" || v === "local")) p.runtime = v;
    else if (a === "--machine" && v) p.machine = v;
    else if (a === "--user" && v) p.user = v;
    else if (a === "--images" && /^[1-9]\d*$/.test(v)) p.images = Number(v);
    else if (a === "--mb" && /^\d+(\.\d+)?$/.test(v) && Number(v) > 0) p.mb = Number(v);
    else return `not understood: ${a}`;
  }
  if (p.runtime !== "local" && !p.machine) return "--machine is needed";
  return p;
}

export function runnerFor(p: Parsed): Run {
  if (p.runtime === "container")
    return stdinRunner("container", [
      "machine",
      "run",
      "-i",
      "-u",
      p.user,
      "-n",
      p.machine,
      "--",
      "bash",
      "-s",
    ]);
  if (p.runtime === "docker")
    return stdinRunner("docker", ["exec", "-i", "-u", p.user, p.machine, "bash", "-s"]);
  return stdinRunner("bash", ["-s"]);
}

if (import.meta.main) {
  const p = parseArgs(process.argv.slice(2));
  if (typeof p === "string") {
    console.error(
      `${p}\nusage: bun apps/daemon/scripts/reviewer-check.ts --runtime container|docker|local --machine <name> [--user employee] [--images 6] [--mb 10] [--keep]`,
    );
    process.exit(64);
  }
  const base = `/tmp/i-inc-reviewer-check-${randomBytes(4).toString("hex")}`;
  console.log(
    `${p.runtime} ${p.machine || "(this host)"} as ${p.user}: ${p.images} images of ${p.mb} MB, in ${base}`,
  );
  try {
    const r = await runCheck({
      run: runnerFor(p),
      base,
      images: p.images,
      bytes: Math.round(p.mb * 1024 * 1024),
      keep: p.keep,
      log: (l) => console.log(l),
    });
    const ms = r.imageMs.map((m) => Math.round(m));
    console.log(`image copy, ms each: ${ms.join(" ")} (slowest ${Math.max(...ms)})`);
    console.log(r.ok ? "PASS" : "FAIL");
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`couldn't reach the machine: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
