// Unsent chat drafts, kept in localStorage per employee so a reload doesn't lose them. Signing out
// or a 401 (showLogin) forgets them all, since a draft to a PA can hold home data.
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
    try {
      if (text.trim()) localStorage.setItem(prefix + employeeId, text);
      else localStorage.removeItem(prefix + employeeId);
    } catch {
      // Private mode or blocked storage: drafts last only for this page.
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
