// The desktop app's zoom popup: after ⌘+ / ⌘− / ⌘0 the level shows in the bottom right with Reset, and goes
// away a few seconds later unless the pointer or focus is on it. A page load reapplying the zoom shows nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wireDesktop } from "../src/desktop.ts";
import { type IncZoomPopup, showZoomPopup, ZOOM_POPUP_MS, zoomLabel } from "../src/zoom-popup.ts";

const tick = async (pop: IncZoomPopup) => {
  await pop.updateComplete;
};

describe("the zoom popup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("says the level as a percentage", () => {
    expect(zoomLabel(0.8)).toBe("80%");
    expect(zoomLabel(1.1)).toBe("110%");
    expect(zoomLabel(1.2)).toBe("120%");
  });

  it("shows the level, then goes away by itself", async () => {
    const pop = showZoomPopup(1.1);
    await tick(pop);
    expect(pop.hasAttribute("open")).toBe(true);
    expect(pop.shadowRoot?.querySelector(".level")?.textContent).toBe("110%");
    // It undoes the page zoom, so it stays one size.
    expect(pop.style.zoom).toBe(String(1 / 1.1));
    vi.advanceTimersByTime(ZOOM_POPUP_MS + 10);
    await tick(pop);
    expect(pop.hasAttribute("open")).toBe(false);
  });

  it("starts the countdown again on each change, and is one popup", async () => {
    const pop = showZoomPopup(1.1);
    vi.advanceTimersByTime(ZOOM_POPUP_MS - 500);
    expect(showZoomPopup(1.2)).toBe(pop);
    vi.advanceTimersByTime(ZOOM_POPUP_MS - 500);
    await tick(pop);
    expect(pop.hasAttribute("open")).toBe(true);
    expect(pop.shadowRoot?.querySelector(".level")?.textContent).toBe("120%");
    expect(document.querySelectorAll("inc-zoom-popup").length).toBe(1);
  });

  it("stays while the pointer is on it", async () => {
    const pop = showZoomPopup(0.9);
    await tick(pop);
    const card = pop.shadowRoot?.querySelector(".pop") as HTMLElement;
    card.dispatchEvent(new Event("pointerenter"));
    vi.advanceTimersByTime(ZOOM_POPUP_MS * 3);
    await tick(pop);
    expect(pop.hasAttribute("open")).toBe(true);
  });

  it("asks the app for 100% from Reset, which is off at 100%", async () => {
    const invoke = vi.fn(async () => undefined);
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
    const pop = showZoomPopup(1.2);
    await tick(pop);
    const reset = pop.shadowRoot?.querySelector("button") as HTMLButtonElement;
    expect(reset.disabled).toBe(false);
    reset.click();
    expect(invoke).toHaveBeenCalledWith("reset_zoom");
    pop.show(1);
    await tick(pop);
    expect(reset.disabled).toBe(true);
  });

  it("is shown for a zoom change, not for a page load reapplying the level", async () => {
    window.__I_INC_TITLEBAR__ = true;
    try {
      wireDesktop();
      window.__I_INC_ZOOM__ = 1.1;
      dispatchEvent(new CustomEvent("i-inc:zoom", { detail: { show: false } }));
      expect(document.querySelector("inc-zoom-popup")).toBeNull();
      dispatchEvent(new CustomEvent("i-inc:zoom", { detail: { show: true } }));
      const pop = document.querySelector("inc-zoom-popup") as IncZoomPopup;
      await tick(pop);
      expect(pop.shadowRoot?.querySelector(".level")?.textContent).toBe("110%");
    } finally {
      delete window.__I_INC_TITLEBAR__;
      delete window.__I_INC_ZOOM__;
    }
  });
});
