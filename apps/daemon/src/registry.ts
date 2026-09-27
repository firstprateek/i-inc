// The company's configuration, kept in SQLite: employees, engines, accounts, hosts, contacts and
// settings. It is the Company port the core reads.
import {
  type AccountCost,
  type Company,
  type Duty,
  type Employee,
  type Engine,
  type HostCost,
  type Id,
  pickTint,
  type Ticket,
} from "@i-inc/core";
import type { Db } from "./db.ts";

export interface Settings {
  /** The owner's offset from UTC, for working hours. */
  utcOffsetMinutes: number;
  pricePerKWh: number;
  currency: string;
}

const defaultSettings: Settings = { utcOffsetMinutes: 0, pricePerKWh: 0, currency: "USD" };

type Kind = "employee" | "engine" | "account" | "host" | "contact" | "settings";

export class Registry implements Company {
  constructor(private readonly db: Db) {}

  private put(kind: Kind, id: Id, body: unknown): void {
    this.db.run(
      "INSERT INTO company (kind, id, body) VALUES (?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET body = excluded.body",
      kind,
      id,
      JSON.stringify(body),
    );
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
}
