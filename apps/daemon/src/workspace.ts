// The Workspace port on GitHub (spec §6, stages 1 and 9). Pick-up makes the ticket's worktree and
// branch in the builder's machine, pushes the branch as the bot, and opens a draft PR. GitHub opens
// no PR without a commit, so a new branch starts with an empty one; the squash merge drops it. The
// report stage writes the PR's body and takes it out of draft. Both are safe to repeat: a crash, a
// handoff or a new machine finds the branch and the PR that are already there.
import { dirname } from "node:path";
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
  /** The images the owner attached to a ticket, with their bytes. */
  attachments?: (ticketId: string) => AttachmentFile[];
}

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

export const branchName = (ticket: Ticket) => {
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
}): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(o.branch)) throw new Error(`not a branch name: ${o.branch}`);
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
    `if ! git -C ${worktree} rev-parse --is-inside-work-tree >/dev/null 2>&1; then`,
    `  if git show-ref --quiet --verify refs/remotes/origin/${o.branch}; then`,
    `    git worktree add --quiet -B ${branch} ${worktree} origin/${o.branch}`,
    "  else",
    `    git worktree add --quiet -b ${branch} ${worktree} "$BASE_REF"`,
    "  fi",
    "fi",
    `cd ${worktree}`,
    `git config --worktree user.name ${quote(o.name)}`,
    `git config --worktree user.email ${quote(o.email)}`,
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
 * Writes one of the owner's images into the worktree, under `.inc/`, which git is told to ignore
 * (`info/exclude`, so it isn't a change to the repo). One image per script keeps each one small.
 * An image that's already there is left alone: attachments never change.
 */
export function attachmentScript(o: { worktree: string; file: AttachmentFile }): string {
  const path = attachmentPath(o.file);
  if (!/^[A-Za-z0-9._/-]+$/.test(path) || path.includes("..")) throw new Error(`not a safe path: ${path}`);
  const base64 = Buffer.from(o.file.data)
    .toString("base64")
    .replace(/.{1,76}/g, "$&\n");
  return [
    "set -e",
    `cd ${quote(o.worktree)}`,
    "EXCLUDE=$(git rev-parse --git-path info/exclude)",
    'mkdir -p "$(dirname "$EXCLUDE")" .inc/attachments',
    `grep -qxF .inc/ "$EXCLUDE" 2>/dev/null || echo .inc/ >> "$EXCLUDE"`,
    `if [ ! -f ${path} ]; then`,
    `  base64 -d > ${path}.part <<'@@IMAGE'`,
    `${base64}@@IMAGE`,
    `  mv ${path}.part ${path}`,
    "fi",
    "echo @@attached",
  ].join("\n");
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
    });
    const r = await this.o.run(builder.id, script, { GH_TOKEN: token });
    if (r.code !== 0 || !r.output.includes(direct ? "@@ready" : "@@pushed")) {
      const tail = r.output.trim().split("\n").slice(-5).join("\n");
      throw new Error(`git in ${builder.name}'s machine failed: ${tail}`);
    }
    for (const file of this.o.attachments?.(ticket.id) ?? []) {
      const a = await this.o.run(builder.id, attachmentScript({ worktree, file }));
      if (a.code !== 0 || !a.output.includes("@@attached")) {
        const tail = a.output.trim().split("\n").slice(-5).join("\n");
        throw new Error(`couldn't copy ${file.name} into ${builder.name}'s machine: ${tail}`);
      }
    }
    // Direct mode: a local branch; the reviewed work is pushed to main at the gates.
    if (direct) return { branch };
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
    return { number: pr.number, url: pr.url, nodeId: pr.nodeId, branch };
  }

  async ready(ticket: Ticket, pr: PullRequestRef, report: string): Promise<void> {
    const { repo } = this.project(ticket);
    if (pr.number === undefined || pr.nodeId === undefined) return; // direct mode: no PR
    await this.o.prs.setBody(repo, pr.number, report);
    if (await this.o.prs.isDraft(repo, pr.number)) await this.o.prs.markReady(repo, pr.nodeId);
  }
}
