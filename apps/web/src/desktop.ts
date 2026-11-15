// Inside the desktop app (apps/desktop) the window has no system title bar: the shell's header is the title bar.
// The app sets `window.__I_INC_TITLEBAR__` on every page load; a browser or the installed PWA never does, so
// there nothing here changes and the header stays as it is.
//
// In the title bar the header is a drag region: Tauri moves the window from a press on any part of an element
// marked `data-tauri-drag-region="deep"` that is not a link, button, field or menu item (its script walks the
// event's composed path, so the mark works inside the shell's shadow root). On a Mac the header leaves room for
// the three window buttons, except in full screen, where macOS hides them.

declare global {
  interface Window {
    __I_INC_TITLEBAR__?: boolean;
  }
}

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
 * True when the window fills the screen: macOS full screen, where the window buttons are hidden until the
 * pointer reaches the top. The webview covers the whole window (the title bar is an overlay), so its size is
 * the window's.
 */
export function isFullScreen(
  view: { innerWidth: number; innerHeight: number },
  screen: { width: number; height: number },
): boolean {
  return view.innerWidth >= screen.width && view.innerHeight >= screen.height;
}

/** Says "change" when the window goes into or out of full screen. */
export const titlebarEvents = new EventTarget();

/** True while the desktop window fills the screen (its window buttons hidden). */
export function inFullScreen(): boolean {
  return document.documentElement.classList.contains("fullscreen");
}

let wired = false;

/** Marks the document (`in-app`, plus `mac` and `fullscreen` as they apply). Does nothing outside the app. */
export function wireDesktop(): void {
  if (wired || !inDesktopApp()) return;
  wired = true;
  const root = document.documentElement;
  root.classList.add("in-app");
  if (titlebarKind() === "mac") root.classList.add("mac");
  const update = () => {
    const full = isFullScreen(window, window.screen);
    if (root.classList.contains("fullscreen") === full) return;
    root.classList.toggle("fullscreen", full);
    titlebarEvents.dispatchEvent(new Event("change"));
  };
  update();
  addEventListener("resize", update);
}
