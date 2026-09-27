// The shell: navigation, a hash router, the theme toggle, and a gentle refresh while visible.
import { css, html, LitElement } from "lit";
import { refreshNow } from "../api.ts";
import { base } from "./shared.ts";
import "./office.ts";
import "./board.ts";
import "./ticket.ts";
import "./desk.ts";
import "./inbox.ts";
import "./hiring.ts";

type Route = { view: "office" | "board" | "desk" | "inbox" | "hiring" } | { view: "ticket"; id: string };

function parse(hash: string): Route {
  const [, view, id] = hash.split("/");
  if (view === "ticket" && id) return { view: "ticket", id };
  if (view === "board" || view === "desk" || view === "inbox" || view === "hiring") return { view };
  // Phones start at the inbox; desktops at the office (spec §10).
  return { view: matchMedia("(max-width: 700px)").matches ? "inbox" : "office" };
}

export class IncApp extends LitElement {
  static override properties = { route: { state: true }, theme: { state: true } };
  declare route: Route;
  declare theme: "light" | "dark" | null;
  private timer = 0;

  constructor() {
    super();
    this.route = parse(location.hash);
    this.theme = readTheme();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    addEventListener("hashchange", this.onHash);
    this.timer = window.setInterval(() => document.visibilityState === "visible" && refreshNow(), 5000);
    applyTheme(this.theme);
  }

  override disconnectedCallback(): void {
    removeEventListener("hashchange", this.onHash);
    clearInterval(this.timer);
    super.disconnectedCallback();
  }

  private onHash = () => {
    this.route = parse(location.hash);
  };

  private toggleTheme() {
    const dark = this.theme ? this.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    this.theme = dark ? "light" : "dark";
    applyTheme(this.theme);
    try {
      localStorage.setItem("i-inc-theme", this.theme);
    } catch {}
  }

  static override styles = [
    base,
    css`
      header { display: flex; align-items: center; gap: 28px; padding: 12px 32px; }
      .mark { font-family: var(--display); font-weight: 700; font-size: 28px; letter-spacing: -0.8px; text-decoration: none; }
      nav { display: flex; gap: 4px; }
      nav a { padding: 10px 14px; border-radius: 999px; font-weight: 600; font-size: 15px; text-decoration: none; }
      nav a[aria-current="page"] { background: var(--ink); color: var(--on-ink); }
      .spacer { flex-grow: 1; }
      .icon { width: 44px; height: 44px; border-radius: 50%; border: 1px solid var(--line); background: transparent;
        color: var(--ink); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
      main { padding: 4px 32px 28px; }
      @media (max-width: 700px) {
        header { padding: 10px 16px; gap: 12px; }
        nav { display: none; }
        main { padding: 0 16px 96px; }
        .tabs { position: fixed; inset: auto 0 0 0; display: grid; grid-template-columns: repeat(3, 1fr);
          background: var(--surface); border-top: 1px solid var(--line); padding: 6px 8px calc(10px + env(safe-area-inset-bottom)); }
        .tabs a { display: flex; flex-direction: column; align-items: center; gap: 2px; min-height: 44px; justify-content: center;
          font-size: 12px; font-weight: 600; text-decoration: none; }
        .tabs a[aria-current="page"] { background: transparent; color: var(--ink); font-weight: 800; text-decoration: underline; }
      }
      @media (min-width: 701px) { .tabs { display: none; } }
    `,
  ];

  override render() {
    const v = this.route.view;
    const link = (to: string, label: string, active: boolean) =>
      html`<a href="#/${to}" aria-current=${active ? "page" : "false"}>${label}</a>`;
    return html`
      <header>
        <a class="mark" href="#/office">i.inc</a>
        <nav aria-label="Views">
          ${link("office", "Office", v === "office")} ${link("board", "Board", v === "board" || v === "ticket")}
          ${link("desk", "My desk", v === "desk")} ${link("hiring", "Hiring", v === "hiring")}
          ${link("inbox", "Inbox", v === "inbox")}
        </nav>
        <span class="spacer"></span>
        <button class="icon" type="button" aria-label="Switch theme" @click=${this.toggleTheme}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"></path></svg>
        </button>
      </header>
      <main>${this.view()}</main>
      <nav class="tabs" aria-label="Views">
        ${link("inbox", "Inbox", v === "inbox")} ${link("office", "Office", v === "office")}
        ${link("board", "Board", v === "board" || v === "ticket")}
      </nav>
    `;
  }

  private view() {
    switch (this.route.view) {
      case "office":
        return html`<inc-office></inc-office>`;
      case "board":
        return html`<inc-board></inc-board>`;
      case "desk":
        return html`<inc-desk></inc-desk>`;
      case "inbox":
        return html`<inc-inbox></inc-inbox>`;
      case "hiring":
        return html`<inc-hiring></inc-hiring>`;
      case "ticket":
        return html`<inc-ticket .ticketId=${this.route.id}></inc-ticket>`;
    }
  }
}

function readTheme(): "light" | "dark" | null {
  try {
    const t = localStorage.getItem("i-inc-theme");
    return t === "light" || t === "dark" ? t : null;
  } catch {
    return null;
  }
}

function applyTheme(t: "light" | "dark" | null) {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

customElements.define("inc-app", IncApp);
