// Inside the desktop app (apps/desktop) the window has no system title bar: the shell's header is the title bar.
// The app sets `window.__I_INC_TITLEBAR__` on every page load; a browser or the installed PWA never does, so
// there nothing here changes and the header stays as it is.
//
// In the title bar the header is a drag region: Tauri moves the window from a press on any part of an element
// marked `data-tauri-drag-region="deep"` that is not a link, button, field or menu item (its script walks the
// event's composed path, so the mark works inside the shell's shadow root). On a Mac the header leaves room for
// the three window buttons, except in full screen, where macOS hides them.
//
// After each page load the app also tells the page its version (`__I_INC_APP_VERSION__`), whether the window is
// in full screen (`__I_INC_FULLSCREEN__`, again on every resize) and the page zoom (`__I_INC_ZOOM__`, with an
// `i-inc:zoom` event).

import { showOutdatedApp } from "./app-outdated.ts";
import { showZoomPopup } from "./zoom-popup.ts";

declare global {
  interface Window {
    __I_INC_TITLEBAR__?: boolean;
    /** The page zoom the app set (⌘+ / ⌘− / ⌘0), announced with an `i-inc:zoom` event. */
    __I_INC_ZOOM__?: number;
    /** Whether the app's window is in full screen, announced with an `i-inc:fullscreen` event. */
    __I_INC_FULLSCREEN__?: boolean;
    /** The app build's version (semver), set after each page load. Builds before 0.2.0 do not set it. */
    __I_INC_APP_VERSION__?: string;
  }
}

/**
 * The oldest app build these pages are made for. The pages deploy at once; the app on a laptop does not, so a
 * page newer than the app says so instead of looking broken (a title bar under the window buttons, a zoom with
 * no indicator). Raise it when the pages start to rely on something a newer app build does.
 */
export const MIN_APP_VERSION = "0.2.0";

/** True in the desktop app, which draws no title bar of its own. */
export function inDesktopApp(): boolean {
  return typeof window !== "undefined" && window.__I_INC_TITLEBAR__ === true;
}

/** "mac" when the window buttons sit over the header's left end; "plain" for the app elsewhere. */
export type Titlebar = "mac" | "plain";

export function titlebarKind(ua = navigator.userAgent): Titlebar {
  return /Mac/.test(ua) ? "mac" : "plain";
}

/**
 * A guess at full screen for an app build that does not say (before 0.2.0): the window is as big as the screen.
 * It uses the window's outer size, which page zoom does not change (the page's own size does).
 */
export function isFullScreen(
  view: { outerWidth: number; outerHeight: number },
  screen: { width: number; height: number },
): boolean {
  return view.outerWidth >= screen.width && view.outerHeight >= screen.height;
}

/** True when version `a` (semver, numbers only compared) is at least `b`. */
export function versionAtLeast(a: string, b: string): boolean {
  const parts = (v: string) =>
    v
      .split(/[.+-]/)
      .slice(0, 3)
      .map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return true;
}

/** Where the last zoom the app announced is kept, so a reload starts at that size before the app says again. */
const ZOOM_KEY = "i-inc-app-zoom";

function validZoom(z: unknown): z is number {
  return typeof z === "number" && Number.isFinite(z) && z > 0;
}

/**
 * The app's page zoom. It scales the page but not the window buttons, so the title bar undoes it (CSS `zoom`
 * of 1/z) to stay the buttons' height and keep clear of them. Until the app has said it after a load, the level
 * it said last time stands in (WebKit applies the zoom before the page has loaded).
 */
export function appZoom(): number {
  if (typeof window === "undefined") return 1;
  if (validZoom(window.__I_INC_ZOOM__)) return window.__I_INC_ZOOM__;
  try {
    const kept = Number(localStorage.getItem(ZOOM_KEY));
    if (inDesktopApp() && validZoom(kept)) return kept;
  } catch {}
  return 1;
}

/** Says "change" when the window goes into or out of full screen, or the app's zoom changes. */
export const titlebarEvents = new EventTarget();

/** True while the desktop window fills the screen (its window buttons hidden). */
export function inFullScreen(): boolean {
  return document.documentElement.classList.contains("fullscreen");
}

/** How long after a load an app build that says nothing about itself counts as older than these pages. */
export const APP_VERSION_WAIT_MS = 4000;

let wired = false;

/**
 * Marks the document (`in-app`, plus `mac` and `fullscreen` as they apply), follows full screen and zoom, and
 * says when the app is older than the pages. Does nothing outside the app. (The page never bounces on a
 * two-finger scroll: tokens.css sets `overscroll-behavior: none` on html and body everywhere.)
 */
export function wireDesktop(): void {
  if (wired || !inDesktopApp()) return;
  wired = true;
  const root = document.documentElement;
  root.classList.add("in-app");
  if (titlebarKind() === "mac") root.classList.add("mac");
  const setFull = (full: boolean) => {
    if (root.classList.contains("fullscreen") === full) return;
    root.classList.toggle("fullscreen", full);
    titlebarEvents.dispatchEvent(new Event("change"));
  };
  const guess = () => {
    if (typeof window.__I_INC_FULLSCREEN__ !== "boolean") setFull(isFullScreen(window, window.screen));
  };
  guess();
  addEventListener("resize", guess);
  addEventListener("i-inc:fullscreen", () => setFull(window.__I_INC_FULLSCREEN__ === true));
  addEventListener("i-inc:zoom", (e) => {
    if (validZoom(window.__I_INC_ZOOM__)) {
      try {
        localStorage.setItem(ZOOM_KEY, String(window.__I_INC_ZOOM__));
      } catch {}
    }
    titlebarEvents.dispatchEvent(new Event("change"));
    // ⌘+ / ⌘− / ⌘0 and Reset show the level; a page load reapplying it does not.
    if ((e as CustomEvent<{ show?: boolean }>).detail?.show) showZoomPopup(appZoom());
  });
  setTimeout(() => {
    const version = window.__I_INC_APP_VERSION__;
    if (!version || !versionAtLeast(version, MIN_APP_VERSION)) showOutdatedApp();
  }, APP_VERSION_WAIT_MS);
}

/** For tests: forget that the document was wired. */
export function resetDesktopForTests(): void {
  wired = false;
}
