// The desktop app (apps/desktop) draws no title bar: it sets `window.__I_INC_TITLEBAR__`, and only then does
// the shell's header become the title bar (a drag region, room for the window buttons, Back and Forward). A
// browser or the installed PWA never sets the mark, so there the header is unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncApp } from "../src/components/app.ts";
import { inDesktopApp, isFullScreen, titlebarKind } from "../src/desktop.ts";
import { IncLogin } from "../src/login.ts";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

describe("desktop marks", () => {
  afterEach(() => {
    delete window.__I_INC_TITLEBAR__;
  });

  it("sees the app only when it set its mark", () => {
    expect(inDesktopApp()).toBe(false);
    window.__I_INC_TITLEBAR__ = true;
    expect(inDesktopApp()).toBe(true);
  });

  it("leaves room for the window buttons on a Mac only", () => {
    expect(titlebarKind(MAC)).toBe("mac");
    expect(titlebarKind("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("plain");
  });

  it("calls a window that fills the screen full screen, and a zoomed one not", () => {
    const screen = { width: 1920, height: 1080 };
    expect(isFullScreen({ innerWidth: 1920, innerHeight: 1080 }, screen)).toBe(true);
    // Zoomed: as wide as the screen, short of it by the menu bar.
    expect(isFullScreen({ innerWidth: 1920, innerHeight: 1055 }, screen)).toBe(false);
    expect(isFullScreen({ innerWidth: 1320, innerHeight: 880 }, screen)).toBe(false);
  });
});

describe("the shell's header", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    location.hash = "#/work/board";
  });
  afterEach(() => {
    delete window.__I_INC_TITLEBAR__;
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  async function mount(): Promise<{ app: IncApp; root: ShadowRoot }> {
    const app = new IncApp();
    document.body.append(app);
    await app.updateComplete;
    return { app, root: app.shadowRoot as ShadowRoot };
  }

  it("is unchanged in a browser: no title-bar mode, no drag region, no Back and Forward", async () => {
    const { app, root } = await mount();
    expect(app.hasAttribute("titlebar")).toBe(false);
    expect(root.querySelector("header")?.hasAttribute("data-tauri-drag-region")).toBe(false);
    expect(root.querySelector(".history")).toBeNull();
  });

  it("is the title bar in the app: a deep drag region with Back and Forward before the logo", async () => {
    window.__I_INC_TITLEBAR__ = true;
    vi.stubGlobal("navigator", { ...navigator, userAgent: MAC });
    const { app, root } = await mount();
    expect(app.getAttribute("titlebar")).toBe("mac");
    const header = root.querySelector("header") as HTMLElement;
    expect(header.getAttribute("data-tauri-drag-region")).toBe("deep");
    const buttons = [...header.querySelectorAll(".history button")].map((b) => b.getAttribute("aria-label"));
    expect(buttons).toEqual(["Back", "Forward"]);
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    (header.querySelector(".history button") as HTMLButtonElement).click();
    expect(back).toHaveBeenCalledOnce();
    // The logo and the area links still come after, in the same header.
    expect(header.querySelector(".mark")).not.toBeNull();
    expect(header.querySelectorAll("nav.areas a").length).toBe(3);
  });

  it("keeps the open account menu out of the drag region", async () => {
    window.__I_INC_TITLEBAR__ = true;
    const { app, root } = await mount();
    (root.querySelector(".account-trigger") as HTMLButtonElement).click();
    await app.updateComplete;
    expect(root.querySelector(".account-menu")?.getAttribute("data-tauri-drag-region")).toBe("false");
  });
});

describe("the sign-in screen", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ initialized: true }), { status: 200 }));
  });
  afterEach(() => {
    delete window.__I_INC_TITLEBAR__;
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("has a strip to drag the window by in the app, and none in a browser", async () => {
    for (const app of [false, true]) {
      if (app) window.__I_INC_TITLEBAR__ = true;
      const el = new IncLogin();
      document.body.append(el);
      await el.updateComplete;
      expect(el.hasAttribute("titlebar")).toBe(app);
      const strip = el.shadowRoot?.querySelector(".titlebar");
      expect(strip?.hasAttribute("data-tauri-drag-region") ?? false).toBe(app);
      el.remove();
    }
  });
});
