// The installed app (T63 group 7): the service worker's rough edges, a subscription the browser replaced or made
// for another key, a page that outlives a deploy, installing, and what the manifest offers.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncApp } from "../src/components/app.ts";
import {
  canInstall,
  captureInstallPrompt,
  installSignal,
  needsIosInstall,
  promptInstall,
  resetInstall,
} from "../src/install.ts";
import { enablePush, keyBytes, type PushEnv, pushState, sameKey } from "../src/push.ts";
import {
  CHECK_EVERY_MS,
  checkForUpdate,
  resetUpdateCheck,
  updateAvailable,
  updates,
  watchForUpdates,
} from "../src/update-check.ts";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ---- the service worker ----
type Listener = (event: Record<string, unknown>) => void;

function loadWorker(opts: { windows?: Record<string, unknown>[]; fetch?: ReturnType<typeof vi.fn> } = {}) {
  const source = readFileSync(join(web, "public/sw.js"), "utf8")
    .replace('"__BUILD_ID__"', '"v1"')
    .replace('"__PRECACHE__"', "[]");
  const listeners: Record<string, Listener> = {};
  const puts: string[] = [];
  const cache = {
    match: async () => undefined,
    put: vi.fn(async (req: { url: string }, res: Response) => {
      // The real Cache rejects a partial response.
      if (res.status === 206) throw new TypeError("Partial response (status code 206) is unsupported");
      puts.push(new URL(req.url).pathname);
    }),
  };
  const subscribe = vi.fn(async () => ({
    endpoint: "https://push.example/new",
    toJSON: () => ({ endpoint: "https://push.example/new", keys: { p256dh: "p", auth: "a" } }),
  }));
  const self = {
    location: { origin: "https://app.test" },
    addEventListener: (type: string, fn: Listener) => {
      listeners[type] = fn;
    },
    registration: {
      pushManager: { subscribe },
      showNotification: vi.fn(),
      getNotifications: vi.fn(async () => []),
    },
    clients: {
      matchAll: vi.fn(async () => opts.windows ?? []),
      openWindow: vi.fn(async () => null),
      claim: vi.fn(),
    },
    navigator: { userAgent: "Chrome" },
  };
  const net = opts.fetch ?? vi.fn();
  new Function("self", "caches", "fetch", source)(
    self,
    { open: async () => cache, keys: async () => [] },
    net,
  );
  const dispatch = async (type: string, extra: Record<string, unknown> = {}) => {
    const waits: Promise<unknown>[] = [];
    let responded: Promise<unknown> | undefined;
    listeners[type]?.({
      ...extra,
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      respondWith: (p: Promise<unknown>) => {
        responded = p;
      },
    });
    await Promise.all(waits);
    return responded ? await responded : undefined;
  };
  return { dispatch, cache, puts, subscribe, self, net };
}

describe("the service worker's cache", () => {
  it("keeps a whole file, but not a 206 (put() rejects a range, and nothing may go unhandled)", async () => {
    const net = vi.fn();
    const w = loadWorker({ fetch: net });
    const req = (path: string) => ({ method: "GET", url: `https://app.test${path}`, mode: "cors" });
    net.mockResolvedValueOnce(
      new Response("whole", { status: 200, headers: { "content-type": "text/css" } }),
    );
    await w.dispatch("fetch", { request: req("/assets/a.css") });
    net.mockResolvedValueOnce(
      new Response("part", { status: 206, headers: { "content-type": "video/mp4" } }),
    );
    const res = (await w.dispatch("fetch", { request: req("/assets/clip.mp4") })) as Response;
    await new Promise((r) => setTimeout(r, 0));
    expect(await res.text()).toBe("part"); // the page still gets its bytes
    expect(w.puts).toEqual(["/assets/a.css"]);
    // It never even tried to keep the range (the real put() rejects it, and nothing handles that).
    expect(w.cache.put).toHaveBeenCalledTimes(1);
  });
});

describe("a tap on a notification", () => {
  const win = (url: string, over: Record<string, unknown> = {}) => {
    const c: Record<string, unknown> = { url, visibilityState: "hidden", focused: false, ...over };
    c.focus = vi.fn(async () => c);
    c.postMessage = vi.fn();
    return c;
  };

  it("focuses the window that is being looked at, not the first one listed", async () => {
    const background = win("https://app.test/#/work/board");
    const visible = win("https://app.test/#/needs-you", { visibilityState: "visible", focused: true });
    const w = loadWorker({ windows: [background, visible] });
    await w.dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: "#/ticket/7" } } });
    expect(visible.focus).toHaveBeenCalled();
    expect(background.focus).not.toHaveBeenCalled();
    expect(visible.postMessage).toHaveBeenCalledWith({
      type: "i-inc:open",
      url: "https://app.test/#/ticket/7",
    });
  });

  it("prefers a visible window to a hidden one when none has the focus, and falls back to the first", async () => {
    const hidden = win("https://app.test/");
    const visible = win("https://app.test/", { visibilityState: "visible" });
    const w = loadWorker({ windows: [hidden, visible] });
    await w.dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: "#/ticket/7" } } });
    expect(visible.focus).toHaveBeenCalled();
    const only = win("https://app.test/");
    const w2 = loadWorker({ windows: [win("https://elsewhere.test/"), only] });
    await w2.dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: "#/ticket/7" } } });
    expect(only.focus).toHaveBeenCalled();
  });
});

describe("a push subscription the browser replaced", () => {
  it("subscribes again with the daemon's key, tells the daemon, and has it forget the old endpoint", async () => {
    const net = vi.fn(async (url: string) =>
      url === "/api/push/key"
        ? json({
            publicKey:
              "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U",
          })
        : json({ ok: true }),
    );
    const w = loadWorker({ fetch: net });
    await w.dispatch("pushsubscriptionchange", {
      oldSubscription: { endpoint: "https://push.example/dead" },
    });
    expect(w.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true, applicationServerKey: expect.any(Uint8Array) }),
    );
    const posts = (net.mock.calls as unknown as [string, RequestInit | undefined][]).filter(
      ([, init]) => init?.method === "POST",
    );
    expect(posts.map(([u]) => u)).toEqual(["/api/push/subscribe", "/api/push/unsubscribe"]);
    expect(JSON.parse(String(posts[0]?.[1]?.body)).endpoint).toBe("https://push.example/new");
    expect(JSON.parse(String(posts[1]?.[1]?.body))).toEqual({
      endpoint: "https://push.example/dead",
    });
  });

  it("uses the new subscription the browser already made, and does nothing when the daemon has no push", async () => {
    const net = vi.fn(async () => json({ ok: true }));
    const w = loadWorker({ fetch: net });
    await w.dispatch("pushsubscriptionchange", {
      newSubscription: {
        endpoint: "https://push.example/n",
        toJSON: () => ({ endpoint: "https://push.example/n" }),
      },
    });
    expect(w.subscribe).not.toHaveBeenCalled();
    expect(net).toHaveBeenCalledWith("/api/push/subscribe", expect.objectContaining({ method: "POST" }));

    const none = vi.fn(async () => json({ publicKey: "" }));
    const w2 = loadWorker({ fetch: none });
    await w2.dispatch("pushsubscriptionchange", {});
    expect(w2.subscribe).not.toHaveBeenCalled();
    expect(none).toHaveBeenCalledTimes(1);
  });
});

// ---- push.ts against a key that changed ----
const KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
const OTHER = "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM";

function pushBrowser(subKey: string | null) {
  let sub: {
    endpoint: string;
    options?: { applicationServerKey: ArrayBuffer };
    toJSON(): unknown;
    unsubscribe: ReturnType<typeof vi.fn>;
  } | null =
    subKey === null
      ? null
      : {
          endpoint: "https://push.example/old",
          options: { applicationServerKey: keyBytes(subKey).buffer },
          toJSON: () => ({ endpoint: "https://push.example/old" }),
          unsubscribe: vi.fn(async () => {
            sub = null;
            return true;
          }),
        };
  const subscribe = vi.fn(async () => {
    // A real browser refuses a second subscription for a different key.
    if (sub && !sameKey(sub as never, KEY))
      throw new DOMException("different applicationServerKey", "InvalidStateError");
    sub = {
      endpoint: "https://push.example/new",
      toJSON: () => ({ endpoint: "https://push.example/new" }),
      unsubscribe: vi.fn(async () => true),
    };
    return sub;
  });
  const env: PushEnv = {
    notification: { permission: "granted", requestPermission: async () => "granted" },
    hasPushManager: true,
    registration: async () =>
      ({
        pushManager: { getSubscription: async () => sub, subscribe },
      }) as unknown as ServiceWorkerRegistration,
  };
  return { env, subscribe, current: () => sub };
}

describe("push after the daemon's key changed", () => {
  const posts: string[] = [];
  beforeEach(() => {
    posts.length = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") posts.push(url);
      return url === "/api/push/key" ? json({ publicKey: KEY }) : json({ ok: true });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("compares a subscription's key with the daemon's", () => {
    expect(sameKey({ options: { applicationServerKey: keyBytes(KEY).buffer } } as never, KEY)).toBe(true);
    expect(sameKey({ options: { applicationServerKey: keyBytes(OTHER).buffer } } as never, KEY)).toBe(false);
    expect(sameKey({} as never, KEY)).toBe(true); // a browser that does not say
  });

  it("says off, not on, for a subscription made for the old key", async () => {
    expect(await pushState(pushBrowser(KEY).env)).toBe("on");
    expect(await pushState(pushBrowser(OTHER).env)).toBe("off");
  });

  it("trusts the browser when the daemon cannot be asked", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("offline");
    });
    expect(await pushState(pushBrowser(OTHER).env)).toBe("on");
  });

  it("turns on again by dropping the old subscription first, here and in the daemon (subscribe() would throw)", async () => {
    const b = pushBrowser(OTHER);
    expect(await enablePush(b.env)).toBe("on");
    expect(posts).toEqual(["/api/push/unsubscribe", "/api/push/subscribe"]);
    expect(b.current()?.endpoint).toBe("https://push.example/new");
  });
});

// ---- a page that outlives a deploy ----
describe("an update while the app is open", () => {
  beforeEach(() => {
    resetUpdateCheck();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    location.hash = "";
  });

  const health = (version: () => string) =>
    vi.stubGlobal("fetch", async (url: string) =>
      json(url === "/api/health" ? { ok: true, version: version() } : {}),
    );

  it("takes the first release it hears of as the one this page runs, and marks the page stale on a different one", async () => {
    let running = "aaa111";
    health(() => running);
    expect(await checkForUpdate()).toBe(false);
    expect(await checkForUpdate()).toBe(false);
    running = "bbb222";
    const heard = vi.fn();
    updates.addEventListener("update-available", heard);
    expect(await checkForUpdate()).toBe(true);
    expect(updateAvailable()).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
    await checkForUpdate();
    expect(heard).toHaveBeenCalledTimes(1); // said once
  });

  it("ignores a daemon that does not say its release", async () => {
    health(() => "unknown");
    expect(await checkForUpdate()).toBe(false);
    vi.stubGlobal("fetch", async () => json({ ok: true }));
    expect(await checkForUpdate()).toBe(false);
    expect(updateAvailable()).toBe(false);
  });

  it("checks again when the app is shown after a while, not every time", async () => {
    let running = "aaa111";
    let asked = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "/api/health") asked++;
      return json({ version: running });
    });
    const stop = watchForUpdates(() => Date.now());
    await vi.advanceTimersByTimeAsync(10);
    expect(asked).toBe(1);
    running = "bbb222";
    document.dispatchEvent(new Event("visibilitychange")); // shown again straight away
    await vi.advanceTimersByTimeAsync(10);
    expect(asked).toBe(1);
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS + 10);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(10);
    expect(asked).toBe(2);
    expect(updateAvailable()).toBe(true);
    stop();
  });

  it("shows a banner with Reload, and never reloads by itself", async () => {
    let running = "aaa111";
    health(() => running);
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }));
    const reload = vi.fn();
    vi.stubGlobal("location", {
      ...location,
      hash: "#/company/team",
      reload,
      origin: location.origin,
      href: location.href,
    });
    const app = new IncApp();
    document.body.append(app);
    await vi.advanceTimersByTimeAsync(20);
    await app.updateComplete;
    expect(app.shadowRoot?.querySelector('[slot="notice"]')).toBeNull();
    running = "bbb222";
    await checkForUpdate();
    await app.updateComplete;
    const banner = app.shadowRoot?.querySelector('[slot="notice"]');
    expect(banner?.textContent).toContain("i.inc was updated");
    expect(reload).not.toHaveBeenCalled();
    banner?.querySelector("button")?.click();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

// ---- installing ----
describe("installing i.inc", () => {
  let stop: () => void;
  beforeEach(() => {
    resetInstall();
    stop = captureInstallPrompt();
  });
  afterEach(() => {
    stop();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  const offer = () => {
    const prompt = vi.fn(async () => {});
    const e = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt,
      userChoice: Promise.resolve({ outcome: "accepted" as const }),
    });
    dispatchEvent(e);
    return { e, prompt };
  };

  it("keeps the browser's offer for its own menu, shows it once, and drops it once used", async () => {
    expect(canInstall()).toBe(false);
    const changed = vi.fn();
    installSignal.addEventListener("change", changed);
    const { e, prompt } = offer();
    expect(e.defaultPrevented).toBe(true);
    expect(canInstall()).toBe(true);
    expect(await promptInstall()).toBe("accepted");
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(canInstall()).toBe(false);
    expect(await promptInstall()).toBe("unavailable");
    installSignal.removeEventListener("change", changed);
  });

  it("offers nothing to an installed app", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("standalone"),
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }));
    offer();
    expect(canInstall()).toBe(false);
  });

  it("says where Add to Home Screen is for Safari on an iPhone, and only there", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }));
    expect(needsIosInstall("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605")).toBe(true);
    expect(needsIosInstall("Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/130")).toBe(false);
    expect(needsIosInstall("Mozilla/5.0 (Linux; Android 14) Chrome/130")).toBe(false);
  });

  it("puts Install in the account menu while the browser offers it", async () => {
    vi.stubGlobal("fetch", async () => json({}));
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }));
    location.hash = "#/company/team";
    const app = new IncApp();
    document.body.append(app);
    await app.updateComplete;
    const items = () =>
      [...(app.shadowRoot?.querySelectorAll('.account-menu [role="menuitem"]') ?? [])].map((b) =>
        b.textContent?.trim(),
      );
    app.shadowRoot?.querySelector<HTMLButtonElement>(".account-trigger")?.click();
    await app.updateComplete;
    expect(items()).not.toContain("Install i.inc as an app");
    const { prompt } = offer();
    await app.updateComplete;
    expect(items()).toContain("Install i.inc as an app");
    const item = [...(app.shadowRoot?.querySelectorAll('.account-menu [role="menuitem"]') ?? [])].find((b) =>
      b.textContent?.includes("Install"),
    ) as HTMLButtonElement;
    item.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(prompt).toHaveBeenCalledTimes(1);
    location.hash = "";
  });
});

// ---- the manifest ----
describe("the manifest", () => {
  const manifest = JSON.parse(readFileSync(join(web, "public/manifest.webmanifest"), "utf8"));
  const pngSize = (b: Buffer) => `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;

  it("offers shortcuts to Needs you, the board and conversations, inside its scope", () => {
    expect(manifest.shortcuts.map((s: { name: string }) => s.name)).toEqual([
      "Needs you",
      "Board",
      "Conversations",
    ]);
    for (const s of manifest.shortcuts) {
      expect(s.url, s.name).toMatch(/^\/#\//);
      expect(s.description, s.name).toBeTruthy();
    }
  });

  it("has a wide and a narrow screenshot, present and the size it says", () => {
    const forms = manifest.screenshots.map((s: { form_factor: string }) => s.form_factor).sort();
    expect(forms).toEqual(["narrow", "wide"]);
    for (const s of manifest.screenshots) {
      expect(s.label).toBeTruthy();
      expect(pngSize(readFileSync(join(web, "public", s.src.slice(1))))).toBe(s.sizes);
    }
  });
});
