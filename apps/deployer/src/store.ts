// The deployer's own state (in the releases folder) and the record it shares with the daemon,
// ~/.i-inc/deploys.jsonl. Nothing else under ~/.i-inc is touched.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DeployRecord, Lock, State, Store } from "./types.ts";

export const emptyState = (): State => ({
  bad: {},
  ciFailed: [],
  attempts: {},
  ready: {},
  retry: {},
  ancestrySkipped: [],
  allowRewrite: [],
  recorded: [],
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
 * A lock file holding the owner's pid and the time that process started. A lock whose process is gone,
 * or whose pid now belongs to a different process (after a reboot or power loss pids are reused), is
 * stale and is taken over, so a crash never blocks the next start.
 */
export class FileLock implements Lock {
  private held = false;

  constructor(
    private readonly path: string,
    private readonly pid = process.pid,
    private readonly alive: (pid: number) => boolean = isAlive,
    private readonly startOf: (pid: number) => string | null = processStart,
  ) {}

  acquire(): boolean {
    mkdirSync(dirname(this.path), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(this.path, this.mine(), { flag: "wx" });
        this.held = true;
        return true;
      } catch {
        const owner = this.read();
        if (owner.pid === this.pid && owner.start === (this.startOf(this.pid) ?? "")) {
          this.held = true;
          return true;
        }
        if (this.live(owner)) return false;
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
      if (this.read().pid === this.pid) unlinkSync(this.path);
    } catch {}
  }

  private mine(): string {
    return `${JSON.stringify({ pid: this.pid, start: this.startOf(this.pid) ?? "" })}\n`;
  }

  /** Whether the process named in a lock file is still the one that took the lock. */
  private live(owner: { pid: number; start: string }): boolean {
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 || !this.alive(owner.pid)) return false;
    // A different start time means the pid was reused by another process.
    if (owner.start && this.startOf(owner.pid) !== owner.start) return false;
    return true;
  }

  private read(): { pid: number; start: string } {
    let text = "";
    try {
      text = readFileSync(this.path, "utf8").trim();
    } catch {
      return { pid: Number.NaN, start: "" };
    }
    try {
      const j = JSON.parse(text) as { pid?: unknown; start?: unknown };
      if (typeof j.pid === "number") return { pid: j.pid, start: typeof j.start === "string" ? j.start : "" };
    } catch {}
    return { pid: Number.parseInt(text, 10), start: "" }; // a lock from before start times
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

/** When a process started, as `ps` prints it (the same on macOS and Linux), or null if it is gone. */
export function processStart(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}
