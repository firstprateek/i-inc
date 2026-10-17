// The Workspace port on GitHub (spec §6, stages 1 and 9). Pick-up makes the ticket's worktree and
// branch in the builder's machine, pushes the branch as the bot, and opens a draft PR. GitHub opens
// no PR without a commit, so a new branch starts with an empty one; the squash merge drops it. The
// report stage writes the PR's body and takes it out of draft. Both are safe to repeat: a crash, a
// handoff or a new machine finds the branch and the PR that are already there.
import { dirname } from "node:path";
import type { Employee, PullRequestRef, Ticket, Workspace } from "@i-inc/core";
import type { PullRequests, TokenSource } from "./github.ts";
import type { RunScript } from "./harness.ts";
import type { Project } from "./registry.ts";

export interface WorkspaceOptions {
  project: (name: string) => Project | undefined;
  tokens: TokenSource;
  prs: PullRequests;
  /** The git identity an employee's commits carry, such as "Ada (i.inc)" with the bot's address. */
  identity: (employee: Employee) => Promise<{ name: string; email: string }>;
  /** The ticket's worktree in the machine: `workDir`. */
  worktree: (ticketId: string) => string;
  run: RunScript;
  /** Where the repo is cloned from; tests use a local path. */
  remote?: (repo: string) => string;
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
}): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(o.branch)) throw new Error(`not a branch name: ${o.branch}`);
  const [remote, repoDir, worktree, branch] = [o.remote, o.repoDir, o.worktree, o.branch].map(quote);
  return [
    "set -e",
    `git config --global user.name ${quote(o.name)}`,
    `git config --global user.email ${quote(o.email)}`,
    `if [ ! -d ${repoDir}/.git ]; then git clone --quiet ${remote} ${repoDir}; fi`,
    `cd ${repoDir}`,
    "git fetch --quiet --prune origin",
    `if ! git -C ${worktree} rev-parse --is-inside-work-tree >/dev/null 2>&1; then`,
    `  if git show-ref --quiet --verify refs/remotes/origin/${o.branch}; then`,
    `    git worktree add --quiet -B ${branch} ${worktree} origin/${o.branch}`,
    "  else",
    `    git worktree add --quiet -b ${branch} ${worktree} origin/main`,
    "  fi",
    "fi",
    `cd ${worktree}`,
    `if [ -z "$(git rev-list origin/main..HEAD)" ]; then git commit --quiet --allow-empty -m ${quote(o.message)}; fi`,
    `git push --quiet -u origin ${branch}`,
    "echo @@pushed",
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
    const { repo } = this.project(ticket);
    const branch = branchName(ticket);
    const worktree = this.o.worktree(ticket.id);
    const [token, who] = await Promise.all([this.o.tokens.token(repo), this.o.identity(builder)]);
    const script = openScript({
      remote: this.o.remote?.(repo) ?? `https://github.com/${repo}.git`,
      repoDir: `${dirname(worktree)}/${repo.split("/")[1]}`,
      worktree,
      branch,
      ...who,
      message: `chore: start work on ${ticket.title}`,
    });
    const r = await this.o.run(builder.id, script, { GH_TOKEN: token });
    if (r.code !== 0 || !r.output.includes("@@pushed")) {
      const tail = r.output.trim().split("\n").slice(-5).join("\n");
      throw new Error(`git in ${builder.name}'s machine failed: ${tail}`);
    }
    const pr =
      (await this.o.prs.find(repo, branch)) ??
      (await this.o.prs.openDraft(repo, {
        head: branch,
        base: "main",
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
    await this.o.prs.setBody(repo, pr.number, report);
    if (await this.o.prs.isDraft(repo, pr.number)) await this.o.prs.markReady(repo, pr.nodeId);
  }
}
