// Wires the daemon together over one database. main.ts calls this on the host; tests call it with
// an in-memory database and the core's fakes.
import type { Agent, Clock, Harness, MachineProvider } from "@i-inc/core";
import { type ApiOptions, createApi } from "./api.ts";
import { Daemon, type DaemonDeps } from "./daemon.ts";
import { openDb } from "./db.ts";
import { Registry } from "./registry.ts";
import { migrate } from "./schema.ts";
import { SqliteEventStore } from "./store.ts";
import { Tickets } from "./tickets.ts";

export interface AppOptions extends ApiOptions {
  dbPath: string;
  clock: Clock;
  machines: MachineProvider;
  agent: Agent;
  harness: Harness;
  log?: (msg: string) => void;
}

export async function createApp(o: AppOptions) {
  const db = await openDb(o.dbPath);
  migrate(db);
  const deps: DaemonDeps = {
    clock: o.clock,
    store: new SqliteEventStore(db),
    registry: new Registry(db),
    tickets: new Tickets(db),
    machines: o.machines,
    agent: o.agent,
    harness: o.harness,
    ...(o.log ? { log: o.log } : {}),
  };
  const daemon = new Daemon(deps);
  const handle = createApi(daemon, deps, o.token ? { token: o.token } : {});
  return { db, deps, daemon, handle };
}
