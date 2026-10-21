// The company's configuration, kept in SQLite: employees, engines, accounts, hosts, contacts,
// projects and settings, plus each account's latest usage. It is the Company port the core reads.
import {
  type AccountCost,
  type Company,
  type Duty,
  defaultProjectPolicy,
  type Employee,
  type Engine,
  type HostCost,
  type Id,
  type ProjectPolicy,
  type ProjectRelease,
  pickTint,
  type Ticket,
} from "@i-inc/core";
import type { UsageReport } from "./acp.ts";
import type { Db } from "./db.ts";
import type { NotifySettings, PushSubscription } from "./push.ts";

/** A repo employees work on, and the checks its tickets must pass (spec §6, stages 4 and 8). */
export interface Project extends Partial<ProjectPolicy> {
  /** The name tickets use, such as "Duet". */
  id: Id;
  /** "owner/name" on GitHub. */
  repo: string;
  /** The check recipe, in order: for Duet, install, lint, typecheck and test. */
  checks: string[];
  /** Default branch for PR base and checkout (e.g. "main" or "master"). */
  defaultBranch?: string;
  /** GitHub's numeric id of the repo, so a rename or transfer doesn't make it look like another repo. */
  repoId?: number;
}

/**
 * A team shares one sandbox: one walled machine its members all work in, signed in once to each
 * subscription (decided 2026-10-17). Its id names the machine: inc-<id>.
 */
export interface Team {
  id: Id;
  name: string;
  members: Id[];
  /** The sandbox's size. Default: 6 CPUs and 12G. */
  sandbox?: { cpus: number; memory: string };
}

/** Where an employee works when no team claims it. */
export const defaultTeam: Team = { id: "company", name: "Company", members: [] };

export interface Settings {
  /** The owner's offset from UTC, for working hours. */
  utcOffsetMinutes: number;
  pricePerKWh: number;
  currency: string;
  /** Retention and cleanup settings the owner changed (T52); the rest keep their defaults. */
  storage?: Partial<StorageSettings>;
  /** What the owner chose to be notified about (T65); the rest keep their defaults. */
  notify?: Partial<NotifySettings>;
}

const defaultSettings: Settings = { utcOffsetMinutes: 0, pricePerKWh: 0, currency: "USD" };

import type { StorageSettings } from "./storage-settings.ts";
import type { AccountRateLimit } from "./view-types.ts";

export type { AccountRateLimit };

export type RegistryKind =
  | "employee"
  | "engine"
  | "account"
  | "host"
  | "contact"
  | "project"
  | "team"
  | "usage"
  | "settings"
  | "rate_limit"
  | "release"
  | "push_sub";

type Kind = RegistryKind;

export class Registry implements Company {
  onChange?: (kind: RegistryKind) => void;

  constructor(private readonly db: Db) {}

  private put(kind: Kind, id: Id, body: unknown): void {
    this.db.run(
      "INSERT INTO company (kind, id, body) VALUES (?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET body = excluded.body",
      kind,
      id,
      JSON.stringify(body),
    );
    this.onChange?.(kind);
  }

  private list<T>(kind: Kind): T[] {
    return this.db
      .all<{ body: string }>("SELECT body FROM company WHERE kind = ? ORDER BY rowid", kind)
      .map((r) => JSON.parse(r.body) as T);
  }

  private get<T>(kind: Kind, id: Id): T | undefined {
    const [row] = this.db.all<{ body: string }>(
      "SELECT body FROM company WHERE kind = ? AND id = ?",
      kind,
      id,
    );
    return row ? (JSON.parse(row.body) as T) : undefined;
  }

  /** Hires someone, or updates them. A new hire gets the least-worn avatar tint; an update keeps theirs. */
  hire(e: Employee): void {
    const current = this.get<Employee>("employee", e.id);
    const others = this.employees().filter((x) => x.id !== e.id);
    const tint = e.tint ?? current?.tint ?? pickTint(others);
    this.put("employee", e.id, { ...e, tint });
  }
  addEngine(e: Engine): void {
    if (e.harness === "codex" && e.local) {
      throw new Error("Codex is a cloud harness and cannot be marked local");
    }
    this.put("engine", e.id, e);
  }
  addAccount(a: AccountCost): void {
    this.put("account", a.id, a);
  }
  addHost(h: HostCost): void {
    this.put("host", h.id, h);
  }
  addContact(address: string): void {
    this.put("contact", address.toLowerCase(), address);
  }
  addProject(p: Project): void {
    this.put("project", p.id, p);
  }
  private remove(kind: Kind, id: Id): boolean {
    const existing = this.get(kind, id);
    if (!existing) return false;
    this.db.run("DELETE FROM company WHERE kind = ? AND id = ?", kind, id);
    this.onChange?.(kind);
    return true;
  }

  removeEngine(id: Id): boolean {
    return this.remove("engine", id);
  }
  removeAccount(id: Id): boolean {
    return this.remove("account", id);
  }
  removeProject(id: Id): boolean {
    return this.remove("project", id);
  }
  removeTeam(id: Id): boolean {
    return this.remove("team", id);
  }

  addTeam(t: Team): void {
    this.put("team", t.id, t);
  }
  /** Saves team membership with the same one-team-at-a-time rule as the setup API. */
  setTeam(t: Team): void {
    this.db.transaction(() => this.setTeamInTransaction(t));
  }
  /** Saves an employee and assigns them in one transaction, without a Company fallback. */
  saveEmployeeInTeam(e: Employee, teamId: Id): void {
    this.db.transaction(() => {
      this.hire(e);
      const team = this.teams().find((candidate) => candidate.id === teamId);
      if (!team) throw new Error(`no team ${teamId}`);
      this.setTeamInTransaction({ ...team, members: [...team.members.filter((id) => id !== e.id), e.id] });
    });
  }
  private setTeamInTransaction(team: Team): void {
    const members = new Set(team.members);
    for (const other of this.teams()) {
      if (other.id !== team.id && other.members.some((member) => members.has(member))) {
        this.addTeam({ ...other, members: other.members.filter((member) => !members.has(member)) });
      }
    }
    this.addTeam(team);
  }
  teams(): Team[] {
    return this.list<Team>("team");
  }
  /** The team whose sandbox an employee works in. */
  teamOf(employeeId: Id): Team {
    return this.teams().find((t) => t.members.includes(employeeId)) ?? defaultTeam;
  }
  /** The other employees who work in the same sandbox as this one. */
  machineMates(employeeId: Id): Id[] {
    const team = this.teamOf(employeeId);
    const teams = this.teams();
    const named = teams.some((t) => t.id === team.id);
    const claimed = new Set(teams.flatMap((t) => t.members));
    return this.employees()
      .filter((e) => e.id !== employeeId && (named ? team.members.includes(e.id) : !claimed.has(e.id)))
      .map((e) => e.id);
  }
  /** How a project's work reaches main: its own settings over the defaults (direct). */
  projectPolicy(project: string): ProjectPolicy {
    const p = this.project(project);
    return {
      mode: p?.mode ?? defaultProjectPolicy.mode,
      protectedPaths: p?.protectedPaths ?? defaultProjectPolicy.protectedPaths,
      followUpsPerDay: p?.followUpsPerDay ?? defaultProjectPolicy.followUpsPerDay,
      autoRelease: p?.autoRelease ?? defaultProjectPolicy.autoRelease ?? false,
    };
  }
  /** The latest report on an account's limits, as its harness sent it (Claude's, for now). */
  recordUsage(u: UsageReport): void {
    this.put("usage", u.accountId, u);
  }
  setAccountRateLimit(accountId: Id, limit: AccountRateLimit): void {
    const existing = this.accountRateLimits()[accountId];
    const now = limit.updatedAt ?? Date.now();
    if (
      existing?.status === "rejected" &&
      existing.resetsAt &&
      existing.resetsAt > now &&
      limit.status !== "rejected"
    ) {
      // Do not downgrade an unexpired rejected status
      return;
    }
    this.put("rate_limit", accountId, {
      ...existing,
      ...limit,
    });
  }
  accountRateLimits(): Record<Id, AccountRateLimit> {
    const rows = this.db.all<{ id: string; body: string }>(
      "SELECT id, body FROM company WHERE kind = ?",
      "rate_limit",
    );
    const out: Record<Id, AccountRateLimit> = {};
    for (const r of rows) {
      out[r.id] = JSON.parse(r.body) as AccountRateLimit;
    }
    return out;
  }
  setSettings(s: Partial<Settings>): void {
    this.put("settings", "company", { ...this.settings(), ...s });
  }

  /** Everyone, in hiring order. Anyone hired before tints existed gets one here, the same each time. */
  employees(): Employee[] {
    const all: Employee[] = [];
    for (const e of this.list<Employee>("employee"))
      all.push(e.tint === undefined ? { ...e, tint: pickTint(all) } : e);
    return all;
  }
  engines(): Engine[] {
    return this.list<Engine>("engine");
  }
  accounts(): AccountCost[] {
    return this.list<AccountCost>("account");
  }
  hosts(): HostCost[] {
    return this.list<HostCost>("host");
  }
  projects(): Project[] {
    return this.list<Project>("project");
  }
  project(id: Id): Project | undefined {
    return this.get<Project>("project", id);
  }
  releases(): ProjectRelease[] {
    return this.list<ProjectRelease>("release");
  }
  recordRelease(r: ProjectRelease): void {
    this.put("release", `${r.project}:${r.tag}`, r);
  }
  usage(): UsageReport[] {
    return this.list<UsageReport>("usage");
  }
  settings(): Settings {
    return { ...defaultSettings, ...this.get<Settings>("settings", "company") };
  }

  employee(id: Id): Employee {
    const e = this.employees().find((x) => x.id === id);
    if (!e) throw new Error(`no employee ${id}`);
    return e;
  }
  engine(id: Id): Engine {
    const e = this.get<Engine>("engine", id);
    if (!e) throw new Error(`no engine ${id}`);
    return e;
  }
  pickEmployee(duty: Duty, ticket: Ticket, exclude: Id[]): Employee | undefined {
    return this.employees().find(
      (e) =>
        e.duties.includes(duty) &&
        !exclude.includes(e.id) &&
        (!e.projects || e.projects.includes(ticket.project)),
    );
  }
  isContact(address: string): boolean {
    return this.get("contact", address.toLowerCase()) !== undefined;
  }

  addPushSubscription(sub: PushSubscription): void {
    this.put("push_sub", sub.endpoint, sub);
  }
  removePushSubscription(endpoint: string): void {
    this.db.run("DELETE FROM company WHERE kind = ? AND id = ?", "push_sub", endpoint);
    this.onChange?.("push_sub");
  }
  pushSubscriptions(): PushSubscription[] {
    return this.list<PushSubscription>("push_sub");
  }
}
