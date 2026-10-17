import { css, html, LitElement } from "lit";
import { logout, refreshNow } from "../api.ts";
import { base } from "./shared.ts";
import "./office.ts";
import "./board.ts";
import "./ticket.ts";
import "./desk.ts";
import "./inbox.ts";
import "./hiring.ts";
import "./chat.ts";
import "./knowledge.ts";

type Route =
  | { view: "office" | "board" | "desk" | "inbox" | "hiring" | "handbook" | "more" }
  | { view: "brain"; id: string }
  | { view: "ticket"; id: string }
  | { view: "chat"; id: string };

/** Below this width the views are a bottom tab bar, not a row in the header. */
const phone = 900;

function parse(hash: string): Route {
  const [, view, id] = hash.split("/");
  if (view === "ticket" && id) return { view: "ticket", id };
  if (view === "chat") return { view: "chat", id: id ?? "" };
  if (view === "brain" && id) return { view: "brain", id };
  if (
    view === "board" ||
    view === "desk" ||
    view === "inbox" ||
    view === "hiring" ||
    view === "handbook" ||
    view === "more"
  )
    return { view };
  // Phones start at the inbox; desktops at the office (spec §10).
  return { view: matchMedia(`(max-width: ${phone}px)`).matches ? "inbox" : "office" };
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
      .mark { font-family: var(--display); font-weight: 700; font-size: 28px; letter-spacing: -0.8px; text-decoration: none;
        min-height: 44px; display: inline-flex; align-items: center; }
      nav { display: flex; gap: 4px; }
      nav a { padding: 10px 14px; border-radius: 999px; font-weight: 600; font-size: 15px; text-decoration: none; }
      nav a[aria-current="page"] { background: var(--ink); color: var(--on-ink); }
      .spacer { flex-grow: 1; }
      .icon { width: 44px; height: 44px; flex-shrink: 0; border-radius: 50%; border: 1px solid var(--line); background: transparent;
        color: var(--ink); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
      .sign-out { font-size: 13px; min-height: 36px; padding: 0 14px; }
      main { padding: 4px 32px 28px; }
      h1.page { font-size: 30px; margin: 4px 0 14px; }
      .more { display: flex; flex-direction: column; gap: 10px; max-width: 560px; padding: 0; margin: 0; list-style: none; }
      .more a { display: flex; flex-direction: column; justify-content: center; gap: 2px; min-height: 64px; box-sizing: border-box;
        padding: 10px 18px; text-decoration: none; }
      .more b { font-size: 17px; }
      .more span { font-size: 14px; color: var(--ink-2); }
      @media (max-width: 900px) {
        header { padding: 10px 16px; gap: 12px; }
        header nav { display: none; }
        .sign-out { min-height: 44px; }
        main { padding: 0 16px calc(88px + env(safe-area-inset-bottom)); }
        .tabs { position: fixed; inset: auto 0 0 0; z-index: 10; display: grid; grid-template-columns: repeat(5, 1fr);
          background: var(--surface); border-top: 1px solid var(--line); padding: 6px 4px calc(10px + env(safe-area-inset-bottom)); }
        .tabs a { display: flex; flex-direction: column; align-items: center; gap: 2px; min-height: 44px; justify-content: center;
          padding: 0; border-radius: 12px; font-size: 12px; font-weight: 600; text-decoration: none; }
        .tabs a[aria-current="page"] { background: transparent; color: var(--ink); font-weight: 800; text-decoration: underline; }
      }
      @media (min-width: 901px) { .tabs { display: none; } }
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
          ${link("chat", "Chat", v === "chat")}
          ${link("desk", "My desk", v === "desk")} ${link("handbook", "Handbook", v === "handbook" || v === "brain")}
          ${link("hiring", "Hiring", v === "hiring")}
          ${link("inbox", "Inbox", v === "inbox")}
        </nav>
        <span class="spacer"></span>
        <button class="icon" type="button" aria-label="Switch theme" @click=${this.toggleTheme}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"></path></svg>
        </button>
        <button class="btn ghost sign-out" type="button" @click=${() => logout()}>Sign out</button>
      </header>
      <main>${this.view()}</main>
      <nav class="tabs" aria-label="Views">
        ${link("inbox", "Inbox", v === "inbox")} ${link("office", "Office", v === "office")}
        ${link("board", "Board", v === "board" || v === "ticket")} ${link("chat", "Chats", v === "chat")}
        ${link("more", "More", v === "more" || v === "desk" || v === "hiring" || v === "handbook" || v === "brain")}
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
      case "chat":
        return html`<inc-chat .employeeId=${this.route.id}></inc-chat>`;
      case "ticket":
        return html`<inc-ticket .ticketId=${this.route.id}></inc-ticket>`;
      case "more":
        return html`<h1 class="page">More</h1>
          <ul class="more">
            ${[
              ["desk", "My desk", "Spend, where work waited, releases"],
              ["handbook", "Handbook", "What every employee knows"],
              ["hiring", "Hiring", "Add someone to the team"],
            ].map(
              ([to, name, what]) =>
                html`<li><a class="card" href="#/${to}"><b>${name}</b><span>${what}</span></a></li>`,
            )}
          </ul>`;
      case "handbook":
        return html`<inc-knowledge repo="handbook"></inc-knowledge>`;
      case "brain":
        return html`<inc-knowledge .repo=${this.route.id}></inc-knowledge>`;
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
