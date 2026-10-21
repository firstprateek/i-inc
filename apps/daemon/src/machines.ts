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
import { statSync } from "node:fs";
import {
  type AgentHarness,
  type Id,
  type MachineProvider,
  type SandboxFault,
  type SandboxFaultKind,
  type SandboxStatus,
  StartupError,
} from "@i-inc/core";
import type { AgentProcess, Launch } from "./acp.ts";

export const BOOT_FAILURES: Record<SandboxFaultKind, { reason: string; fix: string; waiting: string }> = {
  "stale-hostname": {
    reason: "container-apiserver still holds the machine's hostname from an earlier boot",
    fix: "restart the container service on the Mac mini: container system stop && container system start",
    waiting: "the engineering sandbox can't start (restart the container service on the Mac mini)",
  },
  "container-service-down": {
    reason: "Apple container service is not responding",
    fix: "start the container service on the Mac mini: container system start",
    waiting: "the container service is down on the Mac mini (run container system start)",
  },
  unknown: {
    reason: "the sandbox failed to boot",
    fix: "check container machine ls on the Mac mini",
    waiting: "the sandbox failed to boot (check container machine ls on the Mac mini)",
  },
};

export function classifyBootFailure(err: unknown): { kind: SandboxFaultKind; message: string } {
  const msg = err instanceof Error ? err.message : String(err);
  if (/hostname\(s\)\s+already\s+exist/i.test(msg)) {
    return { kind: "stale-hostname", message: msg };
  }
  if (
    /connection refused|cannot connect to container service|container service isn't running|is the container service running|container service is not responding/i.test(
      msg,
    )
  ) {
    return { kind: "container-service-down", message: msg };
  }
  return { kind: "unknown", message: msg };
}

export interface MachineSettings {
  /** Path to the `container` CLI. */
  bin: string;
  /** The employee base image (images/employee). */
  image: string;
  /** The image's user that everything runs as, rather than the user that matches the host's. */
  user: string;
  cpus: number;
  memory: string;
  /**
   * A file the walls job leaves while the walls are up (tools/host/walls.sh). When it's set and the
   * file is missing, no machine boots and nothing starts in one.
   */
  wallsMarker?: string;
  /**
   * The machine an employee works in: its team's shared sandbox, inc-<team> (decided 2026-10-17).
   * Absent: one machine per employee, inc-<employee>.
   */
  machineFor?: (employeeId: Id) => string;
  /** A machine's size, when its team sets one. Absent: `cpus` and `memory`. */
  sizeFor?: (machine: string) => { cpus: number; memory: string } | undefined;
}

export const defaultMachineSettings: MachineSettings = {
  bin: "/usr/local/bin/container",
  image: "local/i-inc-employee:latest",
  user: "employee",
  cpus: 6,
  memory: "12G",
  wallsMarker: "/var/run/i-inc-walls.ok",
};

/** Whether the walls job has confirmed the walls in the last two minutes (it runs every minute). */
export function wallsUp(s: MachineSettings, now = Date.now()): boolean {
  if (!s.wallsMarker) return true;
  try {
    return now - statSync(s.wallsMarker).mtimeMs < 120_000;
  } catch {
    return false;
  }
}

/** Fails closed: nothing runs in a machine unless the walls are up (spec §5). */
export function assertWalls(s: MachineSettings): void {
  if (!wallsUp(s)) {
    throw new Error(
      `the walls aren't up (${s.wallsMarker} is missing or stale), so no machine runs: see tools/host`,
    );
  }
}

/** Where a ticket's worktree is in its machine, and so where its ACP sessions work. */
export const workDir = (ticketId: Id, s: MachineSettings = defaultMachineSettings) => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(ticketId)) throw new Error(`not a ticket id: ${ticketId}`);
  return `/home/${s.user}/work/inc-${ticketId}`;
};

export interface ExecOptions {
  env?: Record<string, string>;
  input?: string;
  /** Kill the command after this long. */
  timeoutMs?: number;
}

/** Runs a command and resolves with its output, or rejects with its error output. */
export type Exec = (bin: string, args: string[], opts?: ExecOptions) => Promise<string>;

const execDefault: Exec = (bin, args, opts) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      {
        encoding: "utf8",
        ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
        ...(opts?.timeoutMs ? { timeout: opts.timeoutMs } : {}),
        maxBuffer: 8 * 1024 * 1024,
      },
      (err, stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout)),
    );
    if (opts?.input && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });

/** Employee ids are validated at hiring (1-32 lowercase letters, digits or dashes). */
export const machineName = (employeeId: Id) => {
  if (!/^[a-z0-9-]{1,32}$/.test(employeeId)) throw new Error(`not an employee id: ${employeeId}`);
  return `inc-${employeeId}`;
};

/** The machine an employee works in, under these settings. */
export const machineOf = (s: MachineSettings, employeeId: Id): string => {
  machineName(employeeId); // checks the id
  const name = s.machineFor ? s.machineFor(employeeId) : `inc-${employeeId}`;
  if (!/^inc-[a-z0-9-]{1,32}$/.test(name)) throw new Error(`not a machine name: ${name}`);
  return name;
};

export class AppleMachines implements MachineProvider {
  /** The employees each running machine has working in it; a team's sandbox stops when none are. */
  private readonly up = new Map<string, Set<Id>>();
  readonly signedInCache = new Map<
    string,
    { claude: boolean; antigravity: boolean; codex: boolean; github: boolean }
  >();
  private readonly faults = new Map<string, SandboxFault>();
  private readonly attempts = new Map<string, number>();
  private readonly lastLogged = new Map<string, string>();

  constructor(
    private readonly s: MachineSettings = defaultMachineSettings,
    private readonly exec: Exec = execDefault,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly now: () => number = Date.now,
    private readonly log?: (msg: string) => void,
  ) {}

  async ensureUp(employeeId: Id): Promise<void> {
    assertWalls(this.s);
    const name = machineOf(this.s, employeeId);
    const working = this.up.get(name);
    if (working) {
      working.add(employeeId);
      return;
    }
    const currentTime = this.now();
    const fault = this.faults.get(name);
    if (fault && currentTime < fault.retryAt) {
      throw new StartupError(fault.waiting, fault.retryAt);
    }
    const size = this.s.sizeFor?.(name) ?? { cpus: this.s.cpus, memory: this.s.memory };
    try {
      await this.bootWithRecovery(name);
    } catch (err) {
      if (!/notFound|not found/.test(err instanceof Error ? err.message : String(err))) throw err;
      // No such machine yet: make it with the flags M1 used.
      await this.exec(this.s.bin, [
        "machine",
        "create",
        "--name",
        name,
        "--cpus",
        String(size.cpus),
        "--memory",
        size.memory,
        "--home-mount",
        "none",
        this.s.image,
      ]);
      // Boot it here rather than in its first job.
      await this.bootWithRecovery(name);
    }
    this.up.set(name, new Set([employeeId]));
  }

  /**
   * Boots a machine with safe recovery and exponential backoff on failure (T50).
   */
  private async bootWithRecovery(name: string): Promise<void> {
    try {
      await this.boot(name);
      if (this.faults.has(name) || this.attempts.has(name)) {
        this.faults.delete(name);
        this.attempts.delete(name);
        this.lastLogged.delete(name);
        this.logStateChange(name, "running", "recovered and running");
      }
    } catch (err) {
      if (/notFound|not found/i.test(err instanceof Error ? err.message : String(err))) {
        throw err;
      }
      // Safe automatic recovery inside the sandbox layer only: machine stop, retry once
      try {
        try {
          await this.exec(this.s.bin, ["machine", "stop", name]);
        } catch {
          // ignore error stopping if already stopped
        }
        await this.boot(name);
        if (this.faults.has(name) || this.attempts.has(name)) {
          this.faults.delete(name);
          this.attempts.delete(name);
          this.lastLogged.delete(name);
          this.logStateChange(name, "running", "recovered after safe machine stop");
        }
        return;
      } catch (recoveryErr) {
        if (
          /notFound|not found/i.test(recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr))
        ) {
          throw recoveryErr;
        }
        const failure = classifyBootFailure(recoveryErr || err);
        const attempts = (this.attempts.get(name) ?? 0) + 1;
        this.attempts.set(name, attempts);
        const backoffMs = Math.min(30_000 * 2 ** (attempts - 1), 600_000);
        const currentTime = this.now();
        const retryAt = currentTime + backoffMs;
        const info = BOOT_FAILURES[failure.kind];
        const teamName = name.replace(/^inc-/, "");
        const waiting =
          failure.kind === "stale-hostname"
            ? `the ${teamName} sandbox can't start (restart the container service on the Mac mini)`
            : info.waiting;
        const fault: SandboxFault = {
          machine: name,
          kind: failure.kind,
          reason: `${info.reason} — ${info.fix}`,
          waiting,
          since: this.faults.get(name)?.since ?? currentTime,
          retryAt,
          attempts,
        };
        this.faults.set(name, fault);
        this.logStateChange(
          name,
          `fault:${failure.kind}`,
          `boot failed (${failure.kind}): ${fault.reason}; retrying in ${Math.round(backoffMs / 1000)}s`,
        );
        throw new StartupError(fault.waiting, fault.retryAt);
      }
    }
  }

  private logStateChange(machine: string, stateKey: string, stateDescription: string): void {
    if (this.lastLogged.get(machine) === stateKey) return;
    this.lastLogged.set(machine, stateKey);
    this.log?.(`[sandbox:${machine}] ${stateDescription}`);
  }

  sandboxFault(employeeId: Id): SandboxFault | undefined {
    const name = machineOf(this.s, employeeId);
    return this.faults.get(name);
  }

  signedIn(employeeId: Id, harness: AgentHarness): boolean | undefined {
    const name = machineOf(this.s, employeeId);
    const cached = this.signedInCache.get(name);
    if (!cached) return undefined;
    if (harness === "claude-code") return cached.claude;
    if (harness === "antigravity") return cached.antigravity;
    if (harness === "codex") return cached.codex;
    return true;
  }

  async retrySandbox(team: Id, size: { cpus: number; memory: string }): Promise<SandboxStatus> {
    const machine = machineName(team);
    this.faults.delete(machine);
    this.attempts.delete(machine);
    this.lastLogged.delete(machine);
    try {
      await this.bootWithRecovery(machine);
    } catch {
      // faults will be updated if it fails
    }
    return this.inspectSandbox(team, size);
  }

  /**
   * Boots a machine. A boot fails now and then with "Operation not supported by device", most often
   * a new machine's first, and a later one works (images/employee/README.md): try up to three times,
   * a few seconds apart.
   */
  private async boot(name: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.exec(this.s.bin, ["machine", "run", "-n", name, "--", "true"]);
        return;
      } catch (err) {
        const flaky = /Operation not supported by device/.test(
          err instanceof Error ? err.message : String(err),
        );
        if (!flaky || attempt === 3) throw err;
        await this.sleep(3000);
      }
    }
  }

  /** Done with the machine for now; it stops once nobody else is working in it. */
  async stop(employeeId: Id): Promise<void> {
    const name = machineOf(this.s, employeeId);
    const working = this.up.get(name);
    if (!working?.delete(employeeId) || working.size > 0) return;
    this.up.delete(name);
    await this.exec(this.s.bin, ["machine", "stop", name]);
  }

  /**
   * Stops every running employee machine, including ones an earlier daemon started: what the daemon
   * does when the walls go down. Returns the machines it stopped.
   */
  async stopAll(): Promise<string[]> {
    const listing = await this.exec(this.s.bin, ["machine", "ls"]);
    const names = listing
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter((cols) => cols[0]?.startsWith("inc-") && cols.includes("running"))
      .map((cols) => cols[0] as string);
    for (const name of names) await this.exec(this.s.bin, ["machine", "stop", name]);
    this.up.clear();
    return names;
  }

  /** Employees whose machines this daemon started and hasn't stopped. */
  running(): Id[] {
    return [...this.up.values()].flatMap((working) => [...working]);
  }

  /** The machine an employee works in. */
  machineFor(employeeId: Id): string {
    return machineOf(this.s, employeeId);
  }

  /**
   * The machines `container machine ls` shows, with the disk each takes on the host (its DISK
   * column), which grows as a machine writes and which the listing gives even for a stopped machine.
   */
  async listMachines(): Promise<MachineRow[]> {
    return parseMachineListing(await this.exec(this.s.bin, ["machine", "ls"]));
  }

  /**
   * Runs a script in a machine that's already running, as the employee user, with the script on
   * stdin. It never boots a machine: `machine run` would, so a machine that isn't running is refused
   * (T52: cleaning must not wake a machine).
   */
  async runIn(machine: string, script: string, timeoutMs = 15 * 60_000): Promise<string> {
    assertWalls(this.s);
    if (!/^inc-[a-z0-9-]{1,32}$/.test(machine)) throw new Error(`not a machine name: ${machine}`);
    const row = (await this.listMachines()).find((m) => m.name === machine);
    if (row?.state !== "running") throw new Error(`${machine} isn't running, so nothing is run in it`);
    return this.exec(
      this.s.bin,
      ["machine", "run", "-i", "-u", this.s.user, "-n", machine, "--", "bash", "-s"],
      {
        input: script,
        timeoutMs,
      },
    );
  }

  /** How many entries the long-lived maps hold, for GET /api/storage and the leak test. */
  footprint(): Record<string, number> {
    return {
      machinesUp: this.up.size,
      signedInCache: this.signedInCache.size,
      faults: this.faults.size,
      attempts: this.attempts.size,
      lastLogged: this.lastLogged.size,
    };
  }

  async deliverCallback(teamId: Id, url: string): Promise<void> {
    assertWalls(this.s);
    const machine = machineName(teamId);
    await this.exec(
      this.s.bin,
      ["machine", "run", "-i", "-u", this.s.user, "-n", machine, "-e", "CALLBACK_URL", "--", "bash", "-s"],
      {
        env: { CALLBACK_URL: url },
        input: 'curl -fsS -- "$CALLBACK_URL" >/dev/null\n',
      },
    );
  }

  async inspectSandbox(team: Id, size: { cpus: number; memory: string }): Promise<SandboxStatus> {
    if (!/^[a-z0-9-]{1,32}$/.test(team)) throw new Error(`not a team id: ${team}`);
    const machine = machineName(team);
    const defaultSignedIn = { claude: false, antigravity: false, codex: false, github: false };
    const fault = this.faults.get(machine);

    let listing = "";
    try {
      listing = await this.exec(this.s.bin, ["machine", "ls"]);
    } catch {
      return {
        team,
        machine,
        state: "error",
        cpus: size.cpus,
        memory: size.memory,
        signedIn: defaultSignedIn,
        ...(fault ? { reason: fault.reason, kind: fault.kind, retryAt: fault.retryAt } : {}),
      };
    }

    const lines = listing
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/));
    const entry = lines.find((cols) => cols[0] === machine);

    if (!entry) {
      return {
        team,
        machine,
        state: "missing",
        cpus: size.cpus,
        memory: size.memory,
        signedIn: defaultSignedIn,
      };
    }

    const inFault = Boolean(fault && this.now() < fault.retryAt);
    const state: "running" | "stopped" | "error" = inFault
      ? "error"
      : entry.includes("running")
        ? "running"
        : "stopped";

    let signedIn = this.signedInCache.get(machine) ?? defaultSignedIn;
    if (wallsUp(this.s) && state === "running") {
      try {
        signedIn = await this.probeSignIn(machine);
      } catch {
        // keep cached or fallback
      }
    }

    return {
      team,
      machine,
      state,
      cpus: size.cpus,
      memory: size.memory,
      signedIn,
      ...(fault && inFault ? { reason: fault.reason, kind: fault.kind, retryAt: fault.retryAt } : {}),
    };
  }

  private async probeSignIn(
    machine: string,
  ): Promise<{ claude: boolean; antigravity: boolean; codex: boolean; github: boolean }> {
    // The probe runs in non-login bash, and the sandbox's npm globals (the Codex CLI) live in
    // ~/.local/bin, which that shell doesn't have on its PATH. The string is fixed: no input reaches it.
    const input =
      'export PATH="$HOME/.local/bin:$PATH"; ' +
      "[ -s ~/.claude/.credentials.json ] && echo claude; [ -s ~/.gemini/antigravity-acp/acp_token.json ] && echo antigravity; codex login status >/dev/null 2>&1 && echo codex; [ -s ~/.config/gh/hosts.yml ] && echo github; true\n";
    const output = await this.exec(
      this.s.bin,
      ["machine", "run", "-i", "-u", this.s.user, "-n", machine, "--", "bash", "-s"],
      { input },
    );
    const found = new Set(output.split(/\s+/).filter(Boolean));
    const result = {
      claude: found.has("claude"),
      antigravity: found.has("antigravity"),
      codex: found.has("codex"),
      github: found.has("github"),
    };
    this.signedInCache.set(machine, result);
    return result;
  }
}

export interface MachineRow {
  name: string;
  state: "running" | "stopped" | string;
  /** The machine's disk on the host, in bytes, when the listing has one. */
  diskBytes?: number;
}

const units: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** Reads `container machine ls`: a header line, then a row per machine ending in DISK, STATE and DEFAULT. */
export function parseMachineListing(listing: string): MachineRow[] {
  const rows: MachineRow[] = [];
  for (const line of listing.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    const name = cols[0];
    if (!name?.startsWith("inc-")) continue;
    const state = cols.find((c) => c === "running" || c === "stopped") ?? "unknown";
    // The DISK column is the size right before the state, such as "20.4G".
    const at = cols.indexOf(state);
    const m = /^(\d+(?:\.\d+)?)([KMGT])B?$/i.exec(cols[at - 1] ?? "");
    const unit = units[(m?.[2] ?? "").toUpperCase()];
    rows.push({
      name,
      state,
      ...(m && unit ? { diskBytes: Math.round(Number(m[1]) * unit) } : {}),
    });
  }
  return rows;
}

/** Which one-word launcher starts each harness's ACP server in the base image (M1's acp-launchers.sh). */
export const launchers: Record<string, string> = {
  "claude-code": "acp-claude",
  antigravity: "acp-antigravity",
  opencode: "acp-opencode",
  codex: "acp-codex",
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
    assertWalls(s);
    const launcher = launchers[engine.harness];
    if (!launcher) throw new Error(`no ACP launcher for ${engine.harness}`);
    const vars: Record<string, string> = { I_INC_CWD: cwd, ...env };
    for (const name of Object.keys(vars)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`can't pass ${name} into a machine`);
    }
    const flags = Object.keys(vars).flatMap((name) => ["-e", name]);
    const child = run(
      s.bin,
      ["machine", "run", "-i", "-u", s.user, "-n", machineOf(s, employeeId), ...flags, "--", launcher],
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
