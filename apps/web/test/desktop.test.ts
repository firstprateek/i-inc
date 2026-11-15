// The desktop app (apps/desktop) draws no title bar: it sets `window.__I_INC_TITLEBAR__`, and only then does
// the shell's header become the title bar (a drag region, room for the window buttons, Back and Forward). A
// browser or the installed PWA never sets the mark, so there the header is unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncApp } from "../src/components/app.ts";
import {
  appZoom,
  inDesktopApp,
  inFullScreen,
  isFullScreen,
  resetDesktopForTests,
  titlebarKind,
  versionAtLeast,
  wireDesktop,
} from "../src/desktop.ts";
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

  it("guesses full screen from the window's outer size, which page zoom does not change", () => {
    const screen = { width: 1920, height: 1080 };
    expect(isFullScreen({ outerWidth: 1920, outerHeight: 1080 }, screen)).toBe(true);
    // Zoomed: as wide as the screen, short of it by the menu bar.
    expect(isFullScreen({ outerWidth: 1920, outerHeight: 1055 }, screen)).toBe(false);
    expect(isFullScreen({ outerWidth: 1320, outerHeight: 880 }, screen)).toBe(false);
  });

  it("compares app versions by their numbers", () => {
    expect(versionAtLeast("0.2.0", "0.2.0")).toBe(true);
    expect(versionAtLeast("0.10.0", "0.2.0")).toBe(true);
    expect(versionAtLeast("1.0.0", "0.9.9")).toBe(true);
    expect(versionAtLeast("0.1.9", "0.2.0")).toBe(false);
    expect(versionAtLeast("0.2.0-beta", "0.2.0")).toBe(true);
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

  it("undoes the app's zoom on the title bar, which must stay the window buttons' size", async () => {
    window.__I_INC_TITLEBAR__ = true;
    window.__I_INC_ZOOM__ = 1.25;
    try {
      const { root } = await mount();
      expect((root.querySelector("header") as HTMLElement).getAttribute("style")).toBe("zoom: 0.8");
    } finally {
      delete window.__I_INC_ZOOM__;
    }
    // At actual size the header has no zoom of its own…
    document.body.innerHTML = "";
    const atOne = await mount();
    expect((atOne.root.querySelector("header") as HTMLElement).hasAttribute("style")).toBe(false);
    // …and in a browser it never has, whatever zoom a page might report.
    document.body.innerHTML = "";
    delete window.__I_INC_TITLEBAR__;
    window.__I_INC_ZOOM__ = 1.25;
    try {
      const browser = await mount();
      expect((browser.root.querySelector("header") as HTMLElement).hasAttribute("style")).toBe(false);
    } finally {
      delete window.__I_INC_ZOOM__;
    }
  });

  it("zooms the account menu back up, since it sits inside the counter-zoomed header", async () => {
    window.__I_INC_TITLEBAR__ = true;
    window.__I_INC_ZOOM__ = 1.2;
    try {
      const { app, root } = await mount();
      (root.querySelector(".account-trigger") as HTMLButtonElement).click();
      await app.updateComplete;
      expect(root.querySelector(".account-menu")?.getAttribute("style")).toBe("zoom: 1.2");
    } finally {
      delete window.__I_INC_ZOOM__;
    }
  });

  it("closes the account menu on a press elsewhere, which on the title bar starts a drag and never clicks", async () => {
    window.__I_INC_TITLEBAR__ = true;
    const { app, root } = await mount();
    (root.querySelector(".account-trigger") as HTMLButtonElement).click();
    await app.updateComplete;
    expect(root.querySelector(".account-menu")).not.toBeNull();
    (root.querySelector(".spacer") as HTMLElement).dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, composed: true }),
    );
    await app.updateComplete;
    expect(root.querySelector(".account-menu")).toBeNull();
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

describe("wiring the document in the app", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDesktopForTests();
    window.__I_INC_TITLEBAR__ = true;
    localStorage.clear();
    sessionStorage.clear();
    document.documentElement.className = "";
  });
  afterEach(() => {
    vi.useRealTimers();
    delete window.__I_INC_TITLEBAR__;
    delete window.__I_INC_FULLSCREEN__;
    delete window.__I_INC_ZOOM__;
    delete window.__I_INC_APP_VERSION__;
    document.body.innerHTML = "";
    document.documentElement.className = "";
    resetDesktopForTests();
  });

  it("takes full screen from the app when it says, not from the page's size", () => {
    wireDesktop();
    window.__I_INC_FULLSCREEN__ = true;
    dispatchEvent(new Event("i-inc:fullscreen"));
    expect(inFullScreen()).toBe(true);
    window.__I_INC_FULLSCREEN__ = false;
    dispatchEvent(new Event("i-inc:fullscreen"));
    // A resize no longer guesses once the app has said.
    dispatchEvent(new Event("resize"));
    expect(inFullScreen()).toBe(false);
  });

  it("starts a reload at the zoom the app said last, until it says again", () => {
    wireDesktop();
    window.__I_INC_ZOOM__ = 1.2;
    dispatchEvent(new CustomEvent("i-inc:zoom", { detail: { show: false } }));
    delete window.__I_INC_ZOOM__;
    expect(appZoom()).toBe(1.2);
  });

  it("says at once that the app is older than the pages when it sets no version", () => {
    wireDesktop();
    expect(document.querySelector("inc-app-outdated")).not.toBeNull();
  });

  it("says nothing about an app that is new enough, however slow the load", () => {
    window.__I_INC_APP_VERSION__ = "0.3.202611150200";
    wireDesktop();
    vi.advanceTimersByTime(60_000);
    expect(document.querySelector("inc-app-outdated")).toBeNull();
  });

  /** The card asks whether the daemon has a build (HEAD /desktop/i.inc.zip); let that answer land. */
  async function outdatedCard(status: number) {
    vi.stubGlobal("fetch", async () => new Response(null, { status }));
    window.__I_INC_APP_VERSION__ = "0.2.0";
    wireDesktop();
    const card = document.querySelector("inc-app-outdated") as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    expect(card).not.toBeNull();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await card.updateComplete;
    vi.unstubAllGlobals();
    return card;
  }

  it("says it about an app below the pages' minimum (0.2 cannot update itself), with a download link", async () => {
    const card = await outdatedCard(200);
    const link = card.shadowRoot?.querySelector("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/desktop/i.inc.zip");
    // A new window, which the app opens in the default browser, where the zip downloads.
    expect(link.target).toBe("_blank");
  });

  it("leaves the download link out while the daemon has no build to give", async () => {
    const card = await outdatedCard(404);
    expect(card.shadowRoot?.textContent).toContain("older build");
    expect(card.shadowRoot?.querySelector("a")).toBeNull();
  });

  it("offers Restart once the app has installed a newer build, and asks the app to restart", async () => {
    const invoke = vi.fn(async () => undefined);
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
    try {
      window.__I_INC_APP_VERSION__ = "0.3.202611150200";
      wireDesktop();
      window.__I_INC_APP_UPDATE__ = { version: "0.3.202611160900" };
      dispatchEvent(new Event("i-inc:app-update"));
      const card = document.querySelector("inc-app-update") as HTMLElement & {
        updateComplete: Promise<unknown>;
      };
      await card.updateComplete;
      expect(card.shadowRoot?.textContent).toContain("0.3.202611160900 is ready");
      const restart = card.shadowRoot?.querySelector("button") as HTMLButtonElement;
      restart.click();
      expect(invoke).toHaveBeenCalledWith("restart_app");
    } finally {
      delete window.__I_INC_APP_UPDATE__;
      delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });

  it("shows a note from Check for Updates for a few seconds", async () => {
    window.__I_INC_APP_VERSION__ = "0.3.202611150200";
    wireDesktop();
    dispatchEvent(new CustomEvent("i-inc:app-note", { detail: "The i.inc app is up to date (0.3.1)." }));
    const card = document.querySelector("inc-app-update") as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    await card.updateComplete;
    expect(card.shadowRoot?.textContent).toContain("up to date");
    vi.advanceTimersByTime(7000);
    expect(document.querySelector("inc-app-update")).toBeNull();
  });
});
