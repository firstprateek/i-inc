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
 * agents working there) in the environment. Prints `@@reaped <pid> <folder>` for each one it stopped.
 * For each note: a pid that is gone, or whose start time or token differs, is a stale note and is
 * just removed; a match gets SIGTERM with its descendants, and SIGKILL after three seconds.
 */
export const SWEEP_SCRIPT = `
d="${AGENT_NOTES}"
[ -d "$d" ] || exit 0
keep=" \${I_INC_KEEP:-} "
st() {
  if [ -r "/proc/$1/stat" ]; then sed 's/^.*) //' "/proc/$1/stat" | cut -d' ' -f20
  else ps -o lstart= -p "$1" 2>/dev/null | tr -s ' ' | sed 's/^ //; s/ $//'; fi
}
kids() { for c in $(pgrep -P "$1" 2>/dev/null); do kids "$c"; echo "$c"; done; }
for f in "$d"/*.pid; do
  [ -e "$f" ] || continue
  tok=$(basename "$f" .pid)
  case "$keep" in *" $tok "*) continue ;; esac
  pid=""; start=""; cwd=""
  IFS="|" read -r pid start cwd < "$f" || true
  [ -z "\${I_INC_SWEEP_CWD:-}" ] || [ "$cwd" = "$I_INC_SWEEP_CWD" ] || continue
  case "$pid" in ''|*[!0-9]*) rm -f "$f"; continue ;; esac
  now=$(st "$pid")
  if [ -z "$now" ] || [ "$now" != "$start" ]; then rm -f "$f"; continue; fi
  if [ -r "/proc/$pid/environ" ] && ! tr '\\0' '\\n' < "/proc/$pid/environ" | grep -qx "I_INC_AGENT=$tok"; then
    rm -f "$f"; continue
  fi
  all="$(kids "$pid") $pid"
  kill -TERM $all 2>/dev/null
  alive=""
  for i in 1 2 3 4 5 6; do
    sleep 0.5
    alive=""
    for p in $all; do kill -0 "$p" 2>/dev/null && alive="$alive $p"; done
    [ -n "$alive" ] || break
  done
  [ -z "$alive" ] || kill -KILL $alive 2>/dev/null
  rm -f "$f"
  echo "@@reaped $pid $cwd"
done
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

/** The sweep as a function of the employee whose sandbox it goes through; it never throws. */
export function reaper(run: RunInMachine, log?: (m: string) => void): Reap {
  return async (employeeId, o = {}) => {
    try {
      const env: Record<string, string> = {
        I_INC_KEEP: o.all ? "" : liveAgentIds().join(" "),
        ...(o.cwd ? { I_INC_SWEEP_CWD: o.cwd } : {}),
      };
      const r = await run(employeeId, SWEEP_SCRIPT, env);
      const reaped = r.output
        .split("\n")
        .filter((l) => l.startsWith("@@reaped "))
        .map((l) => l.slice("@@reaped ".length));
      for (const line of reaped) log?.(`stopped an agent left running by an earlier daemon (pid ${line})`);
      return reaped;
    } catch (e) {
      log?.(`looking for agents left running failed: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  };
}

/** `sweep` as run on a machine by name (a startup sweep of every machine that is up). */
export async function reapMachines(
  machines: {
    listMachines(): Promise<{ name: string; state: string }[]>;
    runIn(m: string, s: string, t?: number): Promise<string>;
  },
  log?: (m: string) => void,
): Promise<number> {
  let n = 0;
  try {
    for (const m of await machines.listMachines()) {
      if (!m.name.startsWith("inc-") || m.state !== "running") continue;
      try {
        const out = await machines.runIn(
          m.name,
          `export I_INC_KEEP='${liveAgentIds().join(" ")}'\n${SWEEP_SCRIPT}`,
          60_000,
        );
        for (const line of out.split("\n").filter((l) => l.startsWith("@@reaped "))) {
          n++;
          log?.(`stopped an agent left running in ${m.name} by an earlier daemon (pid ${line.slice(9)})`);
        }
      } catch (e) {
        log?.(`looking for agents left running in ${m.name} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  } catch (e) {
    log?.(`looking for agents left running failed: ${e instanceof Error ? e.message : e}`);
  }
  return n;
}
