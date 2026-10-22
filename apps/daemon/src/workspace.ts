// The Workspace port on GitHub (spec §6, stages 1 and 9). Pick-up makes the ticket's worktree and
// branch in the builder's machine, pushes the branch as the bot, and opens a draft PR. GitHub opens
// no PR without a commit, so a new branch starts with an empty one; the squash merge drops it. The
// report stage writes the PR's body and takes it out of draft. Both are safe to repeat: a crash, a
// handoff or a new machine finds the branch and the PR that are already there.
import { dirname, posix } from "node:path";
import {
  attachmentPath,
  type Employee,
  type ProjectPolicy,
  type PullRequestRef,
  type Ticket,
  type Workspace,
} from "@i-inc/core";
import type { PullRequests, TokenSource } from "./github.ts";
import type { RunScript } from "./harness.ts";
import type { Project } from "./registry.ts";
import type { AttachmentFile } from "./tickets.ts";

export interface WorkspaceOptions {
  project: (name: string) => Project | undefined;
  tokens: TokenSource;
  prs: PullRequests;
  /** The git identity an employee's commits carry, such as "Ada (i.inc)" with the bot's address. */
  identity: (employee: Employee) => Promise<{ name: string; email: string }>;
  /** The ticket's worktree in the machine: `workDir`. */
  worktree: (ticketId: string) => string;
  run: RunScript;
  /** How a project's work reaches main. Absent: owner-merges, with a draft PR. */
  policy?: (project: string) => ProjectPolicy;
  /** Where the repo is cloned from; tests use a local path. */
  remote?: (repo: string) => string;
  log?: (msg: string) => void;
  /** The images the owner attached to a ticket, with their bytes. */
  attachments?: (ticketId: string) => AttachmentFile[];
}

/**
 * Is this a branch name git would take, by `git check-ref-format --branch`'s rules and a stricter
 * one on whitespace? Nothing else may reach a script run in a sandbox: no `..`, no leading `-`, no
 * control characters or spaces, none of `~^:?*[\\`, no `@{`, no component that starts with `.` or ends
 * `.lock`, no empty component, no trailing `.` or `/`.
 */
export function isSafeRefName(name: unknown): name is string {
  if (typeof name !== "string" || name.length === 0 || name.length > 200) return false;
  if (
    name === "@" ||
    name.startsWith("-") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".")
  ) {
    return false;
  }
  if (name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  // Beyond git's rules: plain characters only, so nothing is ever left for a shell to read.
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) return false;
  return name.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

/** Where conversations and tickets work in a sandbox. */
export const WORK_ROOT = "/home/employee/work/";

/**
 * A working directory is a normalised path directly under the work root, named `conv-<id>` or
 * `inc-<id>`. Anything else (`/etc/x`, `../..`, spaces, `$(...)`) is refused before it reaches a shell.
 */
export function isSafeWorkDir(cwd: unknown): cwd is string {
  if (typeof cwd !== "string" || !cwd.startsWith(WORK_ROOT)) return false;
  if (posix.normalize(cwd) !== cwd) return false;
  return /^(?:conv|inc)-[A-Za-z0-9_-]{1,64}$/.test(cwd.slice(WORK_ROOT.length));
}

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

export const branchName = (ticket: Ticket) => {
  // A ticket made from a conversation works on the conversation's own branch.
  if (ticket.branch) return ticket.branch;
  const slug = ticket.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/, "");
  return `inc/${ticket.id}-${slug || "work"}`;
};

/**
 * The git side of pick-up, run in the builder's machine. The repo is cloned once per machine, next
 * to the worktrees. A branch that's already on GitHub (a handoff, or a new machine) is checked out
 * as it is.
 */
export function openScript(o: {
  remote: string;
  repoDir: string;
  worktree: string;
  branch: string;
  name: string;
  email: string;
  message: string;
  /** Owner-merges mode pushes the branch for a PR; direct mode keeps it local. Default: push. */
  push?: boolean;
  /**
   * What to do with a local branch that has commits GitHub's copy lacks, when the worktree is made
   * again. "keep" (conversations) checks the local branch out as it is. "origin" (tickets) resets it
   * to GitHub's, after saving the local one as `refs/inc-backup/<branch>-<time>` and saying so
   * (`@@backup <ref>`), so nothing is lost. Default: origin.
   */
  local?: "keep" | "origin";
}): string {
  if (!isSafeRefName(o.branch)) throw new Error(`not a branch name: ${o.branch}`);
  const [remote, repoDir, worktree, branch] = [o.remote, o.repoDir, o.worktree, o.branch].map(quote);
  return [
    "set -e",
    `if [ ! -d ${repoDir}/.git ]; then git clone --quiet ${remote} ${repoDir}; fi`,
    `cd ${repoDir}`,
    // A team shares one machine, so each worktree carries its own author, not the global config.
    "git config extensions.worktreeConfig true",
    "git fetch --quiet --prune origin",
    "BASE_REF=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)",
    'if [ -z "$BASE_REF" ]; then',
    "  if git show-ref --quiet --verify refs/remotes/origin/main; then",
    '    BASE_REF="origin/main"',
    "  elif git show-ref --quiet --verify refs/remotes/origin/master; then",
    '    BASE_REF="origin/master"',
    "  elif git rev-parse --verify HEAD >/dev/null 2>&1; then",
    '    BASE_REF="HEAD"',
    "  else",
    '    git commit --quiet --allow-empty -m "Initial commit"',
    '    BASE_REF="HEAD"',
    "  fi",
    "fi",
    // Folders removed by hand or by the storage cleanup leave worktree records behind.
    "git worktree prune",
    "COPY=existing",
    `if ! git -C ${worktree} rev-parse --is-inside-work-tree >/dev/null 2>&1; then`,
    `  if git show-ref --quiet --verify refs/remotes/origin/${o.branch}; then`,
    `    if git show-ref --quiet --verify refs/heads/${o.branch} && [ "$(git rev-list --count ${branch} --not origin/${o.branch})" != 0 ]; then`,
    ...(o.local === "keep"
      ? [
          // A conversation's local branch with commits that were never pushed is checked out as it is, never reset.
          `      git worktree add --quiet ${worktree} ${branch}; COPY=restored`,
        ]
      : [
          // A ticket's is reset to GitHub's, as before, but first saved where it can be found again.
          `      BACKUP="refs/inc-backup/${o.branch}-$(date +%s)"`,
          `      git update-ref "$BACKUP" refs/heads/${o.branch}`,
          '      echo "@@backup $BACKUP"',
          `      git worktree add --quiet -B ${branch} ${worktree} origin/${o.branch}; COPY=remote`,
        ]),
    "    else",
    `      git worktree add --quiet -B ${branch} ${worktree} origin/${o.branch}; COPY=remote`,
    "    fi",
    // The branch is still here from an earlier copy that was cleaned up: its commits are kept.
    `  elif git show-ref --quiet --verify refs/heads/${o.branch}; then`,
    `    git worktree add --quiet ${worktree} ${branch}; COPY=restored`,
    "  else",
    `    git worktree add --quiet -b ${branch} ${worktree} "$BASE_REF"; COPY=fresh`,
    "  fi",
    "fi",
    `cd ${worktree}`,
    // A reviewer's copy that becomes a builder's worktree (a handoff) is never reset again.
    "git config --worktree --unset i-inc.copy || true",
    `git config --worktree user.name ${quote(o.name)}`,
    `git config --worktree user.email ${quote(o.email)}`,
    'echo "@@copy $COPY"',
    ...(o.push === false
      ? ["echo @@ready"]
      : [
          `if [ -z "$(git rev-list \${BASE_REF:-origin/main}..HEAD 2>/dev/null)" ]; then git commit --quiet --allow-empty -m ${quote(o.message)}; fi`,
          `git push --quiet -u origin ${branch}`,
          "echo @@pushed",
        ]),
  ].join("\n");
}

/**
 * The branch, checked out for a reviewer or verifier in its own machine (spec §6, stage 6), at its
 * latest pushed commit. A worktree that's already there and isn't a review copy (the builder's, on
 * a team's shared machine) is left alone. A review copy is marked, and only a marked copy is moved
 * to a later commit. It sets no author: it never commits or pushes.
 */
export function checkoutScript(o: {
  remote: string;
  repoDir: string;
  worktree: string;
  branch: string;
}): string {
  if (!isSafeRefName(o.branch)) throw new Error(`not a branch name: ${o.branch}`);
  const [remote, repoDir, worktree, branch] = [o.remote, o.repoDir, o.worktree, o.branch].map(quote);
  const aside = quote(`${o.worktree}.pre-checkout`);
  return [
    "set -e",
    `if git -C ${worktree} rev-parse --is-inside-work-tree >/dev/null 2>&1; then`,
    `  if [ "$(git -C ${worktree} config --worktree --get i-inc.copy 2>/dev/null || true)" != review ]; then`,
    "    echo @@ready; exit 0",
    "  fi",
    `  git -C ${worktree} fetch --quiet --prune origin`,
    `  git -C ${worktree} checkout --quiet -B ${branch} origin/${o.branch}`,
    `  git -C ${worktree} reset --quiet --hard origin/${o.branch}`,
    "  echo @@ready; exit 0",
    "fi",
    `if [ ! -d ${repoDir}/.git ]; then git clone --quiet ${remote} ${repoDir}; fi`,
    `cd ${repoDir}`,
    "git config extensions.worktreeConfig true",
    "git fetch --quiet --prune origin",
    // The folder may hold the images already, or the launcher's empty folder: set it aside, then
    // put back what isn't in the branch.
    `rm -rf ${aside}`,
    `if [ -e ${worktree} ]; then mv ${worktree} ${aside}; fi`,
    `git worktree add --quiet -B ${branch} ${worktree} origin/${o.branch}`,
    `git -C ${worktree} config --worktree i-inc.copy review`,
    `EXCLUDE=$(git -C ${worktree} rev-parse --path-format=absolute --git-path info/exclude)`,
    'mkdir -p "$(dirname "$EXCLUDE")"',
    `grep -qxF .inc/ "$EXCLUDE" 2>/dev/null || echo .inc/ >> "$EXCLUDE"`,
    `if [ -e ${aside} ]; then cp -an ${aside}/. ${worktree}/; rm -rf ${aside}; fi`,
    "echo @@ready",
  ].join("\n");
}

/**
 * Writes one of the owner's images into the worktree, under `.inc/`, which git is told to ignore
 * (`info/exclude`, so it isn't a change to the repo). One image per script keeps each one small.
 * An image that's already there is left alone: attachments never change.
 *
 * The image's base64 comes after the script's last line, which hands the rest of stdin to
 * `base64 -d`. Bash reads a script from a pipe a byte at a time, so a 10 MB image as a heredoc
 * took over a second and a half to read on Linux; this way it takes milliseconds (#14).
 */
export function attachmentScript(o: { worktree: string; file: AttachmentFile }): string {
  const path = attachmentPath(o.file);
  if (!/^[A-Za-z0-9._/-]+$/.test(path) || path.includes("..")) throw new Error(`not a safe path: ${path}`);
  const base64 = Buffer.from(o.file.data)
    .toString("base64")
    .replace(/.{1,76}/g, "$&\n");
  return [
    "set -e",
    // A reviewer's folder may not be a checkout (direct mode on another team's machine).
    `mkdir -p ${quote(o.worktree)}`,
    `cd ${quote(o.worktree)}`,
    "mkdir -p .inc/attachments",
    "if EXCLUDE=$(git rev-parse --git-path info/exclude 2>/dev/null); then",
    '  mkdir -p "$(dirname "$EXCLUDE")"',
    `  grep -qxF .inc/ "$EXCLUDE" 2>/dev/null || echo .inc/ >> "$EXCLUDE"`,
    "fi",
    // One line, so bash has read all of it before base64 (or cat) takes the rest of stdin.
    `if [ -f ${path} ]; then cat > /dev/null; else base64 -d > ${path}.part; mv ${path}.part ${path}; fi; echo @@attached`,
    base64,
  ].join("\n");
}

/**
 * Removes a conversation's working copy that was made for a session that then failed to open (no
 * sign-in, the agent would not start): nothing of the owner's is in it. Only a copy with no
 * commits of its own and no changes goes, with its new branch; anything else is left for the storage
 * cleanup, which keeps unpushed work.
 */
export function removeCopyScript(o: { worktree: string; branch: string | null }): string {
  if (o.branch !== null && !isSafeRefName(o.branch)) throw new Error(`not a branch name: ${o.branch}`);
  const q = quote(o.worktree);
  return [
    "set -u",
    `q=${q}`,
    '[ -L "$q" ] && { echo @@kept symlink; exit 0; }',
    '[ -d "$q" ] || { echo @@gone; exit 0; }',
    'if [ -e "$q/.git" ]; then',
    '  ahead=$(git -C "$q" rev-list --count HEAD --not --remotes) || { echo @@kept gitfail; exit 0; }',
    '  dirty=$(git -C "$q" status --porcelain) || { echo @@kept gitfail; exit 0; }',
    '  [ "$ahead" = 0 ] && [ -z "$dirty" ] || { echo @@kept work; exit 0; }',
    '  common=$(git -C "$q" rev-parse --path-format=absolute --git-common-dir) || { echo @@kept gitfail; exit 0; }',
    '  repo=$(dirname "$common")',
    '  git -C "$repo" worktree remove --force "$q" || { echo @@kept gitfail; exit 0; }',
    ...(o.branch !== null ? [`  git -C "$repo" branch -D ${quote(o.branch)} >/dev/null 2>&1 || true`] : []),
    "else",
    // The empty folder of a conversation with no project, or one holding only the images.
    '  extra=$(ls -A "$q" | grep -v "^[.]inc$" | head -n 1)',
    '  [ -z "$extra" ] || { echo @@kept files; exit 0; }',
    '  rm -rf -- "$q"',
    "fi",
    "echo @@removed",
  ].join("\n");
}

/**
 * A conversation's working copy in its employee's sandbox: a branch worktree of the project's repo,
 * made like a ticket's but never committed to or pushed (the owner turns the work into a ticket when it
 * should ship), or, with no project, an empty folder to work in. Safe to repeat: a worktree that is
 * already there is left as it is.
 */
export type CopyState = "existing" | "fresh" | "restored" | "remote";

/** What `prepareConversationCopy` found: the copy was there, or it was made new, or made again from what was kept. */
export async function prepareConversationCopy(
  o: Pick<WorkspaceOptions, "project" | "tokens" | "identity" | "run" | "remote">,
  c: { employee: Employee; project: string | null; branch: string | null; cwd: string },
): Promise<CopyState> {
  const state = (r: { output: string }): CopyState => {
    const m = /@@copy (existing|fresh|restored|remote)/.exec(r.output);
    return (m?.[1] as CopyState | undefined) ?? "existing";
  };
  const fail = (r: { output: string }) => {
    const tail = r.output.trim().split("\n").slice(-5).join("\n");
    return new Error(`git in ${c.employee.name}'s machine failed: ${tail}`);
  };
  if (!isSafeWorkDir(c.cwd)) throw new Error(`not a safe folder: ${String(c.cwd)}`);
  if (c.project === null || c.branch === null) {
    const r = await o.run(
      c.employee.id,
      `set -e\nif [ -d ${quote(c.cwd)} ]; then COPY=existing; else COPY=fresh; fi\nmkdir -p ${quote(c.cwd)}\necho "@@copy $COPY"\necho @@ready`,
    );
    if (r.code !== 0 || !r.output.includes("@@ready")) throw fail(r);
    return state(r);
  }
  if (!isSafeRefName(c.branch)) throw new Error(`not a branch name: ${c.branch}`);
  const project = o.project(c.project);
  if (!project) throw new Error(`no project ${c.project}`);
  const { repo } = project;
  const [token, who] = await Promise.all([o.tokens.token(repo), o.identity(c.employee)]);
  const script = openScript({
    remote: o.remote?.(repo) ?? `https://github.com/${repo}.git`,
    repoDir: `${dirname(c.cwd)}/${repo.split("/")[1]}`,
    worktree: c.cwd,
    branch: c.branch,
    ...who,
    message: "",
    push: false,
    local: "keep",
  });
  const r = await o.run(c.employee.id, script, { GH_TOKEN: token });
  if (r.code !== 0 || !r.output.includes("@@ready")) throw fail(r);
  return state(r);
}

export class GitHubWorkspace implements Workspace {
  constructor(private readonly o: WorkspaceOptions) {}

  private project(ticket: Ticket): Project {
    const project = this.o.project(ticket.project);
    if (!project) throw new Error(`no project ${ticket.project}: add it with PUT /api/projects/:id`);
    return project;
  }

  async open(ticket: Ticket, builder: Employee): Promise<PullRequestRef> {
    const project = this.project(ticket);
    const { repo } = project;
    const branch = branchName(ticket);
    const worktree = this.o.worktree(ticket.id);
    const direct = this.o.policy?.(ticket.project).mode === "direct";
    const [token, who] = await Promise.all([this.o.tokens.token(repo), this.o.identity(builder)]);
    const script = openScript({
      remote: this.o.remote?.(repo) ?? `https://github.com/${repo}.git`,
      repoDir: `${dirname(worktree)}/${repo.split("/")[1]}`,
      worktree,
      branch,
      ...who,
      message: `chore: start work on ${ticket.title}`,
      push: !direct,
      // A conversation's branch may hold commits GitHub lacks (direct mode never pushes): they stay.
      ...(ticket.conversation ? { local: "keep" as const } : {}),
    });
    const r = await this.o.run(builder.id, script, { GH_TOKEN: token });
    if (r.code !== 0 || !r.output.includes(direct ? "@@ready" : "@@pushed")) {
      const tail = r.output.trim().split("\n").slice(-5).join("\n");
      throw new Error(`git in ${builder.name}'s machine failed: ${tail}`);
    }
    await this.attach(ticket, builder);
    // A local branch with commits GitHub did not have was reset to GitHub's; the ticket says where the old one is.
    const backup = /@@backup (\S+)/.exec(r.output)?.[1];
    const note = backup
      ? `${branch} in ${builder.name}'s machine had commits GitHub's copy lacked. They are kept as ${backup} (git branch <name> ${backup} brings them back); the working copy now matches GitHub's branch.`
      : undefined;
    if (note) this.o.log?.(`${ticket.id}: ${note}`);
    // Direct mode: a local branch; the reviewed work is pushed to main at the gates.
    if (direct) return { branch, ...(note ? { note } : {}) };
    const pr =
      (await this.o.prs.find(repo, branch)) ??
      (await this.o.prs.openDraft(repo, {
        head: branch,
        base: project.defaultBranch ?? "main",
        title: `${ticket.type}: ${ticket.title}`,
        body: [
          `Ticket #${ticket.id} in i.inc, built by ${builder.name}. It's a draft so CI runs from the start;`,
          "the report replaces this text when the work is ready.",
          "",
          "Done when:",
          ...ticket.doneWhen.map((d) => `- ${d}`),
        ].join("\n"),
      }));
    return { number: pr.number, url: pr.url, nodeId: pr.nodeId, branch, ...(note ? { note } : {}) };
  }

  /**
   * Checks the branch out in a reviewer's or verifier's machine. Direct mode keeps the branch in
   * the builder's machine, so there is nothing to fetch: the images alone are copied there.
   */
  async checkout(ticket: Ticket, employee: Employee): Promise<void> {
    if (this.o.policy?.(ticket.project).mode === "direct") return;
    const { repo } = this.project(ticket);
    const worktree = this.o.worktree(ticket.id);
    const script = checkoutScript({
      remote: this.o.remote?.(repo) ?? `https://github.com/${repo}.git`,
      repoDir: `${dirname(worktree)}/${repo.split("/")[1]}`,
      worktree,
      branch: branchName(ticket),
    });
    const token = await this.o.tokens.token(repo);
    const r = await this.o.run(employee.id, script, { GH_TOKEN: token });
    if (r.code !== 0 || !r.output.includes("@@ready")) {
      const tail = r.output.trim().split("\n").slice(-5).join("\n");
      throw new Error(`git in ${employee.name}'s machine failed: ${tail}`);
    }
  }

  /** Copies the ticket's images into the worktree: those numbered `ns`, or all of them. */
  async attach(ticket: Ticket, employee: Employee, ns?: number[]): Promise<void> {
    const worktree = this.o.worktree(ticket.id);
    for (const file of this.o.attachments?.(ticket.id) ?? []) {
      if (ns && !ns.includes(file.n)) continue;
      const a = await this.o.run(employee.id, attachmentScript({ worktree, file }));
      if (a.code !== 0 || !a.output.includes("@@attached")) {
        const tail = a.output.trim().split("\n").slice(-5).join("\n");
        throw new Error(`couldn't copy ${file.name} into ${employee.name}'s machine: ${tail}`);
      }
    }
  }

  async ready(ticket: Ticket, pr: PullRequestRef, report: string): Promise<void> {
    const { repo } = this.project(ticket);
    if (pr.number === undefined || pr.nodeId === undefined) return; // direct mode: no PR
    await this.o.prs.setBody(repo, pr.number, report);
    if (await this.o.prs.isDraft(repo, pr.number)) await this.o.prs.markReady(repo, pr.nodeId);
  }
}
