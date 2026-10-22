// What the New conversation screen remembers between visits, in this browser only: who and what the owner
// last started a conversation with, the mode each employee last ran in, and the modes an agent has offered (so
// the mode picker can show the real list before a session is open). Every read and write survives a browser
// that refuses storage.
import type { Choice, Picker } from "./model.ts";

/** The per-employee default mode, remembered when the owner changes it. */
export const modeKey = (employeeId: string) => `i-inc-conv-mode:${employeeId}`;
/** The modes an employee's agent offered the last time a session was open, as `[value, label][]`. */
export const modesKey = (employeeId: string) => `i-inc-conv-modes:${employeeId}`;
/** The employee and project of the last conversation started. */
export const LAST_KEY = "i-inc-conv-last";

/** The mode every conversation starts in unless the owner chose another: the agent's bypass-permissions mode. */
export const DEFAULT_MODE_LABEL = "Bypass permissions";

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {}
};

export interface LastUsed {
  employee: string;
  project: string;
}

export function lastUsed(): LastUsed {
  try {
    const v = JSON.parse(read(LAST_KEY) ?? "null") as Partial<LastUsed> | null;
    return {
      employee: typeof v?.employee === "string" ? v.employee : "",
      project: typeof v?.project === "string" ? v.project : "",
    };
  } catch {
    return { employee: "", project: "" };
  }
}

export const rememberLastUsed = (v: LastUsed): void => write(LAST_KEY, JSON.stringify(v));

export const rememberedMode = (employeeId: string): string => read(modeKey(employeeId)) ?? "";
export const rememberMode = (employeeId: string, value: string): void => write(modeKey(employeeId), value);

/** Keeps the modes an agent offers, so a later draft can list them before its session opens. */
export function rememberModes(employeeId: string, choices: readonly Choice[]): void {
  if (choices.length) write(modesKey(employeeId), JSON.stringify(choices.map((c) => [c.value, c.label])));
}

function knownChoices(employeeId: string): Choice[] {
  try {
    const raw = JSON.parse(read(modesKey(employeeId)) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (r): r is [string, string] =>
          Array.isArray(r) && typeof r[0] === "string" && typeof r[1] === "string",
      )
      .map(([value, label]) => ({ value, label }));
  } catch {
    return [];
  }
}

/** "bypassPermissions" and "acceptEdits" as words, for a mode the agent has not named yet. */
export function modeWords(value: string): string {
  const words = value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

/**
 * The mode picker of a conversation not started yet. The agent's own list is known only once its session is
 * open, so until then the picker shows the mode the conversation will start in (the one this employee last
 * used, else bypass permissions) with the modes the agent offered last time; `value` "" is the default.
 */
export function draftModePicker(employeeId: string, chosen: string): Picker {
  const known = knownChoices(employeeId);
  // Nothing chosen or remembered: the agent's bypass mode, when its list is known; else the default stands in.
  const remembered =
    chosen ||
    rememberedMode(employeeId) ||
    (known.find((c) => /bypass|full[- ]access|yolo/i.test(`${c.value} ${c.label}`))?.value ?? "");
  const label = (value: string) =>
    known.find((c) => c.value === value)?.label ?? (value ? modeWords(value) : DEFAULT_MODE_LABEL);
  const choices: Choice[] = known.length ? known : [{ value: remembered, label: label(remembered) }];
  if (remembered && !choices.some((c) => c.value === remembered))
    choices.unshift({ value: remembered, label: label(remembered) });
  return { key: "mode", title: "Mode", value: remembered, choices };
}
