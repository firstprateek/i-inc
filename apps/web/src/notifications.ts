// Taking down notifications that are not true any more (T65). The daemon closes a conversation's notification
// with a "resolve" push when its request is answered, but it cannot to Apple's push service (a push that shows
// nothing revokes the subscription), a phone that was off misses it, and a daemon that restarted may not know.
// So the app does it itself when it is opened or comes back into view: a notification of a conversation whose
// request is no longer waiting is closed (by its tag, `conv-<id>`), and so are all of the conversation the owner
// is looking at.
import { api, type Conversation } from "./api.ts";

const TAG = /^conv-([0-9a-f]{8})$/;

/** What the app needs of the page and the worker, so tests can swap it. */
export interface NotificationEnv {
  registration(): Promise<Pick<ServiceWorkerRegistration, "getNotifications"> | undefined>;
  conversations(): Promise<Pick<Conversation, "id" | "needsYou">[]>;
}

export const browserNotificationEnv: NotificationEnv = {
  registration: async () => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return undefined;
    return navigator.serviceWorker.getRegistration();
  },
  conversations: () => api.conversations(),
};

/** The conversation a hash opens (`#/conversations/<id>...`), or "". */
export const conversationOf = (hash: string): string =>
  /^#\/conversations\/([0-9a-f]{8})(?:[/?]|$)/i.exec(hash)?.[1]?.toLowerCase() ?? "";

/**
 * Closes what is stale. `looking` is the conversation the owner has open right now (visible), or "".
 * Returns how many it closed.
 */
export async function closeStaleNotifications(
  looking: string,
  env: NotificationEnv = browserNotificationEnv,
): Promise<number> {
  const reg = await env.registration().catch(() => undefined);
  if (!reg) return 0;
  const shown = (await reg.getNotifications().catch(() => [])).filter((n) => TAG.test(n.tag));
  if (shown.length === 0) return 0;
  const rows = shown.some((n) => TAG.exec(n.tag)?.[1] !== looking)
    ? await env.conversations().catch(() => undefined)
    : undefined;
  let closed = 0;
  for (const n of shown) {
    const id = TAG.exec(n.tag)?.[1] ?? "";
    // The conversation in front of the owner needs no notification. Otherwise only the ones that ask for a
    // card ("?card="), and only when the conversation isn't waiting any more (or is gone): a "finished" one stays.
    const asksForCard = typeof n.data?.url === "string" && n.data.url.includes("?card=");
    const waiting = rows?.find((c) => c.id === id)?.needsYou === true;
    const stale = id === looking || (asksForCard && rows !== undefined && !waiting);
    if (!stale) continue;
    n.close();
    closed++;
  }
  return closed;
}

/**
 * Runs `closeStaleNotifications` when the app opens, comes back into view or gains focus, and when its address
 * moves to another conversation. Returns the way to stop.
 */
export function keepNotificationsTidy(env: NotificationEnv = browserNotificationEnv): () => void {
  if (typeof document === "undefined") return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (document.visibilityState !== "visible") return;
      void closeStaleNotifications(conversationOf(location.hash), env).catch(() => {});
    }, 800);
  };
  document.addEventListener("visibilitychange", run);
  addEventListener("focus", run);
  addEventListener("hashchange", run);
  run();
  return () => {
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", run);
    removeEventListener("focus", run);
    removeEventListener("hashchange", run);
  };
}
