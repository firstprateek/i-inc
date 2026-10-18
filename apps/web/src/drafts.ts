// Unsent chat drafts, kept in localStorage per employee so a reload doesn't lose them. Signing out
// or a 401 (showLogin) forgets them all, since a draft to a PA can hold home data.

// A draft longer than this (in UTF-16 characters) stays in memory only, so one paste can't fill storage.
export const DRAFT_CAP = 20 * 1024;
const prefix = "inc.chat.draft.";

export const draftMemo = {
  get(employeeId: string): string | null {
    try {
      return localStorage.getItem(prefix + employeeId);
    } catch {
      return null;
    }
  },
  set(employeeId: string, text: string): void {
    const key = prefix + employeeId;
    try {
      // Blank or oversized: drop the key, so an older draft can't come back after a reload.
      if (text.trim() && text.length <= DRAFT_CAP) localStorage.setItem(key, text);
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
  clearAll(): void {
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
};
