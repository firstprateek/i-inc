// The installable app: the manifest, the service worker's rules, registration, and the offline panel.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/components/app.ts";
import { report } from "../src/connection.ts";
import { registerServiceWorker, shouldRegister } from "../src/register-sw.ts";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicFile = (name: string) => readFileSync(join(web, "public", name));

describe("the manifest", () => {
  const manifest = JSON.parse(publicFile("manifest.webmanifest").toString());

  it("has what installing needs", () => {
    expect(manifest).toMatchObject({
      name: "i.inc",
      short_name: "i.inc",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#EEF0EA",
      theme_color: "#EEF0EA",
    });
  });

  it("matches the light ground in tokens.css", () => {
    const tokens = readFileSync(join(web, "src/tokens.css"), "utf8");
    const ground = /--ground:\s*(#[0-9a-f]{6})/i.exec(tokens)?.[1];
    expect(manifest.theme_color.toLowerCase()).toBe(ground?.toLowerCase());
    expect(manifest.background_color.toLowerCase()).toBe(ground?.toLowerCase());
  });

  it("lists the SVG, 192 and 512 PNGs and a maskable 512, all present with the right size", () => {
    const find = (sizes: string, purpose: string) =>
      manifest.icons.find(
        (i: { sizes: string; purpose: string }) => i.sizes === sizes && i.purpose === purpose,
      );
    expect(manifest.icons.find((i: { type: string }) => i.type === "image/svg+xml")).toBeTruthy();
    for (const icon of [find("192x192", "any"), find("512x512", "any"), find("512x512", "maskable")]) {
      expect(icon?.type).toBe("image/png");
      expect(pngSize(publicFile(icon.src.slice(1)))).toBe(icon.sizes);
    }
    expect(pngSize(publicFile("icons/apple-touch-icon.png"))).toBe("180x180");
  });

  it("is linked from index.html with the iOS and theme tags", () => {
    const html = readFileSync(join(web, "index.html"), "utf8");
    for (const needle of [
      'rel="manifest" href="/manifest.webmanifest"',
      'rel="apple-touch-icon" href="/icons/apple-touch-icon.png"',
      'name="apple-mobile-web-app-capable"',
      'name="apple-mobile-web-app-status-bar-style"',
      "viewport-fit=cover",
      "(prefers-color-scheme: light)",
      "(prefers-color-scheme: dark)",
    ]) {
      expect(html).toContain(needle);
    }
  });
});

function pngSize(png: Buffer): string {
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
}

describe("registering the service worker", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("only in a production build, in a secure context, where service workers exist", () => {
    const ok = { production: true, secure: true, supported: true };
    expect(shouldRegister(ok)).toBe(true);
    expect(shouldRegister({ ...ok, production: false })).toBe(false);
    expect(shouldRegister({ ...ok, secure: false })).toBe(false);
    expect(shouldRegister({ ...ok, supported: false })).toBe(false);
  });

  it("does not touch navigator.serviceWorker when guarded off", () => {
    const register = vi.fn();
    vi.stubGlobal("navigator", { serviceWorker: { register } });
    expect(registerServiceWorker({ production: false })).toBe(false);
    expect(register).not.toHaveBeenCalled();
  });

  it("registers /sw.js with the root scope when allowed", async () => {
    const register = vi.fn(async () => ({}));
    vi.stubGlobal("navigator", { serviceWorker: { register } });
    Object.defineProperty(document, "readyState", { value: "complete", configurable: true });
    expect(registerServiceWorker({ production: true, secure: true, supported: true })).toBe(true);
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
  });
});

// The service worker is a plain script, so run it against fakes of the worker's globals.
type Listener = (event: Record<string, unknown>) => void;

function loadWorker(precache: string[] = ["/index.html", "/assets/app-abc.js"], build = "v1") {
  const source = readFileSync(join(web, "public/sw.js"), "utf8")
    .replace('"__BUILD_ID__"', JSON.stringify(build))
    .replace('"__PRECACHE__"', JSON.stringify(precache));
  const listeners: Record<string, Listener> = {};
  const stores = new Map<string, Map<string, Response>>();
  const store = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name) as Map<string, Response>;
  };
  const key = (r: Request | string) =>
    new URL(typeof r === "string" ? r : r.url, "https://app.test").pathname;
  const caches = {
    open: async (name: string) => ({
      addAll: async (urls: string[]) => {
        for (const u of urls) store(name).set(key(u), new Response(`cached ${u}`));
      },
      match: async (r: Request | string) => store(name).get(key(r))?.clone(),
      put: async (r: Request, res: Response) => void store(name).set(key(r), res),
    }),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  const self = {
    location: { origin: "https://app.test" },
    addEventListener: (type: string, fn: Listener) => {
      listeners[type] = fn;
    },
    skipWaiting: vi.fn(async () => {}),
    clients: { claim: vi.fn(async () => {}) },
  };
  const network = vi.fn<(r: Request) => Promise<Response>>();
  new Function("self", "caches", "fetch", source)(self, caches, network);

  /** Dispatches an event and returns what respondWith got (undefined: the worker left it alone). */
  const run = async (type: string, extra: Record<string, unknown> = {}) => {
    let responded: Promise<unknown> | undefined;
    const waits: Promise<unknown>[] = [];
    listeners[type]?.({
      ...extra,
      respondWith: (p: Promise<unknown>) => {
        responded = p;
      },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    await Promise.all(waits);
    return responded;
  };
  const get = (path: string, mode = "cors") =>
    run("fetch", { request: { method: "GET", url: `https://app.test${path}`, mode } });
  return { run, get, network, stores, self };
}

describe("the service worker", () => {
  beforeEach(() => {});

  it("precaches the shell on install and takes over", async () => {
    const w = loadWorker();
    await w.run("install");
    expect([...(w.stores.get("i-inc-shell-v1")?.keys() ?? [])]).toEqual([
      "/index.html",
      "/assets/app-abc.js",
    ]);
    expect(w.self.skipWaiting).toHaveBeenCalled();
  });

  it("deletes its old caches on activate, and only its own", async () => {
    const w = loadWorker();
    w.stores.set("i-inc-shell-old", new Map());
    w.stores.set("i-inc-shell-v1", new Map());
    w.stores.set("someone-else", new Map());
    await w.run("activate");
    expect([...w.stores.keys()].sort()).toEqual(["i-inc-shell-v1", "someone-else"]);
    expect(w.self.clients.claim).toHaveBeenCalled();
  });

  it("never touches /api/ requests, or anything but GET", async () => {
    const w = loadWorker();
    expect(await w.get("/api/board")).toBeUndefined();
    expect(await w.get("/api/auth", "navigate")).toBeUndefined();
    expect(
      await w.run("fetch", { request: { method: "POST", url: "https://app.test/x", mode: "cors" } }),
    ).toBeUndefined();
    expect(w.network).not.toHaveBeenCalled();
  });

  it("navigations go to the network first", async () => {
    const w = loadWorker();
    await w.run("install");
    w.network.mockResolvedValue(new Response("fresh"));
    const res = (await w.get("/", "navigate")) as Response;
    expect(await res.text()).toBe("fresh");
  });

  it("navigations fall back to the cached shell when the network fails or the daemon answers 5xx", async () => {
    const w = loadWorker();
    await w.run("install");
    w.network.mockRejectedValueOnce(new TypeError("offline"));
    expect(await ((await w.get("/#/inbox", "navigate")) as Response).text()).toBe("cached /index.html");
    w.network.mockResolvedValueOnce(new Response("bad gateway", { status: 502 }));
    expect(await ((await w.get("/", "navigate")) as Response).text()).toBe("cached /index.html");
  });

  it("serves assets from the cache, and remembers new files but not the HTML fallback", async () => {
    const w = loadWorker();
    await w.run("install");
    expect(await ((await w.get("/assets/app-abc.js")) as Response).text()).toBe("cached /assets/app-abc.js");
    expect(w.network).not.toHaveBeenCalled();

    w.network.mockResolvedValueOnce(new Response("body{}", { headers: { "content-type": "text/css" } }));
    await w.get("/assets/new-1.css");
    expect(w.stores.get("i-inc-shell-v1")?.has("/assets/new-1.css")).toBe(true);

    w.network.mockResolvedValueOnce(new Response("<html>", { headers: { "content-type": "text/html" } }));
    await w.get("/assets/missing.js");
    expect(w.stores.get("i-inc-shell-v1")?.has("/assets/missing.js")).toBe(false);
  });
});

describe("the offline panel", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    report(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    report(true);
  });

  async function settle(el: Element) {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  }

  it("replaces the views when the daemon can't be reached, and goes away when it answers", async () => {
    let up = false;
    vi.stubGlobal("fetch", async () => {
      if (!up) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ tickets: [], initialized: true }), {
        headers: { "content-type": "application/json" },
      });
    });
    const app = document.createElement("inc-app");
    document.body.append(app);
    await settle(app);
    const main = app.shadowRoot?.querySelector("main");
    const panel = main?.querySelector("inc-offline");
    expect(panel).toBeTruthy();
    expect(panel?.shadowRoot?.textContent).toContain("Can't reach i.inc");
    expect(panel?.shadowRoot?.textContent).toContain("Retrying");

    up = true;
    panel?.shadowRoot?.querySelector("button")?.click();
    await settle(app);
    expect(app.shadowRoot?.querySelector("inc-offline")).toBeNull();
  });

  it("treats an answer from the daemon, even a 401, as reachable; a 502 is not", async () => {
    const { send } = await import("../src/api.ts");
    const { isOffline } = await import("../src/connection.ts");
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 401 }));
    await send("/api/board");
    expect(isOffline()).toBe(false);
    vi.stubGlobal("fetch", async () => new Response("", { status: 502 }));
    await send("/api/board");
    expect(isOffline()).toBe(true);
  });
});
