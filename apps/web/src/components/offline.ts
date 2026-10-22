// A banner above the view while the daemon can't be reached. The view stays where it is, with what it
// had and anything typed into it; this keeps asking, so the app comes back by itself, and the owner can
// ask right now.
import { css, html, LitElement } from "lit";
import { send } from "../api.ts";
import { base } from "./shared.ts";

const RETRY_MS = 3000;

export class IncOffline extends LitElement {
  static override properties = { trying: { state: true } };
  declare trying: boolean;
  private timer = 0;

  constructor() {
    super();
    this.trying = false;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.timer = window.setInterval(() => void this.retry(), RETRY_MS);
    addEventListener("online", this.onOnline);
  }

  override disconnectedCallback(): void {
    clearInterval(this.timer);
    removeEventListener("online", this.onOnline);
    super.disconnectedCallback();
  }

  private onOnline = () => void this.retry();

  /** Any answer from the daemon (even a 401) reports it reachable, and the app swaps this panel out. */
  private async retry(): Promise<void> {
    if (this.trying) return;
    this.trying = true;
    try {
      await send("/api/auth");
    } catch {
      // Still unreachable; the next tick tries again.
    } finally {
      this.trying = false;
    }
  }

  static override styles = [
    base,
    css`
      :host { display: block; }
      .banner { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px 16px; box-sizing: border-box;
        background: var(--needs-surface); border: 2px solid var(--needs-edge); border-radius: var(--radius); }
      .mark { width: 32px; height: 32px; flex: none; border-radius: 50%; background: var(--needs-bg); color: var(--needs-fg);
        display: flex; align-items: center; justify-content: center; }
      .text { flex: 1 1 14rem; min-width: 0; }
      h2 { font-size: 16px; line-height: 1.25; }
      p { margin: 2px 0 0; font-size: 14px; line-height: 1.4; }
      .status { display: inline-flex; align-items: center; gap: 8px; margin-top: 4px; font-size: 13px; font-weight: 600; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--needs-edge); }
      .dot.trying { animation: pulse 1s ease-in-out infinite; }
      @keyframes pulse { 50% { opacity: 0.25; } }
      @media (prefers-reduced-motion: reduce) { .dot.trying { animation: none; } }
      .btn { flex: none; }
    `,
  ];

  override render() {
    return html`
      <section class="banner" role="status" aria-live="polite">
        <div class="mark" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 8.8a15 15 0 0 1 20 0"></path><path d="M5 12.5a10 10 0 0 1 14 0"></path>
            <path d="M8.5 16.2a5 5 0 0 1 7 0"></path><path d="M12 20h.01"></path><path d="M3 3l18 18"></path>
          </svg>
        </div>
        <div class="text">
          <h2>Can't reach i.inc</h2>
          <p class="muted">Your connection is down, or the office isn't answering. What's below is what was last loaded, and
            nothing you typed is lost.</p>
          <div class="status"><span class="dot ${this.trying ? "trying" : ""}"></span>Retrying every few seconds</div>
        </div>
        <button class="btn" type="button" @click=${() => void this.retry()}>Try now</button>
      </section>
    `;
  }
}

if (!customElements.get("inc-offline")) customElements.define("inc-offline", IncOffline);
