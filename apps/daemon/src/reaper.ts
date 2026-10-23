// Agents that outlive the daemon, and how they are found again.
//
// An agent runs in the team's sandbox, started by `container machine run -i ... -- acp-<harness>`.
// If the daemon dies (a crash, kill -9, a deploy that does not wait), the agent's stdin closes, and
// an agent that does not treat that as the end keeps running; the restarted daemon then starts a
// second one for the same work. So every launch has a token (`I_INC_AGENT`), and the image's
// launcher (images/employee/acp-env.sh) writes `~/.inc-agents/<token>.pid` in the sandbox: the pid,
// the process's start time and its folder. This module has the other half: a script that stops
// the agents whose note is still there and whose pid still has the same start time and token,
// and the code that runs it before a launch, at startup, and at shutdown.
//
// Never by name: an agent is stopped only if a note says it is this launch's process.
import { randomBytes } from "node:crypto";
import type { Id } from "@i-inc/core";
import { MachineNotRunning } from "./machine-queue.ts";

/** The tokens of the agents this daemon has started and not seen end: it never reaps those. */
const live = new Set<string>();

/** A new launch's token (hex, as the launcher expects it). */
export function newAgentId(): string {
  return randomBytes(8).toString("hex");
}

/** Marks an agent as this daemon's own until `ended` settles. */
export function trackAgent(id: string, ended: Promise<unknown>): void {
  live.add(id);
  void ended.then(() => live.delete(id));
}

export function liveAgentIds(): string[] {
  return [...live];
}

/** Test hook: a new process knows none of an old one's agents. */
export function forgetLiveAgents(): void {
  live.clear();
}

/** The folder in the sandbox that holds the notes. */
export const AGENT_NOTES = "$HOME/.inc-agents";

/**
 * Runs in the sandbox (`bash -s`), with I_INC_KEEP (tokens not to touch) and I_INC_SWEEP_CWD (only
 * agents working there) in the environment. Prints `@@launcher current|old` (does the sandbox's
 * launcher write notes at all?) and `@@reaped <pid> <folder>` for each agent it stopped.
 *
 * A note is used only if its name is a launch token, 16 to 64 lower-case hex digits: anything else
 * is not ours, and is left alone. For each note: a pid that is gone, or whose start time or token
 * differs, is a stale note and is just removed; a match is stopped. All the matches are sent SIGTERM
 * together (with their descendants), and the ones still there three seconds later get SIGKILL, so
 * any number of agents takes three seconds, not three seconds each.
 */
export const SWEEP_SCRIPT = `
if grep -q inc-agents /usr/local/lib/i-inc/acp-env.sh 2>/dev/null; then echo "@@launcher current"; else echo "@@launcher old"; fi
d="${AGENT_NOTES}"
[ -d "$d" ] || exit 0
keep=" \${I_INC_KEEP:-} "
st() {
  if [ -r "/proc/$1/stat" ]; then sed 's/^.*) //' "/proc/$1/stat" | cut -d' ' -f20
  else ps -o lstart= -p "$1" 2>/dev/null | tr -s ' ' | sed 's/^ //; s/ $//'; fi
}
kids() { for c in $(pgrep -P "$1" 2>/dev/null); do kids "$c"; echo "$c"; done; }
victims=""; notes=(); lines=()
for f in "$d"/*.pid; do
  [ -e "$f" ] || continue
  tok=$(basename "$f" .pid)
  case "$tok" in ''|*[!0-9a-f]*) continue ;; esac
  [ "\${#tok}" -ge 16 ] && [ "\${#tok}" -le 64 ] || continue
  case "$keep" in *" $tok "*) continue ;; esac
  pid=""; start=""; cwd=""
  IFS="|" read -r pid start cwd < "$f" || true
  [ -z "\${I_INC_SWEEP_CWD:-}" ] || [ "$cwd" = "$I_INC_SWEEP_CWD" ] || continue
  case "$pid" in ''|*[!0-9]*) rm -f "$f"; continue ;; esac
  now=$(st "$pid")
  if [ -z "$now" ] || [ "$now" != "$start" ]; then rm -f "$f"; continue; fi
  if [ -r "/proc/$pid/environ" ] && ! tr '\\0' '\\n' < "/proc/$pid/environ" | grep -qxF "I_INC_AGENT=$tok"; then
    rm -f "$f"; continue
  fi
  all="$(kids "$pid") $pid"
  victims="$victims $all"
  notes+=("$f"); lines+=("@@reaped $pid $cwd")
done
if [ -n "$victims" ]; then
  kill -TERM $victims 2>/dev/null
  alive=""
  for i in 1 2 3 4 5 6; do
    sleep 0.5
    alive=""
    for p in $victims; do kill -0 "$p" 2>/dev/null && alive="$alive $p"; done
    [ -n "$alive" ] || break
  done
  [ -z "$alive" ] || kill -KILL $alive 2>/dev/null
  for f in "\${notes[@]}"; do rm -f "$f"; done
  for l in "\${lines[@]}"; do echo "$l"; done
fi
exit 0
`;

/** Runs a script in an employee's sandbox (harness.ts `RunScript`). */
export type RunInMachine = (
  employeeId: Id,
  script: string,
  env?: Record<string, string>,
) => Promise<{ code: number; output: string }>;

export interface ReapOptions {
  /** Only agents working in this folder. */
  cwd?: string;
  /** Also the agents this daemon started: it is shutting down. */
  all?: boolean;
}

export type Reap = (employeeId: Id, o?: ReapOptions) => Promise<string[]>;

/** Machines whose launcher writes no notes (made before agent notes existed): no leftover agent there can be found. */
const oldLauncher = new Set<string>();

/**
 * The launcher check in a sweep's or a probe's output: logged once per machine, and shown in Setup. Returns
 * whether the launcher is old, so the caller can have the machine updated (`AppleMachines.updateLauncher`).
 */
export function noteLauncher(machine: string, current: boolean, log?: (m: string) => void): boolean {
  if (current) {
    oldLauncher.delete(machine);
    return false;
  }
  if (!oldLauncher.has(machine)) {
    oldLauncher.add(machine);
    log?.(
      `${machine}: its launcher writes no agent notes, so an agent left running by a crash can't be found. The daemon updates it from the release (or run tools/host/update-machine.sh ${machine.replace(/^inc-/, "")} on the host)`,
    );
  }
  return true;
}

/** Updates a machine's launcher from the release, if it can (machines.ts `updateLauncher`); it never throws. */
export type UpdateLauncher = (machine: string) => Promise<unknown>;

/** Does this machine need `tools/host/update-machine.sh`? Known once a sweep or a probe has looked. */
export const launcherNeedsUpdate = (machine: string): boolean => oldLauncher.has(machine);

/** Reads the launcher line of a sweep, and has an old launcher updated before the caller goes on. */
async function readLauncher(
  machine: string,
  output: string,
  log?: (m: string) => void,
  update?: UpdateLauncher,
): Promise<void> {
  const m = /@@launcher (current|old)/.exec(output);
  if (m && noteLauncher(machine, m[1] === "current", log) && update) {
    await update(machine).catch(() => {});
  }
}

/** Launches wait for the startup sweep, so an agent started in its window is never in its way. */
let startupSweep: Promise<unknown> | undefined;
const SWEEP_WAIT_MS = 120_000;
async function afterStartupSweep(): Promise<void> {
  if (!startupSweep) return;
  await Promise.race([startupSweep, new Promise((r) => setTimeout(r, SWEEP_WAIT_MS).unref?.())]);
}

/** The sweep as a function of the employee whose sandbox it goes through; it never throws. */
export function reaper(
  run: RunInMachine,
  log?: (m: string) => void,
  machineOf?: (employeeId: Id) => string,
  update?: UpdateLauncher,
): Reap {
  return async (employeeId, o = {}) => {
    try {
      // Not while the startup sweep is still going: it decides what is left over by what it finds.
      if (!o.all) await afterStartupSweep();
      const env: Record<string, string> = {
        I_INC_KEEP: o.all ? "" : liveAgentIds().join(" "),
        ...(o.cwd ? { I_INC_SWEEP_CWD: o.cwd } : {}),
      };
      const r = await run(employeeId, SWEEP_SCRIPT, env);
      // An old launcher is updated first, so the launch that follows this sweep uses the release's.
      if (machineOf) await readLauncher(machineOf(employeeId), r.output, log, update);
      const reaped = r.output
        .split("\n")
        .filter((l) => l.startsWith("@@reaped "))
        .map((l) => l.slice("@@reaped ".length));
      for (const line of reaped) log?.(`stopped an agent left running by an earlier daemon (pid ${line})`);
      return reaped;
    } catch (e) {
      // A stopped machine has no agent left in it, and is not started to look.
      if (!(e instanceof MachineNotRunning)) {
        log?.(`looking for agents left running failed: ${e instanceof Error ? e.message : e}`);
      }
      return [];
    }
  };
}

/**
 * The sweep on every machine that is up, by name, all at once. Never starts a machine: only those
 * `listMachines` shows as running are touched. At startup it holds launches back until it is done
 * (`all` false); at shutdown (`all` true) it takes every agent, this daemon's own included.
 */
export async function reapMachines(
  machines: {
    listMachines(): Promise<{ name: string; state: string }[]>;
    runIn(m: string, s: string, t?: number): Promise<string>;
    /** A machine whose launcher is old is updated here (never started for it: only running ones are swept). */
    updateLauncher?: UpdateLauncher;
  },
  log?: (m: string) => void,
  o: { all?: boolean; timeoutMs?: number } = {},
): Promise<number> {
  const work = (async () => {
    let n = 0;
    try {
      const up = (await machines.listMachines()).filter(
        (m) => m.name.startsWith("inc-") && m.state === "running",
      );
      await Promise.all(
        up.map(async (m) => {
          try {
            const keep = o.all ? "" : liveAgentIds().join(" ");
            const out = await machines.runIn(
              m.name,
              `export I_INC_KEEP='${keep}'\n${SWEEP_SCRIPT}`,
              o.timeoutMs ?? 60_000,
            );
            await readLauncher(m.name, out, log, machines.updateLauncher?.bind(machines));
            for (const line of out.split("\n").filter((l) => l.startsWith("@@reaped "))) {
              n++;
              log?.(`stopped an agent left running in ${m.name} by an earlier daemon (pid ${line.slice(9)})`);
            }
          } catch (e) {
            // It stopped since the listing: there is nothing left in it to look for.
            if (e instanceof MachineNotRunning) return;
            log?.(
              `looking for agents left running in ${m.name} failed: ${e instanceof Error ? e.message : e}`,
            );
          }
        }),
      );
    } catch (e) {
      log?.(`looking for agents left running failed: ${e instanceof Error ? e.message : e}`);
    }
    return n;
  })();
  if (!o.all) startupSweep = work;
  return work;
}

/** Test hook: a new process has no startup sweep and has seen no launcher. */
export function forgetSweepState(): void {
  startupSweep = undefined;
  oldLauncher.clear();
}
