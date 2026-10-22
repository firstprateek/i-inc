// The real harness (spec §6, stages 4 and 8): the project's check recipe and the final gates, run in
// the builder's machine. Scripts go in on stdin through `container machine run -i … -- bash -s`,
// because `machine run` re-splits its arguments (M1).
import { spawn } from "node:child_process";
import type { ChecksResult, GatesOptions, GatesResult, Harness, ProjectPolicy, Ticket } from "@i-inc/core";
import { type ApprovalCard, type HostPush, HostPushError } from "./host-push.ts";
import {
  assertRunnable,
  defaultMachineSettings,
  type Exec,
  execDefault,
  type MachineSettings,
  machineOf,
  withDefaultTimeout,
} from "./machines.ts";
import { isHostExecuted, isProtected } from "./paths.ts";
import { describeMs, guardStdin, stopGroup, trackGroup } from "./proc.ts";
import { pushFromSandbox } from "./sandbox-push.ts";
import { defaultTimeoutsMs, type TimeoutsMs } from "./timeouts.ts";
import { branchName, isSafeRefName } from "./workspace.ts";

/**
 * Runs a script in an employee's machine and resolves with its exit code and output. Variables in
 * `env`, such as GH_TOKEN, go in with `-e NAME`, like a session's credentials (machines.ts).
 */
export type RunScript = (
  employeeId: string,
  script: string,
  env?: Record<string, string>,
  /**
   * `machine`: a machine other than the employee's own, such as the one they used to work in.
   * `timeoutMs`: how long it may run before it is stopped (default: the script limit in timeouts.ts).
   */
  opts?: { machine?: string; timeoutMs?: number },
) => Promise<{ code: number; output: string }>;

/** The exit code of a script that was stopped for running too long (the one GNU `timeout` uses). */
export const TIMED_OUT = 124;

/** The most a script's output is kept: past it the script is stopped and its output ends with `@@output-limit`. */
export const MAX_SCRIPT_OUTPUT = 16 * 1024 * 1024;

export function machineScript(
  s: MachineSettings = defaultMachineSettings,
  exec: Exec = execDefault,
): RunScript {
  // The walls' look at `machine ls` has a limit too.
  const look = withDefaultTimeout(s, exec);
  return async (employeeId, script, env = {}, opts = {}) => {
    if (opts.machine !== undefined && !/^inc-[a-z0-9-]{1,32}$/.test(opts.machine)) {
      throw new Error(`not a machine name: ${opts.machine}`);
    }
    const machine = opts.machine ?? machineOf(s, employeeId);
    await assertRunnable(s, look, machine);
    const names = Object.keys(env);
    const bad = names.find((name) => !/^[A-Z_][A-Z0-9_]*$/.test(name));
    if (bad) throw new Error(`can't pass ${bad} into a machine`);
    const flags = names.flatMap((name) => ["-e", name]);
    const args = ["machine", "run", "-i", "-u", s.user, "-n", machine, ...flags, "--", "bash", "-s"];
    const limit = opts.timeoutMs ?? s.timeouts?.().scriptMs ?? defaultTimeoutsMs.scriptMs;
    return new Promise((resolve, reject) => {
      // Detached, so the child leads a process group that a timeout can stop as a whole.
      const child = spawn(s.bin, args, {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
      trackGroup(child);
      let output = "";
      let settled = false;
      const settle = (result: { code: number; output: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      // The deadline settles the call itself: a killed child whose grandchildren still hold its pipes
      // would never emit 'close', and the busy signal (and a deploy) would wait for it.
      const timer = setTimeout(() => {
        stopGroup(child, 2000);
        settle({
          code: TIMED_OUT,
          output: `${output}\nthe script timed out after ${describeMs(limit)} and was stopped`,
        });
      }, limit);
      timer.unref?.();
      // A script that prints without end (a runaway check, a hostile machine) is stopped at the cap, not held in
      // memory. A bundle (bundle.ts) is capped well under it.
      let size = 0;
      const take = (chunk: Buffer | string) => {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_SCRIPT_OUTPUT) {
          stopGroup(child, 2000);
          settle({
            code: 1,
            output: `${output.slice(-4000)}\n@@output-limit the script printed more than ${MAX_SCRIPT_OUTPUT / 1048576} MB\n`,
          });
          return;
        }
        output += chunk;
      };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      // A write to a child that has already exited is EPIPE: its exit is the answer, not a crash.
      guardStdin(child.stdin);
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      // 'close', not 'exit': 'exit' can come before the last output has been read.
      child.on("close", (code) => settle({ code: code ?? 1, output }));
      child.stdin.end(script);
    });
  };
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
  /** The limits in timeouts.ts, as the owner has them now (milliseconds). */
  timeouts?: () => Partial<TimeoutsMs>;
  /**
   * With GitHub: pushes what passed the gates (the rebased branch, or main), from a bundle of exactly the commit
   * that was rebased and checked. The machine holds no write credential (T68). Without it, nothing is pushed.
   */
  host?: HostPush;
  /** The project's repo ("owner/name"), for the host's push. */
  repo?: (project: string) => string | undefined;
  /**
   * Is this project's repo the one the deployer deploys onto the host? Then every path the host could run needs the
   * owner's OK (paths.ts), whatever the project's `protectedPaths` say.
   */
  hostExecuted?: (project: string) => boolean;
  /** The git identity of the commit the host makes to take work back out of main (a revert). */
  author?: (ticket: Ticket) => Promise<{ name: string; email: string }>;
}

/** Direct mode: the files this ticket's work changes, against where it left main. */
export function changedScript(worktree: string, branch = "main"): string {
  if (!isSafeRefName(branch)) throw new Error(`not a branch name: ${branch}`);
  return [
    `cd ${quote(worktree)} || { echo '@@fail cd into the worktree'; exit 1; }`,
    `git fetch --quiet origin ${branch} || { echo '@@fail git fetch'; exit 1; }`,
    // No rename detection: a file moved out of a protected folder is a deletion there as well as an addition
    // elsewhere, and both paths count. NUL-separated and encoded, so a name with a quote, tab or newline is exact.
    `git diff --name-only -z --no-renames --no-ext-diff "$(git merge-base origin/${branch} HEAD)" | while IFS= read -r -d '' f; do printf '@@changed64 %s\\n' "$(printf %s "$f" | base64 | tr -d '\\n')"; done`,
  ].join("\n");
}

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

/**
 * Fetches main and rebases onto it. A conflict aborts the rebase and says so. `own` is the ticket's own branch
 * on GitHub (the daemon's name for it, not the working copy's): its tip is read as the lease. Says
 * `@@head <sha>`: the rebased commit, the one the checks and the push are about.
 */
export function rebaseScript(worktree: string, branch = "main", own = ""): string {
  if (!isSafeRefName(branch)) throw new Error(`not a branch name: ${branch}`);
  if (own !== "" && !isSafeRefName(own)) throw new Error(`not a branch name: ${own}`);
  return [
    `cd ${quote(worktree)} || { echo '@@fail cd into the worktree'; exit 1; }`,
    // Uncommitted work would stop the rebase, and isn't a conflict.
    `if [ -n "$(git status --porcelain)" ]; then git status --porcelain | head -20 | sed 's/^/@@dirty /'; exit 3; fi`,
    own ? `branch=${quote(own)}` : "branch=$(git branch --show-current)",
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
    'echo "@@head $(git rev-parse HEAD)"',
    "echo @@rebased",
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
  /** Tickets whose commit the credential scan refused and the owner was asked about: the commit it was. */
  private readonly secretsShown = new Map<string, string>();

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

  /**
   * Has the host push `sha`, the commit that was rebased and checked, from a bundle the machine hands over.
   * `lease`: replace the ticket's branch only if it is still where the gates found it; absent: a fast-forward of
   * the default branch. The repo and branch are the daemon's own, never read back from the machine.
   */
  private async pushFromMachine(
    ticket: Ticket,
    sha: string,
    to: {
      branch: string;
      lease?: string;
      protect?: { paths: string[]; hostExecuted?: boolean };
      approval?: { sha: string; patchId: string; paths: string[] };
      overrideSecrets?: boolean;
      allowDefaultBranch?: boolean;
    },
  ): Promise<
    { ok: true } | { ok: false; kind: string; reason: string; findings: string[]; approval?: ApprovalCard }
  > {
    const repo = this.s.repo?.(ticket.project);
    const defaultBranch = this.defaultBranch(ticket);
    try {
      if (!repo) throw new HostPushError(`no repo for ${ticket.project}`, "git");
      await pushFromSandbox({
        host: this.s.host,
        run: (script) => this.run(ticket.assignee, script),
        worktree: this.worktree(ticket),
        sha,
        req: {
          repo,
          branch: to.branch,
          defaultBranch,
          ticket: ticket.id,
          ...(to.lease !== undefined ? { lease: to.lease } : {}),
          ...(to.protect ? { protect: to.protect } : {}),
          ...(to.approval ? { approval: to.approval } : {}),
          ...(to.overrideSecrets ? { overrideSecrets: true } : {}),
          ...(to.allowDefaultBranch ? { allowDefaultBranch: true } : {}),
        },
        baseBranches: [defaultBranch, to.branch],
      });
      return { ok: true };
    } catch (e) {
      if (e instanceof HostPushError)
        return {
          ok: false,
          kind: e.kind,
          reason: e.message,
          findings: e.findings,
          ...(e.approval ? { approval: e.approval } : {}),
        };
      throw e;
    }
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
    const { code, output } = await this.run(
      ticket.assignee,
      script,
      {},
      { timeoutMs: this.s.timeouts?.().checksMs ?? defaultTimeoutsMs.checksMs },
    );
    return readChecks(code, output);
  }

  async runGates(ticket: Ticket, opts: GatesOptions = {}): Promise<GatesResult> {
    const policy = this.s.policy?.(ticket.project);
    if (policy?.mode === "direct") return this.directGates(ticket, policy, opts);
    const env = (await this.s.github?.(ticket)) ?? {};
    const branch = this.defaultBranch(ticket);
    const own = branchName(ticket);
    const rebased = await this.run(ticket.assignee, rebaseScript(this.worktree(ticket), branch, own), env);
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
    // The commit that was rebased: the checks run on it, and exactly it is pushed.
    const head = lines("head")[0] ?? "";
    const checks = await this.runChecks(ticket);
    if (!checks.green) {
      return {
        ok: false,
        conflict: false,
        reason: `the checks fail after rebasing on ${branch}: ${checks.failures.join("; ")}`,
      };
    }
    if (this.s.github) {
      if (!/^[0-9a-f]{40}$/.test(head) || !/^([0-9a-f]{40})?$/.test(lease)) {
        return no("the rebase gave no commit to push");
      }
      const pushed = await this.pushFromMachine(ticket, head, { branch: own, lease });
      if (!pushed.ok) return no(`couldn't push the rebased branch: ${pushed.reason}`);
      const ci = await this.s.ci?.(ticket, head);
      if (ci && !ci.ok) return { ok: false, conflict: false, reason: ci.reason };
    }
    return { ok: true };
  }

  /**
   * Direct mode's gates (decided 2026-10-17): protected paths wait for the owner; then rebase on
   * main, checks, and a push to main. If main moves in between, rebase and try again, up to 3 times.
   */
  private async directGates(ticket: Ticket, policy: ProjectPolicy, opts: GatesOptions): Promise<GatesResult> {
    const ownerApproved = opts.ownerApproved === true;
    const env = (await this.s.github?.(ticket)) ?? {};
    const worktree = this.worktree(ticket);
    const branch = this.defaultBranch(ticket);
    const no = (reason: string): GatesResult => ({ ok: false, conflict: false, reason });

    // A run before this one wrote down the commit it was about to push. If that commit is on main now,
    // the push landed and only its record was lost (a stop, a crash, a lost reply): carry on from there.
    // Whether it landed is asked of the HOST's mirror of GitHub (an ancestor of its fetched origin/<default>),
    // never of the machine, whose say-so about what is on main is worth nothing.
    const landed = async (): Promise<GatesResult | null> => {
      if (!opts.pushIntended) return null;
      const repo = this.s.repo?.(ticket.project);
      const there =
        this.s.host && repo ? await this.s.host.landed({ repo, branch, sha: opts.pushIntended }) : null;
      if (there === null) {
        return no(
          `couldn't tell whether ${opts.pushIntended.slice(0, 7)} reached ${branch}: GitHub could not be read`,
        );
      }
      return there ? { ok: true, pushed: opts.pushIntended } : null;
    };
    const earlier = await landed();
    if (earlier) return earlier;

    const changed = await this.run(ticket.assignee, changedScript(worktree, branch), env);
    if (changed.code !== 0) return no(`couldn't read the change: ${changed.output.trim().slice(-300)}`);
    const files = [...changed.output.matchAll(/^@@changed64 (\S*)$/gm)].map((m) =>
      Buffer.from(m[1] as string, "base64").toString("utf8"),
    );
    // The owner's OK covers the paths on the card they answered, and no others. Without a list (an
    // `ownerApproved` alone) it covers all, as it always did.
    const approved = new Set(opts.approvedPaths);
    const hostExec = this.s.hostExecuted?.(ticket.project) === true;
    const held = files
      .filter((f) => isProtected(f, policy.protectedPaths) || (hostExec && isHostExecuted(f)))
      .filter((f) => (opts.approvedPaths ? !approved.has(f) : !ownerApproved));
    // With a host push, the host is the check (it reads the change from the verified bundle and binds the OK to
    // its content), and the card comes from it, with the diff. This early look, the machine's say-so, is only for
    // a harness with no host.
    if (!this.s.host && held.length) {
      return {
        ok: false,
        conflict: false,
        reason: `it changes protected paths: ${held.join(", ")}`,
        protectedPaths: held,
      };
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      const rebased = await this.run(
        ticket.assignee,
        rebaseScript(worktree, branch, branchName(ticket)),
        env,
      );
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
        if (ownerApproved && main && /^[0-9a-f]{40}$/.test(main)) {
          // `main` is what the machine says origin/main is: it counts only if the host's mirror has it on main.
          const repo = this.s.repo?.(ticket.project);
          const there = this.s.host && repo ? await this.s.host.landed({ repo, branch, sha: main }) : false;
          if (there) return { ok: true, pushed: main };
        }
        // Or this ticket pushed it already, and the rebase found nothing left to put on main.
        const pushedBefore = await landed();
        if (pushedBefore) return pushedBefore;
        return no(`the branch has no changes beyond ${branch}`);
      }
      if (rebased.code !== 0) return no(`couldn't rebase on ${branch}: ${rebased.output.trim().slice(-300)}`);
      const checks = await this.runChecks(ticket);
      if (!checks.green)
        return no(`the checks fail after rebasing on ${branch}: ${checks.failures.join("; ")}`);
      const head = lines("head")[0] ?? "";
      if (!/^[0-9a-f]{40}$/.test(head)) return no("the rebase gave no commit to push");
      // Written first, so a stop after the push but before its record can be told from a push that never happened.
      if (opts.onPushIntended) await opts.onPushIntended(head);
      // The host reads the change from the commits and holds protected paths itself: the machine's say-so
      // about what changed (`changedScript`) is a courtesy, not the check. A credential scan finding the owner
      // has been shown for this very commit and called harmless is let through (and recorded in the ledger).
      const pushed = await this.pushFromMachine(ticket, head, {
        branch,
        protect: { paths: policy.protectedPaths, hostExecuted: hostExec },
        ...(opts.approval ? { approval: opts.approval } : {}),
        allowDefaultBranch: true,
        ...(ownerApproved && this.secretsShown.get(ticket.id) === head ? { overrideSecrets: true } : {}),
      });
      if (pushed.ok) {
        this.secretsShown.delete(ticket.id);
        return { ok: true, pushed: head };
      }
      if (pushed.kind === "protected") {
        return {
          ok: false,
          conflict: false,
          reason: pushed.reason,
          protectedPaths: pushed.findings,
          ...(pushed.approval ? { approval: pushed.approval } : {}),
        };
      }
      if (pushed.kind === "secrets" && pushed.findings.length) {
        // Asked of the owner like a protected path: "approve" says it is not a secret, and it is pushed.
        this.secretsShown.set(ticket.id, head);
        return {
          ok: false,
          conflict: false,
          reason: pushed.reason,
          protectedPaths: pushed.findings.map((f) => `${f} (looks like a credential)`),
        };
      }
      if (pushed.kind !== "behind") {
        // GitHub refuses the bot any change to workflows: that needs the owner's push.
        return no(
          pushed.kind === "workflow"
            ? "GitHub won't let the bot push changes to workflows: the owner pushes this one (tools/host/push-for-owner.sh)"
            : `couldn't push to ${branch}: ${pushed.reason}`,
        );
      }
    }
    return no(`${branch} kept moving while the gates ran; try again`);
  }

  /** Direct mode: CI on the commit pushed to main. */
  async watchCi(ticket: Ticket, sha: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    return (await this.s.ci?.(ticket, sha)) ?? { ok: true };
  }

  /** Direct mode: reverts a commit on main that stayed red too long. The host makes the revert and pushes it. */
  async revert(ticket: Ticket, sha: string): Promise<void> {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a commit: ${sha}`);
    const repo = this.s.repo?.(ticket.project);
    if (!this.s.host || !repo) throw new Error(`couldn't revert ${sha}: no host push is set up`);
    const author = (await this.s.author?.(ticket)) ?? {
      name: "i.inc",
      email: "i-inc@users.noreply.github.com",
    };
    const branch = this.defaultBranch(ticket);
    try {
      await this.s.host.revert({ repo, branch, defaultBranch: branch, sha, author, ticket: ticket.id });
    } catch (e) {
      throw new Error(`couldn't revert ${sha}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
