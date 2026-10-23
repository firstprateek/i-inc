// Installing i.inc as an app (T63). Chrome and Edge offer it through `beforeinstallprompt`, which the page may
// keep and show from its own menu; Safari on iPhone has no such event, only Share > Add to Home Screen, so the
// menu says where that is. Once installed (or running as the installed app) there is nothing to offer.

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPromptEvent | null = null;

/** Sent when the browser offers (or withdraws) the install prompt, so the menu can show or hide its item. */
export const installSignal = new EventTarget();

/** The page runs as the installed app (a standalone window, or iOS's Home Screen mode). */
export function isStandalone(): boolean {
  const nav = globalThis.navigator as (Navigator & { standalone?: boolean }) | undefined;
  return (
    nav?.standalone === true ||
    (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches)
  );
}

/** Safari on an iPhone or iPad that is not installed: the only way in is Share > Add to Home Screen. */
export function needsIosInstall(ua: string = globalThis.navigator?.userAgent ?? ""): boolean {
  const ios =
    /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (globalThis.navigator?.maxTouchPoints ?? 0) > 1);
  return ios && !isStandalone();
}

/** The browser has offered to install i.inc, and the owner has not yet. */
export const canInstall = (): boolean => deferred !== null && !isStandalone();

/** Asks the browser to show its install dialog. Must come from a tap. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const ev = deferred;
  if (!ev) return "unavailable";
  deferred = null; // an event can be used once
  installSignal.dispatchEvent(new Event("change"));
  await ev.prompt();
  return (await ev.userChoice).outcome;
}

/** Listens for the install prompt. Returns the way to stop. */
export function captureInstallPrompt(): () => void {
  const onPrompt = (e: Event) => {
    e.preventDefault(); // keep it for our own menu instead of the browser's mini-bar
    deferred = e as InstallPromptEvent;
    installSignal.dispatchEvent(new Event("change"));
  };
  const onInstalled = () => {
    deferred = null;
    installSignal.dispatchEvent(new Event("change"));
  };
  addEventListener("beforeinstallprompt", onPrompt);
  addEventListener("appinstalled", onInstalled);
  return () => {
    removeEventListener("beforeinstallprompt", onPrompt);
    removeEventListener("appinstalled", onInstalled);
  };
}

/** For tests. */
export function resetInstall(): void {
  deferred = null;
}
