// What makes a hire valid (spec §5, "What you set when hiring"). Pure: the daemon checks these
// before it builds the machine and the brain.
import type { Employee, Engine } from "./model.ts";

/** Roles whose work is home data: they may only have local engines (spec §7). */
export const homeRoles = ["Personal Assistant"];

export function hiringProblems(e: Employee, engines: Engine[], existing: Employee[]): string[] {
  const problems: string[] = [];
  const byId = new Map(engines.map((x) => [x.id, x]));
  if (!e.name.trim()) problems.push("an employee needs a name");
  if (!/^[a-z0-9-]{1,32}$/.test(e.id))
    problems.push("the id must be 1-32 lowercase letters, digits or dashes");
  if (existing.some((x) => x.id === e.id)) problems.push(`someone called ${e.id} already works here`);
  if (e.duties.length === 0) problems.push("an employee needs at least one duty");

  const chosen = [e.engines.default, ...Object.values(e.engines.perDuty ?? {}), ...e.engines.fallbacks];
  for (const id of chosen) if (!byId.has(id)) problems.push(`there is no engine ${id}`);

  if (homeRoles.includes(e.role)) {
    const cloud = chosen.filter((id) => byId.get(id)?.local === false);
    if (cloud.length) {
      problems.push(
        `a ${e.role} works on home data, so it may only use local engines, not ${cloud.join(", ")}`,
      );
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
