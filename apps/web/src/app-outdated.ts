// Said once, in the desktop app, when the installed app is older than the pages (./desktop.ts,
// `MIN_APP_VERSION`): the pages deploy at once, the app on a laptop does not, and an old build looks broken in
// ways that are already fixed. A small card at the bottom left; it can be closed, and stays closed for the session.
import { css, html, LitElement } from "lit";
import { base } from "./components/shared.ts";

const CLOSED_KEY = "i-inc-app-outdated-closed";

export class IncAppOutdated extends LitElement {
  static override styles = [
    base,
    css`
      :host { position: fixed; left: 16px; bottom: 16px; z-index: 1000; max-width: min(420px, calc(100vw - 32px)); }
      .card { display: flex; align-items: center; gap: 12px; padding: 10px 8px 10px 16px; background: var(--surface);
        color: var(--ink); border: 1px solid var(--needs-edge, var(--line)); border-radius: 14px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.14), 0 2px 8px rgba(0, 0, 0, 0.06); font: 500 14px/1.4 var(--body); }
      p { margin: 0; flex: 1; }
      strong { font-weight: 700; }
      button { flex: none; width: 36px; height: 36px; border-radius: 50%; border: 0; background: transparent;
        color: var(--ink-2); font: 600 18px var(--body); cursor: pointer; }
      button:hover { background: var(--sunken); color: var(--ink); }
      button:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 2px; }
    `,
  ];

  private close = () => {
    try {
      sessionStorage.setItem(CLOSED_KEY, "1");
    } catch {}
    this.remove();
  };

  override render() {
    return html`<div class="card" role="status">
      <p><strong>This i.inc app is an older build.</strong> Some things may look wrong until it is updated.</p>
      <button type="button" aria-label="Close" @click=${this.close}>×</button>
    </div>`;
  }
}

if (!customElements.get("inc-app-outdated")) customElements.define("inc-app-outdated", IncAppOutdated);

/** Shows the card unless it is already up or was closed this session. */
export function showOutdatedApp(): void {
  try {
    if (sessionStorage.getItem(CLOSED_KEY)) return;
  } catch {}
  if (document.querySelector("inc-app-outdated")) return;
  document.body.append(new IncAppOutdated());
}
