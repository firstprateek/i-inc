// What makes a hire valid (spec §5, "What you set when hiring"). Pure: the daemon checks these
// before it builds the machine and the brain.
import { isLocalEngine } from "./engines.ts";
import type { Employee, Engine } from "./model.ts";

/** How many identity tints avatars can wear. The colours themselves belong to the web app. */
export const tintCount = 7;

/** The tint for a new hire: the one fewest employees wear, lowest first, so tints repeat only past seven. */
export function pickTint(existing: Employee[]): number {
  const worn = new Array<number>(tintCount).fill(0);
  for (const e of existing)
    if (e.tint !== undefined) worn[e.tint % tintCount] = (worn[e.tint % tintCount] ?? 0) + 1;
  return worn.indexOf(Math.min(...worn));
}

/** Roles whose work is home data: they may only have local engines (spec §7). */
export const homeRoles = ["Personal Assistant"];

/**
 * The size of a home team's sandbox (a PA works alone, on a small local model's errands): smaller than the
 * default 6 CPUs and 12G. Adjustable like any team's, with `PUT /api/teams/:id`.
 */
export const homeSandbox = { cpus: 2, memory: "4G" } as const;

/** Whether this employee works on home data (a PA). */
export const isHomeEmployee = (e: Pick<Employee, "role">): boolean => homeRoles.includes(e.role);

/**
 * A home-data employee needs a sandbox to itself: every employee of a team shares one machine and one
 * Unix user, so anything of the PA's that reaches that machine (its brain, its files) reaches them
 * all, with the internet open. `members` is everyone who would work in the team's sandbox.
 */
export function sharedHomeProblems(teamName: string, members: Employee[]): string[] {
  const home = members.filter(isHomeEmployee);
  if (home.length === 0 || members.length <= 1) return [];
  const names = (list: Employee[]) => list.map((m) => m.name).join(", ");
  return [
    `${teamName} would put ${names(members)} in one sandbox, and ${names(home)} works on home data, which needs a sandbox of its own`,
  ];
}

export function hiringProblems(e: Employee, engines: Engine[], existing: Employee[]): string[] {
  const problems: string[] = [];
  const byId = new Map(engines.map((x) => [x.id, x]));
  if (!e.name.trim()) problems.push("an employee needs a name");
  if (!e.role?.trim()) problems.push("an employee needs a role");
  if (!/^[a-z0-9-]{1,32}$/.test(e.id))
    problems.push("the id must be 1-32 lowercase letters, digits or dashes");
  if (existing.some((x) => x.id === e.id)) problems.push(`someone called ${e.id} already works here`);
  if (e.duties.length === 0) problems.push("an employee needs at least one duty");
  if (e.effort && !["low", "medium", "high"].includes(e.effort))
    problems.push("effort must be low, medium or high");

  const chosen = [e.engines.default, ...Object.values(e.engines.perDuty ?? {}), ...e.engines.fallbacks];
  for (const id of chosen) if (!byId.has(id)) problems.push(`there is no engine ${id}`);

  if (homeRoles.includes(e.role)) {
    // Its sandbox has no internet (the walls, spec §7), so every duty, fallbacks included, needs a
    // local engine: the model runs on the host and the sandbox reaches it through the Ollama relay.
    if (!engines.some(isLocalEngine)) {
      problems.push(
        `a ${e.role} works on home data and its sandbox has no internet, so it needs a local engine (OpenCode on Ollama), and none is set up yet: add one in Setup, then hire the ${e.role}`,
      );
    } else {
      const cloud = [...new Set(chosen)].filter((id) => {
        const engine = byId.get(id);
        return engine !== undefined && !isLocalEngine(engine);
      });
      if (cloud.length) {
        problems.push(
          `a ${e.role} works on home data and its sandbox has no internet, so it may only use local engines, not ${cloud.join(", ")}`,
        );
      }
    }
  }
  if (e.workingHours) {
    const { from, to } = e.workingHours;
    if (![from, to].every((h) => Number.isInteger(h) && h >= 0 && h <= 23)) {
      problems.push("working hours are whole hours from 0 to 23");
    }
  }
  return problems;
}
