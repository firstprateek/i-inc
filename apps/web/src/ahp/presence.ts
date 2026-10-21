// "I am looking at this conversation" (T65): while the page is visible and focused on a conversation, tell
// the host now and every HEARTBEAT_MS, so it does not push a notification for what you can already see.
// The host forgets a report after 45 s, so a phone put in a pocket, a closed tab or a dropped connection
// goes quiet on its own; and the page says it is not looking the moment it is hidden or loses focus. A page
// that is visible and focused but untouched for IDLE_MS (a laptop left open on a conversation) is not
// looking either: it stops reporting, and the next touch starts it again.
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

/** No touch, key or scroll for this long and nobody is reading. */
export const IDLE_MS = 120_000;

let lastInput = Date.now();
const INPUTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "scroll"] as const;

export const browserPage: PageEnv = {
  looking: () =>
    document.visibilityState === "visible" && document.hasFocus() && Date.now() - lastInput < IDLE_MS,
  onChange: (fn) => {
    // Opening a conversation is a touch.
    lastInput = Date.now();
    const touched = () => {
      lastInput = Date.now();
      fn();
    };
    document.addEventListener("visibilitychange", fn);
    addEventListener("focus", fn);
    addEventListener("blur", fn);
    addEventListener("pagehide", fn);
    for (const type of INPUTS) addEventListener(type, touched, { capture: true, passive: true });
    return () => {
      document.removeEventListener("visibilitychange", fn);
      removeEventListener("focus", fn);
      removeEventListener("blur", fn);
      removeEventListener("pagehide", fn);
      for (const type of INPUTS) removeEventListener(type, touched, { capture: true });
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
    // Good news is repeated; a page that has gone idle says so once, then stays quiet.
    if (page.looking()) report();
    else changed();
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
