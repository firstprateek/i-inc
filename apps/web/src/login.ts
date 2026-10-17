// The owner sign-in and first-time signup form, shown when the daemon answers 401.
import { css, html, LitElement } from "lit";
import { authStatus, login, signup } from "./api.ts";
import { base } from "./components/shared.ts";

export class IncLogin extends LitElement {
  static override properties = {
    initialized: { state: true },
    username: { state: true },
    password: { state: true },
    error: { state: true },
    busy: { state: true },
  };
  declare initialized: boolean;
  declare username: string;
  declare password: string;
  declare error: string | null;
  declare busy: boolean;

  constructor() {
    super();
    this.initialized = true;
    this.username = "";
    this.password = "";
    this.error = null;
    this.busy = false;
  }

  override async connectedCallback(): Promise<void> {
    super.connectedCallback();
    try {
      const { initialized } = await authStatus();
      this.initialized = initialized;
    } catch {
      // Keep default sign-in view if status check fails.
    }
  }

  private async submit(event: Event) {
    event.preventDefault();
    this.busy = true;
    this.error = null;
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const username = (this.username || String(data.get("username") ?? "")).trim();
    const password = this.password || String(data.get("password") ?? "");
    try {
      const res = this.initialized ? await login(username, password) : await signup(username, password);
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
      form {
        width: calc(100% - 32px);
        max-width: 24rem;
        margin: 15vh auto;
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
        border: 1px solid var(--line-strong, var(--line));
        border-radius: 12px;
        font: inherit;
        background: var(--surface, var(--paper-2));
        color: var(--ink);
      }
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
      <form id="login" @submit=${this.submit}>
        <h1>${title}</h1>
        <p class="sub">${subtitle}</p>
        <label>
          Username
          <input
            name="username"
            type="text"
            autocomplete="username"
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
            type="password"
            autocomplete=${passwordAutocomplete}
            aria-label="Password"
            required
            .value=${this.password}
            @input=${(e: InputEvent) => {
              this.password = (e.target as HTMLInputElement).value;
            }}
          />
        </label>
        ${this.error ? html`<p id="login-error" class="error" role="alert">${this.error}</p>` : ""}
        <button type="submit" ?disabled=${this.busy}>${submitLabel}</button>
      </form>
    `;
  }
}

if (!customElements.get("inc-login")) {
  customElements.define("inc-login", IncLogin);
}

export function showLogin(): void {
  if (document.querySelector("inc-login")) return;
  document.body.innerHTML = "<inc-login></inc-login>";
}
