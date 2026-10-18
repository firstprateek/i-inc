// Push notifications on this device: the opt-in state machine behind Setup > Notifications.
// The backend is contract C2 in docs/coord.md: GET /api/push/key, POST /api/push/subscribe and
// POST /api/push/unsubscribe. The service worker (public/sw.js) shows what the daemon sends.
import { send } from "./api.ts";
import { showLogin } from "./login.ts";

/**
 * unsupported: no Notification, service worker or PushManager here (on iPhone: not installed to the
 *   Home Screen), or no service worker is running (a dev server).
 * denied: the browser blocks notifications for i.inc.
 * unavailable: the daemon has no push (it answers 404, or has no key).
 */
export type PushState = "unsupported" | "denied" | "unavailable" | "on" | "off";

/** What the browser gives us, as one object so tests can swap it. */
export interface PushEnv {
  notification:
    | { permission: NotificationPermission; requestPermission(): Promise<NotificationPermission> }
    | undefined;
  /** The registration of i.inc's own service worker, or undefined when there isn't one running. */
  registration(): Promise<ServiceWorkerRegistration | undefined>;
  /** Whether the page has a PushManager at all. */
  hasPushManager: boolean;
}

export function browserEnv(): PushEnv {
  const g = globalThis as { Notification?: PushEnv["notification"]; PushManager?: unknown };
  return {
    notification: g.Notification,
    hasPushManager: g.PushManager !== undefined,
    registration: async () => {
      if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return undefined;
      const sw = navigator.serviceWorker;
      const existing = await sw.getRegistration();
      if (existing) return existing;
      // On the very first visit the worker registers when the page finishes loading, a moment from now.
      // With none (a dev server), `ready` never settles, so don't wait for it for long.
      return Promise.race([sw.ready, new Promise<undefined>((r) => setTimeout(r, 2000))]);
    },
  };
}

const supported = (env: PushEnv, reg: ServiceWorkerRegistration | undefined) =>
  env.notification !== undefined && env.hasPushManager && reg?.pushManager !== undefined;

/** Where this device stands right now. */
export async function pushState(env: PushEnv = browserEnv()): Promise<PushState> {
  const reg = await env.registration().catch(() => undefined);
  if (!supported(env, reg) || !env.notification || !reg) return "unsupported";
  if (env.notification.permission === "denied") return "denied";
  const sub = await reg.pushManager.getSubscription().catch(() => null);
  return sub && env.notification.permission === "granted" ? "on" : "off";
}

/** The VAPID key is base64url; pushManager.subscribe wants the bytes. */
export function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const b64 = key.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function post(path: string, body: unknown): Promise<Response> {
  const res = await send(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) showLogin();
  return res;
}

/** The daemon's VAPID public key, or null when it has no push (404, an HTML fallback, or no key). */
async function serverKey(): Promise<string | null> {
  const res = await send("/api/push/key");
  if (res.status === 401) showLogin();
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`The daemon couldn't give a notification key (${res.status}).`);
  }
  const body = (await res.json().catch(() => null)) as { publicKey?: unknown } | null;
  return typeof body?.publicKey === "string" && body.publicKey ? body.publicKey : null;
}

/**
 * Turns notifications on: ask permission, fetch the key, subscribe this browser, tell the daemon.
 * Must start from a tap, because the permission prompt needs one. Throws with a sentence for the owner.
 */
export async function enablePush(env: PushEnv = browserEnv()): Promise<PushState> {
  const reg = await env.registration().catch(() => undefined);
  if (!supported(env, reg) || !env.notification || !reg) return "unsupported";
  const permission = await env.notification.requestPermission();
  if (permission === "denied") return "denied";
  if (permission !== "granted") return "off"; // dismissed the prompt: nothing changed

  const key = await serverKey();
  if (!key) return "unavailable";
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  const res = await post("/api/push/subscribe", sub.toJSON());
  if (!res.ok) {
    // Leave no half-open subscription behind: the daemon doesn't know it.
    await sub.unsubscribe().catch(() => false);
    if (res.status === 404) return "unavailable";
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `The daemon refused the subscription (${res.status}).`);
  }
  return "on";
}

/** Turns notifications off on both sides. The browser side always goes, even if the daemon is down. */
export async function disablePush(env: PushEnv = browserEnv()): Promise<PushState> {
  const reg = await env.registration().catch(() => undefined);
  if (!supported(env, reg) || !reg) return "unsupported";
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return "off";
  let failure: string | undefined;
  try {
    const res = await post("/api/push/unsubscribe", { endpoint: sub.endpoint });
    if (!res.ok && res.status !== 404) failure = `The daemon couldn't remove this device (${res.status}).`;
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }
  await sub.unsubscribe();
  // The daemon drops a dead endpoint the next time it tries it, so this is worth a word, not a block.
  if (failure) throw new Error(`Notifications are off on this device. ${failure}`);
  return "off";
}
