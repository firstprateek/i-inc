// Push opt-in: the toggle's state machine and the Notifications section against a fake browser and
// daemon, and the service worker's push and click handlers against fakes of the worker's globals.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/components/setup-notifications.ts";
import { disablePush, enablePush, keyBytes, type PushEnv, pushState } from "../src/push.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
const endpoint = "https://push.example/send/abc";

interface Fake {
  env: PushEnv;
  perm: { value: NotificationPermission };
  sub: { current: ReturnType<typeof makeSub> | null };
  subscribe: ReturnType<typeof vi.fn>;
  requestPermission: ReturnType<typeof vi.fn>;
}

function makeSub(onGone: () => void = () => {}) {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
    unsubscribe: vi.fn(async () => {
      onGone();
      return true;
    }),
  };
}

/** A browser that can push. `answer` is what the permission prompt returns. */
function browser(
  opts: { permission?: NotificationPermission; answer?: NotificationPermission; subscribed?: boolean } = {},
): Fake {
  const perm = { value: opts.permission ?? "default" };
  const sub = {
    current: opts.subscribed
      ? makeSub(() => {
          sub.current = null;
        })
      : null,
  };
  const subscribe = vi.fn(async () => {
    sub.current = makeSub(() => {
      sub.current = null;
    });
    return sub.current;
  });
  const requestPermission = vi.fn(async () => {
    perm.value = opts.answer ?? "granted";
    return perm.value;
  });
  const registration = {
    pushManager: {
      getSubscription: async () => sub.current,
      subscribe,
    },
  } as unknown as ServiceWorkerRegistration;
  // After unsubscribing, the browser has no subscription.
  const env: PushEnv = {
    notification: {
      get permission() {
        return perm.value;
      },
      requestPermission,
    },
    hasPushManager: true,
    registration: async () => registration,
  };
  return { env, perm, sub, subscribe, requestPermission };
}

let calls: { method: string; url: string; body: unknown }[] = [];

function serve(
  handlers: { key?: () => Response; subscribe?: () => Response; unsubscribe?: () => Response } = {},
) {
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url === "/api/push/key") return handlers.key?.() ?? json({ publicKey: KEY });
    if (url === "/api/push/subscribe") return handlers.subscribe?.() ?? json({ ok: true });
    if (url === "/api/push/unsubscribe") return handlers.unsubscribe?.() ?? json({ ok: true });
    return json({}, 404);
  });
}

beforeEach(() => serve());
afterEach(() => vi.unstubAllGlobals());

describe("the push state", () => {
  it("is unsupported without Notification, a PushManager or a running service worker", async () => {
    const b = browser();
    expect(await pushState({ ...b.env, notification: undefined })).toBe("unsupported");
    expect(await pushState({ ...b.env, hasPushManager: false })).toBe("unsupported");
    expect(await pushState({ ...b.env, registration: async () => undefined })).toBe("unsupported");
    expect(await pushState({ ...b.env, registration: async () => Promise.reject(new Error("no")) })).toBe(
      "unsupported",
    );
  });

  it("is denied when the browser blocks notifications, whatever is subscribed", async () => {
    expect(await pushState(browser({ permission: "denied", subscribed: true }).env)).toBe("denied");
  });

  it("is on only with permission and a subscription, otherwise off", async () => {
    expect(await pushState(browser({ permission: "granted", subscribed: true }).env)).toBe("on");
    expect(await pushState(browser({ permission: "granted" }).env)).toBe("off");
    expect(await pushState(browser({ permission: "default" }).env)).toBe("off");
    expect(await pushState(browser({ permission: "default", subscribed: true }).env)).toBe("off");
  });
});

describe("turning notifications on", () => {
  it("asks permission, fetches the key, subscribes with it and posts the subscription", async () => {
    const b = browser();
    expect(await enablePush(b.env)).toBe("on");
    expect(b.requestPermission).toHaveBeenCalledOnce();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /api/push/key",
      "POST /api/push/subscribe",
    ]);
    expect(calls[1]?.body).toEqual({ endpoint, keys: { p256dh: "p", auth: "a" } });
    const options = b.subscribe.mock.calls[0]?.[0] as {
      userVisibleOnly: boolean;
      applicationServerKey: Uint8Array;
    };
    expect(options.userVisibleOnly).toBe(true);
    expect(options.applicationServerKey).toEqual(keyBytes(KEY));
    expect(options.applicationServerKey).toHaveLength(65);
    expect(options.applicationServerKey[0]).toBe(4); // an uncompressed P-256 point
  });

  it("stops at a refused prompt without calling the daemon", async () => {
    const denied = browser({ answer: "denied" });
    expect(await enablePush(denied.env)).toBe("denied");
    const dismissed = browser({ answer: "default" });
    expect(await enablePush(dismissed.env)).toBe("off");
    expect(calls).toEqual([]);
    expect(denied.subscribe).not.toHaveBeenCalled();
  });

  it("is unavailable, quietly, when the daemon has no push (404 or no key)", async () => {
    serve({ key: () => json({ error: "not found" }, 404) });
    const a = browser();
    expect(await enablePush(a.env)).toBe("unavailable");
    expect(a.subscribe).not.toHaveBeenCalled();

    serve({ key: () => json({ publicKey: "" }) });
    expect(await enablePush(browser().env)).toBe("unavailable");

    serve({
      key: () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
    });
    expect(await enablePush(browser().env)).toBe("unavailable");
  });

  it("drops the browser subscription when the daemon refuses it", async () => {
    serve({ subscribe: () => json({ error: "endpoint must be https" }, 400) });
    const b = browser();
    await expect(enablePush(b.env)).rejects.toThrow("endpoint must be https");
    expect(b.sub.current).toBeNull(); // unsubscribed again

    serve({ subscribe: () => json({ error: "not found" }, 404) });
    expect(await enablePush(browser().env)).toBe("unavailable");
  });

  it("forgets chat drafts when the session has expired (401)", async () => {
    serve({ key: () => json({ error: "Sign in" }, 401) });
    localStorage.setItem("inc.chat.draft.pa", "My address is…");
    localStorage.setItem("inc.new-ticket.project", "i-inc");
    await enablePush(browser().env).catch(() => {});
    expect(localStorage.getItem("inc.chat.draft.pa")).toBeNull();
    expect(localStorage.getItem("inc.new-ticket.project")).toBe("i-inc");
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("is unsupported where it can't work, without prompting", async () => {
    const b = browser();
    expect(await enablePush({ ...b.env, hasPushManager: false })).toBe("unsupported");
    expect(b.requestPermission).not.toHaveBeenCalled();
  });
});

describe("turning notifications off", () => {
  it("tells the daemon the endpoint and unsubscribes the browser", async () => {
    const b = browser({ permission: "granted", subscribed: true });
    const sub = b.sub.current;
    expect(await disablePush(b.env)).toBe("off");
    expect(calls).toEqual([{ method: "POST", url: "/api/push/unsubscribe", body: { endpoint } }]);
    expect(sub?.unsubscribe).toHaveBeenCalled();
  });

  it("still unsubscribes the browser when the daemon fails, and says so", async () => {
    serve({ unsubscribe: () => json({ error: "boom" }, 500) });
    const b = browser({ permission: "granted", subscribed: true });
    const sub = b.sub.current;
    await expect(disablePush(b.env)).rejects.toThrow("Notifications are off on this device");
    expect(sub?.unsubscribe).toHaveBeenCalled();
  });

  it("does nothing when there is no subscription", async () => {
    expect(await disablePush(browser({ permission: "granted" }).env)).toBe("off");
    expect(calls).toEqual([]);
  });
});

describe("the Notifications section", () => {
  async function settle(el: Element) {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  }

  /** Puts a fake browser on the globals the element reads, and mounts it. */
  async function mount(b: Fake | "unsupported"): Promise<ShadowRoot> {
    document.body.innerHTML = "";
    if (b === "unsupported") {
      vi.stubGlobal("Notification", undefined);
    } else {
      vi.stubGlobal("Notification", b.env.notification);
      vi.stubGlobal("PushManager", class {});
      const reg = await b.env.registration();
      vi.stubGlobal("navigator", { serviceWorker: { getRegistration: async () => reg } });
    }
    const el = document.createElement("inc-setup-notifications");
    document.body.append(el);
    await settle(el);
    return el.shadowRoot as ShadowRoot;
  }
  const toggle = (r: ShadowRoot) => r.querySelector('[role="switch"]') as HTMLButtonElement | null;

  it("explains the iPhone install when push is unsupported", async () => {
    const root = await mount("unsupported");
    expect(toggle(root)).toBeNull();
    expect(root.textContent).toContain("Not supported");
    expect(root.textContent).toContain("Add to Home Screen");
    expect(root.textContent).toContain("installed web apps");
  });

  it("explains how to re-enable when permission is denied", async () => {
    const root = await mount(browser({ permission: "denied" }));
    expect(toggle(root)).toBeNull();
    expect(root.textContent).toContain("Blocked");
    expect(root.textContent).toContain("site settings");
  });

  it("switches on and off", async () => {
    const root = await mount(browser());
    expect(toggle(root)?.getAttribute("aria-checked")).toBe("false");
    expect(root.textContent).toContain("Notifications off");

    toggle(root)?.click();
    await settle(root.host);
    expect(toggle(root)?.getAttribute("aria-checked")).toBe("true");
    expect(root.textContent).toContain("Notifications on");
    expect(root.textContent).toContain("On");
    expect(calls.map((c) => c.url)).toEqual(["/api/push/key", "/api/push/subscribe"]);

    toggle(root)?.click();
    await settle(root.host);
    expect(toggle(root)?.getAttribute("aria-checked")).toBe("false");
    expect(calls.at(-1)?.url).toBe("/api/push/unsubscribe");
  });

  it("shows a quiet note when the daemon has no push", async () => {
    serve({ key: () => json({ error: "not found" }, 404) });
    const root = await mount(browser());
    toggle(root)?.click();
    await settle(root.host);
    expect(root.textContent).toContain("Notifications aren't available yet");
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows the reason when turning on fails", async () => {
    serve({ subscribe: () => json({ error: "endpoint must be https" }, 400) });
    const root = await mount(browser());
    toggle(root)?.click();
    await settle(root.host);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("endpoint must be https");
    expect(toggle(root)?.getAttribute("aria-checked")).toBe("false");
  });
});

// ---- the service worker's push and click handlers ----
const web = join(dirname(fileURLToPath(import.meta.url)), "..");
type Listener = (event: Record<string, unknown>) => void;

interface FakeClient {
  url: string;
  focus: ReturnType<typeof vi.fn>;
  navigate?: ReturnType<typeof vi.fn>;
}

function loadWorker(windows: FakeClient[] = []) {
  const source = readFileSync(join(web, "public/sw.js"), "utf8")
    .replace('"__BUILD_ID__"', '"v1"')
    .replace('"__PRECACHE__"', "[]");
  const listeners: Record<string, Listener> = {};
  const showNotification = vi.fn(async () => {});
  const openWindow = vi.fn(async () => null);
  const self = {
    location: { origin: "https://app.test" },
    addEventListener: (type: string, fn: Listener) => {
      listeners[type] = fn;
    },
    registration: { showNotification },
    clients: { matchAll: vi.fn(async () => windows), openWindow, claim: vi.fn() },
  };
  new Function("self", "caches", "fetch", source)(self, {}, vi.fn());

  const dispatch = async (type: string, extra: Record<string, unknown>) => {
    const waits: Promise<unknown>[] = [];
    listeners[type]?.({ ...extra, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  };
  const push = (data: unknown) =>
    dispatch("push", {
      data: data === undefined ? null : { json: () => data, text: () => String(data) },
    });
  const click = (url: unknown) => {
    const close = vi.fn();
    return dispatch("notificationclick", { notification: { close, data: { url } } }).then(() => close);
  };
  return { push, click, dispatch, showNotification, openWindow, self };
}

const client = (url: string, withNavigate = true): FakeClient => {
  const c: FakeClient = { url, focus: vi.fn() };
  c.focus.mockResolvedValue(c);
  if (withNavigate) c.navigate = vi.fn(async () => c);
  return c;
};

describe("the service worker's push handler", () => {
  it("shows the payload's title, body and url, collapsing repeats per ticket", async () => {
    const w = loadWorker();
    await w.push({ title: "Needs you · #7", body: "Fix login", url: "#/ticket/7" });
    expect(w.showNotification).toHaveBeenCalledOnce();
    const [title, options] = w.showNotification.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(title).toBe("Needs you · #7");
    expect(options).toMatchObject({
      body: "Fix login",
      tag: "#/ticket/7",
      renotify: true,
      data: { url: "#/ticket/7" },
    });
  });

  it("prefers an explicit tag", async () => {
    const w = loadWorker();
    await w.push({ title: "t", body: "b", url: "#/ticket/1", tag: "main" });
    expect((w.showNotification.mock.calls[0] as unknown as [string, { tag: string }])[1].tag).toBe("main");
  });

  it("still shows something for an empty or unreadable payload", async () => {
    const w = loadWorker();
    await w.push(undefined);
    expect(w.showNotification).toHaveBeenLastCalledWith(
      "i.inc",
      expect.objectContaining({ body: "", tag: "i-inc" }),
    );
    await w.dispatch("push", {
      data: {
        json: () => {
          throw new SyntaxError("bad");
        },
        text: () => "plain words",
      },
    });
    expect(w.showNotification).toHaveBeenLastCalledWith(
      "i.inc",
      expect.objectContaining({ body: "plain words" }),
    );
  });
});

describe("the service worker's click handler", () => {
  it("closes the notification and focuses an open i.inc window, moving it to the ticket", async () => {
    const other = client("https://elsewhere.test/");
    const open = client("https://app.test/#/inbox");
    const w = loadWorker([other, open]);
    const close = await w.click("#/ticket/7");
    expect(close).toHaveBeenCalled();
    expect(other.focus).not.toHaveBeenCalled();
    expect(open.focus).toHaveBeenCalled();
    expect(open.navigate).toHaveBeenCalledWith("https://app.test/#/ticket/7");
    expect(w.openWindow).not.toHaveBeenCalled();
  });

  it("focuses a window that can't navigate, without failing", async () => {
    const open = client("https://app.test/", false);
    const w = loadWorker([open]);
    await w.click("#/ticket/7");
    expect(open.focus).toHaveBeenCalled();
    expect(w.openWindow).not.toHaveBeenCalled();
  });

  it("opens the url when no window is open", async () => {
    const w = loadWorker([]);
    await w.click("#/ticket/7");
    expect(w.openWindow).toHaveBeenCalledWith("https://app.test/#/ticket/7");
  });

  it("only follows same-origin urls: anything else opens the app's front door", async () => {
    for (const bad of ["https://evil.test/phish", "//evil.test/x", "javascript:alert(1)", 42, undefined]) {
      const w = loadWorker([]);
      await w.click(bad);
      expect(w.openWindow).toHaveBeenCalledWith("https://app.test/");
    }
  });

  it("accepts an absolute url on this origin", async () => {
    const w = loadWorker([]);
    await w.click("https://app.test/#/ticket/3");
    expect(w.openWindow).toHaveBeenCalledWith("https://app.test/#/ticket/3");
  });
});
