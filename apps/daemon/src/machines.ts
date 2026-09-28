// The Apple container machine provider (spec §5 and §12; M1 steps 2 and 5). One persistent Linux VM
// per employee, made with the flags M1 found necessary: no home mount (the default mounts the host's
// home read-write), and explicit CPUs and memory (the default is half the host's). A machine is
// stopped when its employee has nothing running, because it only returns memory on restart and
// wakes in under a second.
//
// The commands were checked on the mini with container 1.4.1 (m1-findings.md, "M3: machine
// commands"). There is no `machine start`: `machine run` boots a stopped machine, and fails with
// "notFound" for a missing one. `machine create` boots the new machine itself. `machine stop` also
// succeeds on a machine that's already stopped.
import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import type { Id, MachineProvider } from "@i-inc/core";
import type { AgentProcess, Launch } from "./acp.ts";

export interface MachineSettings {
  /** Path to the `container` CLI. */
  bin: string;
  /** The employee base image (images/employee). */
  image: string;
  /** The image's user that everything runs as, rather than the user that matches the host's. */
  user: string;
  cpus: number;
  memory: string;
}

export const defaultMachineSettings: MachineSettings = {
  bin: "/usr/local/bin/container",
  image: "local/i-inc-employee:latest",
  user: "employee",
  cpus: 4,
  memory: "6G",
};

/** Where a ticket's worktree is in its machine, and so where its ACP sessions work. */
export const workDir = (ticketId: Id, s: MachineSettings = defaultMachineSettings) => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(ticketId)) throw new Error(`not a ticket id: ${ticketId}`);
  return `/home/${s.user}/work/inc-${ticketId}`;
};

/** Runs a command and resolves with its output, or rejects with its error output. */
export type Exec = (bin: string, args: string[]) => Promise<string>;

const execDefault: Exec = (bin, args) =>
  new Promise((resolve, reject) =>
    execFile(bin, args, { encoding: "utf8" }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout),
    ),
  );

/** Employee ids are validated at hiring (1-32 lowercase letters, digits or dashes). */
export const machineName = (employeeId: Id) => {
  if (!/^[a-z0-9-]{1,32}$/.test(employeeId)) throw new Error(`not an employee id: ${employeeId}`);
  return `inc-${employeeId}`;
};

export class AppleMachines implements MachineProvider {
  private readonly up = new Set<Id>();

  constructor(
    private readonly s: MachineSettings = defaultMachineSettings,
    private readonly exec: Exec = execDefault,
  ) {}

  async ensureUp(employeeId: Id): Promise<void> {
    if (this.up.has(employeeId)) return;
    const name = machineName(employeeId);
    try {
      // Boots the machine if it's stopped (0.6 s), and does nothing if it's running.
      await this.exec(this.s.bin, ["machine", "run", "-n", name, "--", "true"]);
    } catch (err) {
      if (!/notFound|not found/.test(err instanceof Error ? err.message : String(err))) throw err;
      // No such machine yet: make it with the flags M1 used. Creating it also boots it.
      await this.exec(this.s.bin, [
        "machine",
        "create",
        "--name",
        name,
        "--cpus",
        String(this.s.cpus),
        "--memory",
        this.s.memory,
        "--home-mount",
        "none",
        this.s.image,
      ]);
    }
    this.up.add(employeeId);
  }

  async stop(employeeId: Id): Promise<void> {
    if (!this.up.delete(employeeId)) return;
    await this.exec(this.s.bin, ["machine", "stop", machineName(employeeId)]);
  }

  /** Employees whose machines this daemon started and hasn't stopped. */
  running(): Id[] {
    return [...this.up];
  }
}

/** Which one-word launcher starts each harness's ACP server in the base image (M1's acp-launchers.sh). */
export const launchers: Record<string, string> = {
  "claude-code": "acp-claude",
  antigravity: "acp-antigravity",
  opencode: "acp-opencode",
};

/** Starts the `container` CLI; a test can stand in for it. */
export type Spawn = (bin: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams;

const spawnDefault: Spawn = (bin, args, env) => spawn(bin, args, { env, stdio: ["pipe", "pipe", "pipe"] });

/**
 * Starts a harness's ACP server in the employee's machine:
 * `container machine run -i -u employee -n <machine> -e I_INC_CWD -e <CREDENTIAL> -- acp-<harness>`.
 * The base image's launcher makes I_INC_CWD and starts there.
 *
 * Each variable goes in with `-e NAME`, which copies it from the environment of this one `container`
 * process. So a credential is in no command line on the host or in the machine, never on the
 * machine's disk, and gone when the session ends (checked on the mini: m1-findings.md, "M3:
 * credentials"). Values don't pass through the machine's login shell either, so any value is safe.
 */
export function machineLaunch(
  s: MachineSettings = defaultMachineSettings,
  run: Spawn = spawnDefault,
): Launch {
  return ({ employeeId, engine, cwd, env }) => {
    const launcher = launchers[engine.harness];
    if (!launcher) throw new Error(`no ACP launcher for ${engine.harness}`);
    const vars: Record<string, string> = { I_INC_CWD: cwd, ...env };
    for (const name of Object.keys(vars)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`can't pass ${name} into a machine`);
    }
    const flags = Object.keys(vars).flatMap((name) => ["-e", name]);
    const child = run(
      s.bin,
      ["machine", "run", "-i", "-u", s.user, "-n", machineName(employeeId), ...flags, "--", launcher],
      { ...process.env, ...vars },
    );
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    const proc: AgentProcess = {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      kill: () => child.kill(),
      exited,
    };
    return proc;
  };
}
