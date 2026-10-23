// The owner sign-in and first-time signup form, shown when the daemon answers 401.
import { css, html, LitElement } from "lit";
import { authStatus, login, signup } from "./api.ts";
import { base } from "./components/shared.ts";
import "./components/layout.ts";
import { draftMemo } from "./drafts.ts";

export class IncLogin extends LitElement {
  static override properties = {
    initialized: { state: true },
    username: { state: true },
    password: { state: true },
    reveal: { state: true },
    setupCode: { state: true },
    setupCodeRequired: { state: true },
    error: { state: true },
    busy: { state: true },
  };
  declare initialized: boolean;
  declare username: string;
  declare password: string;
  /** The password is shown as text (the owner asked; off again after signing in). */
  declare reveal: boolean;
  declare setupCode: string;
  declare setupCodeRequired: boolean;
  declare error: string | null;
  declare busy: boolean;

  constructor() {
    super();
    this.initialized = true;
    this.username = "";
    this.password = "";
    this.reveal = false;
    this.setupCode = "";
    this.setupCodeRequired = false;
    this.error = null;
    this.busy = false;
  }

  override async connectedCallback(): Promise<void> {
    super.connectedCallback();
    this.titleNow();
    try {
      const { initialized, setupCodeRequired } = await authStatus();
      this.initialized = initialized;
      this.setupCodeRequired = !initialized && setupCodeRequired === true;
      this.titleNow();
    } catch {
      // Keep default sign-in view if status check fails.
    }
  }

  /** The tab says where you are: the app's last route title would be wrong here. */
  private titleNow() {
    document.title = `${this.initialized ? "Sign in" : "Create owner account"} · i.inc`;
  }

  private async submit(event: Event) {
    event.preventDefault();
    this.busy = true;
    this.error = null;
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const username = (this.username || String(data.get("username") ?? "")).trim();
    const password = this.password || String(data.get("password") ?? "");
    const setupCode = (this.setupCode || String(data.get("setupCode") ?? "")).trim();
    try {
      const res = this.initialized
        ? await login(username, password)
        : await signup(username, password, this.setupCodeRequired ? setupCode : undefined);
      if (res.ok) {
        location.reload();
      } else {
        this.error = res.error ?? (this.initialized ? "wrong username or password" : "signup failed");
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy = false;
    }
  }

  static override styles = [
    base,
    css`
      /* The document does not scroll (the app shell), so a short window scrolls the sign-in itself. */
      :host { display: block; height: 100vh; height: 100dvh; overflow-y: auto; box-sizing: border-box;
        padding: max(var(--layout-mobile-gutter, 16px), env(safe-area-inset-top))
          max(var(--layout-mobile-gutter, 16px), env(safe-area-inset-right))
          max(var(--layout-mobile-gutter, 16px), env(safe-area-inset-bottom))
          max(var(--layout-mobile-gutter, 16px), env(safe-area-inset-left)); }
      form {
        width: 100%;
        max-width: var(--compact-page-width, 24rem);
        margin: 0 auto;
        padding: 1.5rem;
        box-sizing: border-box;
        background: var(--surface, var(--paper-2));
        border: 1px solid var(--line);
        border-radius: var(--radius);
        font: 15px/1.5 var(--body);
        color: var(--ink);
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      h1 {
        font: 700 22px/1.2 var(--display);
        letter-spacing: -0.3px;
        margin: 0;
      }
      /* The checkbox is a 44px target with its words. */
      label.reveal { flex-direction: row; align-items: center; gap: 10px; min-height: 44px; font-weight: 600; }
      label.reveal input { width: 22px; min-height: 22px; height: 22px; padding: 0; accent-color: var(--ink); }
      .brand { font: 700 16px var(--display); letter-spacing: -0.2px; color: var(--ink-2); margin: 0 0 4px; }
      .sub {
        margin: 0;
        color: var(--ink-2);
      }
      label {
        font-size: 13px;
        font-weight: 600;
        color: var(--ink-2);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      input {
        width: 100%;
        min-height: 44px;
        box-sizing: border-box;
        padding: 0 12px;
        border: 1px solid var(--control-edge);
        border-radius: 12px;
        font: inherit;
        font-size: 16px;
        background: var(--surface, var(--paper-2));
        color: var(--ink);
      }
      .hint { font-weight: 400; font-size: 13px; color: var(--ink-2); }
      .hint code { font: 12px ui-monospace, monospace; overflow-wrap: anywhere; }
      .error {
        color: var(--alarm-fg);
        margin: 0;
      }
      button {
        min-height: 44px;
        padding: 0 18px;
        border: 0;
        border-radius: 999px;
        background: var(--ink, var(--accent));
        color: var(--on-ink);
        font: 700 15px var(--body);
        cursor: pointer;
        white-space: nowrap;
        align-self: flex-start;
      }
      @media (max-width: 480px) {
        form { padding: 1.25rem; }
        button { align-self: stretch; }
      }
    `,
  ];

  override render() {
    const title = this.initialized ? "Sign in" : "Create owner account";
    const subtitle = this.initialized
      ? "Sign in with your owner username and password."
      : "Choose a username and password (at least 8 characters) to secure this company.";
    const passwordAutocomplete = this.initialized ? "current-password" : "new-password";
    const submitLabel = this.initialized ? "Sign in" : "Create account";
    return html`
      <inc-layout kind="page" compact>
      <h1 slot="heading">${title}</h1>
      <p slot="subtitle">${subtitle}</p>
      <form id="login" @submit=${this.submit}>
        <p class="brand" aria-hidden="true">i.inc</p>
        <label>
          Username
          <input
            name="username"
            type="text"
            autocomplete="username"
            autocapitalize="none"
            autocorrect="off"
            spellcheck="false"
            enterkeyhint="next"
            aria-label="Username"
            required
            .value=${this.username}
            @input=${(e: InputEvent) => {
              this.username = (e.target as HTMLInputElement).value;
            }}
          />
        </label>
        <label>
          Password
          <input
            name="password"
            type=${this.reveal ? "text" : "password"}
            autocomplete=${passwordAutocomplete}
            enterkeyhint="go"
            aria-label="Password"
            required
            .value=${this.password}
            @input=${(e: InputEvent) => {
              this.password = (e.target as HTMLInputElement).value;
            }}
          />
        </label>
        <label class="reveal">
          <input type="checkbox" .checked=${this.reveal} @change=${(e: Event) => {
            this.reveal = (e.target as HTMLInputElement).checked;
          }} />
          Show password
        </label>
        ${
          this.setupCodeRequired
            ? html`<label>
                Setup code
                <input
                  name="setupCode"
                  type="text"
                  autocomplete="one-time-code"
                  autocapitalize="none"
                  autocorrect="off"
                  spellcheck="false"
                  enterkeyhint="next"
                  aria-label="Setup code"
                  aria-describedby="setup-hint"
                  required
                  .value=${this.setupCode}
                  @input=${(e: InputEvent) => {
                    this.setupCode = (e.target as HTMLInputElement).value;
                  }}
                />
                <span id="setup-hint" class="hint"
                  >The daemon logged this code when it started with no owner. On the Mac mini:
                  <code>cat ~/.i-inc/setup-code</code></span
                >
              </label>`
            : ""
        }
        ${this.error ? html`<p id="login-error" class="error" role="alert">${this.error}</p>` : ""}
        <button type="submit" ?disabled=${this.busy}>${submitLabel}</button>
      </form>
      </inc-layout>
    `;
  }
}

if (!customElements.get("inc-login")) {
  customElements.define("inc-login", IncLogin);
}

export function showLogin(): void {
  // Signed out or the session expired: forget unsent chat drafts, since one to a PA can hold home data.
  draftMemo.clearAll();
  if (document.querySelector("inc-login")) return;
  document.body.innerHTML = "<inc-login></inc-login>";
}
