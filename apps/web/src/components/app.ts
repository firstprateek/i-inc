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

export type ViewCategory = "Workspace" | "Operations & Knowledge" | "Management";

export interface ViewDef {
  id: string;
  label: string;
  href: string;
  title?: string;
  description: string;
  category: ViewCategory;
  icon: unknown;
  isActive: (route: Route) => boolean;
}

const inboxIcon = html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"></polyline><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path></svg>`;
const officeIcon = html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21h18"></path><path d="M5 21V7l8-4v18"></path><path d="M19 21V11l-6-4"></path><line x1="9" y1="9" x2="9" y2="9.01"></line><line x1="9" y1="13" x2="9" y2="13.01"></line><line x1="9" y1="17" x2="9" y2="17.01"></line></svg>`;
const boardIcon = html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="5" height="16" rx="1.5"></rect><rect x="10" y="4" width="5" height="10" rx="1.5"></rect><rect x="17" y="4" width="5" height="14" rx="1.5"></rect></svg>`;
const chatIcon = html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`;
const moreIcon = html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="14" width="7" height="7" rx="1.5"></rect><rect x="3" y="14" width="7" height="7" rx="1.5"></rect></svg>`;
const deskIcon = html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>`;
const handbookIcon = html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>`;
const hiringIcon = html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><line x1="19" y1="8" x2="19" y2="14"></line><line x1="22" y1="11" x2="16" y2="11"></line></svg>`;
const setupIcon = html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line></svg>`;
const notificationsIcon = html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>`;

export const VIEW_CATALOG: ViewDef[] = [
  {
    id: "inbox",
    label: "Inbox",
    href: "inbox",
    description: "Items needing your attention and notifications",
    category: "Workspace",
    icon: inboxIcon,
    isActive: (r) => r.view === "inbox",
  },
  {
    id: "office",
    label: "Office",
    href: "office",
    description: "Floor plan, employees, harnesses and meters",
    category: "Workspace",
    icon: officeIcon,
    isActive: (r) => r.view === "office",
  },
  {
    id: "board",
    label: "Board",
    href: "board",
    description: "Ticket kanban board and active work",
    category: "Workspace",
    icon: boardIcon,
    isActive: (r) => r.view === "board" || r.view === "ticket",
  },
  {
    id: "chat",
    label: "Chat",
    href: "chat",
    description: "1:1 messaging with company employees",
    category: "Workspace",
    icon: chatIcon,
    isActive: (r) => r.view === "chat",
  },
  {
    id: "desk",
    label: "My desk",
    href: "desk",
    description: "Spend, where work waited, releases",
    category: "Operations & Knowledge",
    icon: deskIcon,
    isActive: (r) => r.view === "desk",
  },
  {
    id: "handbook",
    label: "Company brain / Handbook",
    title: "Company brain / Handbook",
    href: "handbook",
    description: "Organisation-wide knowledge: policies and facts",
    category: "Operations & Knowledge",
    icon: handbookIcon,
    isActive: (r) => r.view === "handbook" || r.view === "brain",
  },
  {
    id: "hiring",
    label: "Hiring",
    href: "hiring",
    description: "Add someone to the team",
    category: "Management",
    icon: hiringIcon,
    isActive: (r) => r.view === "hiring",
  },
  {
    id: "setup",
    label: "Setup",
    href: "setup/teams",
    description: "Teams, projects, engines and sandboxes",
    category: "Management",
    icon: setupIcon,
    isActive: (r) => r.view === "setup" && r.section !== "notifications",
  },
  {
    id: "notifications",
    label: "Notifications",
    href: "setup/notifications",
    description: "Web push notifications and alerts",
    category: "Management",
    icon: notificationsIcon,
    isActive: (r) => r.view === "setup" && r.section === "notifications",
  },
];

export const CATEGORIES: ViewCategory[] = ["Workspace", "Operations & Knowledge", "Management"];

export const DEFAULT_PINNED_VIEWS: string[] = [
  "office",
  "board",
  "chat",
  "desk",
  "handbook",
  "hiring",
  "setup",
  "inbox",
];

export const STORAGE_KEY_PINNED = "i-inc-nav-pinned";

export function readPinnedViews(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PINNED);
    if (!raw) return [...DEFAULT_PINNED_VIEWS];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const valid = parsed.filter(
        (id): id is string => typeof id === "string" && VIEW_CATALOG.some((v) => v.id === id),
      );
      if (valid.length > 0) return Array.from(new Set(valid));
    }
  } catch {}
  return [...DEFAULT_PINNED_VIEWS];
}

export function savePinnedViews(views: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY_PINNED, JSON.stringify(views));
  } catch {}
}

export class IncApp extends LitElement {
  static override properties = {
    route: { state: true },
    theme: { state: true },
    offline: { state: true },
    allViewsOpen: { state: true },
    pinnedViews: { state: true },
  };
  declare route: Route;
  declare offline: boolean;
  declare theme: "light" | "dark" | null;
  declare allViewsOpen: boolean;
  declare pinnedViews: string[];
  private stopLive: (() => void) | null = null;

  constructor() {
    super();
    this.route = parse(location.hash);
    this.theme = readTheme();
    this.offline = isOffline();
    this.allViewsOpen = false;
    this.pinnedViews = readPinnedViews();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    addEventListener("hashchange", this.onHash);
    connection.addEventListener("change", this.onConnection);
    document.addEventListener("click", this.onDocumentClick);
    document.addEventListener("keydown", this.onDocumentKeydown);
    this.stopLive = startLiveUpdates();
    applyTheme(this.theme);
  }

  override willUpdate(): void {
    // The chat route is an app-like screen: exactly the viewport, with the panes scrolling inside it.
    // Every other route is a document that scrolls as usual. The attribute styles the shell; the
    // flag on <html> stops the document itself from being taller than the screen (see tokens.css).
    const fill = this.route.view === "chat";
    this.toggleAttribute("fill", fill);
    if (fill) document.documentElement.dataset.fill = "";
    else delete document.documentElement.dataset.fill;
  }

  override disconnectedCallback(): void {
    delete document.documentElement.dataset.fill;
    removeEventListener("hashchange", this.onHash);
    connection.removeEventListener("change", this.onConnection);
    document.removeEventListener("click", this.onDocumentClick);
    document.removeEventListener("keydown", this.onDocumentKeydown);
    this.stopLive?.();
    this.stopLive = null;
    super.disconnectedCallback();
  }

  private onHash = () => {
    this.route = parse(location.hash);
    this.allViewsOpen = false;
  };

  private onConnection = () => {
    this.offline = isOffline();
  };

  private onDocumentClick = (e: MouseEvent) => {
    if (!this.allViewsOpen) return;
    const path = e.composedPath();
    const dropdown = this.renderRoot?.querySelector?.(".all-views-wrap");
    if (dropdown && !path.includes(dropdown)) {
      this.allViewsOpen = false;
    }
  };

  private onDocumentKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.allViewsOpen) {
      this.allViewsOpen = false;
      const trigger = this.renderRoot?.querySelector?.<HTMLButtonElement>(".all-views-trigger");
      trigger?.focus();
    }
  };

  private toggleAllViews = (e?: Event) => {
    e?.stopPropagation();
    this.allViewsOpen = !this.allViewsOpen;
  };

  private togglePin(id: string) {
    const idx = this.pinnedViews.indexOf(id);
    if (idx >= 0) {
      if (this.pinnedViews.length <= 1) return;
      this.pinnedViews = this.pinnedViews.filter((v) => v !== id);
    } else {
      this.pinnedViews = [...this.pinnedViews, id];
    }
    savePinnedViews(this.pinnedViews);
  }

  private movePinnedView(id: string, delta: number) {
    const idx = this.pinnedViews.indexOf(id);
    if (idx === -1) return;
    const targetIdx = idx + delta;
    if (targetIdx < 0 || targetIdx >= this.pinnedViews.length) return;
    const next = [...this.pinnedViews];
    const item = next[idx];
    if (!item) return;
    next.splice(idx, 1);
    next.splice(targetIdx, 0, item);
    this.pinnedViews = next;
    savePinnedViews(this.pinnedViews);
  }

  private resetPinnedViews = () => {
    this.pinnedViews = [...DEFAULT_PINNED_VIEWS];
    try {
      localStorage.removeItem(STORAGE_KEY_PINNED);
    } catch {}
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
      header { display: flex; align-items: center; gap: 24px; padding: 12px 32px; }
      .mark { font-family: var(--display); font-weight: 700; font-size: 28px; letter-spacing: -0.8px; text-decoration: none;
        min-height: 44px; display: inline-flex; align-items: center; }
      nav { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
      .pinned-links { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
      nav a { padding: 10px 14px; border-radius: 999px; font-weight: 600; font-size: 15px; text-decoration: none; }
      nav a[aria-current="page"] { background: var(--ink); color: var(--on-ink); }
      .all-views-wrap {
        position: relative;
        display: inline-flex;
        align-items: center;
      }
      .all-views-trigger {
        padding: 8px 14px;
        border-radius: 999px;
        font-weight: 600;
        font-size: 14px;
        background: transparent;
        color: var(--ink);
        border: 1px solid var(--line-strong);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 40px;
        box-sizing: border-box;
        transition: background 0.12s ease, border-color 0.12s ease;
      }
      .all-views-trigger:hover,
      .all-views-trigger.open {
        background: var(--sunken);
        border-color: var(--line);
      }
      .all-views-trigger:focus-visible {
        outline: 3px solid var(--reviewing-mark);
        outline-offset: 2px;
      }
      .chevron-icon {
        transition: transform 0.15s ease;
      }
      .chevron-icon.rotated {
        transform: rotate(180deg);
      }
      .all-views-dropdown {
        position: absolute;
        top: calc(100% + 8px);
        left: 0;
        width: 440px;
        max-width: calc(100vw - 32px);
        max-height: calc(85vh - 60px);
        overflow-y: auto;
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: 16px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.14), 0 2px 8px rgba(0, 0, 0, 0.06);
        padding: 16px;
        z-index: 100;
        box-sizing: border-box;
      }
      @media (prefers-color-scheme: dark) {
        .all-views-dropdown {
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.25);
        }
      }
      :host-context([data-theme="dark"]) .all-views-dropdown {
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.25);
      }
      .dropdown-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 12px;
        padding-bottom: 10px;
        border-bottom: 1px solid var(--line);
      }
      .header-titles {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .dropdown-title {
        font-size: 16px;
        font-family: var(--display);
        font-weight: 700;
        margin: 0;
        color: var(--ink);
      }
      .dropdown-subtitle {
        font-size: 12px;
        color: var(--ink-2);
        margin: 0;
      }
      .dropdown-actions {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .reset-btn {
        font-size: 12px;
        padding: 0 10px;
        min-height: 30px;
        border-radius: 6px;
      }
      .close-btn {
        width: 30px;
        height: 30px;
        border-radius: 50%;
        border: 1px solid var(--line);
        background: transparent;
        color: var(--ink);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      .close-btn:hover {
        background: var(--sunken);
      }
      .categories-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .category-section {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .category-heading {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.6px;
        color: var(--ink-2);
        margin: 4px 0 2px 4px;
      }
      .category-items {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .view-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 6px 8px;
        border-radius: 10px;
        border: 1px solid transparent;
        transition: background 0.12s ease;
      }
      .view-row:hover {
        background: var(--sunken);
      }
      .view-row.is-active {
        background: color-mix(in srgb, var(--reviewing-bg) 40%, var(--surface));
        border-color: var(--reviewing-edge);
      }
      .view-link {
        display: flex;
        align-items: center;
        gap: 10px;
        flex: 1 1 auto;
        min-width: 0;
        text-decoration: none;
        color: inherit;
        border-radius: 6px;
      }
      .view-link:focus-visible {
        outline: 2px solid var(--reviewing-mark);
        outline-offset: 2px;
      }
      .view-icon {
        width: 32px;
        height: 32px;
        border-radius: 8px;
        background: var(--sunken);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        color: var(--ink);
      }
      .view-meta {
        display: flex;
        flex-direction: column;
        gap: 1px;
        min-width: 0;
        overflow: hidden;
      }
      .view-title-line {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .view-label {
        font-weight: 600;
        font-size: 14px;
        color: var(--ink);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .view-desc {
        font-size: 12px;
        color: var(--ink-2);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .active-pill {
        font-size: 10px;
        padding: 1px 6px;
        background: var(--reviewing-bg);
        color: var(--reviewing-fg);
        border: 1px solid var(--reviewing-edge);
        border-radius: 999px;
        font-weight: 700;
      }
      .view-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
      }
      .reorder-group {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        background: var(--sunken);
        padding: 2px 4px;
        border-radius: 6px;
        border: 1px solid var(--line);
      }
      .pos-badge {
        font-family: var(--mono);
        font-size: 11px;
        font-weight: 700;
        color: var(--ink-2);
        padding: 0 4px;
      }
      .reorder-btn {
        width: 20px;
        height: 20px;
        border: none;
        background: transparent;
        color: var(--ink);
        cursor: pointer;
        border-radius: 4px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 9px;
        padding: 0;
        line-height: 1;
      }
      .reorder-btn:hover:not(:disabled) {
        background: var(--surface);
      }
      .reorder-btn:disabled {
        opacity: 0.25;
        cursor: not-allowed;
      }
      .reorder-btn:focus-visible {
        outline: 2px solid var(--reviewing-mark);
        outline-offset: 1px;
      }
      .pin-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 12px;
        font-weight: 600;
        padding: 4px 10px;
        border-radius: 999px;
        cursor: pointer;
        border: 1px solid var(--line-strong);
        background: transparent;
        color: var(--ink);
        min-height: 28px;
        transition: background 0.12s ease, border-color 0.12s ease;
      }
      .pin-btn:hover:not(:disabled) {
        background: var(--sunken);
      }
      .pin-btn.pinned {
        background: var(--reviewing-bg);
        color: var(--reviewing-fg);
        border-color: var(--reviewing-edge);
      }
      .pin-btn.pinned:hover:not(:disabled) {
        background: color-mix(in srgb, var(--reviewing-bg) 80%, black);
      }
      .pin-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .pin-btn:focus-visible {
        outline: 2px solid var(--reviewing-mark);
        outline-offset: 2px;
      }
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
      .sign-out .short-icon { display: none; }
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
          display: block;
          flex: 1 1 auto;
          min-width: 0;
          font-family: var(--display);
          font-weight: 600;
          font-size: 17px;
          color: var(--ink-2);
          letter-spacing: -0.3px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .mobile-view-title .short { display: none; }
        .spacer { display: none; }
        .sign-out { min-height: 44px; }
        @media (max-width: 420px) {
          header { gap: 6px; }
          .sign-out { width: 44px; padding: 0; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
          .sign-out .short-icon { display: block; }
          .sign-out .label {
            position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
            clip-path: inset(50%); white-space: nowrap; border: 0;
          }
        }
        @media (max-width: 359px) {
          .mobile-view-title .long { display: none; }
          .mobile-view-title .short { display: inline; }
        }
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

      /* The chat route: header, then the chat taking all the rest of the viewport, and on a phone the
         tab bar in the flow below it instead of floating over the page. Nothing here scrolls the page. */
      :host([fill]) { height: 100%; display: flex; flex-direction: column; overflow: hidden; }
      :host([fill]) header { flex: none; }
      :host([fill]) main { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; padding: 4px 32px 20px; }
      :host([fill]) inc-chat { flex: 1 1 0; min-height: 0; }
      @media (max-width: 900px) {
        :host([fill]) main { padding: 0; }
        :host([fill]) .tabs { position: static; flex: none; }
      }
    `,
  ];

  private navigate(to: string) {
    location.hash = `#/${to}`;
    this.route = parse(location.hash);
  }

  // The mobile header title: the full name, and a short form used on very narrow screens (under 360px)
  // so it never has to be cut off with an ellipsis.
  private viewTitle(): { long: string; short: string } {
    const r = this.route;
    const same = (t: string) => ({ long: t, short: t });
    const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
    switch (r.view) {
      case "inbox":
        return same("Inbox");
      case "office":
        return same("Office");
      case "board":
        return same("Board");
      case "ticket":
        return r.id ? { long: `Ticket #${r.id}`, short: `#${r.id}` } : same("Ticket");
      case "chat":
        return r.id ? same(cap(r.id)) : same("Chats");
      case "desk":
        return { long: "My desk", short: "Desk" };
      case "handbook":
      case "brain":
        return { long: "Company brain", short: "Brain" };
      case "hiring":
        return same("Hiring");
      case "setup":
        return same(cap(r.section));
      case "more":
        return same("More");
      default:
        return same("");
    }
  }

  private mobileTitle() {
    const t = this.viewTitle();
    return html`<span class="mobile-view-title" aria-hidden="true"><span class="long">${t.long}</span><span class="short">${t.short}</span></span>`;
  }

  private renderAllViewsDropdown() {
    return html`
      <div
        class="all-views-dropdown"
        role="dialog"
        aria-label="All views and customize navigation"
        @click=${(e: Event) => e.stopPropagation()}
      >
        <div class="dropdown-header">
          <div class="header-titles">
            <span class="dropdown-title">All views</span>
            <span class="dropdown-subtitle">Pin & re-arrange views on the top bar</span>
          </div>
          <div class="dropdown-actions">
            <button
              class="btn ghost reset-btn"
              type="button"
              @click=${this.resetPinnedViews}
              title="Reset navigation bar to default views"
            >
              Reset
            </button>
            <button
              class="close-btn"
              type="button"
              aria-label="Close all views menu"
              @click=${() => {
                this.allViewsOpen = false;
              }}
            >
              ✕
            </button>
          </div>
        </div>

        <div class="categories-list">
          ${CATEGORIES.map((cat) => {
            const items = VIEW_CATALOG.filter((v) => v.category === cat);
            if (items.length === 0) return "";
            return html`
              <section class="category-section">
                <h3 class="category-heading">${cat}</h3>
                <div class="category-items">
                  ${items.map((item) => {
                    const pinnedIndex = this.pinnedViews.indexOf(item.id);
                    const isPinned = pinnedIndex >= 0;
                    const isActive = item.isActive(this.route);
                    return html`
                      <div class="view-row ${isPinned ? "is-pinned" : ""} ${isActive ? "is-active" : ""}">
                        <a
                          href="#/${item.href}"
                          class="view-link"
                          @click=${() => {
                            this.allViewsOpen = false;
                          }}
                        >
                          <span class="view-icon" aria-hidden="true">${item.icon}</span>
                          <span class="view-meta">
                            <span class="view-title-line">
                              <span class="view-label">${item.label}</span>
                              ${isActive ? html`<span class="active-pill">Current</span>` : ""}
                            </span>
                            <span class="view-desc">${item.description}</span>
                          </span>
                        </a>
                        <div class="view-actions">
                          ${
                            isPinned
                              ? html`
                                <div class="reorder-group" aria-label="Position on top bar">
                                  <span class="pos-badge" title="Position #${pinnedIndex + 1}">#${pinnedIndex + 1}</span>
                                  <button
                                    class="reorder-btn move-up"
                                    type="button"
                                    aria-label="Move ${item.label} earlier"
                                    title="Move ${item.label} earlier"
                                    ?disabled=${pinnedIndex === 0}
                                    @click=${() => this.movePinnedView(item.id, -1)}
                                  >
                                    ▲
                                  </button>
                                  <button
                                    class="reorder-btn move-down"
                                    type="button"
                                    aria-label="Move ${item.label} later"
                                    title="Move ${item.label} later"
                                    ?disabled=${pinnedIndex === this.pinnedViews.length - 1}
                                    @click=${() => this.movePinnedView(item.id, 1)}
                                  >
                                    ▼
                                  </button>
                                </div>
                              `
                              : ""
                          }
                          <button
                            class="pin-btn ${isPinned ? "pinned" : ""}"
                            type="button"
                            role="button"
                            aria-pressed=${isPinned ? "true" : "false"}
                            aria-label=${isPinned ? `Unpin ${item.label} from navigation` : `Pin ${item.label} to navigation`}
                            title=${
                              isPinned && this.pinnedViews.length <= 1
                                ? "At least one view must remain pinned"
                                : isPinned
                                  ? "Unpin from top navigation"
                                  : "Pin to top navigation"
                            }
                            ?disabled=${isPinned && this.pinnedViews.length <= 1}
                            @click=${() => this.togglePin(item.id)}
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill=${isPinned ? "currentColor" : "none"} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                              <line x1="12" y1="17" x2="12" y2="22"></line>
                              <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.89A2 2 0 0 1 15 10.77V5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5.77a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 5 15.24Z"></path>
                            </svg>
                            <span>${isPinned ? "Pinned" : "Pin"}</span>
                          </button>
                        </div>
                      </div>
                    `;
                  })}
                </div>
              </section>
            `;
          })}
        </div>
      </div>
    `;
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

    return html`
      <header>
        <a class="mark" href="#/office">i.inc</a>
        ${this.mobileTitle()}
        <nav aria-label="Views">
          <div class="pinned-links">
            ${this.pinnedViews.map((id) => {
              const item = VIEW_CATALOG.find((def) => def.id === id);
              if (!item) return "";
              return link(item.href, item.label, item.isActive(this.route), item.title);
            })}
          </div>
          <div class="all-views-wrap">
            <button
              class="all-views-trigger ${this.allViewsOpen ? "open" : ""}"
              type="button"
              aria-haspopup="true"
              aria-expanded=${this.allViewsOpen ? "true" : "false"}
              aria-label="All views and customize navigation"
              @click=${this.toggleAllViews}
              title="All views and customize navigation"
            >
              <svg class="grid-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="7" height="7" rx="1.5"></rect>
                <rect x="14" y="3" width="7" height="7" rx="1.5"></rect>
                <rect x="14" y="14" width="7" height="7" rx="1.5"></rect>
                <rect x="3" y="14" width="7" height="7" rx="1.5"></rect>
              </svg>
              <span>All views</span>
              <svg class="chevron-icon ${this.allViewsOpen ? "rotated" : ""}" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
            </button>
            ${this.allViewsOpen ? this.renderAllViewsDropdown() : ""}
          </div>
        </nav>
        <span class="spacer"></span>
        <button class="icon" type="button" aria-label="Switch theme" @click=${this.toggleTheme}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"></path></svg>
        </button>
        <button class="btn ghost sign-out" type="button" @click=${() => logout()}>
          <svg class="short-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline>
            <line x1="21" y1="12" x2="9" y2="12"></line></svg>
          <span class="label">Sign out</span>
        </button>
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
