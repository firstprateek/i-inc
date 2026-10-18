// Scroll position per history entry, for the app shell. <main> is the one scroll container, so the
// shell keeps where each visited page was scrolled and puts it back on Back/Forward; a fresh
// navigation always starts at the top. No DOM here beyond `history`, so it is easy to test.

/** How many entries to remember; the oldest are dropped first. */
export const MAX_REMEMBERED = 50;

export class ScrollMemory {
  private tops = new Map<string, number>();

  save(key: string, top: number): void {
    // Re-insert, so the Map's order is least- to most-recently saved.
    this.tops.delete(key);
    this.tops.set(key, Math.max(0, Math.round(top)));
    while (this.tops.size > MAX_REMEMBERED) {
      const oldest = this.tops.keys().next().value;
      if (oldest === undefined) break;
      this.tops.delete(oldest);
    }
  }

  /** Where this entry was last scrolled to, 0 if it was never left. */
  get(key: string): number {
    return this.tops.get(key) ?? 0;
  }

  has(key: string): boolean {
    return this.tops.has(key);
  }

  get size(): number {
    return this.tops.size;
  }
}

const STATE_KEY = "incEntry";
let counter = 0;

/** The key this history entry was given when the shell first saw it, or null for a fresh one. */
export function entryKey(state: unknown = history.state): string | null {
  if (state && typeof state === "object" && STATE_KEY in state) {
    const k = (state as Record<string, unknown>)[STATE_KEY];
    return typeof k === "string" ? k : null;
  }
  return null;
}

/** Gives the current history entry a key (keeping any other state) and returns it. */
export function stampEntry(): string {
  const existing = entryKey();
  if (existing) return existing;
  const key = `${Date.now().toString(36)}-${(counter++).toString(36)}`;
  const prev = history.state && typeof history.state === "object" ? history.state : {};
  history.replaceState({ ...prev, [STATE_KEY]: key }, "");
  return key;
}

export interface Arrival {
  /** The key of the entry now showing. */
  key: string;
  /** Where <main> should be scrolled: the remembered place on Back/Forward, otherwise the top. */
  top: number;
  /** True when this is a history traversal to a page we have already shown. */
  revisit: boolean;
}

/**
 * Called when the hash changes. An entry that already carries our key was shown before, so this is
 * Back/Forward and gets its remembered position; a fresh entry (a link click) is stamped and starts at 0.
 */
export function arrive(memory: ScrollMemory): Arrival {
  const known = entryKey();
  if (known) return { key: known, top: memory.get(known), revisit: true };
  return { key: stampEntry(), top: 0, revisit: false };
}
