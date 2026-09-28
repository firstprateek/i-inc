// The real harness (spec §6, stages 4 and 8): the project's check recipe and the final gates, run in
// the builder's machine. Scripts go in on stdin through `container machine run -i … -- bash -s`,
// because `machine run` re-splits its arguments (M1).
import { spawn } from "node:child_process";
import type { ChecksResult, GatesResult, Harness, Ticket } from "@i-inc/core";
import { defaultMachineSettings, type MachineSettings, machineName } from "./machines.ts";

/**
 * Runs a script in an employee's machine and resolves with its exit code and output. Variables in
 * `env`, such as GH_TOKEN, go in with `-e NAME`, like a session's credentials (machines.ts).
 */
export type RunScript = (
  employeeId: string,
  script: string,
  env?: Record<string, string>,
) => Promise<{ code: number; output: string }>;

export function machineScript(s: MachineSettings = defaultMachineSettings): RunScript {
  return (employeeId, script, env = {}) =>
    new Promise((resolve, reject) => {
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
        machineName(employeeId),
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
  /**
   * With GitHub: the environment (GH_TOKEN) for fetching main and pushing the rebased branch, so the
   * PR shows what passed the gates. Without it, the gates rebase locally only.
   */
  github?: (ticket: Ticket) => Promise<Record<string, string>>;
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

/** Fetches main and rebases onto it. A conflict aborts the rebase and says so. */
export function rebaseScript(worktree: string): string {
  return [
    `cd ${quote(worktree)} || { echo '@@fail cd into the worktree'; exit 1; }`,
    "git fetch --quiet origin main || { echo '@@fail git fetch'; exit 1; }",
    "if ! git rebase --quiet origin/main >/dev/null 2>&1; then",
    "  git diff --name-only --diff-filter=U | sed 's/^/@@conflict /'",
    "  git rebase --abort",
    "  exit 2",
    "fi",
    "echo @@rebased",
  ].join("\n");
}

/** Pushes the rebased branch over the PR's, unless someone else pushed to it since the fetch. */
export function pushScript(worktree: string): string {
  return [
    `cd ${quote(worktree)} || { echo '@@fail cd into the worktree'; exit 1; }`,
    "git push --quiet --force-with-lease origin HEAD && echo @@pushed",
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

  async runChecks(ticket: Ticket): Promise<ChecksResult> {
    const script = checksScript(this.worktree(ticket), this.recipe(ticket), this.s.tailLines ?? 40);
    const { code, output } = await this.run(ticket.assignee, script);
    return readChecks(code, output);
  }

  async runGates(ticket: Ticket): Promise<GatesResult> {
    const env = (await this.s.github?.(ticket)) ?? {};
    const rebased = await this.run(ticket.assignee, rebaseScript(this.worktree(ticket)), env);
    if (rebased.code === 2) {
      const files = [...rebased.output.matchAll(/^@@conflict (.+)$/gm)].map((m) => m[1]);
      return {
        ok: false,
        conflict: true,
        reason: `rebasing on main conflicts in ${files.join(", ") || "some files"}`,
      };
    }
    if (rebased.code !== 0) {
      return {
        ok: false,
        conflict: false,
        reason: `couldn't rebase on main: ${rebased.output.trim().slice(-300)}`,
      };
    }
    const checks = await this.runChecks(ticket);
    if (!checks.green) {
      return {
        ok: false,
        conflict: false,
        reason: `the checks fail after rebasing on main: ${checks.failures.join("; ")}`,
      };
    }
    if (this.s.github) {
      const pushed = await this.run(ticket.assignee, pushScript(this.worktree(ticket)), env);
      if (pushed.code !== 0 || !pushed.output.includes("@@pushed")) {
        return {
          ok: false,
          conflict: false,
          reason: `couldn't push the rebased branch: ${pushed.output.trim().slice(-300)}`,
        };
      }
    }
    return { ok: true };
  }
}
