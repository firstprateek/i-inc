// The real harness (spec §6, stages 4 and 8): the project's check recipe and the final gates, run in
// the builder's machine. Scripts go in on stdin through `container machine run -i … -- bash -s`,
// because `machine run` re-splits its arguments (M1).
import { spawn } from "node:child_process";
import type { ChecksResult, GatesResult, Harness, ProjectPolicy, Ticket } from "@i-inc/core";
import { assertWalls, defaultMachineSettings, type MachineSettings, machineOf } from "./machines.ts";

/**
 * Runs a script in an employee's machine and resolves with its exit code and output. Variables in
 * `env`, such as GH_TOKEN, go in with `-e NAME`, like a session's credentials (machines.ts).
 */
export type RunScript = (
  employeeId: string,
  script: string,
  env?: Record<string, string>,
  /** A machine other than the employee's own, such as the one they used to work in. */
  opts?: { machine?: string },
) => Promise<{ code: number; output: string }>;

export function machineScript(s: MachineSettings = defaultMachineSettings): RunScript {
  return (employeeId, script, env = {}, opts = {}) =>
    new Promise((resolve, reject) => {
      try {
        assertWalls(s);
        if (opts.machine !== undefined && !/^inc-[a-z0-9-]{1,32}$/.test(opts.machine)) {
          throw new Error(`not a machine name: ${opts.machine}`);
        }
      } catch (err) {
        return reject(err);
      }
      const names = Object.keys(env);
      const bad = names.find((name) => !/^[A-Z_][A-Z0-9_]*$/.test(name));
      if (bad) return reject(new Error(`can't pass ${bad} into a machine`));
      const flags = names.flatMap((name) => ["-e", name]);
      const args = [
        "machine",
        "run",
        "-i",
        "-u",
        s.user,
        "-n",
        opts.machine ?? machineOf(s, employeeId),
        ...flags,
        "--",
        "bash",
        "-s",
      ];
      const child = spawn(s.bin, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code: code ?? 1, output }));
      child.stdin.end(script);
    });
}

export interface HarnessSettings {
  /** A project's check recipe, in order: for Duet, pnpm install, lint, typecheck and test. */
  recipe: (project: string) => string[] | undefined;
  /** The ticket's worktree in the machine; the same path the ACP session works in. */
  worktree: (ticketId: string) => string;
  /** How many lines of a failing step's output go back to the builder. */
  tailLines?: number;
  /** What the machine has, for briefs: images/employee's tools. */
  machine?: string;
  /**
   * With GitHub: the environment (GH_TOKEN) for fetching main and pushing the rebased branch, so the
   * PR shows what passed the gates. Without it, the gates rebase locally only.
   */
  github?: (ticket: Ticket) => Promise<Record<string, string>>;
  /** With GitHub: waits for CI on the pushed commit, the last of stage 8's gates. */
  ci?: (ticket: Ticket, sha: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** How a project's work reaches main. Absent: owner-merges (rebase, and push the PR's branch). */
  policy?: (project: string) => ProjectPolicy;
  /** The project's default branch (main, master, etc.). Default: main. */
  defaultBranch?: (project: string) => string | undefined;
}

/** Direct mode: the files this ticket's work changes, against where it left main. */
export function changedScript(worktree: string, branch = "main"): string {
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(branch)) throw new Error(`not a branch name: ${branch}`);
  return [
    `cd ${quote(worktree)} || { echo '@@fail cd into the worktree'; exit 1; }`,
    `git fetch --quiet origin ${branch} || { echo '@@fail git fetch'; exit 1; }`,
    // No rename detection: a file moved out of a protected folder is a deletion there as well as an addition
    // elsewhere, and both paths count. NUL-separated and encoded, so a name with a quote, tab or newline is exact.
    `git diff --name-only -z --no-renames --no-ext-diff "$(git merge-base origin/${branch} HEAD)" | while IFS= read -r -d '' f; do printf '@@changed64 %s\\n' "$(printf %s "$f" | base64 | tr -d '\\n')"; done`,
  ].join("\n");
}

/** Direct mode: pushes the rebased work to main, or says main moved since the rebase. */
export function pushMainScript(worktree: string, branch = "main"): string {
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(branch)) throw new Error(`not a branch name: ${branch}`);
  return [
    `cd ${quote(worktree)} || { echo '@@fail cd into the worktree'; exit 1; }`,
    `if out=$(git push --quiet origin HEAD:${branch} 2>&1); then`,
    '  echo "@@pushed $(git rev-parse HEAD)"',
    "else",
    '  echo "$out"',
    '  case "$out" in *"fetch first"*|*non-fast-forward*|*rejected*) echo "@@behind"; exit 7 ;; esac',
    "  exit 1",
    "fi",
  ].join("\n");
}

/** Direct mode: takes a commit back out of main, from a scratch worktree beside the ticket's. */
export function revertScript(worktree: string, sha: string, branch = "main"): string {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a commit: ${sha}`);
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(branch)) throw new Error(`not a branch name: ${branch}`);
  return [
    `cd ${quote(worktree)} || { echo '@@fail cd into the worktree'; exit 1; }`,
    "tmp=$(mktemp -d)",
    "for attempt in 1 2 3; do",
    `  git fetch --quiet origin ${branch} || continue`,
    `  rm -rf "$tmp"; git worktree add --quiet --detach "$tmp" origin/${branch} || continue`,
    `  if (cd "$tmp" && git revert --no-edit ${sha} >/dev/null && git push --quiet origin HEAD:${branch}); then`,
    '    git worktree remove --force "$tmp"; echo @@reverted; exit 0',
    "  fi",
    '  git worktree remove --force "$tmp" 2>/dev/null',
    "done",
    "exit 1",
  ].join("\n");
}

/** Whether a changed file falls under one of a project's protected paths (a prefix or an exact file). */
export const isProtected = (file: string, paths: string[]) =>
  paths.some((p) => (p.endsWith("/") ? file.startsWith(p) : file === p));

const safeId = /^[A-Za-z0-9_-]{1,64}$/;
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/**
 * The recipe as a script. It stops at the first failing step, like CI, and marks each step so the
 * output can be read back: `@@ok <step>`, or `@@fail <step>` followed by the step's last lines.
 */
export function checksScript(worktree: string, recipe: string[], tail: number): string {
  const steps = recipe.map(
    (step) =>
      `if ( ${step} ) >"$log" 2>&1; then echo ${quote(`@@ok ${step}`)}; ` +
      `else echo ${quote(`@@fail ${step}`)}; tail -n ${tail} "$log"; exit 1; fi`,
  );
  return [
    'export PATH="$HOME/.local/bin:$PATH"',
    `cd ${quote(worktree)} || { echo '@@fail cd into the worktree'; exit 1; }`,
    "log=$(mktemp)",
    ...steps,
    "echo @@green",
  ].join("\n");
}

/** Fetches main and rebases onto it. A conflict aborts the rebase and says so. */
export function rebaseScript(worktree: string, branch = "main"): string {
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(branch)) throw new Error(`not a branch name: ${branch}`);
  return [
    `cd ${quote(worktree)} || { echo '@@fail cd into the worktree'; exit 1; }`,
    // Uncommitted work would stop the rebase, and isn't a conflict.
    `if [ -n "$(git status --porcelain)" ]; then git status --porcelain | head -20 | sed 's/^/@@dirty /'; exit 3; fi`,
    "branch=$(git branch --show-current)",
    `git fetch --quiet origin ${branch} || { echo '@@fail git fetch'; exit 1; }`,
    // Whatever GitHub has on the branch must already be here, or the force-push would drop it. Its
    // commit is the lease the push holds to.
    `remote=$(git ls-remote origin "refs/heads/$branch" | cut -f1)`,
    'if [ -n "$remote" ]; then',
    "  git fetch --quiet origin \"refs/heads/$branch\" || { echo '@@fail git fetch'; exit 1; }",
    '  git merge-base --is-ancestor "$remote" HEAD || { echo "@@diverged $remote"; exit 4; }',
    "fi",
    'echo "@@lease $remote"',
    `if ! git rebase --quiet origin/${branch} >/dev/null 2>&1; then`,
    "  git diff --name-only --diff-filter=U | sed 's/^/@@conflict /'",
    "  git rebase --abort",
    "  exit 2",
    "fi",
    // Pick-up's empty commit alone isn't work.
    `if git diff --quiet origin/${branch} HEAD; then echo "@@empty $(git rev-parse origin/${branch})"; exit 5; fi`,
    "echo @@rebased",
  ].join("\n");
}

/**
 * Pushes the rebased branch over the PR's, only if the PR's branch is still at `lease`, the commit
 * the gates found there (empty: it didn't exist), so nobody else's push is dropped.
 */
export function pushScript(worktree: string, lease: string): string {
  if (!/^([0-9a-f]{40})?$/.test(lease)) throw new Error(`not a commit: ${lease}`);
  return [
    `cd ${quote(worktree)} || { echo '@@fail cd into the worktree'; exit 1; }`,
    "branch=$(git branch --show-current)",
    `git push --quiet --force-with-lease="$branch:${lease}" origin HEAD && echo "@@pushed $(git rev-parse HEAD)"`,
  ].join("\n");
}

export function readChecks(code: number, output: string): ChecksResult {
  if (code === 0 && output.includes("@@green")) return { green: true, failures: [] };
  const at = output.indexOf("@@fail ");
  if (at < 0)
    return {
      green: false,
      failures: [`the checks didn't finish (exit ${code}): ${output.trim().slice(-500)}`],
    };
  const [head = "", ...rest] = output.slice(at + "@@fail ".length).split("\n");
  const detail = rest.join("\n").trim();
  return { green: false, failures: [detail ? `${head}\n${detail}` : head] };
}

export class MachineHarness implements Harness {
  constructor(
    private readonly s: HarnessSettings,
    private readonly run: RunScript = machineScript(),
  ) {}

  private recipe(ticket: Ticket): string[] {
    const recipe = this.s.recipe(ticket.project);
    if (!recipe?.length) throw new Error(`no check recipe for ${ticket.project}`);
    return recipe;
  }

  private worktree(ticket: Ticket): string {
    if (!safeId.test(ticket.id)) throw new Error(`not a ticket id: ${ticket.id}`);
    return this.s.worktree(ticket.id);
  }

  private defaultBranch(ticket: Ticket): string {
    return this.s.defaultBranch?.(ticket.project) || "main";
  }

  describe(ticket: Ticket): string[] {
    const recipe = this.s.recipe(ticket.project);
    return [
      ...(this.s.machine ? [this.s.machine] : []),
      ...(recipe?.length
        ? [
            `After you build, the harness runs ${ticket.project}'s checks in your worktree, in order: ${recipe.map((c) => `\`${c}\``).join(", ")}. Run them yourself before you say you're done.`,
          ]
        : []),
    ];
  }

  async runChecks(ticket: Ticket): Promise<ChecksResult> {
    const script = checksScript(this.worktree(ticket), this.recipe(ticket), this.s.tailLines ?? 40);
    const { code, output } = await this.run(ticket.assignee, script);
    return readChecks(code, output);
  }

  async runGates(ticket: Ticket, opts: { ownerApproved?: boolean } = {}): Promise<GatesResult> {
    const policy = this.s.policy?.(ticket.project);
    if (policy?.mode === "direct") return this.directGates(ticket, policy, opts.ownerApproved === true);
    const env = (await this.s.github?.(ticket)) ?? {};
    const branch = this.defaultBranch(ticket);
    const rebased = await this.run(ticket.assignee, rebaseScript(this.worktree(ticket), branch), env);
    if (rebased.code === 2) {
      const files = [...rebased.output.matchAll(/^@@conflict (.+)$/gm)].map((m) => m[1]);
      return {
        ok: false,
        conflict: true,
        reason: `rebasing on ${branch} conflicts in ${files.join(", ") || "some files"}`,
      };
    }
    const lines = (tag: string) =>
      [...rebased.output.matchAll(new RegExp(`^@@${tag} ?(.*)$`, "gm"))].map((m) => m[1]);
    const no = (reason: string): GatesResult => ({ ok: false, conflict: false, reason });
    if (rebased.code === 3) return no(`the worktree has uncommitted changes: ${lines("dirty").join(", ")}`);
    if (rebased.code === 4) {
      return no(
        `the PR's branch has commits the worktree hasn't (${lines("diverged")[0]}), so it wasn't pushed over`,
      );
    }
    if (rebased.code === 5) return no(`the branch has no changes beyond ${branch}`);
    if (rebased.code !== 0) return no(`couldn't rebase on ${branch}: ${rebased.output.trim().slice(-300)}`);
    const lease = lines("lease")[0] ?? "";
    const checks = await this.runChecks(ticket);
    if (!checks.green) {
      return {
        ok: false,
        conflict: false,
        reason: `the checks fail after rebasing on ${branch}: ${checks.failures.join("; ")}`,
      };
    }
    if (this.s.github) {
      const pushed = await this.run(ticket.assignee, pushScript(this.worktree(ticket), lease), env);
      const sha = /^@@pushed ([0-9a-f]{40})$/m.exec(pushed.output)?.[1];
      if (pushed.code !== 0 || !sha) {
        return {
          ok: false,
          conflict: false,
          reason: `couldn't push the rebased branch: ${pushed.output.trim().slice(-300)}`,
        };
      }
      const ci = await this.s.ci?.(ticket, sha);
      if (ci && !ci.ok) return { ok: false, conflict: false, reason: ci.reason };
    }
    return { ok: true };
  }

  /**
   * Direct mode's gates (decided 2026-10-17): protected paths wait for the owner; then rebase on
   * main, checks, and a push to main. If main moves in between, rebase and try again, up to 3 times.
   */
  private async directGates(
    ticket: Ticket,
    policy: ProjectPolicy,
    ownerApproved: boolean,
  ): Promise<GatesResult> {
    const env = (await this.s.github?.(ticket)) ?? {};
    const worktree = this.worktree(ticket);
    const branch = this.defaultBranch(ticket);
    const no = (reason: string): GatesResult => ({ ok: false, conflict: false, reason });

    const changed = await this.run(ticket.assignee, changedScript(worktree, branch), env);
    if (changed.code !== 0) return no(`couldn't read the change: ${changed.output.trim().slice(-300)}`);
    const files = [...changed.output.matchAll(/^@@changed64 (\S*)$/gm)].map((m) =>
      Buffer.from(m[1] as string, "base64").toString("utf8"),
    );
    const touched = files.filter((f) => isProtected(f, policy.protectedPaths));
    if (touched.length && !ownerApproved) {
      return {
        ok: false,
        conflict: false,
        reason: `it changes protected paths: ${touched.join(", ")}`,
        protectedPaths: touched,
      };
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      const rebased = await this.run(ticket.assignee, rebaseScript(worktree, branch), env);
      const lines = (tag: string) =>
        [...rebased.output.matchAll(new RegExp(`^@@${tag} ?(.*)$`, "gm"))].map((m) => m[1]);
      if (rebased.code === 2) {
        return {
          ok: false,
          conflict: true,
          reason: `rebasing on ${branch} conflicts in ${lines("conflict").join(", ") || "some files"}`,
        };
      }
      if (rebased.code === 3) return no(`the worktree has uncommitted changes: ${lines("dirty").join(", ")}`);
      if (rebased.code === 5) {
        // After the owner's OK, the owner may have pushed it already (push-for-owner.sh).
        const main = lines("empty")[0];
        if (ownerApproved && main && /^[0-9a-f]{40}$/.test(main)) return { ok: true, pushed: main };
        return no(`the branch has no changes beyond ${branch}`);
      }
      if (rebased.code !== 0) return no(`couldn't rebase on ${branch}: ${rebased.output.trim().slice(-300)}`);
      const checks = await this.runChecks(ticket);
      if (!checks.green)
        return no(`the checks fail after rebasing on ${branch}: ${checks.failures.join("; ")}`);
      const pushed = await this.run(ticket.assignee, pushMainScript(worktree, branch), env);
      const sha = /^@@pushed ([0-9a-f]{40})$/m.exec(pushed.output)?.[1];
      if (sha) return { ok: true, pushed: sha };
      if (pushed.code !== 7) {
        // GitHub refuses the bot any change to workflows: that needs the owner's push.
        const workflows = /workflow/i.test(pushed.output) && /refusing|permission/i.test(pushed.output);
        return no(
          workflows
            ? "GitHub won't let the bot push changes to workflows: the owner pushes this one (tools/host/push-for-owner.sh)"
            : `couldn't push to ${branch}: ${pushed.output.trim().slice(-300)}`,
        );
      }
    }
    return no(`${branch} kept moving while the gates ran; try again`);
  }

  /** Direct mode: CI on the commit pushed to main. */
  async watchCi(ticket: Ticket, sha: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    return (await this.s.ci?.(ticket, sha)) ?? { ok: true };
  }

  /** Direct mode: reverts a commit on main that stayed red too long. */
  async revert(ticket: Ticket, sha: string): Promise<void> {
    const env = (await this.s.github?.(ticket)) ?? {};
    const r = await this.run(
      ticket.assignee,
      revertScript(this.worktree(ticket), sha, this.defaultBranch(ticket)),
      env,
    );
    if (!r.output.includes("@@reverted"))
      throw new Error(`couldn't revert ${sha}: ${r.output.trim().slice(-300)}`);
  }
}
