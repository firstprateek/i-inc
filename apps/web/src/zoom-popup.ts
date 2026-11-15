// The desktop app's zoom popup (./desktop.ts): after ⌘+ / ⌘− / ⌘0 it shows the zoom level in the window's
// bottom right corner, with a Reset button back to 100%, and goes away a few seconds later unless the pointer
// or the focus is on it. Like the title bar it undoes the page zoom, so it is always the same size.
import { css, html, LitElement } from "lit";
import { base } from "./components/shared.ts";

/** How long the popup stays after the last change, or after the pointer or focus leaves it. */
export const ZOOM_POPUP_MS = 3000;

/** The level as the popup says it: 1.1 is "110%". */
export function zoomLabel(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

type Invoke = (cmd: string) => Promise<unknown>;

/** Asks the app for 100% (the page cannot set its own zoom; capabilities/page.json allows this one call). */
function resetZoom(): void {
  const invoke = (window as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__?.invoke;
  void invoke?.("reset_zoom").catch(() => {});
}

export class IncZoomPopup extends LitElement {
  static override properties = {
    zoom: { state: true },
    open: { state: true },
  };
  declare zoom: number;
  declare open: boolean;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private held = false;

  constructor() {
    super();
    this.zoom = 1;
    this.open = false;
  }

  /** Shows `zoom` and starts the countdown again. */
  show(zoom: number): void {
    this.zoom = zoom;
    this.open = true;
    this.arm();
  }

  private arm() {
    clearTimeout(this.timer);
    if (this.held) return;
    this.timer = setTimeout(() => {
      this.open = false;
    }, ZOOM_POPUP_MS);
  }

  private hold = () => {
    this.held = true;
    clearTimeout(this.timer);
  };

  private release = () => {
    if (this.matches(":hover") || this.matches(":focus-within")) return;
    this.held = false;
    this.arm();
  };

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    clearTimeout(this.timer);
  }

  static override styles = [
    base,
    css`
      :host { position: fixed; right: 16px; bottom: 16px; z-index: 1000; }
      /* Closed, the host still has the card's size; it must not catch clicks meant for the page under it. */
      :host(:not([open])) { pointer-events: none; }
      .pop {
        display: flex; align-items: center; gap: 12px; padding: 6px 6px 6px 16px;
        background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-radius: 14px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.14), 0 2px 8px rgba(0, 0, 0, 0.06);
        font: 600 15px var(--body); font-variant-numeric: tabular-nums;
        transition: opacity 0.15s ease, transform 0.15s ease;
      }
      :host(:not([open])) .pop { opacity: 0; transform: translateY(8px); pointer-events: none; visibility: hidden; }
      .level { min-width: 3.2em; text-align: right; }
      button { min-height: 36px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--line-strong);
        background: transparent; color: var(--ink); font: 600 14px var(--body); cursor: pointer; }
      button:hover:not(:disabled) { background: var(--sunken); }
      button:disabled { opacity: 0.45; cursor: default; }
      button:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 2px; }
    `,
  ];

  override updated(): void {
    this.toggleAttribute("open", this.open);
    // The page zoom would scale the popup too: undo it, like the title bar.
    this.style.zoom = this.zoom === 1 ? "" : String(1 / this.zoom);
  }

  override render() {
    return html`<div class="pop" @pointerenter=${this.hold} @pointerleave=${this.release}
      @focusin=${this.hold} @focusout=${() => setTimeout(this.release)}>
      <span class="level" role="status" aria-live="polite" aria-label="Zoom ${zoomLabel(this.zoom)}">${zoomLabel(this.zoom)}</span>
      <button type="button" ?disabled=${this.zoom === 1} @click=${resetZoom}>Reset</button>
    </div>`;
  }
}

if (!customElements.get("inc-zoom-popup")) customElements.define("inc-zoom-popup", IncZoomPopup);

/** Shows the popup with `zoom`, adding it to the page if it is not there (sign-in replaces the body). */
export function showZoomPopup(zoom: number): IncZoomPopup {
  let pop = document.querySelector("inc-zoom-popup") as IncZoomPopup | null;
  if (!pop) {
    pop = new IncZoomPopup();
    document.body.append(pop);
  }
  pop.show(zoom);
  return pop;
}
