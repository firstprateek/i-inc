// The desktop app's own updates, as the page shows them (apps/desktop/src-tauri/src/updates.rs):
// - `i-inc:app-update`: a newer build is installed and a restart will run it. The header's "New version" chip,
//   next to the account button (components/app.ts), offers Restart; the app sends it again after every page load
//   until then. Restart asks the app (the one call the pages may make besides dragging and Reset,
//   capabilities/page.json).
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

/** Sent on `appUpdates` when the app has a newer build installed. */
export const APP_UPDATE_EVENT = "app-update-ready";
export const appUpdates = new EventTarget();
let readyVersion: string | null = null;

/** The newer build the app has installed and will run after a restart, if any. */
export const appUpdateReady = (): string | null => readyVersion;

/** For tests. */
export function resetAppUpdate(): void {
  readyVersion = null;
}

export function restartApp(): void {
  const invoke = (window as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__?.invoke;
  void invoke?.("restart_app").catch(() => {});
}

export class IncAppUpdate extends LitElement {
  static override properties = { note: { state: true } };
  declare note: string | null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    super();
    this.note = null;
  }

  say(text: string): void {
    this.note = text;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.note = null;
      this.remove();
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
    `,
  ];

  override render() {
    return this.note ? html`<div class="card note" role="status"><p>${this.note}</p></div>` : nothing;
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
      if (v !== readyVersion) {
        readyVersion = v;
        appUpdates.dispatchEvent(new Event(APP_UPDATE_EVENT));
      }
    }
  };
  addEventListener("i-inc:app-update", ready);
  addEventListener("i-inc:app-note", (e) => {
    const text = (e as CustomEvent<unknown>).detail;
    if (typeof text === "string" && text) card().say(text);
  });
  ready();
}
