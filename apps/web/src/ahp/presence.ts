// "I am looking at this conversation" (T65): while the page is visible and focused on a conversation, tell
// the host now and every HEARTBEAT_MS, so it does not push a notification for what you can already see.
// The host forgets a report after 45 s, so a phone put in a pocket, a closed tab or a dropped connection
// goes quiet on its own; and the page says it is not looking the moment it is hidden or loses focus.
import type { AhpConnection } from "./connection.ts";

/** The host counts a report for 45 s; three beats fit in that. */
export const HEARTBEAT_MS = 15_000;

/** What the page knows about itself, as one object so tests can swap it. */
export interface PageEnv {
  /** Visible and focused: a person could be reading it. */
  looking(): boolean;
  /** Calls `fn` whenever visibility or focus may have changed; returns the way to stop. */
  onChange(fn: () => void): () => void;
}

export const browserPage: PageEnv = {
  looking: () => document.visibilityState === "visible" && document.hasFocus(),
  onChange: (fn) => {
    document.addEventListener("visibilitychange", fn);
    addEventListener("focus", fn);
    addEventListener("blur", fn);
    addEventListener("pagehide", fn);
    return () => {
      document.removeEventListener("visibilitychange", fn);
      removeEventListener("focus", fn);
      removeEventListener("blur", fn);
      removeEventListener("pagehide", fn);
    };
  },
};

/** Reports for one conversation's session until the returned function is called. */
export function startPresence(
  conn: Pick<AhpConnection, "reportPresence" | "onInfo" | "info">,
  session: string,
  page: PageEnv = browserPage,
): () => void {
  let last: boolean | undefined;
  const report = () => {
    const looking = page.looking();
    last = looking;
    conn.reportPresence(session, looking);
  };
  const changed = () => {
    // Only a change is news between beats; the heartbeat repeats the good news.
    if (page.looking() !== last) report();
  };
  const stopPage = page.onChange(changed);
  const beat = setInterval(() => {
    if (page.looking()) report();
  }, HEARTBEAT_MS);
  // A reconnect is a fresh connection to the host: it knows nothing yet.
  let wasOpen = conn.info.status === "open";
  const stopInfo = conn.onInfo((i) => {
    const open = i.status === "open";
    if (open && !wasOpen) report();
    wasOpen = open;
  });
  report();
  return () => {
    clearInterval(beat);
    stopPage();
    stopInfo();
    if (last) conn.reportPresence(session, false);
  };
}
