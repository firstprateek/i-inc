// Unsent chat drafts, kept in localStorage per employee so a reload doesn't lose them. A sent draft stays
// stored until the daemon takes it, so a failed send comes back after a reload. Signing out
// or a 401 (showLogin) forgets them all, since a draft to a PA can hold home data, and nothing is stored
// again until the owner signs back in, so another open tab can't write its drafts back.

// A draft longer than this (in UTF-16 characters) stays in memory only, so one paste can't fill storage.
export const DRAFT_CAP = 20 * 1024;
const prefix = "inc.chat.draft.";
/** The name a draft has in localStorage: what a `storage` event from another tab says changed. */
export const draftKey = (name: string) => prefix + name;
const onClear = new Set<() => void>();
/** Set by a sign-out or a 401 in any tab, and removed by signing in. */
export const SIGNED_OUT = "inc.signed-out";

function signedOut(): boolean {
  try {
    return localStorage.getItem(SIGNED_OUT) !== null;
  } catch {
    return false;
  }
}

export const draftMemo = {
  get(employeeId: string): string | null {
    try {
      return localStorage.getItem(prefix + employeeId);
    } catch {
      return null;
    }
  },
  set(employeeId: string, text: string, cap = DRAFT_CAP): void {
    const key = prefix + employeeId;
    try {
      // Blank or oversized: drop the key, so an older draft can't come back after a reload.
      if (text.trim() && text.length <= cap && !signedOut()) localStorage.setItem(key, text);
      else localStorage.removeItem(key);
    } catch {
      // Quota, private mode or blocked storage: drafts last only for this page. Don't leave a stale one.
      try {
        localStorage.removeItem(key);
      } catch {
        // Storage is blocked outright.
      }
    }
  },
  /** Forget the stored draft if it's still the text that was just sent, and keep a newer one. */
  clearIfSent(employeeId: string, sent: string): void {
    const stored = draftMemo.get(employeeId);
    if (stored !== null && stored.trim() === sent.trim()) draftMemo.set(employeeId, "");
  },
  /** Whoever keeps a draft in memory forgets it with the rest. */
  onClearAll(fn: () => void): void {
    onClear.add(fn);
  },
  clearAll(): void {
    for (const fn of onClear) fn();
    try {
      localStorage.setItem(SIGNED_OUT, "1");
    } catch {
      // Storage is blocked, so there is nothing to keep out either.
    }
    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(prefix)) keys.push(key);
      }
      for (const key of keys) localStorage.removeItem(key);
    } catch {
      // Nothing stored, or storage is blocked.
    }
  },
  /** The owner signed in: drafts may be stored again. */
  signedIn(): void {
    try {
      localStorage.removeItem(SIGNED_OUT);
    } catch {
      // Storage is blocked.
    }
  },
};
