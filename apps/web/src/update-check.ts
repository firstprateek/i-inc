// A page left open across a deploy keeps the old JavaScript (an installed app resumed from the background does
// it every time). The daemon's /api/health says which release is running: the first answer is the release this
// page was loaded from, and a different one later means the page is out of date. The service worker taking over
// (a new build installed and activated) says the same. Either way the shell offers a reload; it never reloads
// by itself, which would lose what the owner is typing.
import { send } from "./api.ts";

/** Sent on `updates` when the daemon runs a different release than this page was loaded from. */
export const UPDATE_EVENT = "update-available";
export const updates = new EventTarget();

/** How long a check is trusted: resuming the app often, or switching tabs, does not ask every time. */
export const CHECK_EVERY_MS = 60_000;
/** While the app stays open and visible. */
export const POLL_MS = 10 * 60_000;

let loaded: string | null = null;
let stale = false;

/** Whether this page is known to be older than what the daemon runs. */
export const updateAvailable = (): boolean => stale;

function markStale(): void {
  if (stale) return;
  stale = true;
  updates.dispatchEvent(new Event(UPDATE_EVENT));
}

/** The running release, or null when the daemon doesn't say (an older daemon, "unknown", or unreachable). */
async function runningVersion(): Promise<string | null> {
  try {
    const res = await send("/api/health");
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { version?: unknown } | null;
    const v = body?.version;
    return typeof v === "string" && v && v !== "unknown" ? v : null;
  } catch {
    return null;
  }
}

/** One check. The first answer is the baseline; a later, different one marks the page stale. */
export async function checkForUpdate(): Promise<boolean> {
  if (stale) return true;
  const v = await runningVersion();
  if (v === null) return false;
  if (loaded === null) loaded = v;
  else if (v !== loaded) markStale();
  return stale;
}

/** Starts watching; returns the way to stop. */
export function watchForUpdates(now: () => number = Date.now): () => void {
  let last = 0;
  const check = () => {
    last = now();
    void checkForUpdate();
  };
  const onVisible = () => {
    if (document.visibilityState === "visible" && now() - last >= CHECK_EVERY_MS) check();
  };
  const timer = setInterval(() => {
    if (document.visibilityState === "visible") check();
  }, POLL_MS);
  document.addEventListener("visibilitychange", onVisible);
  addEventListener("online", check);
  // A worker that takes over a page that already had one belongs to a newer build.
  const sw = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
  const hadController = !!sw?.controller;
  const onController = () => {
    if (hadController) markStale();
  };
  sw?.addEventListener?.("controllerchange", onController);
  check(); // the baseline
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
    removeEventListener("online", check);
    sw?.removeEventListener?.("controllerchange", onController);
  };
}

/** For tests: forgets the baseline and the stale mark. */
export function resetUpdateCheck(): void {
  loaded = null;
  stale = false;
}
