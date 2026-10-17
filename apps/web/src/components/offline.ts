// Shown in place of the views while the daemon can't be reached. It keeps asking, so the app comes
// back by itself, and the owner can ask right now.
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
      .panel { max-width: 28rem; margin: 12vh auto 0; padding: 28px 24px; text-align: center; box-sizing: border-box;
        width: calc(100% - 8px); }
      .mark { width: 56px; height: 56px; margin: 0 auto 16px; border-radius: 50%; background: var(--needs-bg);
        color: var(--needs-fg); display: flex; align-items: center; justify-content: center; }
      h1 { font-size: 22px; line-height: 1.2; }
      p { margin: 8px 0 0; font-size: 15px; line-height: 1.5; }
      .status { display: inline-flex; align-items: center; gap: 8px; margin-top: 16px; font-size: 14px; font-weight: 600; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--needs-edge); }
      .dot.trying { animation: pulse 1s ease-in-out infinite; }
      @keyframes pulse { 50% { opacity: 0.25; } }
      @media (prefers-reduced-motion: reduce) { .dot.trying { animation: none; } }
      .btn { margin-top: 20px; }
    `,
  ];

  override render() {
    return html`
      <section class="card panel" role="status" aria-live="polite">
        <div class="mark" aria-hidden="true">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 8.8a15 15 0 0 1 20 0"></path><path d="M5 12.5a10 10 0 0 1 14 0"></path>
            <path d="M8.5 16.2a5 5 0 0 1 7 0"></path><path d="M12 20h.01"></path><path d="M3 3l18 18"></path>
          </svg>
        </div>
        <h1>Can't reach i.inc</h1>
        <p class="muted">Your connection is down, or the office isn't answering. This page checks again by itself.</p>
        <div class="status"><span class="dot ${this.trying ? "trying" : ""}"></span>Retrying every few seconds</div>
        <div><button class="btn" type="button" @click=${() => void this.retry()}>Try now</button></div>
      </section>
    `;
  }
}

if (!customElements.get("inc-offline")) customElements.define("inc-offline", IncOffline);
