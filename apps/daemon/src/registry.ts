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
import type { PushSubscription } from "./push.ts";

/** A repo employees work on, and the checks its tickets must pass (spec §6, stages 4 and 8). */
export interface Project extends Partial<ProjectPolicy> {
  /** The name tickets use, such as "Duet". */
  id: Id;
  /** "owner/name" on GitHub. */
  repo: string;
  /** The check recipe, in order: for Duet, install, lint, typecheck and test. */
  checks: string[];
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
}

const defaultSettings: Settings = { utcOffsetMinutes: 0, pricePerKWh: 0, currency: "USD" };

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
  addTeam(t: Team): void {
    this.put("team", t.id, t);
  }
  teams(): Team[] {
    return this.list<Team>("team");
  }
  /** The team whose sandbox an employee works in. */
  teamOf(employeeId: Id): Team {
    return this.teams().find((t) => t.members.includes(employeeId)) ?? defaultTeam;
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
    this.put("rate_limit", accountId, limit);
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
