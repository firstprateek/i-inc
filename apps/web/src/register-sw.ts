// Registers the service worker (public/sw.js) in production builds, in secure contexts only.

export interface Env {
  production: boolean;
  secure: boolean;
  supported: boolean;
}

export function shouldRegister(env: Env): boolean {
  return env.production && env.secure && env.supported;
}

export function registerServiceWorker(env?: Partial<Env>): boolean {
  const ok = shouldRegister({
    production: env?.production ?? import.meta.env.PROD,
    secure: env?.secure ?? globalThis.isSecureContext === true,
    supported: env?.supported ?? "serviceWorker" in navigator,
  });
  if (!ok) return false;
  const register = () => void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  if (document.readyState === "complete") register();
  else addEventListener("load", register, { once: true });
  return true;
}

/**
 * A tap on a notification asks the open app to go to its address (the worker cannot always navigate a
 * window, and an app that is already there has nowhere to go): `{ type: "i-inc:open", url }`.
 * Only an address on this origin, and only its #hash, is followed.
 */
export function notificationTarget(data: unknown, origin: string): string | null {
  if (!data || typeof data !== "object") return null;
  const { type, url } = data as { type?: unknown; url?: unknown };
  if (type !== "i-inc:open" || typeof url !== "string") return null;
  try {
    const target = new URL(url, `${origin}/`);
    if (target.origin !== origin || !target.hash.startsWith("#/")) return null;
    return target.hash;
  } catch {
    return null;
  }
}

/** Fired after the hash is set, so a screen already showing that address can look at it again. */
export const OPEN_CARD_EVENT = "inc-open-card";

/** Follows `i-inc:open` messages from the worker. Returns the way to stop. */
export function followNotificationTaps(): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => {};
  const onMessage = (e: MessageEvent) => {
    const hash = notificationTarget(e.data, location.origin);
    if (!hash) return;
    if (location.hash !== hash) location.hash = hash;
    window.dispatchEvent(new Event(OPEN_CARD_EVENT));
  };
  navigator.serviceWorker.addEventListener("message", onMessage);
  return () => navigator.serviceWorker.removeEventListener("message", onMessage);
}
