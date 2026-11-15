// The desktop app's own updates, as the page shows them (apps/desktop/src-tauri/src/updates.rs):
// - `i-inc:app-update`: a newer build is installed and a restart will run it. A card at the bottom left offers
//   Restart; the app sends it again after every page load until then. Restart asks the app (the one call the
//   pages may make besides dragging and Reset, capabilities/page.json).
// - `i-inc:app-note`: one line from i.inc › Check for Updates… ("up to date", or why not), shown for a few seconds.
import { css, html, LitElement, nothing } from "lit";
import { base } from "./components/shared.ts";

declare global {
  interface Window {
    /** Set by the app when a newer build is installed: its version. */
    __I_INC_APP_UPDATE__?: { version?: string };
  }
}

/** How long a note stays. */
export const NOTE_MS = 6000;

type Invoke = (cmd: string) => Promise<unknown>;

function restartApp(): void {
  const invoke = (window as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__?.invoke;
  void invoke?.("restart_app").catch(() => {});
}

export class IncAppUpdate extends LitElement {
  static override properties = {
    version: { state: true },
    note: { state: true },
  };
  declare version: string | null;
  declare note: string | null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    super();
    this.version = null;
    this.note = null;
  }

  ready(version: string): void {
    this.version = version;
  }

  say(text: string): void {
    this.note = text;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.note = null;
      if (!this.version) this.remove();
    }, NOTE_MS);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    clearTimeout(this.timer);
  }

  static override styles = [
    base,
    css`
      :host { position: fixed; left: 16px; bottom: 16px; z-index: 1001; display: flex; flex-direction: column; gap: 8px;
        max-width: min(420px, calc(100vw - 32px)); }
      .card { display: flex; align-items: center; gap: 12px; padding: 10px 10px 10px 16px; background: var(--surface);
        color: var(--ink); border: 1px solid var(--line); border-radius: 14px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.14), 0 2px 8px rgba(0, 0, 0, 0.06); font: 500 14px/1.4 var(--body); }
      p { margin: 0; flex: 1; }
      strong { font-weight: 700; }
      button { flex: none; min-height: 36px; padding: 0 16px; border-radius: 999px; border: 0; background: var(--ink);
        color: var(--on-ink); font: 600 14px var(--body); cursor: pointer; }
      button:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 2px; }
    `,
  ];

  override render() {
    return html`${
      this.version
        ? html`<div class="card" role="status">
            <p><strong>i.inc ${this.version} is ready.</strong> Restart the app to use it.</p>
            <button type="button" @click=${restartApp}>Restart</button>
          </div>`
        : nothing
    }${this.note ? html`<div class="card note" role="status"><p>${this.note}</p></div>` : nothing}`;
  }
}

if (!customElements.get("inc-app-update")) customElements.define("inc-app-update", IncAppUpdate);

function card(): IncAppUpdate {
  let el = document.querySelector("inc-app-update") as IncAppUpdate | null;
  if (!el) {
    el = new IncAppUpdate();
    document.body.append(el);
  }
  return el;
}

/** Follows the app's update events. In the app only (desktop.ts calls it). */
export function followAppUpdates(): void {
  const ready = () => {
    const v = window.__I_INC_APP_UPDATE__?.version;
    if (typeof v === "string" && v) {
      // A newer build makes the "older build" card moot.
      document.querySelector("inc-app-outdated")?.remove();
      card().ready(v);
    }
  };
  addEventListener("i-inc:app-update", ready);
  addEventListener("i-inc:app-note", (e) => {
    const text = (e as CustomEvent<unknown>).detail;
    if (typeof text === "string" && text) card().say(text);
  });
  ready();
}
