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
import { execFile, spawn } from "node:child_process";
import type { Id, MachineProvider } from "@i-inc/core";
import type { AgentProcess, Launch } from "./acp.ts";

export interface MachineSettings {
  /** Path to the `container` CLI. */
  bin: string;
  /** The employee base image. */
  image: string;
  cpus: number;
  memory: string;
}

export const defaultMachineSettings: MachineSettings = {
  bin: "/usr/local/bin/container",
  image: "local/i-inc-employee:latest",
  cpus: 4,
  memory: "6G",
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

/** `machine run` passes its command through a login shell, so values must survive re-splitting. */
const safe = /^[A-Za-z0-9_./:+=@-]*$/;

/**
 * Starts a harness's ACP server in the employee's machine: `container machine run -i -n <machine> --
 * env I_INC_CWD=<cwd> <credential> acp-<harness>`. The base image's launcher makes I_INC_CWD and
 * starts there. The credential rides in the environment of that one command, never in a file. It
 * does show in the host's process list while the session runs; the host is the owner's alone.
 */
export function machineLaunch(s: MachineSettings = defaultMachineSettings): Launch {
  return ({ employeeId, engine, cwd, env }) => {
    const launcher = launchers[engine.harness];
    if (!launcher) throw new Error(`no ACP launcher for ${engine.harness}`);
    const vars = { I_INC_CWD: cwd, ...env };
    for (const [k, v] of Object.entries(vars)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(k) || !safe.test(v))
        throw new Error(`can't pass ${k} into a machine safely`);
    }
    const command = ["env", ...Object.entries(vars).map(([k, v]) => `${k}=${v}`), launcher];
    const child = spawn(s.bin, ["machine", "run", "-i", "-n", machineName(employeeId), "--", ...command], {
      stdio: ["pipe", "pipe", "pipe"],
    });
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
