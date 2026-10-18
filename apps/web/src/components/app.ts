import { css, html, LitElement } from "lit";
import { logout } from "../api.ts";
import { connection, isOffline } from "../connection.ts";
import { startLiveUpdates } from "../live.ts";
import { base } from "./shared.ts";
import "./office.ts";
import "./board.ts";
import "./ticket.ts";
import "./desk.ts";
import "./inbox.ts";
import "./hiring.ts";
import "./chat.ts";
import "./knowledge.ts";
import "./offline.ts";
import "./setup.ts";
import { isSection, type Section } from "./setup.ts";

type Route =
  | { view: "office" | "board" | "desk" | "inbox" | "hiring" | "handbook" | "more" }
  | { view: "hiring"; id: string }
  | { view: "brain"; id: string }
  | { view: "ticket"; id: string }
  | { view: "chat"; id: string }
  | { view: "setup"; section: Section };

/** Below this width the views are a bottom tab bar, not a row in the header. */
const phone = 900;

export function parse(hash: string): Route {
  const [, view, id] = hash.split("/");
  if (view === "ticket" && id) return { view: "ticket", id };
  if (view === "hiring" && id) return { view: "hiring", id };
  if (view === "chat") return { view: "chat", id: id ?? "" };
  if (view === "setup") return { view: "setup", section: isSection(id) ? id : "teams" };
  if (view === "brain" && id) return { view: "brain", id };
  if (
    view === "office" ||
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
  static override properties = { route: { state: true }, theme: { state: true }, offline: { state: true } };
  declare route: Route;
  declare offline: boolean;
  declare theme: "light" | "dark" | null;
  private stopLive: (() => void) | null = null;

  constructor() {
    super();
    this.route = parse(location.hash);
    this.theme = readTheme();
    this.offline = isOffline();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    addEventListener("hashchange", this.onHash);
    connection.addEventListener("change", this.onConnection);
    this.stopLive = startLiveUpdates();
    applyTheme(this.theme);
  }

  override disconnectedCallback(): void {
    removeEventListener("hashchange", this.onHash);
    connection.removeEventListener("change", this.onConnection);
    this.stopLive?.();
    this.stopLive = null;
    super.disconnectedCallback();
  }

  private onHash = () => {
    this.route = parse(location.hash);
  };

  private onConnection = () => {
    this.offline = isOffline();
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
      .mobile-view-title { display: none; }
      @media (max-width: 900px) {
        header {
          position: sticky;
          top: 0;
          z-index: 10;
          padding: calc(10px + env(safe-area-inset-top)) 16px 10px;
          gap: 10px;
          background: var(--surface);
          border-bottom: 1px solid var(--line);
        }
        @supports ((backdrop-filter: blur(20px)) or (-webkit-backdrop-filter: blur(20px))) and (background: color-mix(in srgb, red, blue)) {
          header {
            background: color-mix(in srgb, var(--surface) 86%, transparent);
            backdrop-filter: blur(20px) saturate(180%);
            -webkit-backdrop-filter: blur(20px) saturate(180%);
          }
        }
        header nav { display: none; }
        .mobile-view-title {
          display: inline-block;
          font-family: var(--display);
          font-weight: 600;
          font-size: 17px;
          color: var(--ink-2);
          letter-spacing: -0.3px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: calc(100vw - 160px);
          vertical-align: middle;
        }
        .sign-out { min-height: 44px; }
        main { padding: 8px 16px calc(88px + env(safe-area-inset-bottom)); }
        .tabs {
          position: fixed;
          inset: auto 0 0 0;
          z-index: 10;
          display: grid;
          grid-template-columns: repeat(5, 1fr);
          background: var(--surface);
          border-top: 1px solid var(--line);
          box-shadow: 0 -1px 3px rgba(0, 0, 0, 0.02);
          padding: 4px 4px calc(8px + env(safe-area-inset-bottom));
          user-select: none;
          -webkit-user-select: none;
          -webkit-touch-callout: none;
          -webkit-tap-highlight-color: transparent;
        }
        @supports ((backdrop-filter: blur(20px)) or (-webkit-backdrop-filter: blur(20px))) and (background: color-mix(in srgb, red, blue)) {
          .tabs {
            background: color-mix(in srgb, var(--surface) 86%, transparent);
            backdrop-filter: blur(20px) saturate(180%);
            -webkit-backdrop-filter: blur(20px) saturate(180%);
          }
        }
        .tabs button,
        .tabs [role="tab"] {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 2px;
          min-height: 44px;
          min-width: 44px;
          justify-content: center;
          padding: 2px 0;
          border: none;
          background: transparent;
          color: var(--ink-2);
          font-family: inherit;
          font-size: 11px;
          font-weight: 600;
          text-decoration: none;
          cursor: pointer;
          border-radius: 12px;
          user-select: none;
          -webkit-user-select: none;
          -webkit-touch-callout: none;
          -webkit-tap-highlight-color: transparent;
          transition: transform 0.08s ease, opacity 0.08s ease;
        }
        .tabs button:active,
        .tabs [role="tab"]:active {
          transform: scale(0.92);
          opacity: 0.7;
        }
        .tab-pill {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 44px;
          height: 26px;
          border-radius: 13px;
          background: transparent;
          color: inherit;
          transition: background 0.15s ease, color 0.15s ease;
        }
        .tab-pill svg {
          width: 19px;
          height: 19px;
          display: block;
        }
        .tab-label {
          font-size: 11px;
          line-height: 1.1;
          letter-spacing: -0.1px;
        }
        .tabs button[aria-current="page"],
        .tabs [role="tab"][aria-current="page"],
        .tabs button[aria-selected="true"],
        .tabs [role="tab"][aria-selected="true"] {
          background: transparent;
          color: var(--ink);
          font-weight: 800;
          text-decoration: none;
        }
        .tabs button[aria-selected="true"] .tab-pill,
        .tabs [role="tab"][aria-selected="true"] .tab-pill {
          background: var(--ink);
          color: var(--on-ink);
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
        }
        .tabs button:focus-visible,
        .tabs [role="tab"]:focus-visible {
          outline: 2px solid var(--reviewing-mark);
          outline-offset: -2px;
        }
      }
      @media (min-width: 901px) { .tabs { display: none; } }
    `,
  ];

  private navigate(to: string) {
    location.hash = `#/${to}`;
    this.route = parse(location.hash);
  }

  private viewTitle(): string {
    const r = this.route;
    switch (r.view) {
      case "inbox":
        return "Inbox";
      case "office":
        return "Office";
      case "board":
        return "Board";
      case "ticket":
        return r.id ? `Ticket #${r.id}` : "Ticket";
      case "chat": {
        if (r.id) {
          const name = r.id.charAt(0).toUpperCase() + r.id.slice(1);
          return `Chat · ${name}`;
        }
        return "Chats";
      }
      case "desk":
        return "My desk";
      case "handbook":
      case "brain":
        return "Company brain";
      case "hiring":
        return "Hiring";
      case "setup":
        return `Setup · ${r.section.charAt(0).toUpperCase() + r.section.slice(1)}`;
      case "more":
        return "More";
      default:
        return "";
    }
  }

  override render() {
    const v = this.route.view;
    const link = (to: string, label: string, active: boolean, title?: string) =>
      title
        ? html`<a href="#/${to}" aria-current=${active ? "page" : "false"} title=${title}>${label}</a>`
        : html`<a href="#/${to}" aria-current=${active ? "page" : "false"}>${label}</a>`;
    const tab = (to: string, label: string, active: boolean, icon: unknown) =>
      html`<button
        type="button"
        role="tab"
        aria-selected=${active ? "true" : "false"}
        aria-current=${active ? "page" : "false"}
        @click=${() => this.navigate(to)}
      ><span class="tab-pill" aria-hidden="true">${icon}</span><span class="tab-label">${label}</span></button>`;

    const inboxIcon = html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"></polyline><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path></svg>`;
    const officeIcon = html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21h18"></path><path d="M5 21V7l8-4v18"></path><path d="M19 21V11l-6-4"></path><line x1="9" y1="9" x2="9" y2="9.01"></line><line x1="9" y1="13" x2="9" y2="13.01"></line><line x1="9" y1="17" x2="9" y2="17.01"></line></svg>`;
    const boardIcon = html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="5" height="16" rx="1.5"></rect><rect x="10" y="4" width="5" height="10" rx="1.5"></rect><rect x="17" y="4" width="5" height="14" rx="1.5"></rect></svg>`;
    const chatIcon = html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`;
    const moreIcon = html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="14" width="7" height="7" rx="1.5"></rect><rect x="3" y="14" width="7" height="7" rx="1.5"></rect></svg>`;

    return html`
      <header>
        <a class="mark" href="#/office">i.inc</a>
        <span class="mobile-view-title" aria-hidden="true"> · ${this.viewTitle()}</span>
        <nav aria-label="Views">
          ${link("office", "Office", v === "office")} ${link("board", "Board", v === "board" || v === "ticket")}
          ${link("chat", "Chat", v === "chat")}
          ${link("desk", "My desk", v === "desk")} ${link("handbook", "Company brain / Handbook", v === "handbook" || v === "brain", "Company brain / Handbook")}
          ${link("hiring", "Hiring", v === "hiring")} ${link("setup/teams", "Setup", v === "setup")}
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
      <main>${this.offline ? html`<inc-offline></inc-offline>` : this.view()}</main>
      <nav class="tabs" role="tablist" aria-label="Views">
        ${tab("inbox", "Inbox", v === "inbox", inboxIcon)}
        ${tab("office", "Office", v === "office", officeIcon)}
        ${tab("board", "Board", v === "board" || v === "ticket", boardIcon)}
        ${tab("chat", "Chats", v === "chat", chatIcon)}
        ${tab("more", "More", v === "more" || v === "desk" || v === "hiring" || v === "handbook" || v === "brain" || v === "setup", moreIcon)}
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
        return html`<inc-hiring .employeeId=${"id" in this.route ? this.route.id : undefined}></inc-hiring>`;
      case "chat":
        return html`<inc-chat .employeeId=${this.route.id}></inc-chat>`;
      case "ticket":
        return html`<inc-ticket .ticketId=${this.route.id}></inc-ticket>`;
      case "more":
        return html`<h1 class="page">More</h1>
          <ul class="more">
            ${[
              ["desk", "My desk", "Spend, where work waited, releases"],
              [
                "handbook",
                "Company brain / Handbook",
                "Organisation-wide knowledge: policies, facts, and what every employee knows",
              ],
              ["hiring", "Hiring", "Add someone to the team"],
              ["setup/notifications", "Notifications", "Get a push when something needs you"],
              ["setup/teams", "Setup", "Teams, projects, engines and sandboxes"],
            ].map(
              ([to, name, what]) =>
                html`<li><a class="card" href="#/${to}"><b>${name}</b><span>${what}</span></a></li>`,
            )}
          </ul>`;
      case "setup":
        return html`<inc-setup .section=${this.route.section}></inc-setup>`;
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
