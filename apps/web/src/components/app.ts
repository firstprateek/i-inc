import { css, html, LitElement } from "lit";
import { logout, refresh } from "../api.ts";
import { connection, isOffline } from "../connection.ts";
import { startLiveUpdates } from "../live.ts";
import { loadNeedsYouCount } from "../needs-you.ts";
import {
  AREAS,
  areaOf,
  COMPANY_TABS,
  companyTabHref,
  layoutForRoute,
  legacyTarget,
  parse,
  type Route,
  routeName,
  routeTitle,
  tabOf,
  WORK_TABS,
  workTabHref,
} from "../routes.ts";
import { arrive, ScrollMemory, stampEntry } from "../scroll-memory.ts";
import { LAYOUT_BREAKPOINTS } from "./layout.ts";
import { base } from "./shared.ts";
import "./office.ts";
import "./board.ts";
import "./ticket.ts";
import "./desk.ts";
import "./inbox.ts";
import "./hiring.ts";
import "./chat.ts";
import "./getting-started.ts";
import "./knowledge.ts";
import "./offline.ts";
import "./setup.ts";
import "./setup-projects.ts";

// The areas and their tabs live in ../routes.ts; the shell re-exports what the rest of the app and the
// tests read from here.
export { layoutForRoute, parse, type Route, routeName, routeTitle };

/** The customizable "All views" menu (T41) stored its pins here. The three areas replaced it. */
export const LEGACY_PINNED_KEY = "i-inc-nav-pinned";

const inboxIcon = html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"></polyline><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path></svg>`;
const companyIcon = html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21h18"></path><path d="M5 21V7l8-4v18"></path><path d="M19 21V11l-6-4"></path><line x1="9" y1="9" x2="9" y2="9.01"></line><line x1="9" y1="13" x2="9" y2="13.01"></line><line x1="9" y1="17" x2="9" y2="17.01"></line></svg>`;
const workIcon = html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="5" height="16" rx="1.5"></rect><rect x="10" y="4" width="5" height="10" rx="1.5"></rect><rect x="17" y="4" width="5" height="14" rx="1.5"></rect></svg>`;
const conversationsIcon = html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`;
const accountIcon = html`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`;

/** What the phone's bottom bar offers, and which routes light each tab up. */
const PHONE_TABS = [
  { id: "conversations", label: "Conversations", to: "conversations", icon: conversationsIcon },
  { id: "work", label: "Work", to: "work/board", icon: workIcon },
  { id: "needs-you", label: "Needs you", to: "work/needs-you", icon: inboxIcon },
  { id: "company", label: "Company", to: "company/team", icon: companyIcon },
] as const;

/** Which phone tab a route lights up: Needs you is Work's own tab, so Work lights up for the rest. */
export function phoneTabOf(r: Route): (typeof PHONE_TABS)[number]["id"] {
  if (r.view === "work" && r.tab === "needs-you") return "needs-you";
  return areaOf(r);
}

const AREA_SUBTITLES: Record<string, string> = {
  conversations: "Talk with an employee about any project.",
  work: "What is happening, what needs you, and what shipped.",
  company: "Who works here, what they know, and where they work.",
};

export class IncApp extends LitElement {
  static override properties = {
    route: { state: true },
    theme: { state: true },
    offline: { state: true },
    accountOpen: { state: true },
    needsCount: { state: true },
  };
  declare route: Route;
  declare offline: boolean;
  declare theme: "light" | "dark" | null;
  declare accountOpen: boolean;
  /** How many things wait for the owner; null until the first answer. */
  declare needsCount: number | null;
  private stopLive: (() => void) | null = null;
  // Scroll and focus across navigation (see scroll-memory.ts). <main> is the one scroll container.
  private memory = new ScrollMemory();
  private currentKey = "";
  /** The page being left has already had its scroll position saved (navigate() runs before the hashchange). */
  private left = false;
  private settleToken = 0;
  private needsToken = 0;
  private lastView: Route["view"] = "conversations";

  constructor() {
    super();
    this.route = parse(this.canonicalHash());
    this.lastView = this.route.view;
    this.theme = readTheme();
    this.offline = isOffline();
    this.accountOpen = false;
    this.needsCount = null;
  }

  /** An old hash is rewritten in place to its new one (no history entry); returns the hash to parse. */
  private canonicalHash(): string {
    const to = legacyTarget(location.hash);
    if (to) {
      try {
        history.replaceState(history.state, "", to);
      } catch {}
    }
    return to ?? location.hash;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    addEventListener("hashchange", this.onHash);
    connection.addEventListener("change", this.onConnection);
    refresh.addEventListener("refresh", this.loadNeeds);
    document.addEventListener("click", this.onDocumentClick);
    document.addEventListener("keydown", this.onDocumentKeydown);
    this.stopLive = startLiveUpdates();
    applyTheme(this.theme);
    // The shell keeps each page's scroll position itself, so the browser must not guess.
    try {
      history.scrollRestoration = "manual";
    } catch {}
    try {
      localStorage.removeItem(LEGACY_PINNED_KEY);
    } catch {}
    this.currentKey = stampEntry();
    document.title = routeTitle(this.route);
    void this.loadNeeds();
  }

  override willUpdate(): void {
    // Split routes own their pane scrolling. Every other route scrolls <main>.
    this.toggleAttribute("own-scroll", layoutForRoute(this.route) === "split");
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("route")) document.title = routeTitle(this.route);
    if (changed.has("accountOpen") && this.accountOpen) {
      this.renderRoot?.querySelector<HTMLElement>('.account-menu [role="menuitem"]')?.focus();
    }
  }

  override disconnectedCallback(): void {
    removeEventListener("hashchange", this.onHash);
    connection.removeEventListener("change", this.onConnection);
    refresh.removeEventListener("refresh", this.loadNeeds);
    document.removeEventListener("click", this.onDocumentClick);
    document.removeEventListener("keydown", this.onDocumentKeydown);
    this.stopLive?.();
    this.stopLive = null;
    super.disconnectedCallback();
  }

  /** The Needs you count, from the same data as the Needs you tab. A failed read keeps the last number. */
  private loadNeeds = async () => {
    const token = ++this.needsToken;
    try {
      const n = await loadNeedsYouCount();
      if (token === this.needsToken) this.needsCount = n;
    } catch {}
  };

  private onHash = () => {
    this.leave();
    const arrival = arrive(this.memory);
    this.currentKey = arrival.key;
    this.left = false;
    const from = this.lastView;
    this.route = parse(this.canonicalHash());
    this.lastView = this.route.view;
    this.accountOpen = false;
    void this.settle(arrival.top, from);
  };

  private main(): HTMLElement | null {
    return this.renderRoot?.querySelector?.<HTMLElement>("main") ?? null;
  }

  /** Remembers where the page being left was scrolled, once per navigation. */
  private leave(): void {
    if (this.left) return;
    this.left = true;
    this.memory.save(this.currentKey, this.main()?.scrollTop ?? 0);
  }

  /**
   * After a route change: put <main> at the top (a new page) or where it was (Back/Forward), then move
   * focus to the page heading without scrolling. A page whose data is still loading is not tall enough
   * yet, so a remembered position is retried for a moment, and given up on the moment the reader scrolls.
   */
  private async settle(top: number, from: Route["view"]): Promise<void> {
    const token = ++this.settleToken;
    await this.updateComplete;
    const main = this.main();
    if (!main || token !== this.settleToken) return;
    main.scrollTop = top;
    if (top > 0 && Math.round(main.scrollTop) < top - 1) {
      const stop = () => {
        this.settleToken++;
      };
      const events = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
      for (const ev of events) main.addEventListener(ev, stop, { once: true, passive: true });
      const until = performance.now() + 1500;
      const step = () => {
        if (token !== this.settleToken) return;
        main.scrollTop = top;
        if (Math.round(main.scrollTop) >= top - 1 || performance.now() > until) return;
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      setTimeout(() => {
        for (const ev of events) main.removeEventListener(ev, stop);
      }, 1600);
    }
    // Moving between sections of the same view (a conversation, a settings section) or along an area's
    // tab row from inside it keeps the reader's place; coming from anywhere else lands on the heading.
    const inside = this.shadowRoot?.activeElement;
    if (inside && main.contains(inside) && (from === this.route.view || inside.closest('[role="tablist"]')))
      return;
    this.renderRoot.querySelector<HTMLElement>("#view-heading")?.focus({ preventScroll: true });
  }

  private onConnection = () => {
    this.offline = isOffline();
  };

  private onDocumentClick = (e: MouseEvent) => {
    if (!this.accountOpen) return;
    const wrap = this.renderRoot?.querySelector?.(".account-wrap");
    if (wrap && !e.composedPath().includes(wrap)) this.accountOpen = false;
  };

  private onDocumentKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.accountOpen) {
      this.accountOpen = false;
      this.renderRoot?.querySelector?.<HTMLButtonElement>(".account-trigger")?.focus();
    }
  };

  /** The link to the page you are already on does not navigate: like the tab bar, it goes to the top. */
  private onHeaderClick = (e: MouseEvent) => {
    const a = e.composedPath().find((n): n is HTMLAnchorElement => n instanceof HTMLAnchorElement);
    if (!a || a.hash !== location.hash) return;
    const main = this.main();
    if (main) main.scrollTop = 0;
  };

  private toggleAccount = (e?: Event) => {
    e?.stopPropagation();
    this.accountOpen = !this.accountOpen;
  };

  /** Arrow keys walk the account menu's items. */
  private onMenuKey = (e: KeyboardEvent) => {
    const items = [
      ...(this.renderRoot?.querySelectorAll<HTMLElement>('.account-menu [role="menuitem"]') ?? []),
    ];
    const at = items.indexOf(e.target as HTMLElement);
    const to =
      e.key === "ArrowDown"
        ? (at + 1) % items.length
        : e.key === "ArrowUp"
          ? (at - 1 + items.length) % items.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? items.length - 1
              : -1;
    if (to < 0) return;
    e.preventDefault();
    items[to]?.focus();
  };

  /** An area's tab row is one tab stop: arrows, Home and End move between its tabs, Space opens one. */
  private onTabKey = (e: KeyboardEvent) => {
    const list = e.currentTarget as HTMLElement;
    const tabs = [...list.querySelectorAll<HTMLElement>('[role="tab"]')];
    const at = tabs.indexOf(e.target as HTMLElement);
    if (at < 0) return;
    if (e.key === " ") {
      e.preventDefault();
      tabs[at]?.click();
      return;
    }
    const to =
      e.key === "ArrowRight"
        ? (at + 1) % tabs.length
        : e.key === "ArrowLeft"
          ? (at - 1 + tabs.length) % tabs.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? tabs.length - 1
              : -1;
    if (to < 0) return;
    e.preventDefault();
    tabs[to]?.focus();
  };

  private isDark(): boolean {
    return this.theme ? this.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  }

  private toggleTheme() {
    this.theme = this.isDark() ? "light" : "dark";
    applyTheme(this.theme);
    try {
      localStorage.setItem("i-inc-theme", this.theme);
    } catch {}
    this.accountOpen = false;
  }

  static override styles = [
    base,
    css`
      /* The app shell (T40): the whole viewport is one grid. The header (and on phones the tab bar) are
         rows of it, so they can never scroll away; <main> is the row that scrolls. */
      :host {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        grid-template-rows: auto minmax(0, 1fr);
        grid-template-areas: "header" "main";
        height: 100vh;
        height: 100dvh;
        overflow: hidden;
        position: relative;
        background: var(--ground);
        color: var(--ink);
      }
      header {
        grid-area: header;
        position: relative;
        z-index: 20;
        display: flex; align-items: center; gap: 16px;
        padding: calc(12px + env(safe-area-inset-top)) max(var(--layout-gutter), calc((100% - var(--wide-width)) / 2), env(safe-area-inset-right)) 12px max(var(--layout-gutter), calc((100% - var(--wide-width)) / 2), env(safe-area-inset-left));
        border-bottom: 1px solid var(--line);
        background: var(--ground);
        -webkit-user-select: none; user-select: none;
      }
      /* The one scroller of every ordinary route. */
      main {
        grid-area: main;
        position: relative;
        min-height: 0;
        min-width: 0;
        overflow-x: hidden;
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-gutter: stable;
        scrollbar-width: thin;
        /* The shared Wide width aligns the app's working area with the route templates. */
        padding: 20px max(var(--layout-gutter), calc((100% - var(--wide-width)) / 2), env(safe-area-inset-right)) 28px max(var(--layout-gutter), calc((100% - var(--wide-width)) / 2), env(safe-area-inset-left));
      }
      main:focus, #view-heading:focus { outline: none; }
      header a, header button, .tabs button { -webkit-tap-highlight-color: transparent; cursor: pointer; }
      .mark { font-family: var(--display); font-weight: 700; font-size: 28px; letter-spacing: -0.8px; text-decoration: none;
        min-height: 44px; display: inline-flex; align-items: center; }
      nav.areas { display: flex; align-items: center; gap: 4px; }
      .mark, nav.areas a { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
      nav.areas a { display: inline-flex; align-items: center; min-height: 44px; box-sizing: border-box; padding: 0 16px;
        border-radius: 999px; font-weight: 600; font-size: 15px; text-decoration: none; }
      nav.areas a[aria-current="page"] { background: var(--ink); color: var(--on-ink); }
      .needs-link { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; box-sizing: border-box; padding: 0 14px;
        border-radius: 999px; border: 1px solid var(--line-strong); font-weight: 600; font-size: 15px; text-decoration: none; white-space: nowrap; }
      .needs-link[aria-current="page"] { background: var(--ink); color: var(--on-ink); border-color: var(--ink); }
      .count { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 22px; padding: 0 6px;
        box-sizing: border-box; border-radius: 999px; font-size: 12px; font-weight: 800; background: var(--neutral-bg); color: var(--neutral-fg); }
      .count.some { background: var(--needs-bg); color: var(--needs-fg); border: 1px solid var(--needs-edge); }
      .spacer { flex-grow: 1; }
      .account-wrap { position: relative; display: inline-flex; }
      .icon { width: 44px; height: 44px; flex-shrink: 0; border-radius: 50%; border: 1px solid var(--line-strong); background: transparent;
        color: var(--ink); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
      .icon:focus-visible, .account-menu button:focus-visible, nav.areas a:focus-visible, .needs-link:focus-visible,
      .mark:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 2px; }
      .account-menu { position: absolute; top: calc(100% + 8px); right: 0; z-index: 100; min-width: 200px; max-width: calc(100vw - 32px);
        box-sizing: border-box; padding: 6px; display: flex; flex-direction: column; gap: 2px; background: var(--surface);
        border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.14), 0 2px 8px rgba(0, 0, 0, 0.06); }
      .account-menu button { all: unset; box-sizing: border-box; display: flex; align-items: center; min-height: 44px; padding: 0 14px;
        border-radius: 10px; font: 600 15px var(--body); color: var(--ink); cursor: pointer; }
      .account-menu button:hover { background: var(--sunken); }
      .account-menu button:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: -3px; }
      a.btn { display: inline-flex; align-items: center; justify-content: center; text-decoration: none; box-sizing: border-box; }

      /* An area's tab row, in the page header: one row of pills, one tab stop, and a strip that scrolls
         sideways rather than wrapping when the tabs do not fit (a phone). */
      .subnav { display: flex; gap: 6px; margin: 12px -4px 0; padding: 4px; overflow-x: auto; overflow-y: hidden;
        overscroll-behavior-x: contain; scrollbar-width: none; }
      .subnav::-webkit-scrollbar { display: none; }
      .subnav a { flex: none; display: inline-flex; align-items: center; gap: 8px; min-height: 44px; box-sizing: border-box; padding: 0 16px;
        border-radius: 999px; border: 1px solid var(--line-strong); font-weight: 600; font-size: 15px; text-decoration: none;
        white-space: nowrap; color: var(--ink); -webkit-user-select: none; user-select: none; }
      .subnav a[aria-selected="true"] { background: var(--ink); color: var(--on-ink); border-color: var(--ink); }
      .subnav a:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 2px; }
      .back { display: inline-flex; align-items: center; min-height: 44px; font-weight: 600; font-size: 15px; text-decoration: none; }
      @media (max-width: 600px), (max-height: 520px) { [slot="subtitle"]:not(.back) { display: none; } }

      /* The conversation screen: the first-run checklist (when there is one) above the conversations. */
      .conv-host { display: flex; flex-direction: column; gap: 12px; height: 100%; min-height: 0; }
      .conv-host > inc-chat { flex: 1 1 0; min-height: 0; }
      .stack { display: flex; flex-direction: column; gap: var(--layout-section-gap, 20px); min-width: 0; }

      /* A narrow desktop window: keep the header to one row, since it no longer scrolls away. */
      @media (min-width: 901px) and (max-width: 1100px) {
        header { gap: 8px; padding-left: max(20px, env(safe-area-inset-left)); padding-right: max(20px, env(safe-area-inset-right)); }
        .mark { font-size: 24px; }
        nav.areas a { padding: 0 12px; }
      }
      @media (max-width: ${LAYOUT_BREAKPOINTS.phone}px) {
        /* Phones: header, main, tab bar are three rows of the grid. */
        :host {
          grid-template-rows: auto minmax(0, 1fr) auto;
          grid-template-areas: "header" "main" "tabs";
        }
        header {
          padding: calc(10px + env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) 10px max(16px, env(safe-area-inset-left));
          gap: 10px;
          background: var(--surface);
        }
        @supports ((backdrop-filter: blur(20px)) or (-webkit-backdrop-filter: blur(20px))) and (background: color-mix(in srgb, red, blue)) {
          header {
            background: color-mix(in srgb, var(--surface) 86%, transparent);
            backdrop-filter: blur(20px) saturate(180%);
            -webkit-backdrop-filter: blur(20px) saturate(180%);
          }
        }
        header nav.areas, header .needs-link { display: none; }
        main { padding: 12px max(16px, env(safe-area-inset-right)) 16px max(16px, env(safe-area-inset-left)); }
        .tabs {
          grid-area: tabs;
          position: relative;
          z-index: 20;
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          background: var(--surface);
          border-top: 1px solid var(--line);
          box-shadow: 0 -1px 3px rgba(0, 0, 0, 0.02);
          padding: 4px max(4px, env(safe-area-inset-right)) calc(8px + env(safe-area-inset-bottom)) max(4px, env(safe-area-inset-left));
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
          position: relative;
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
          position: relative;
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
        .tab-badge {
          position: absolute; top: -6px; right: -4px; min-width: 18px; height: 18px; padding: 0 5px; box-sizing: border-box;
          display: inline-flex; align-items: center; justify-content: center; border-radius: 9px;
          font-size: 11px; font-weight: 800; line-height: 1; background: var(--needs-bg); color: var(--needs-fg); border: 1px solid var(--needs-edge);
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

      /* A route that owns its scrolling (the conversations) turns <main> into a plain flex box that clips: the
         route lays its panes out inside it and scrolls them itself. */
      :host([own-scroll]) main {
        overflow: hidden;
        scrollbar-gutter: auto;
        display: flex;
        flex-direction: column;
        padding-top: 16px;
        padding-bottom: 20px;
      }
      :host([own-scroll]) inc-layout { flex: 1 1 0; min-height: 0; }
      @media (max-width: ${LAYOUT_BREAKPOINTS.phone}px) {
        /* No padding of its own, but the notch's side insets stay (the bars handle top and bottom). */
        :host([own-scroll]) main { padding: 0 env(safe-area-inset-right) 0 env(safe-area-inset-left); }
      }
    `,
  ];

  private navigate(to: string) {
    if (location.hash === `#/${to}`) {
      // The tab you are already on: like an app's tab bar, take it back to the top.
      const main = this.main();
      if (main) main.scrollTop = 0;
      return;
    }
    // Save the scroll position before the new page replaces this one in <main>.
    this.leave();
    location.hash = `#/${to}`;
    this.route = parse(location.hash);
  }

  /** The area's tab row in the page header, or nothing for a route that is on no tab. */
  private renderTabs() {
    const r = this.route;
    const area = areaOf(r);
    if (area === "conversations" || r.view === "ticket") return "";
    const active = tabOf(r);
    const work = area === "work";
    const items: { id: string; label: string; href: string }[] = work
      ? WORK_TABS.map(([id, label]) => ({ id, label, href: workTabHref(id) }))
      : COMPANY_TABS.map(([id, label]) => ({ id, label, href: companyTabHref(id) }));
    return html`<div slot="tabs" class="subnav" role="tablist" aria-label=${work ? "Work sections" : "Company sections"}
      @keydown=${this.onTabKey}>
      ${items.map(
        (
          t,
        ) => html`<a role="tab" id="tab-${t.id}" href=${t.href} aria-selected=${t.id === active ? "true" : "false"}
          aria-current=${t.id === active ? "page" : "false"} tabindex=${t.id === active ? "0" : "-1"}
          >${t.label}${t.id === "needs-you" && this.needsCount ? html` <span class="count some" aria-label="${this.needsCount} waiting">${this.needsCount}</span>` : ""}</a>`,
      )}
    </div>`;
  }

  /** The heading's subtitle and actions: a sentence on what the area is for, and its main action. */
  private renderHeadExtras() {
    const r = this.route;
    const area = areaOf(r);
    if (r.view === "ticket") {
      return html`<a slot="subtitle" class="back" href="#/work/board">← Back to Work</a>`;
    }
    return html`<p slot="subtitle">${AREA_SUBTITLES[area]}</p>
      ${
        r.view === "team"
          ? html`<a slot="actions" class="btn" href="#/company/team/hiring">Hire someone</a>`
          : r.view === "hiring"
            ? html`<a slot="actions" class="btn ghost" href="#/company/team">Back to the team</a>`
            : ""
      }`;
  }

  override render() {
    const tabRoute = phoneTabOf(this.route);
    const count = this.needsCount;
    const tab = (t: (typeof PHONE_TABS)[number]) => {
      const active = tabRoute === t.id;
      const n = t.id === "needs-you" ? count : null;
      return html`<button
        type="button"
        role="tab"
        aria-selected=${active ? "true" : "false"}
        aria-current=${active ? "page" : "false"}
        aria-label=${n ? `${t.label}, ${n} waiting` : t.label}
        @click=${() => this.navigate(t.to)}
      ><span class="tab-pill" aria-hidden="true">${t.icon}${n ? html`<span class="tab-badge">${n}</span>` : ""}</span><span class="tab-label">${t.label}</span></button>`;
    };
    const area = areaOf(this.route);
    const needsActive = this.route.view === "work" && this.route.tab === "needs-you";

    return html`
      <header @click=${this.onHeaderClick}>
        <a class="mark" href="#/conversations">i.inc</a>
        <nav class="areas" aria-label="Areas">
          ${AREAS.map((a) => html`<a href=${a.href} aria-current=${a.id === area ? "page" : "false"}>${a.label}</a>`)}
        </nav>
        <a class="needs-link" href="#/work/needs-you" aria-current=${needsActive ? "page" : "false"}
          aria-label=${count ? `Needs you, ${count} waiting` : "Needs you"}>Needs you${
            count === null
              ? ""
              : html`<span class="count ${count ? "some" : ""}" aria-hidden="true">${count}</span>`
          }</a>
        <span class="spacer"></span>
        <div class="account-wrap">
          <button class="icon account-trigger" type="button" aria-label="Account menu" aria-haspopup="menu"
            aria-expanded=${this.accountOpen ? "true" : "false"} @click=${this.toggleAccount}>${accountIcon}</button>
          ${
            this.accountOpen
              ? html`<div class="account-menu" role="menu" aria-label="Account" @keydown=${this.onMenuKey} @click=${(e: Event) => e.stopPropagation()}>
                  <button type="button" role="menuitem" @click=${() => this.toggleTheme()}>${this.isDark() ? "Switch to light theme" : "Switch to dark theme"}</button>
                  <button type="button" role="menuitem" @click=${() => logout()}>Sign out</button>
                </div>`
              : ""
          }
        </div>
      </header>
      <main tabindex="-1">
        <inc-layout .kind=${layoutForRoute(this.route)}>
          <h1 id="view-heading" tabindex="-1" slot="heading">${routeName(this.route).long}</h1>
          ${this.renderHeadExtras()}
          ${this.renderTabs()}
          ${this.offline ? html`<inc-offline></inc-offline>` : this.view()}
        </inc-layout>
      </main>
      <nav class="tabs" role="tablist" aria-label="Areas">
        ${PHONE_TABS.map(tab)}
      </nav>
    `;
  }

  private view() {
    const r = this.route;
    switch (r.view) {
      case "conversations":
        return html`<div class="conv-host"><inc-getting-started></inc-getting-started><inc-chat .employeeId=${r.id}></inc-chat></div>`;
      case "work":
        return r.tab === "board"
          ? html`<inc-board role="tabpanel" aria-labelledby="tab-board"></inc-board>`
          : r.tab === "needs-you"
            ? html`<inc-inbox role="tabpanel" aria-labelledby="tab-needs-you"></inc-inbox>`
            : html`<inc-desk show="releases" role="tabpanel" aria-labelledby="tab-releases"></inc-desk>`;
      case "ticket":
        return html`<inc-ticket .ticketId=${r.id}></inc-ticket>`;
      case "team":
        return html`<inc-office show="floor" role="tabpanel" aria-labelledby="tab-team"></inc-office>`;
      case "hiring":
        return html`<inc-hiring .employeeId=${r.id} role="tabpanel" aria-labelledby="tab-team"></inc-hiring>`;
      case "brain":
        return r.id
          ? html`<inc-knowledge .repo=${r.id} role="tabpanel" aria-labelledby="tab-brain"></inc-knowledge>`
          : html`<inc-knowledge repo="handbook" role="tabpanel" aria-labelledby="tab-brain"></inc-knowledge>`;
      case "projects":
        return html`<inc-setup-projects role="tabpanel" aria-labelledby="tab-projects"></inc-setup-projects>`;
      case "usage":
        return html`<div class="stack" role="tabpanel" aria-labelledby="tab-usage">
          <inc-desk show="usage"></inc-desk><inc-office show="meters"></inc-office></div>`;
      case "settings":
        return html`<inc-setup .section=${r.section} role="tabpanel" aria-labelledby="tab-settings"></inc-setup>`;
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
