import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileLock, FileStore } from "../src/store.ts";
import type { DeployRecord } from "../src/types.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "i-inc-deployer-store-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("deploys.jsonl", () => {
  it("appends one JSON line per attempt with exactly the documented fields", () => {
    const store = new FileStore(join(dir, "releases/state.json"), join(dir, "home/deploys.jsonl"));
    const a: DeployRecord = {
      at: 1,
      sha: "a".repeat(40),
      from: "b".repeat(40),
      outcome: "deployed",
      reason: "",
      durationMs: 5,
    };
    const b: DeployRecord = {
      at: 2,
      sha: "c".repeat(40),
      from: null,
      outcome: "rolled-back",
      reason: "health",
      durationMs: 9,
    };
    store.append(a);
    store.append(b);
    const lines = readFileSync(join(dir, "home/deploys.jsonl"), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "")).toEqual(a);
    expect(Object.keys(JSON.parse(lines[1] ?? "")).sort()).toEqual([
      "at",
      "durationMs",
      "from",
      "outcome",
      "reason",
      "sha",
    ]);
    // Nothing else is written next to it.
    expect(existsSync(join(dir, "home/state.json"))).toBe(false);
  });
});

describe("state file", () => {
  it("round-trips, and a missing or corrupt file is an empty state", () => {
    const path = join(dir, "state.json");
    const store = new FileStore(path, join(dir, "d.jsonl"));
    expect(store.state().bad).toEqual({});
    const s = store.state();
    s.bad.abc = { at: 1, reason: "x" };
    s.inFlight = { sha: "s", from: null, phase: "switch", startedAt: 3 };
    store.save(s);
    expect(new FileStore(path, join(dir, "d.jsonl")).state()).toEqual(s);
    writeFileSync(path, "{not json");
    expect(store.state().inFlight).toBeNull();
  });
});

describe("lock", () => {
  it("lets one instance in", () => {
    const path = join(dir, "deployer.lock");
    const a = new FileLock(path, 111, () => true);
    const b = new FileLock(path, 222, () => true);
    expect(a.acquire()).toBe(true);
    expect(b.acquire()).toBe(false);
    a.release();
    expect(existsSync(path)).toBe(false);
    expect(b.acquire()).toBe(true);
  });

  it("takes over a lock whose owner is gone", () => {
    const path = join(dir, "deployer.lock");
    writeFileSync(path, "999999\n");
    const b = new FileLock(path, 222, (pid) => pid !== 999999);
    expect(b.acquire()).toBe(true);
    expect(readFileSync(path, "utf8").trim()).toBe("222");
  });

  it("takes over an unreadable lock, and release never removes someone else's", () => {
    const path = join(dir, "deployer.lock");
    writeFileSync(path, "garbage");
    const a = new FileLock(path, 1, () => true);
    expect(a.acquire()).toBe(true);
    writeFileSync(path, "2\n");
    a.release();
    expect(readFileSync(path, "utf8").trim()).toBe("2");
  });
});
