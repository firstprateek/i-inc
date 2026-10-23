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
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type AgentHarness,
  type Id,
  type MachineProvider,
  type SandboxFault,
  type SandboxFaultKind,
  type SandboxStatus,
  type ServiceEvent,
  StartupError,
} from "@i-inc/core";
import type { AgentProcess, Launch } from "./acp.ts";
import { type RecoveryOptions, ServiceRecovery } from "./container-recovery.ts";
import { type EgressWall, isHomeMachine, WallError, type WallRow } from "./egress-wall.ts";
import { HISTORY_LEN, MachineBusy, MachineNotRunning, type MachineQueue, queueFor } from "./machine-queue.ts";
import { describeMs, guardStdin, scriptsRunning, stopGroup, trackGroup } from "./proc.ts";
import { launcherNeedsUpdate, newAgentId, noteLauncher, trackAgent } from "./reaper.ts";
import { defaultTimeoutsMs, type TimeoutsMs } from "./timeouts.ts";

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
  /**
   * Whether a machine is a home machine: a team's sandbox with a personal assistant in it, whatever the
   * team is called. (A machine named inc-home-… is one in any case.)
   */
  homeMachine?: (machine: string) => boolean;
  /**
   * The egress wall (egress-wall.ts): which machines the walls let out, and what the walls job has
   * confirmed. Absent, nothing is checked but the walls marker, and no home machine runs.
   */
  wall?: EgressWall;
  /**
   * Why no new launch may start right now, or null. The container service's restart (container-recovery.ts)
   * sets it; it is read by every launch, script and boot through `assertWalls`.
   */
  gate?: () => string | null;
  /** The limits in timeouts.ts as the owner has them now, read at each call (milliseconds). */
  timeouts?: () => Partial<TimeoutsMs>;
  /**
   * The queue every `container` command for one machine goes through (machine-queue.ts, T75). Absent: one is made
   * per settings object, so the provider, `machineScript` and `machineLaunch` built from the same settings share it.
   */
  queue?: MachineQueue;
  /**
   * The release's employee image folder (images/employee), where the launchers a machine is updated from
   * are read. Absent: the one beside this code, which is the release the daemon runs from.
   */
  imageDir?: string;
}

/** The release's images/employee, relative to this file (apps/daemon/src). */
export const releaseImageDir = fileURLToPath(new URL("../../../images/employee/", import.meta.url));

/** A file the launcher update puts in a machine: the same files and modes as tools/host/update-machine.sh. */
export interface LauncherFile {
  path: string;
  mode: "644" | "755";
  content: Buffer;
  /** In the employee's home, owned by the employee, rather than root's. */
  employee?: boolean;
}

/**
 * Reads from the image folder what a machine's launcher is made of: acp-env.sh (644), every launchers/acp-*
 * (755) and claude-settings.json (the employee's ~/.claude/settings.json). Throws if a piece is missing.
 */
export function launcherFiles(dir: string): LauncherFile[] {
  const files: LauncherFile[] = [
    { path: "/usr/local/lib/i-inc/acp-env.sh", mode: "644", content: readFileSync(`${dir}/acp-env.sh`) },
  ];
  const names = readdirSync(`${dir}/launchers`)
    .filter((n) => /^acp-[a-z0-9-]+$/.test(n))
    .sort();
  if (names.length === 0) throw new Error(`no launchers in ${dir}/launchers`);
  for (const n of names) {
    files.push({ path: `/usr/local/bin/${n}`, mode: "755", content: readFileSync(`${dir}/launchers/${n}`) });
  }
  files.push({
    path: "~/.claude/settings.json",
    mode: "644",
    content: readFileSync(`${dir}/claude-settings.json`),
    employee: true,
  });
  return files;
}

/**
 * The script that writes those files in a machine as root (`machine run -u root -i ... bash -s`, as
 * update-machine.sh does, since a PA's sandbox has its user's sudo taken away), each written beside its
 * place and moved over it so a launch never reads half a file, then checks the sums, modes and the notes
 * marker, and says `@@launcher-updated` only if all hold. The contents are base64 and the paths fixed.
 */
export function launcherUpdateScript(files: LauncherFile[], user: string): string {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new Error(`not a user name: ${user}`);
  const home = `/home/${user}`;
  const place = (f: LauncherFile) => (f.employee ? f.path.replace("~", home) : f.path);
  const lines = [
    "set -u",
    "ok=1",
    'put() { mkdir -p "$(dirname "$3")" && printf %s "$4" | base64 -d >"$3.inc-new" && chmod "$2" "$3.inc-new" && { [ "$1" = root ] || chown "$(stat -c %u:%g ' +
      home +
      ')" "$3.inc-new"; } && mv -f "$3.inc-new" "$3" || ok=0; }',
    'chk() { [ "$(sha256sum "$2" 2>/dev/null | cut -d" " -f1)" = "$1" ] && [ "$(stat -c %a "$2" 2>/dev/null)" = "$3" ] || ok=0; }',
    `mkdir -p ${home}/.claude && chown "$(stat -c %u:%g ${home})" ${home}/.claude`,
  ];
  for (const f of files) {
    lines.push(
      `put ${f.employee ? "employee" : "root"} ${f.mode} ${place(f)} '${f.content.toString("base64")}'`,
    );
  }
  for (const f of files) {
    lines.push(`chk ${createHash("sha256").update(f.content).digest("hex")} ${place(f)} ${f.mode}`);
  }
  lines.push(
    "grep -q inc-agents /usr/local/lib/i-inc/acp-env.sh || ok=0",
    'if [ "$ok" = 1 ]; then echo @@launcher-updated; else echo @@launcher-update-failed; fi',
  );
  return `${lines.join("\n")}\n`;
}

/** After a failed update, no new try for this long (the next sweep or probe that finds the launcher old tries again). */
const LAUNCHER_RETRY_MS = 10 * 60_000;

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
  const held = s.gate?.();
  // A wait, not a failure: the ticket or conversation shows why and tries again.
  if (held) throw new StartupError(held, Date.now() + 30_000);
  if (!wallsUp(s)) {
    throw new Error(
      `the walls aren't up (${s.wallsMarker} is missing or stale), so no machine runs: see tools/host`,
    );
  }
}

/** Whether this machine is a home machine (a PA's sandbox): it is shut in, and its user has no root. */
export function isHome(s: MachineSettings, machine: string): boolean {
  return isHomeMachine(machine) || s.homeMachine?.(machine) === true;
}

/**
 * The running containers in `container ls` (it leaves machines out), as rows named `container:<id>`:
 * the image builder (`container build` runs in a container called buildkit on the same bridge) and any
 * `container run`. They are the owner's, started from the host, and have the internet as they did before the
 * walls were closed. A row named inc-… is left out in case a later version lists machines here too.
 */
export function parseContainerListing(listing: string): WallRow[] {
  const rows: WallRow[] = [];
  for (const line of listing.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    const id = cols[0];
    if (!id || id.startsWith("inc-") || !cols.includes("running")) continue;
    const ip = cols.map((c) => /^(\d{1,3}(?:\.\d{1,3}){3})(?:\/\d+)?$/.exec(c)?.[1]).find(Boolean);
    if (ip) rows.push({ name: `container:${id}`, state: "running", ip, home: false });
  }
  return rows;
}

/**
 * The machines in `machine ls`, with whether each is a home machine. With `containers`, also the running
 * containers of the host's `container ls` (for the list of addresses to let out, not for a launch's check).
 */
export async function wallRows(s: MachineSettings, exec: Exec, containers = false): Promise<WallRow[]> {
  const rows: WallRow[] = parseMachineListing(await exec(s.bin, ["machine", "ls"])).map((r) => ({
    name: r.name,
    state: r.state,
    ...(r.ip ? { ip: r.ip } : {}),
    home: isHome(s, r.name),
  }));
  if (!containers) return rows;
  try {
    const known = new Set(rows.map((r) => r.ip));
    for (const c of parseContainerListing(await exec(s.bin, ["ls"]))) if (!known.has(c.ip)) rows.push(c);
  } catch {
    // The builder isn't there, or the service answered badly: nothing to add.
  }
  return rows;
}

/**
 * Takes root from a home machine's user, run as root before anything else runs in the machine. The image
 * gives the user passwordless sudo (images/employee/Dockerfile), and with it a PA's agent could give the
 * machine an address the walls let out (`ip addr add`), or join the groups that are root in all but name.
 */
export const removeRootScript = (user: string): string =>
  [
    "set -eu",
    `user=${user}`,
    // The last run left the file empty and immutable (below): no change to it works until the flag is off.
    'chattr -i "/etc/sudoers.d/$user" 2>/dev/null || true',
    'rm -f "/etc/sudoers.d/$user"',
    'for f in /etc/sudoers.d/*; do [ -f "$f" ] || continue; case "$f" in */README) ;; *) chattr -i "$f" 2>/dev/null || true; rm -f "$f" ;; esac; done',
    '[ ! -f /etc/sudoers ] || sed -i "/^$user[[:space:]]/d" /etc/sudoers',
    'for g in sudo admin wheel docker lxd adm disk; do getent group "$g" >/dev/null 2>&1 && gpasswd -d "$user" "$g" >/dev/null 2>&1 || true; done',
    // An empty file, root's and immutable where the filesystem allows, so nothing puts the grant back.
    ': >"/etc/sudoers.d/$user"',
    'chown root:root "/etc/sudoers.d/$user" && chmod 0440 "/etc/sudoers.d/$user"',
    'chattr +i "/etc/sudoers.d/$user" 2>/dev/null || true',
    "echo @@no-root",
    "",
  ].join("\n");

/** Run as the user: says @@root if sudo works without a password or the user is in a group that is root in all but name. */
export const rootProbeScript = [
  "if sudo -n true </dev/null >/dev/null 2>&1; then echo @@root; fi",
  "if id -nG | tr ' ' '\\n' | grep -qx -e sudo -e admin -e wheel -e docker -e root; then echo @@root; fi",
  "echo @@checked",
  "",
].join("\n");

/** Whether the machine's user has no way to root. Runs a fixed script in the machine: nothing of anyone's. */
export async function isRootless(s: MachineSettings, exec: Exec, machine: string): Promise<boolean> {
  const out = await exec(s.bin, ["machine", "run", "-i", "-u", s.user, "-n", machine, "--", "bash", "-s"], {
    input: rootProbeScript,
    timeoutMs: 60_000,
  });
  return out.includes("@@checked") && !out.includes("@@root");
}

/** Removes the user's root (removeRootScript) in a home machine. */
export async function removeRoot(s: MachineSettings, exec: Exec, machine: string): Promise<void> {
  const out = await exec(s.bin, ["machine", "run", "-i", "-u", "root", "-n", machine, "--", "bash", "-s"], {
    input: removeRootScript(s.user),
    timeoutMs: 60_000,
  });
  if (!out.includes("@@no-root")) throw new WallError(`couldn't take root from ${s.user} in ${machine}`);
}

/**
 * Throws {@link MachineNotRunning} unless `machine ls` shows the machine running. Called inside the machine's
 * queue (machine-queue.ts) and before anything else that runs in the machine: `machine run` boots a stopped
 * machine, and a boot that comes with a stop is what leaves a machine's hostname stuck (T75).
 */
export async function assertRunning(s: MachineSettings, exec: Exec, machine: string): Promise<void> {
  const row = parseMachineListing(await exec(s.bin, ["machine", "ls"])).find((r) => r.name === machine);
  if (row?.state !== "running") throw new MachineNotRunning(machine);
}

/**
 * Everything that must hold before a command runs in a machine, in order: the walls and the container service
 * allow it, the machine is running (never booted by the command), and the walls' checks of this machine pass.
 * The caller holds a lease on the machine (`MachineQueue.use`).
 */
export async function guardRun(s: MachineSettings, exec: Exec, machine: string): Promise<void> {
  assertWalls(s);
  await assertRunning(s, exec, machine);
  await assertRunnable(s, exec, machine);
}

/**
 * The checks before anything runs in a machine, and so before every launch (spec §5 and §7): the walls
 * are up and, once the new walls are installed, the machine's live address is where the walls' acknowledgement
 * says it should be (let out for an engineers' machine, shut in for a PA's sandbox), and a PA's sandbox
 * still has no root. With the old walls an engineers' machine passes as it always did and a home machine
 * is refused with a message that says to update them. A launch into a machine `machine ls` doesn't show
 * running is refused too, since `machine run` would boot it.
 */
export async function assertRunnable(s: MachineSettings, exec: Exec, machine: string): Promise<void> {
  assertWalls(s);
  const home = isHome(s, machine);
  const wall = s.wall;
  if (!wall) {
    if (home)
      throw new WallError(`${machine} is a home machine, and no wall is set up, so nothing runs in it`);
    return;
  }
  let row: WallRow | undefined;
  if (wall.state().kind !== "old") row = (await wallRows(s, exec)).find((r) => r.name === machine);
  const why = wall.problem(machine, home, row);
  if (why) throw new WallError(why);
  if (home && !(await isRootless(s, exec, machine))) {
    throw new WallError(`${machine}'s user can still get root, so nothing runs in it`);
  }
}

/** Where a ticket's worktree is in its machine, and so where its ACP sessions work. */
export const workDir = (ticketId: Id, s: MachineSettings = defaultMachineSettings) => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(ticketId)) throw new Error(`not a ticket id: ${ticketId}`);
  return `/home/${s.user}/work/inc-${ticketId}`;
};

/** Where a conversation's working copy is in its machine (`conv-<id>`): a ticket made from it works there too. */
export const convDir = (conversationId: Id, s: MachineSettings = defaultMachineSettings) => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(conversationId))
    throw new Error(`not a conversation id: ${conversationId}`);
  return `/home/${s.user}/work/conv-${conversationId}`;
};

export interface ExecOptions {
  env?: Record<string, string>;
  input?: string;
  /** Kill the command after this long. */
  timeoutMs?: number;
}

/** Runs a command and resolves with its output, or rejects with its error output. */
export type Exec = (bin: string, args: string[], opts?: ExecOptions) => Promise<string>;

/** `exec` with a limit on every command that doesn't name its own (the `container` commands in timeouts.ts). */
export function withDefaultTimeout(s: MachineSettings, exec: Exec): Exec {
  return (bin, args, opts) =>
    exec(bin, args, {
      ...opts,
      timeoutMs: opts?.timeoutMs ?? s.timeouts?.().machineCommandMs ?? defaultTimeoutsMs.machineCommandMs,
    });
}

export const execDefault: Exec = (bin, args, opts) =>
  new Promise((resolve, reject) => {
    // Detached, so the command leads a process group that a timeout can stop as a whole.
    const child = spawn(bin, args, {
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    trackGroup(child);
    const maxBuffer = 8 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let settled = false;
    // The deadline rejects the call itself: a killed command whose children still hold its pipes
    // would never close.
    const timer = opts?.timeoutMs
      ? setTimeout(() => {
          stopGroup(child, 1000);
          fail(
            new Error(
              `\`${bin} ${args.slice(0, 3).join(" ")}\` timed out after ${describeMs(opts.timeoutMs ?? 0)}`,
            ),
          );
        }, opts.timeoutMs)
      : undefined;
    timer?.unref?.();
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > maxBuffer) {
        stopGroup(child, 1000);
        fail(new Error(`\`${bin}\` wrote more than ${maxBuffer} bytes`));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < maxBuffer) stderr += chunk;
    });
    child.on("error", fail);
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `Command failed: ${bin} ${args.join(" ")} (${code ?? signal})`));
    });
    // A command that exits before it reads its input leaves the write with EPIPE: its exit is the
    // answer, not a crash.
    guardStdin(child.stdin);
    if (opts?.input) child.stdin.write(opts.input);
    child.stdin.end();
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
  /**
   * When each fault's backoff ends on the monotonic clock. `retryAt` (wall time) is what Setup shows; this is
   * what decides, so a clock stepped back doesn't stretch the wait and one stepped forward doesn't skip it.
   */
  private readonly retryMono = new Map<string, number>();
  private readonly attempts = new Map<string, number>();
  private readonly lastLogged = new Map<string, string>();
  /**
   * Every `container` command for one machine goes through this queue (machine-queue.ts, T75): boots and
   * other changes one at a time, scripts and sessions as leases, and a stop only when nothing else for the
   * machine is under way. Shared with `machineScript` and `machineLaunch` through the settings.
   */
  readonly queue: MachineQueue;
  /** Home machines the walls refused after a boot: stopped (through the queue) once the boot's hold ends. */
  private readonly stopAfter = new Set<string>();
  /** Machines whose launcher is being updated now, and when a failed update may be tried again (monotonic). */
  private readonly launcherBusy = new Set<string>();
  private readonly launcherRetry = new Map<string, number>();

  private readonly exec: Exec;
  /** Clears the container service's stuck machine names by restarting it (container-recovery.ts); absent: never. */
  private recovery?: ServiceRecovery;

  constructor(
    private readonly s: MachineSettings = defaultMachineSettings,
    exec: Exec = execDefault,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly now: () => number = Date.now,
    private readonly log?: (msg: string) => void,
    /** A clock that never steps (for the backoff). Absent: `now`. */
    private readonly mono: () => number = now,
  ) {
    this.queue = queueFor(s);
    // Every `container` command has a limit (timeouts.ts): a frozen container service must not hold a
    // ticket, and with it a deploy, for ever. A call that names its own limit keeps it.
    this.exec = (bin, args, opts) =>
      exec(bin, args, {
        ...opts,
        timeoutMs:
          opts?.timeoutMs ?? this.s.timeouts?.().machineCommandMs ?? defaultTimeoutsMs.machineCommandMs,
      });
  }

  /**
   * Runs `fn` as a lease on the machine: beside other scripts, never beside a stop, and only if the machine is
   * running (it is never booted for `fn`: a chore waits for the next boot). `fn` runs commands with the raw
   * `exec`, since it holds the lease already. Rejects with {@link MachineNotRunning} when the machine is down.
   */
  private async leased<T>(machine: string, label: string, fn: () => Promise<T>): Promise<T> {
    return this.queue.use(machine, label, async () => {
      await guardRun(this.s, this.exec, machine);
      return fn();
    });
  }

  async ensureUp(employeeId: Id): Promise<void> {
    assertWalls(this.s);
    const name = machineOf(this.s, employeeId);
    this.preflight(name);
    try {
      await this.queue.serial(name, "ensureUp", () => this.bringUp(name, employeeId));
    } finally {
      await this.stopRefused(name);
    }
  }

  /** A home machine the walls refused is stopped, now that the boot's hold is over (a stop can't be taken inside it). */
  private async stopRefused(name: string): Promise<void> {
    if (!this.stopAfter.delete(name)) return;
    try {
      await this.queue.stop(name, "walls refused it", () => this.exec(this.s.bin, ["machine", "stop", name]));
    } catch (err) {
      this.log?.(`[sandbox:${name}] couldn't stop it after the walls refused it: ${err}`);
    }
  }

  /**
   * Turns on the automatic restart of the container service for a machine that won't boot because its
   * hostname is still held (container-recovery.ts, T73). `o` is what only the daemon knows: whether any
   * work is running, the push, where the record is kept.
   */
  enableRecovery(
    o: Pick<RecoveryOptions, "idle" | "booted" | "done" | "push" | "store" | "stopping" | "timing">,
  ): ServiceRecovery {
    const recovery = new ServiceRecovery({
      ...o,
      run: (args, timeoutMs) => this.exec(this.s.bin, args, timeoutMs ? { timeoutMs } : undefined),
      sleep: this.sleep,
      now: this.now,
      mono: this.mono,
      ...(this.log ? { log: this.log } : {}),
      // No boot, stop, script or session is under way either (the machine queue is empty), and nothing else is:
      // the daemon says the rest. (A launcher update counts too.)
      idle: async () =>
        this.queue.idle && this.launcherBusy.size === 0 && scriptsRunning() === 0 && (await o.idle()),
      stopMachines: () => this.stopAll(),
      forget: (machine) => this.forgetFault(machine),
      retry: (employeeId) => this.ensureUp(employeeId),
      ...(this.s.wallsMarker ? { wallsMarker: this.s.wallsMarker } : {}),
      wallsAck: () => this.s.wall?.s.ack,
    });
    this.recovery = recovery;
    this.s.gate = () => recovery.gate();
    return recovery;
  }

  /**
   * At startup, before the first launch: the container service must be answering; if the last daemon died in
   * the middle of a restart it is started again (container-recovery.ts). Launches wait for it.
   */
  checkService(): Promise<void> {
    return this.recovery?.startup() ?? Promise.resolve();
  }

  /** The daemon is leaving: no restart starts. */
  closeRecovery(): void {
    this.recovery?.close();
  }

  /** The restart of the container service is cutting machines off (the deployer waits for it). */
  get recoveryActive(): boolean {
    return this.recovery?.active ?? false;
  }

  /** What the daemon did about the container service, newest first (Setup > Sandboxes). */
  serviceEvents(): ServiceEvent[] {
    return this.recovery?.events() ?? [];
  }

  private forgetFault(name: string): void {
    this.faults.delete(name);
    this.retryMono.delete(name);
    this.attempts.delete(name);
    this.lastLogged.delete(name);
  }

  /** The fault to show for a machine: the recovery's wait, or the boot's backoff while it runs. */
  private liveFault(name: string): SandboxFault | undefined {
    const wait = this.recovery?.waitingFor(name);
    if (wait) {
      return {
        machine: name,
        kind: "stale-hostname",
        reason: wait.reason,
        waiting: wait.waiting,
        since: wait.since,
        retryAt: this.now() + 30_000,
        attempts: this.faults.get(name)?.attempts ?? 1,
      };
    }
    const fault = this.faults.get(name);
    return fault && this.backingOff(name, fault) ? fault : undefined;
  }

  /** `ensureUp` once it holds the machine's lock: the machine may be up already by now. */
  private async bringUp(name: string, employeeId: Id): Promise<void> {
    const working = this.up.get(name);
    if (working) {
      // Already up: its address and its lack of root are checked again, since it may have been restarted.
      await this.secure(name, false);
      // The set may have been replaced by a failed check meanwhile; add to what is there.
      this.claim(name, employeeId);
      return;
    }
    const fault = this.liveFault(name);
    if (fault) throw new StartupError(fault.waiting, fault.retryAt);
    const size = this.s.sizeFor?.(name) ?? { cpus: this.s.cpus, memory: this.s.memory };
    try {
      await this.bootWithRecovery(name, employeeId);
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
      await this.bootWithRecovery(name, employeeId);
    }
    // Before anything is run in it: a home machine loses its user's root, and the walls must have its address.
    await this.secure(name, true);
    this.claim(name, employeeId);
  }

  /**
   * At startup, `up` is empty although the machines an earlier daemon started may still be running, and
   * `stop` is a no-op for what it doesn't know. This records, for each of these employees, whether their
   * machine is running now, so the daemon's idle sweep can stop it. Returns those employees.
   */
  async adopt(employeeIds: Id[]): Promise<Id[]> {
    const byMachine = new Map<string, Id[]>();
    for (const id of employeeIds) {
      let name: string;
      try {
        name = machineOf(this.s, id);
      } catch {
        continue;
      }
      byMachine.set(name, [...(byMachine.get(name) ?? []), id]);
    }
    // Each machine is looked at inside its queue, behind any boot or stop already under way: the startup
    // chores (sign-out, sweeps, home checks) and the first idle pass are queued the same way.
    const adoptedMachines = new Set<string>();
    for (const [name, members] of byMachine) {
      await this.queue.serial(name, "adopt", async () => {
        const row = parseMachineListing(await this.exec(this.s.bin, ["machine", "ls"])).find(
          (r) => r.name === name,
        );
        if (row?.state !== "running") return;
        for (const id of members) this.claim(name, id);
        adoptedMachines.add(name);
      });
    }
    return employeeIds.filter((id) => {
      try {
        return adoptedMachines.has(machineOf(this.s, id));
      } catch {
        return false;
      }
    });
  }

  /** Records that an employee works in a machine, next to whoever already does. */
  private claim(name: string, employeeId: Id): void {
    const working = this.up.get(name) ?? new Set<Id>();
    working.add(employeeId);
    this.up.set(name, working);
  }

  /**
   * A home machine (a personal assistant's sandbox) is made and booted only if the walls can shut it in:
   * the new walls have to be installed and running. Nothing is created otherwise. (Apple container 1.4.1
   * has no network option for machines, so the walls name the machines they let out: egress-wall.ts.)
   * Other machines are not asked anything.
   */
  private preflight(name: string): void {
    if (!isHome(this.s, name)) return;
    const why = this.s.wall
      ? this.s.wall.stateProblem(name, true)
      : `${name} is a home machine, and no wall is set up, so nothing runs in it`;
    if (why) this.wallFailure(name, why, "state");
    // The walls were updated since: no need to wait out the backoff of "update the walls".
    if (this.wallFaults.get(name) === "state") this.clearWallFault(name);
  }

  /** Records why the walls hold a machine back, for Setup > Sandboxes and the log, and throws it as a wait. */
  private wallFailure(name: string, why: string, kind: "state" | "verify" = "verify"): never {
    const t = this.now();
    const before = this.faults.get(name);
    this.faults.set(name, {
      machine: name,
      kind: "unknown",
      reason: why,
      waiting: why,
      since: before?.since ?? t,
      retryAt: t + 60_000,
      attempts: (before?.attempts ?? 0) + 1,
    });
    this.retryMono.set(name, this.mono() + 60_000);
    this.wallFaults.set(name, kind);
    this.logStateChange(name, `fault:wall:${why}`, why);
    throw new StartupError(why, t + 60_000);
  }

  /** Machines whose fault is the walls', so it can be cleared when the walls settle. */
  private readonly wallFaults = new Map<string, "state" | "verify">();

  private clearWallFault(name: string): void {
    if (!this.wallFaults.delete(name)) return;
    this.faults.delete(name);
    this.retryMono.delete(name);
    this.attempts.delete(name);
    this.logStateChange(name, "running", "the walls settled");
  }

  /**
   * After a machine is up and before anything runs in it: a home machine's user loses root, and the walls
   * must have the machine's address (let out for an engineers' machine, shut in for a home one). A home
   * machine that can't be secured is stopped. With the old walls an engineers' machine is not asked anything.
   */
  private async secure(name: string, fresh: boolean): Promise<void> {
    const home = isHome(this.s, name);
    const wall = this.s.wall;
    if (!home && (!wall || wall.state().kind === "old")) return;
    try {
      if (home) {
        if (fresh || !(await isRootless(this.s, this.exec, name))) await removeRoot(this.s, this.exec, name);
        if (!(await isRootless(this.s, this.exec, name))) {
          throw new WallError(`${name}'s user can still get root after it was taken away`);
        }
      }
      if (wall) await wall.verify(name, home, () => wallRows(this.s, this.exec, true), this.sleep);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.up.delete(name);
      // Stopped by the caller once its hold on the machine ends: a stop can't be taken from inside one.
      if (home) this.stopAfter.add(name);
      this.wallFailure(name, why);
    }
    this.clearWallFault(name);
  }

  /**
   * One look at the machines, every thirty seconds or so, once the new walls are installed: tells the
   * walls job about the machines that may reach the internet (so a machine that woke with a new address is
   * let out), stops a home machine whose address the walls let out for longer than `graceMs`, and one whose
   * user has root again. Returns the machines stopped.
   */
  async watchHome(graceMs = 90_000): Promise<string[]> {
    const wall = this.s.wall;
    if (!wall || wall.state().kind === "old") return [];
    const { stop, rows } = await wall.watch(() => wallRows(this.s, this.exec, true), graceMs);
    for (const r of rows) {
      if (!r.home || r.state !== "running" || stop.includes(r.name)) continue;
      try {
        // A lease like any script's: the machine may have stopped since the listing, and is not booted for this.
        // (Not `leased`: its walls check would refuse a machine that has root, which is what is looked for here.)
        const hasRoot = await this.queue.use(r.name, "root check", async () => {
          assertWalls(this.s);
          await assertRunning(this.s, this.exec, r.name);
          if (await isRootless(this.s, this.exec, r.name)) return false;
          await removeRoot(this.s, this.exec, r.name);
          return !(await isRootless(this.s, this.exec, r.name));
        });
        if (hasRoot) stop.push(r.name);
      } catch (err) {
        if (err instanceof MachineNotRunning) continue;
        this.log?.(`[sandbox:${r.name}] couldn't check it for root: ${err}`);
      }
    }
    const stopped: string[] = [];
    for (const name of stop) {
      this.log?.(
        `[sandbox:${name}] the walls don't hold it (its address is let out, or it has root), so it is stopped`,
      );
      try {
        await this.queue.stop(name, "walls", async () => {
          this.up.delete(name);
          await this.exec(this.s.bin, ["machine", "stop", name]);
        });
        stopped.push(name);
      } catch (err) {
        // Busy: a session still holds it. Nothing is killed; the next look (thirty seconds on) tries again.
        this.log?.(`[sandbox:${name}] couldn't stop it: ${err}`);
      }
    }
    return stopped;
  }

  /**
   * Boots a machine with safe recovery and exponential backoff on failure (T50). The caller holds the
   * machine's serial hold (`queue.serial`): the recovery's `machine stop` must not kill a boot another call just
   * made. (The machine is not running when it fails to boot, so no lease is held on it: that stop lands beside
   * no script.)
   */
  private async bootWithRecovery(name: string, employeeId?: Id): Promise<void> {
    try {
      await this.boot(name);
      if (this.faults.has(name) || this.attempts.has(name)) {
        this.faults.delete(name);
        this.retryMono.delete(name);
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
          this.retryMono.delete(name);
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
        // A stuck hostname should now be rare (T75). When one happens, the machine's latest queue operations say
        // what stood beside its last stop.
        if (failure.kind === "stale-hostname") {
          this.log?.(
            `[sandbox:${name}] STALE HOSTNAME: the container service holds ${name}'s hostname from an earlier boot (${failure.message.slice(0, 160)}). Its last ${HISTORY_LEN} queue operations: ${this.queue.describeHistory(name)}`,
          );
        }
        const attempts = (this.attempts.get(name) ?? 0) + 1;
        this.attempts.set(name, attempts);
        const backoffMs = Math.min(30_000 * 2 ** (attempts - 1), 600_000);
        const currentTime = this.now();
        const retryAt = currentTime + backoffMs;
        const info = BOOT_FAILURES[failure.kind];
        const teamName = name.replace(/^inc-/, "");
        // A stuck hostname is cleared by restarting the container service, once everything is idle
        // (container-recovery.ts). Only when that has been done lately and did not help does the owner get it.
        if (failure.kind === "stale-hostname" && this.recovery?.request(name, employeeId)) {
          const wait = this.recovery.waitingFor(name);
          const text =
            wait?.waiting ?? `the ${teamName} sandbox can't start: the container service is being restarted`;
          this.logStateChange(
            name,
            "fault:stale-hostname:recovering",
            `boot failed (stale-hostname): ${text}`,
          );
          this.faults.set(name, {
            machine: name,
            kind: "stale-hostname",
            reason: wait?.reason ?? text,
            waiting: text,
            since: this.faults.get(name)?.since ?? currentTime,
            retryAt: currentTime + 30_000,
            attempts,
          });
          this.retryMono.set(name, this.mono() + 30_000);
          throw new StartupError(text, currentTime + 30_000);
        }
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
        this.retryMono.set(name, this.mono() + backoffMs);
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

  /** Whether a fault's backoff is still running: on the monotonic clock, or on wall time for a fault without one. */
  private backingOff(name: string, fault: SandboxFault): boolean {
    const until = this.retryMono.get(name);
    return until !== undefined ? this.mono() < until : this.now() < fault.retryAt;
  }

  /** The fault holding an employee's sandbox, while its backoff runs; once it is over the next start tries again. */
  sandboxFault(employeeId: Id): SandboxFault | undefined {
    const name = machineOf(this.s, employeeId);
    const own = this.liveFault(name);
    if (own) return own;
    // While the container service restarts, nothing starts anywhere: every ticket and conversation says why.
    const held = this.s.gate?.();
    return held
      ? {
          machine: name,
          kind: "container-service-down",
          reason: held,
          waiting: held,
          since: this.now(),
          retryAt: this.now() + 30_000,
          attempts: 1,
        }
      : undefined;
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
    this.retryMono.delete(machine);
    this.attempts.delete(machine);
    this.lastLogged.delete(machine);
    try {
      // A home machine is booted only if the walls are ready for it, and is secured like any other boot.
      this.preflight(machine);
      await this.queue.serial(machine, "retry", async () => {
        await this.bootWithRecovery(machine);
        await this.secure(machine, true);
      });
    } catch {
      // faults will be updated if it fails
    }
    await this.stopRefused(machine);
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

  /**
   * Done with the machine for now; it stops once nobody else is working in it. The stop waits for every script
   * and session in the machine to end, for a bounded time (machine-queue.ts): past it the machine is left
   * running, the employee is recorded as working in it again so the next idle pass tries again, and this
   * rejects with {@link MachineBusy}. Nothing is killed.
   */
  async stop(employeeId: Id): Promise<void> {
    const name = machineOf(this.s, employeeId);
    // After any boot of this machine that is under way: the employee who asked for that boot is in the
    // set by then, so the machine isn't stopped under them.
    const last = await this.queue.serial(name, "release", async () => {
      const working = this.up.get(name);
      if (!working?.delete(employeeId)) return false;
      // The (empty) set stays until the stop: a start that comes in between finds the machine up and joins it.
      return working.size === 0;
    });
    if (!last) return;
    try {
      await this.queue.stop(name, "idle", async () => {
        const working = this.up.get(name);
        if (working && working.size > 0) return; // someone started working in it meanwhile
        this.up.delete(name);
        await this.exec(this.s.bin, ["machine", "stop", name]);
      });
    } catch (err) {
      // Not stopped: the employee is recorded as working in it again, so the next idle pass tries again.
      if (err instanceof MachineBusy) this.claim(name, employeeId);
      throw err;
    }
  }

  /**
   * Stops every running employee machine, including ones an earlier daemon started: what the daemon
   * does when the walls go down. Each stop goes through the machine's queue and looks at the machine again
   * inside it. Returns the machines it stopped (one that is busy, or is stopped by someone else first, is left out).
   */
  async stopAll(): Promise<string[]> {
    const listing = await this.exec(this.s.bin, ["machine", "ls"]);
    const names = parseMachineListing(listing)
      .filter((r) => r.state === "running")
      .map((r) => r.name);
    const stopped: string[] = [];
    for (const name of names) {
      try {
        await this.queue.stop(name, "stop-all", async () => {
          const row = parseMachineListing(await this.exec(this.s.bin, ["machine", "ls"])).find(
            (r) => r.name === name,
          );
          if (row?.state !== "running") return;
          this.up.delete(name);
          await this.exec(this.s.bin, ["machine", "stop", name]);
          stopped.push(name);
        });
      } catch (err) {
        if (!(err instanceof MachineBusy)) throw err;
        this.log?.(`[sandbox:${name}] ${err.message}`);
      }
    }
    return stopped;
  }

  /**
   * The daemon is leaving (SIGTERM): no stop is issued from now on, so none lands beside the sweeps and scripts
   * that are ending. The machines stay running; the next daemon adopts them and stops them when idle.
   */
  closeQueue(): void {
    this.queue.close();
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
   * (T52: cleaning must not wake a machine; T75: a boot beside a stop leaves its hostname stuck). It holds a
   * lease on the machine, so no stop is issued while it runs, and it looks at `machine ls` inside the lease.
   */
  async runIn(machine: string, script: string, timeoutMs = 15 * 60_000): Promise<string> {
    if (!/^inc-[a-z0-9-]{1,32}$/.test(machine)) throw new Error(`not a machine name: ${machine}`);
    return this.leased(machine, "runIn", () =>
      this.exec(this.s.bin, ["machine", "run", "-i", "-u", this.s.user, "-n", machine, "--", "bash", "-s"], {
        input: script,
        timeoutMs,
      }),
    );
  }

  /**
   * Copies the release's launchers into a machine whose launcher is older than the release (a machine made
   * from an older image: images/employee/README.md), as tools/host/update-machine.sh does by hand. Called
   * when a sweep or the sign-in probe reports `@@launcher old`. It respects the walls (`assertRunnable`:
   * the marker and the acknowledgement), holds a lease like any script, and never starts a machine: one that isn't running is left until
   * its next boot, when the next sweep finds the launcher old again. It logs once when it succeeds, and
   * once per failure (with ten minutes before the next try). It never throws.
   */
  async updateLauncher(machine: string): Promise<"updated" | "skipped" | "failed"> {
    if (!/^inc-[a-z0-9-]{1,32}$/.test(machine)) return "skipped";
    if (this.launcherBusy.has(machine)) return "skipped";
    const retryAt = this.launcherRetry.get(machine);
    if (retryAt !== undefined && this.mono() < retryAt) return "skipped";
    this.launcherBusy.add(machine);
    try {
      const files = launcherFiles(this.s.imageDir ?? releaseImageDir);
      let skipped = false;
      const out = await this.queue.use(machine, "launcher update", async () => {
        try {
          await guardRun(this.s, this.exec, machine);
        } catch {
          // Not running (left until its next boot), or the walls aren't up for it: nothing runs in it, this included.
          skipped = true;
          return "";
        }
        return this.exec(
          this.s.bin,
          ["machine", "run", "-i", "-u", "root", "-n", machine, "--", "bash", "-s"],
          {
            input: launcherUpdateScript(files, this.s.user),
          },
        );
      });
      if (skipped) return "skipped";
      if (!out.includes("@@launcher-updated"))
        throw new Error(`the copy did not check out: ${out.trim().slice(-200)}`);
      noteLauncher(machine, true);
      this.launcherRetry.delete(machine);
      this.log?.(
        `${machine}: its launcher was older than the release's, so the daemon copied acp-env.sh, ${files.length - 2} launchers and the Claude settings into it`,
      );
      return "updated";
    } catch (e) {
      this.launcherRetry.set(machine, this.mono() + LAUNCHER_RETRY_MS);
      this.log?.(
        `${machine}: couldn't update its launcher (${e instanceof Error ? e.message : e}); trying again in ten minutes, or run tools/host/update-machine.sh ${machine.replace(/^inc-/, "")}`,
      );
      return "failed";
    } finally {
      this.launcherBusy.delete(machine);
    }
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
    const machine = machineName(teamId);
    await this.leased(machine, "callback", () =>
      this.exec(
        this.s.bin,
        ["machine", "run", "-i", "-u", this.s.user, "-n", machine, "-e", "CALLBACK_URL", "--", "bash", "-s"],
        {
          env: { CALLBACK_URL: url },
          input: 'curl -fsS -- "$CALLBACK_URL" >/dev/null\n',
        },
      ),
    );
  }

  async inspectSandbox(team: Id, size: { cpus: number; memory: string }): Promise<SandboxStatus> {
    if (!/^[a-z0-9-]{1,32}$/.test(team)) throw new Error(`not a team id: ${team}`);
    const machine = machineName(team);
    const defaultSignedIn = { claude: false, antigravity: false, codex: false, github: false };
    const live = this.liveFault(machine);
    const fault = live ?? this.faults.get(machine);

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

    const inFault = Boolean(live || (fault && this.backingOff(machine, fault)));
    const state: "running" | "stopped" | "error" = inFault
      ? "error"
      : entry.includes("running")
        ? "running"
        : "stopped";

    let signedIn = this.signedInCache.get(machine) ?? defaultSignedIn;
    if (wallsUp(this.s) && state === "running") {
      try {
        // A lease, and a second look at `machine ls` inside it: a machine that stopped since the listing is not probed.
        signedIn = await this.leased(machine, "sign-in probe", () => this.probeSignIn(machine));
      } catch {
        // keep cached or fallback (the walls don't let anything run in it, or it isn't running now)
      }
    }

    // A PA's sandbox waits for the walls to be updated: Setup > Sandboxes says so before anyone tries it.
    const wallReason = isHome(this.s, machine) ? this.s.wall?.stateProblem(machine, true) : undefined;

    return {
      team,
      machine,
      state,
      cpus: size.cpus,
      memory: size.memory,
      signedIn,
      ...(launcherNeedsUpdate(machine) ? { launcher: "needs-update" as const } : {}),
      ...(fault && inFault
        ? { reason: fault.reason, kind: fault.kind, retryAt: fault.retryAt }
        : wallReason
          ? { reason: wallReason }
          : {}),
    };
  }

  private async probeSignIn(
    machine: string,
  ): Promise<{ claude: boolean; antigravity: boolean; codex: boolean; github: boolean }> {
    // The probe runs in non-login bash, and the sandbox's npm globals (the Codex CLI) live in
    // ~/.local/bin, which that shell doesn't have on its PATH. The string is fixed: no input reaches it.
    const input =
      'export PATH="$HOME/.local/bin:$PATH"; ' +
      "[ -s ~/.claude/.credentials.json ] && echo claude; [ -s ~/.gemini/antigravity-acp/acp_token.json ] && echo antigravity; codex login status >/dev/null 2>&1 && echo codex; [ -s ~/.config/gh/hosts.yml ] && echo github; if grep -q inc-agents /usr/local/lib/i-inc/acp-env.sh 2>/dev/null; then echo agentnotes; else echo noagentnotes; fi; true\n";
    // The caller holds a lease on the machine (`leased`).
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
    // A launcher from before agent notes: said once in the log, and shown in Setup (reaper.ts). The
    // daemon updates it from the release, in the background (this probe is Setup's, not a launch's).
    if (found.has("agentnotes") || found.has("noagentnotes")) {
      if (noteLauncher(machine, found.has("agentnotes"), this.log)) void this.updateLauncher(machine);
    }
    this.signedInCache.set(machine, result);
    return result;
  }
}

export interface MachineRow {
  name: string;
  state: "running" | "stopped" | string;
  /** The machine's disk on the host, in bytes, when the listing has one. */
  diskBytes?: number;
  /** Its address on the machines' network, when it has one (the listing's IP column; "-" while stopped). */
  ip?: string;
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
    // The IP column sits between the creation time and the CPUs.
    const ip = cols.find((c) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(c));
    rows.push({
      name,
      state,
      ...(m && unit ? { diskBytes: Math.round(Number(m[1]) * unit) } : {}),
      ...(ip ? { ip } : {}),
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

// Detached, so the agent's whole process group can be stopped (killGroup).
export const spawnDefault: Spawn = (bin, args, env) =>
  spawn(bin, args, { env, stdio: ["pipe", "pipe", "pipe"], detached: true });

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
  execRaw: Exec = execDefault,
): Launch {
  const exec = withDefaultTimeout(s, execRaw);
  const queue = queueFor(s);
  return ({ employeeId, engine, cwd, env }) => {
    const machine = machineOf(s, employeeId);
    const launcher = launchers[engine.harness];
    // A session holds a lease on its machine from the launch until its client exits: no stop is issued beside
    // it, and `machine ls` is looked at inside the lease, so a stopped machine is never booted by a launch
    // (the sandbox is brought up first, by `ensureUp`). With the new walls (or for a home machine) the live
    // address is checked too.
    return (async (): Promise<AgentProcess> => {
      const end = await queue.lease(machine, `session ${engine.harness}`);
      try {
        assertWalls(s);
        await assertRunning(s, exec, machine);
        if (needsLiveCheck(s, machine)) await assertRunnable(s, exec, machine);
        return start(end);
      } catch (err) {
        end(err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120));
        throw err;
      }
    })();

    function start(end: (result?: string) => void): AgentProcess {
      if (!launcher) throw new Error(`no ACP launcher for ${engine.harness}`);
      // The launcher notes this token, the pid and the start time in the sandbox (reaper.ts), so an
      // agent that outlives the daemon can be found and stopped.
      const agentId = newAgentId();
      const vars: Record<string, string> = { I_INC_CWD: cwd, ...env, I_INC_AGENT: agentId };
      for (const name of Object.keys(vars)) {
        if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`can't pass ${name} into a machine`);
      }
      const flags = Object.keys(vars).flatMap((name) => ["-e", name]);
      const child = run(
        s.bin,
        ["machine", "run", "-i", "-u", s.user, "-n", machine, ...flags, "--", launcher],
        { ...process.env, ...vars },
      );
      const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
      // The lease ends with the session's client (or with a client that never started).
      void exited.then(() => end("ended"));
      child.on("error", (err) => end(err.message));
      trackAgent(agentId, exited);
      trackGroup(child);
      // The agent exits when its machine goes away; a write after that must not crash the daemon.
      guardStdin(child.stdin);
      const proc: AgentProcess = {
        agentId,
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        kill: () => stopGroup(child),
        exited,
      };
      return proc;
    }
  };
}

/** Whether a launch has to look at `machine ls` first: a home machine, or any machine once the new walls are in. */
function needsLiveCheck(s: MachineSettings, machine: string): boolean {
  if (!s.wall) return isHome(s, machine); // (a home machine is then refused)
  return isHome(s, machine) || s.wall.state().kind !== "old";
}
