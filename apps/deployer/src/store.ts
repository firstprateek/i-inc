// The deployer's own state (in the releases folder) and the record it shares with the daemon,
// ~/.i-inc/deploys.jsonl. Nothing else under ~/.i-inc is touched.
import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DeployRecord, Lock, State, Store } from "./types.ts";

export const emptyState = (): State => ({
  bad: {},
  ciFailed: [],
  attempts: {},
  ready: {},
  history: [],
  inFlight: null,
});

export class FileStore implements Store {
  constructor(
    /** <releases>/state.json */
    private readonly statePath: string,
    /** ~/.i-inc/deploys.jsonl */
    private readonly deploysPath: string,
  ) {}

  state(): State {
    try {
      const raw = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<State>;
      return { ...emptyState(), ...raw };
    } catch {
      return emptyState();
    }
  }

  save(state: State): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, this.statePath);
  }

  append(record: DeployRecord): void {
    mkdirSync(dirname(this.deploysPath), { recursive: true });
    appendFileSync(this.deploysPath, `${JSON.stringify(record)}\n`);
  }
}

/**
 * A lock file holding the owner's pid. A lock whose process is gone is stale and is taken over, so a
 * crash never blocks the next start.
 */
export class FileLock implements Lock {
  private held = false;

  constructor(
    private readonly path: string,
    private readonly pid = process.pid,
    private readonly alive: (pid: number) => boolean = isAlive,
  ) {}

  acquire(): boolean {
    mkdirSync(dirname(this.path), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(this.path, `${this.pid}\n`, { flag: "wx" });
        this.held = true;
        return true;
      } catch {
        const owner = Number.parseInt(this.read(), 10);
        if (owner === this.pid) {
          this.held = true;
          return true;
        }
        if (Number.isInteger(owner) && owner > 0 && this.alive(owner)) return false;
        // Stale (or unreadable): remove it and try again once.
        try {
          unlinkSync(this.path);
        } catch {}
      }
    }
    return false;
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    try {
      if (Number.parseInt(this.read(), 10) === this.pid) unlinkSync(this.path);
    } catch {}
  }

  private read(): string {
    try {
      return readFileSync(this.path, "utf8");
    } catch {
      return "";
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
