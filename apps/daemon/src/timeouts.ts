// How long the daemon waits on a child process or an agent before it gives up (T63, audit 4.2). A
// hang must never hold a ticket (and with it the deployer's drain) for ever. Every limit is a number
// of minutes with a default, saved in the registry's settings next to the others
// (GET/PUT /api/timeouts), so the owner can see and change it.

export interface TimeoutSettings {
  /** A script run in an employee's machine: git, gh, sign-in, the reaper, a brain copy. */
  scriptMinutes: number;
  /** The project's check recipe, which is a whole install, lint, typecheck and test run. */
  checksMinutes: number;
  /** One `container` command on the host: boot, stop, list, create. */
  machineCommandMinutes: number;
  /** An agent's `initialize` and `session/new` (it is starting up, not working). */
  agentStartMinutes: number;
  /** A session with no word from the agent for this long is stopped and counts as stuck. */
  agentIdleMinutes: number;
}

export const defaultTimeoutSettings: TimeoutSettings = {
  scriptMinutes: 10,
  checksMinutes: 30,
  machineCommandMinutes: 5,
  agentStartMinutes: 2,
  agentIdleMinutes: 30,
};

const bounds = { min: 1, max: 24 * 60 };

/** The limits in milliseconds, which is what the code that waits uses. */
export interface TimeoutsMs {
  scriptMs: number;
  checksMs: number;
  machineCommandMs: number;
  agentStartMs: number;
  agentIdleMs: number;
}

const minute = 60_000;

/** The limits in milliseconds, as the owner has them: the defaults with the saved values over them. */
export function timeoutsMs(saved?: Partial<TimeoutSettings>): TimeoutsMs {
  const s = timeoutSettings(saved);
  return {
    scriptMs: s.scriptMinutes * minute,
    checksMs: s.checksMinutes * minute,
    machineCommandMs: s.machineCommandMinutes * minute,
    agentStartMs: s.agentStartMinutes * minute,
    agentIdleMs: s.agentIdleMinutes * minute,
  };
}

export const defaultTimeoutsMs: TimeoutsMs = timeoutsMs();

/** The settings as the owner sees them, in minutes: the defaults with the saved values over them. */
export function timeoutSettings(saved?: Partial<TimeoutSettings>): TimeoutSettings {
  const out = { ...defaultTimeoutSettings };
  for (const key of Object.keys(out) as (keyof TimeoutSettings)[]) {
    const v = saved && Object.hasOwn(saved, key) ? saved[key] : undefined;
    if (typeof v === "number" && Number.isInteger(v) && v >= bounds.min && v <= bounds.max) out[key] = v;
  }
  return out;
}

/** A partial update from the API, or the reason it is refused. */
export function readTimeoutSettings(body: unknown): { ok: Partial<TimeoutSettings> } | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "send a JSON object of settings" };
  }
  const out: Partial<TimeoutSettings> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!Object.hasOwn(defaultTimeoutSettings, key)) return { error: `no such setting: ${key}` };
    if (typeof value !== "number" || !Number.isInteger(value) || value < bounds.min || value > bounds.max) {
      return { error: `${key} must be a whole number of minutes from ${bounds.min} to ${bounds.max}` };
    }
    out[key as keyof TimeoutSettings] = value;
  }
  return { ok: out };
}
