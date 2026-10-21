// Retention and cleanup settings (T52, contract C23). Every bound the daemon puts on growth is a
// number here, with a default, so the owner can see it (GET /api/storage) and change it
// (PUT /api/storage/settings). Saved in the registry's settings, next to the other company settings.

export interface StorageSettings {
  /** Days after a ticket closes (or fails) before its sandbox copies are removed. 0 turns cleanup off. */
  sandboxCleanupDays: number;
  /**
   * A closed ticket's copy that holds unpushed or uncommitted work waits this long before it goes.
   * It must be more than sandboxCleanupDays (when that is on), or it would not wait at all.
   */
  unpushedKeepDays: number;
  /** Per-machine cap, in GB, for ~/.cache, ~/.npm's cache and the pnpm store. */
  cacheCapGb: number;
  /** Whether cleanup prunes Docker's stopped containers, dangling images and old build cache in a machine. */
  dockerPrune: boolean;
  /** Days after a ticket closes before its session transcripts are compacted. 0 turns it off. */
  transcriptCompactDays: number;
  /** Transcript items kept per session when a closed ticket's transcripts are compacted. */
  transcriptKeepItems: number;
  /** Days before the daemon's own database backups (i-inc.db.bak-*) are deleted. 0 turns it off. */
  backupMaxAgeDays: number;
  /** A log file over this many MB is rotated. */
  logMaxMb: number;
  /** Rotated log files kept per log. */
  logKeep: number;
  /** VACUUM the database when this share of its pages (percent) is free and it is idle. */
  vacuumFreePct: number;
  /** Push a warning when a machine's disk is this full (percent). */
  diskWarnPct: number;
}

export const defaultStorageSettings: StorageSettings = {
  sandboxCleanupDays: 3,
  unpushedKeepDays: 30,
  cacheCapGb: 2,
  dockerPrune: true,
  transcriptCompactDays: 30,
  transcriptKeepItems: 50,
  backupMaxAgeDays: 30,
  logMaxMb: 20,
  logKeep: 5,
  vacuumFreePct: 20,
  diskWarnPct: 80,
};

type Bounds = { min: number; max: number };

const bounds: Record<Exclude<keyof StorageSettings, "dockerPrune">, Bounds> = {
  sandboxCleanupDays: { min: 0, max: 365 },
  unpushedKeepDays: { min: 1, max: 365 },
  cacheCapGb: { min: 1, max: 500 },
  transcriptCompactDays: { min: 0, max: 3650 },
  transcriptKeepItems: { min: 10, max: 500 },
  backupMaxAgeDays: { min: 0, max: 3650 },
  logMaxMb: { min: 1, max: 1024 },
  logKeep: { min: 1, max: 50 },
  vacuumFreePct: { min: 5, max: 90 },
  diskWarnPct: { min: 50, max: 99 },
};

/** The settings as the owner has them: the defaults with the saved values over them. */
export function storageSettings(saved: Partial<StorageSettings> | undefined, repair = true): StorageSettings {
  const out: StorageSettings = { ...defaultStorageSettings };
  for (const key of Object.keys(bounds) as (keyof typeof bounds)[]) {
    const v = saved && Object.hasOwn(saved, key) ? saved[key] : undefined;
    const b = bounds[key];
    if (typeof v === "number" && Number.isInteger(v) && v >= b.min && v <= b.max) out[key] = v;
  }
  if (saved && Object.hasOwn(saved, "dockerPrune") && typeof saved.dockerPrune === "boolean") {
    out.dockerPrune = saved.dockerPrune;
  }
  // A saved pair that breaks the rule (the cleanup days raised past it by hand) still waits.
  if (repair && out.sandboxCleanupDays > 0 && out.unpushedKeepDays <= out.sandboxCleanupDays) {
    out.unpushedKeepDays = Math.min(bounds.unpushedKeepDays.max, out.sandboxCleanupDays + 1);
  }
  return out;
}

/** The rule that spans two settings, or the reason the pair is refused. */
export function storageSettingsProblem(s: StorageSettings): string | null {
  if (s.sandboxCleanupDays > 0 && s.unpushedKeepDays <= s.sandboxCleanupDays) {
    return "unpushedKeepDays must be more than sandboxCleanupDays, so unpushed work waits longer than finished work";
  }
  return null;
}

/** A partial update from the API, or the reason it is refused. */
export function readStorageSettings(body: unknown): { ok: Partial<StorageSettings> } | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "send a JSON object of settings" };
  }
  const out: Partial<StorageSettings> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "dockerPrune") {
      if (typeof value !== "boolean") return { error: "dockerPrune must be true or false" };
      out.dockerPrune = value;
    } else if (Object.hasOwn(bounds, key)) {
      const b = bounds[key as keyof typeof bounds];
      if (typeof value !== "number" || !Number.isInteger(value) || value < b.min || value > b.max) {
        return { error: `${key} must be a whole number from ${b.min} to ${b.max}` };
      }
      (out as Record<string, number>)[key] = value;
    } else {
      return { error: `no such setting: ${key}` };
    }
  }
  return { ok: out };
}
