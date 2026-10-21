// The thread: one conversation's turns, streaming live from the AHP host, and the composer under them. It
// follows the stream only while you are at the bottom ("Jump to latest" appears when you scroll up), pages
// older turns in when you scroll to the top, and renders at most a window of turns so a long chat stays fast.
import type { Employee } from "@i-inc/core";
import type { ChatState } from "@microsoft/agent-host-protocol";
import { css, html, LitElement, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { ConnectionInfo, Rejection } from "../ahp/connection.ts";
import { ahp } from "../ahp/hub.ts";
import { startPresence } from "../ahp/presence.ts";
import { ActionType } from "../ahp/wire.ts";
import type { Conversation, ShipView } from "../api.ts";
import { isNearBottom } from "../chat-scroll.ts";
import {
  answerInput,
  attachmentOf,
  cancelTurn,
  checkOutgoing,
  confirmTool,
  newId,
  pendingMessage,
  removePending,
  setConfig,
  turnStarted,
} from "../conversations/actions.ts";
import {
  cardOutcome,
  firstPending,
  isPending,
  modePicker,
  statusText,
  visible,
} from "../conversations/model.ts";
import { cardStyles } from "../conversations/styles.ts";
import { OPEN_CARD_EVENT } from "../register-sw.ts";
import { draftHash } from "../routes.ts";
import { avatar, base, projectBadge, selectField } from "./shared.ts";
import "./conv-composer.ts";
import "./conv-turn.ts";
import type { SendDetail } from "./conv-composer.ts";
import type { InputDetail } from "./conv-question.ts";
import type { ConfirmDetail } from "./conv-tool.ts";

const WINDOW = 30;
const PAGE = 20;

/** The per-employee default mode, remembered when the owner changes it. */
export const modeKey = (employeeId: string) => `i-inc-conv-mode:${employeeId}`;

/** A message sent and not yet confirmed, with the id it was sent under. */
interface Sent {
  text: string;
  files: File[];
  at: number;
  turnId?: string;
  pendingId?: string;
}

export class IncConvThread extends LitElement {
  static override properties = {
    conv: { attribute: false },
    draft: { attribute: false },
    draftNote: { type: String },
    draftProjects: { attribute: false },
    first: { attribute: false },
    onCreate: { attribute: false },
    employee: { attribute: false },
    phone: { type: Boolean },
    contextOpen: { type: Boolean },
    card: { type: String },
    cardNote: { state: true },
    ship: { attribute: false },
    shipMenu: { state: true },
    info: { state: true },
    stick: { state: true },
    notice: { state: true },
    announce: { state: true },
    loadingOlder: { state: true },
  };
  declare conv: Conversation | undefined;
  /** A conversation not made yet: the first message creates it (the screen does, through `onCreate`). */
  declare draft: { employee: string; project: string } | undefined;
  /** What is wrong with the draft's address (an unknown employee or project), in a sentence. */
  declare draftNote: string;
  /** The projects this employee can be asked about, for the draft's project picker. */
  declare draftProjects: string[];
  /** The message that made this conversation, sent once its chat is loaded. */
  declare first: SendDetail | undefined;
  declare onCreate: ((d: SendDetail) => Promise<string | null>) | undefined;
  declare employee: Employee | undefined;
  declare phone: boolean;
  declare contextOpen: boolean;
  /** `?card=<id>` of the address: a card a notification opened. It is brought into view, once. */
  declare card: string;
  /** Said when that card was answered already ("Already answered on another device"). */
  declare cardNote: string;
  /** What shipping says (C22b): the ticket that has the working copy, the PR, and whether each button can be pressed. */
  declare ship: ShipView | undefined;
  declare shipMenu: boolean;
  declare info: ConnectionInfo;
  declare stick: boolean;
  declare notice: string | null;
  declare announce: string;
  declare loadingOlder: boolean;

  private releases: (() => void)[] = [];
  private offs: (() => void)[] = [];
  private wired = "";
  private firstId: string | undefined;
  private lastHeight = 0;
  private lastFirstId: string | undefined;
  private focusedPending = false;
  private prevActive: string | undefined;
  private prevPending = new Set<string>();
  private announceTimer: ReturnType<typeof setTimeout> | undefined;
  private resizer: ResizeObserver | undefined;
  private baselined = false;
  private firstSent = false;
  private draftKey = "";
  private cardVisible = false;
  private openedId = "";
  /** How many past turns the last render showed. */
  private shownCount = 0;
  private modeApplied = false;
  /** The conversation and card already looked at, so a re-render does not scroll the reader back to it. */
  private cardDone = "";
  private cardTries = 0;
  private cardTimer: ReturnType<typeof setTimeout> | undefined;
  private highlightTimer: ReturnType<typeof setTimeout> | undefined;
  private noteTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    super();
    this.phone = false;
    this.draftNote = "";
    this.draftProjects = [];
    this.contextOpen = false;
    this.card = "";
    this.cardNote = "";
    this.shipMenu = false;
    this.info = ahp().info;
    this.stick = true;
    this.notice = null;
    this.announce = "";
    this.loadingOlder = false;
  }

  static override styles = [
    base,
    cardStyles,
    selectField,
    css`
      :host { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; position: relative; }
      .head { flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 4px 10px; border-bottom: 1px solid var(--line); min-width: 0; }
      .back, .tool-btn { flex: none; width: 44px; height: 44px; border-radius: 50%; border: 1px solid var(--line-strong); background: transparent; color: var(--ink);
        display: inline-grid; place-items: center; cursor: pointer; }
      .back:focus-visible, .tool-btn:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 2px; }
      .tool-btn[aria-pressed="true"] { background: var(--ink); color: var(--on-ink); border-color: var(--ink); }
      .back svg, .tool-btn svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
      .who { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
      .title { margin: 0; font: 700 18px/1.25 var(--display); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .meta { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink-2); min-width: 0; flex-wrap: nowrap; overflow: hidden; }
      .meta > * { flex: none; } .meta .proj-badge { flex: 0 1 auto; min-width: 0; }
      .status { font-size: 12px; font-weight: 800; padding: 2px 10px; border-radius: 999px; background: var(--neutral-bg); color: var(--neutral-fg); white-space: nowrap; }
      .status.needs { background: var(--needs-bg); color: var(--needs-fg); border: 1px solid var(--needs-edge); }
      .status.run { background: var(--working-bg); color: var(--working-fg); border: 1px solid var(--working-edge); }
      .ship-wrap { position: relative; flex: none; }
      .ship-menu { position: absolute; right: 0; top: 50px; z-index: 30; width: min(300px, calc(100vw - 32px)); padding: 6px; border-radius: 14px; background: var(--surface);
        border: 1px solid var(--line); box-shadow: 0 12px 32px rgba(0,0,0,0.18); display: flex; flex-direction: column; }
      .ship-menu .mi { all: unset; box-sizing: border-box; min-height: 44px; padding: 6px 14px; display: flex; flex-direction: column; justify-content: center; gap: 1px; border-radius: 10px;
        font: 600 15px var(--body); cursor: pointer; color: var(--ink); }
      .ship-menu .mi small { font: 400 12.5px var(--body); color: var(--ink-2); }
      .ship-menu .mi:hover { background: var(--sunken); }
      .ship-menu .mi:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: -3px; }
      .ship-menu .mi[aria-disabled="true"] { opacity: 0.55; cursor: default; }
      .ship-menu .why { margin: 4px 14px 8px; font-size: 12.5px; line-height: 1.4; color: var(--ink-2); }
      .ship-menu hr { border: 0; border-top: 1px solid var(--line); margin: 4px 0; width: 100%; }
      .held { flex: none; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px; padding: 8px 12px; border-radius: 12px; background: var(--working-bg);
        color: var(--working-fg); font-weight: 600; font-size: 14px; border: 1px solid var(--working-edge); }
      .held a { color: inherit; font-weight: 800; text-underline-offset: 2px; display: inline-flex; align-items: center; min-height: 44px; }
      .banner { flex: none; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px; padding: 8px 12px; border-radius: 12px; background: var(--banner-bg);
        color: var(--banner-fg); font-weight: 600; font-size: 14px; border: 1px solid var(--needs-edge); }
      .banner button { margin-left: auto; }
      .stage { position: relative; flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; }
      .scroller { flex: 1 1 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 0 6px; scrollbar-gutter: stable; }
      .inner { max-width: 820px; margin: 0 auto; padding-bottom: 12px; min-width: 0; }
      .older { display: flex; justify-content: center; padding: 12px 0 4px; }
      .empty { max-width: 46ch; margin: 12vh auto 0; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 0 16px; }
      .empty .pick { display: flex; flex-direction: column; gap: 4px; align-items: stretch; font-size: 13px; font-weight: 700; color: var(--ink-2); min-width: 220px; }
      .empty h2 { font-size: 22px; } .empty p { margin: 0; color: var(--ink-2); line-height: 1.5; }
      .skeleton { display: flex; flex-direction: column; gap: 12px; padding: 24px 0; }
      .skeleton i { display: block; height: 16px; border-radius: 8px; background: var(--sunken); animation: pulse 1.4s ease-in-out infinite; }
      .skeleton i:nth-child(2) { width: 80%; } .skeleton i:nth-child(3) { width: 60%; }
      @keyframes pulse { 50% { opacity: 0.45; } }
      .jump-row { display: flex; justify-content: center; }
      .jump { min-height: 44px; padding: 0 16px; border-radius: 999px;
        border: 1px solid var(--line-strong); background: var(--surface); color: var(--ink); font: 700 14px var(--body); cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,0.18);
        display: inline-flex; align-items: center; gap: 8px; }
      .jump:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 2px; }
      .jump svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
      .dock { flex: none; max-width: 820px; width: 100%; margin: 0 auto; box-sizing: border-box; padding: 6px 6px max(8px, env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 8px; }
      .needs-bar { display: flex; align-items: center; gap: 10px; padding: 2px 4px 2px 12px; min-height: 44px; border-radius: 14px; font-size: 13.5px; background: var(--needs-bg); color: var(--needs-fg);
        border: 1px solid var(--needs-edge); font-weight: 700; font-size: 14px; }
      .needs-bar > span { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .needs-bar button { margin-left: auto; flex: none; padding: 0 12px; }
      .notice { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 12px; border: 1px solid var(--alarm); color: var(--alarm-fg); font-size: 14px; font-weight: 600; }
      .notice button { margin-left: auto; }
      .card-note { flex: none; display: flex; align-items: center; gap: 10px; margin-top: 8px; padding: 8px 12px; border-radius: 12px; border: 1px solid var(--line-strong);
        background: var(--sunken); color: var(--ink); font-size: 14px; font-weight: 600; }
      .card-note button { margin-left: auto; }
      @media (max-width: 767px) {
        .title { font-size: 17px; }
        .meta code { display: none; }
        .meta { flex-wrap: wrap; row-gap: 2px; }
        .meta .proj-badge { flex: none; max-width: 100%; }
        .scroller { padding: 0 2px; }
        .dock { padding-left: 2px; padding-right: 2px; }
      }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("click", this.closeShipMenu);
    document.addEventListener("keydown", this.shipMenuKey, true);
    const c = ahp();
    this.info = c.info;
    this.offs = [
      c.onChange((uris) => {
        const conv = this.conv;
        if (conv && (uris.has(conv.ahpChat) || uris.has(conv.ahpSession))) {
          if (this.lost && this.info.status === "open") this.settleLost();
          this.noteTransitions();
          this.requestUpdate();
        }
      }),
      c.onInfo((i) => {
        this.info = i;
        this.onInfoChanged(i.status);
      }),
      c.onRejected(this.onRejected),
      c.onAccepted((seq) => this.inflight.delete(seq)),
    ];
    // A tap on a notification while the app is already at this address.
    addEventListener(OPEN_CARD_EVENT, this.onOpenCard);
    if (typeof ResizeObserver === "function") {
      this.resizer = new ResizeObserver(() => {
        if (this.stick) this.scrollToBottom();
      });
    }
  }

  private onOpenCard = () => {
    this.cardDone = "";
    this.cardTries = 0;
    this.openCard();
  };

  override disconnectedCallback(): void {
    document.removeEventListener("click", this.closeShipMenu);
    document.removeEventListener("keydown", this.shipMenuKey, true);
    for (const off of this.offs) off();
    this.offs = [];
    for (const t of this.probes) clearTimeout(t);
    this.probes.clear();
    this.unwatch();
    this.resizer?.disconnect();
    clearTimeout(this.announceTimer);
    clearTimeout(this.cardTimer);
    clearTimeout(this.highlightTimer);
    clearTimeout(this.noteTimer);
    removeEventListener(OPEN_CARD_EVENT, this.onOpenCard);
    super.disconnectedCallback();
  }

  private closeShipMenu = (e?: Event) => {
    if (!this.shipMenu) return;
    // A click inside the menu or on its button is handled by them.
    if (e && e.composedPath().some((n) => n instanceof Element && n.classList?.contains("ship-wrap"))) return;
    this.shipMenu = false;
  };

  private shipMenuKey = (e: KeyboardEvent) => {
    if (!this.shipMenu) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.shipMenu = false;
      this.focusShipButton();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const items = [...(this.shadowRoot?.querySelectorAll<HTMLElement>(".ship-menu .mi") ?? [])];
      if (!items.length) return;
      e.preventDefault();
      const at = items.indexOf(this.shadowRoot?.activeElement as HTMLElement);
      items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    }
  };

  /** Puts focus back on the Ship button (after its menu or its dialog closes). */
  focusShipButton(): void {
    this.shadowRoot?.querySelector<HTMLElement>(".ship-btn")?.focus();
  }

  private openShip(kind: "ticket" | "pr") {
    this.shipMenu = false;
    this.dispatchEvent(new CustomEvent("conv-ship", { detail: { kind }, bubbles: true, composed: true }));
  }

  /** The ticket that has this conversation's working copy, if one does. */
  private heldTicket(conv: Conversation): string | undefined {
    const t = this.ship?.ticket ?? conv.ship?.ticket;
    return t?.held ? t.id || "…" : undefined;
  }

  private shipControl(conv: Conversation) {
    if (!conv.project) return nothing;
    const ship = this.ship;
    const held = this.heldTicket(conv);
    const direct = ship?.mode === "direct";
    const canTicket = ship ? ship.canTicket : !held;
    const canPr = ship ? ship.canPr : !held;
    const prUrl = ship?.pr?.url ?? conv.ship?.pr?.url;
    const prNo = ship?.pr?.number ?? conv.ship?.pr?.number;
    return html`<div class="ship-wrap">
      <button class="tool-btn ship-btn" type="button" aria-label="Ship this work" aria-haspopup="menu" aria-expanded=${this.shipMenu ? "true" : "false"} title="Ship this work: a ticket or a PR"
        @click=${() => {
          this.shipMenu = !this.shipMenu;
          if (this.shipMenu)
            void this.updateComplete.then(() =>
              this.shadowRoot?.querySelector<HTMLElement>(".ship-menu .mi")?.focus(),
            );
        }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4M7 9l5-5 5 5M4 15v4a1 1 0 001 1h14a1 1 0 001-1v-4"/></svg></button>
      ${
        this.shipMenu
          ? html`<div class="ship-menu" role="menu" aria-label="Ship this work">
            <button class="mi" type="button" role="menuitem" aria-disabled=${canTicket ? "false" : "true"}
              @click=${() => canTicket && this.openShip("ticket")}>Make this a ticket
              <small>${direct ? "Checks and a review, then main" : "Checks and a review, then a PR for you"}</small></button>
            ${
              direct
                ? nothing
                : html`<button class="mi" type="button" role="menuitem" aria-disabled=${canPr ? "false" : "true"}
              @click=${() => canPr && this.openShip("pr")}>${ship?.pr ? "Update the PR" : "Open a PR"}
              <small>A draft, without i.inc's review</small></button>`
            }
            ${!canTicket && ship?.reason ? html`<p class="why">${ship.reason}</p>` : direct && ship?.reason ? html`<p class="why">${ship.reason}</p>` : nothing}
            ${held || prUrl ? html`<hr />` : nothing}
            ${held ? html`<a class="mi" role="menuitem" href="#/ticket/${held}" @click=${() => (this.shipMenu = false)}>Open ticket #${held}</a>` : nothing}
            ${prUrl ? html`<a class="mi" role="menuitem" href=${prUrl} target="_blank" rel="noopener" @click=${() => (this.shipMenu = false)}>Open PR #${prNo} on GitHub</a>` : nothing}
          </div>`
          : nothing
      }
    </div>`;
  }

  private unwatch() {
    for (const r of this.releases) r();
    this.releases = [];
    this.wired = "";
  }

  override willUpdate(changed: Map<string, unknown>): void {
    const conv = this.conv;
    const key = conv ? `${conv.id}|${conv.ahpSession}|${conv.ahpChat}` : "";
    if (changed.has("draft")) {
      // A different draft (the route changed): what was said about the last one is stale.
      const d = this.draft;
      const dk = d ? `${d.employee}|${d.project}` : "";
      if (dk !== this.draftKey) {
        this.draftKey = dk;
        this.notice = null;
      }
    }
    if (changed.has("conv") && key !== this.wired) {
      this.unwatch();
      this.wired = key;
      this.firstId = undefined;
      this.lastFirstId = undefined;
      this.stick = true;
      this.focusedPending = false;
      this.baselined = false;
      this.firstSent = false;
      this.modeApplied = false;
      this.prevActive = undefined;
      this.prevPending = new Set();
      this.notice = null;
      if (conv) {
        const c = ahp();
        this.releases = [
          c.watch(conv.ahpSession),
          c.watch(conv.ahpChat, { turns: WINDOW }),
          // While this page is visible and focused on the conversation, no push notification is sent for it.
          startPresence(c, conv.ahpSession),
        ];
        this.cardDone = "";
        this.cardTries = 0;
        this.cardNote = "";
      }
    }
  }

  override firstUpdated(): void {
    const inner = this.renderRoot.querySelector(".inner");
    if (inner) this.resizer?.observe(inner);
  }

  override updated(changed: Map<string, unknown>): void {
    const sc = this.scroller();
    if (!sc) return;
    // Opening a different conversation starts at its end. A refreshed row of the same conversation (the list
    // reloads on every change) must not move the reader.
    const opened = this.conv?.id ?? "";
    if (changed.has("conv") && opened !== this.openedId) {
      this.openedId = opened;
      this.stick = true;
      this.scrollToBottom();
    }
    // Older turns arrived at the top: keep what the reader is looking at where it was.
    const first = this.firstId;
    if (this.lastFirstId !== undefined && first !== this.lastFirstId && !this.stick) {
      sc.scrollTop += sc.scrollHeight - this.lastHeight;
    }
    this.lastFirstId = first;
    if (this.stick) this.scrollToBottom();
    this.lastHeight = sc.scrollHeight;
    if (!this.focusedPending) this.focusPendingOnOpen();
    this.openCard();
    this.checkCardVisible();
    this.applyRememberedMode();
    if (!this.baselined) this.noteTransitions();
    void this.sendFirst();
  }

  /** The message that created this conversation goes out as soon as its chat is loaded (after the mode is set). */
  private async sendFirst() {
    const conv = this.conv;
    const first = this.first;
    if (!first || this.firstSent || !conv) return;
    if (!ahp().chat(conv.ahpChat) || !ahp().session(conv.ahpSession) || this.info.status !== "open") return;
    this.firstSent = true;
    const why = await this.send(first);
    this.dispatchEvent(new CustomEvent("conv-first-sent", { bubbles: true, composed: true }));
    if (why) this.restoreMessage(first, why);
  }

  /** A new, empty conversation starts in the mode the owner last chose for this employee. */
  private applyRememberedMode() {
    const conv = this.conv;
    if (!conv || this.modeApplied) return;
    const chat = ahp().chat(conv.ahpChat);
    const picker = modePicker(ahp().session(conv.ahpSession));
    if (!chat || !picker) return;
    this.modeApplied = true;
    if (chat.turns.length || chat.activeTurn) return;
    let want: string | null = null;
    try {
      want = localStorage.getItem(modeKey(conv.employeeId));
    } catch {}
    if (want && want !== picker.value && picker.choices.some((c) => c.value === want)) {
      ahp().dispatch(conv.ahpSession, setConfig({ mode: want }));
    }
  }

  private scroller(): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>(".scroller");
  }

  private scrollToBottom() {
    const sc = this.scroller();
    if (sc) sc.scrollTop = sc.scrollHeight;
  }

  private onScroll = () => {
    const sc = this.scroller();
    if (!sc) return;
    const near = isNearBottom(sc);
    if (near !== this.stick) this.stick = near;
    this.checkCardVisible();
    if (sc.scrollTop < 160) void this.loadEarlier();
  };

  private jump = () => {
    this.stick = true;
    this.scrollToBottom();
  };

  private async loadEarlier() {
    const conv = this.conv;
    const chat = conv ? ahp().chat(conv.ahpChat) : undefined;
    if (!conv || !chat || this.loadingOlder) return;
    const idx = this.firstId ? chat.turns.findIndex((t) => t.id === this.firstId) : 0;
    if (idx > 0) {
      this.firstId = chat.turns[Math.max(0, idx - PAGE)]?.id;
      this.requestUpdate();
      return;
    }
    if (!chat.turnsNextCursor) return;
    this.loadingOlder = true;
    try {
      await ahp().fetchTurns(conv.ahpChat);
      const now = ahp().chat(conv.ahpChat);
      if (now) this.firstId = now.turns[0]?.id;
    } finally {
      this.loadingOlder = false;
    }
  }

  // ───────────────────────────── announcements ─────────────────────────────

  private say(text: string) {
    this.announce = text;
    clearTimeout(this.announceTimer);
    this.announceTimer = setTimeout(() => {
      this.announce = "";
    }, 5000);
  }

  /** Turn start, turn end and a new permission request are announced; the deltas never are. */
  private noteTransitions() {
    const conv = this.conv;
    const chat = conv ? ahp().chat(conv.ahpChat) : undefined;
    if (!conv || !chat) return;
    const name = this.employee?.name ?? "The agent";
    const active = chat.activeTurn?.id;
    if (!this.baselined) {
      // What was already going on when the conversation opened is not news.
      this.baselined = true;
      this.prevActive = active;
      const p = firstPending(chat);
      this.prevPending = new Set(p ? [p.id] : []);
      return;
    }
    if (active && active !== this.prevActive) this.say(`${name} started working`);
    else if (!active && this.prevActive) {
      const last = chat.turns.at(-1);
      this.say(
        last?.state === ("error" as never)
          ? `${name} hit an error`
          : last?.state === ("cancelled" as never)
            ? `${name} stopped`
            : `${name} finished`,
      );
    }
    this.prevActive = active;
    const now = new Set<string>();
    const pending = firstPending(chat);
    if (pending) now.add(pending.id);
    for (const id of now) if (!this.prevPending.has(id)) this.say(`${name} needs your answer`);
    this.prevPending = now;
  }

  // ───────────────────────────── sending ─────────────────────────────

  private fail(why: string) {
    this.notice = why;
  }

  /** Messages sent and not yet accepted, by `clientSeq`: the host's refusal does not echo their content. */
  private inflight = new Map<number, Sent>();
  private probes = new Set<ReturnType<typeof setTimeout>>();
  /** The connection dropped with sends unanswered: once it is back, each is found in the chat or given back. */
  private lost = false;

  private remember(clientSeq: number, m: Sent) {
    this.inflight.set(clientSeq, m);
    if (this.inflight.size > 30) {
      const oldest = this.inflight.keys().next().value;
      if (oldest !== undefined) this.inflight.delete(oldest);
    }
    // The echo normally comes in milliseconds. If it has not come in 5 s, ask the socket whether it is there at
    // all, rather than waiting out the 20 s heartbeat to find out the message went nowhere.
    const t = setTimeout(() => {
      this.probes.delete(t);
      if (this.inflight.has(clientSeq)) void ahp().probe();
    }, 5000);
    this.probes.add(t);
  }

  /**
   * Whether the chat already holds this message (the host took it; only the echo was lost). A turn is found by the
   * id this client gave it, a pending message by its id; never by its words alone, so a lost "ok" is not taken for
   * another "ok". A pending message that already became a turn (the host started it from the queue) has a turn id
   * of the host's, so that one is found by its words, but only among turns that began after it was sent.
   */
  private holds(chat: ChatState, m: Sent): boolean {
    if (m.turnId !== undefined)
      return chat.turns.some((t) => t.id === m.turnId) || chat.activeTurn?.id === m.turnId;
    const pendingId = m.pendingId;
    if (chat.steeringMessage?.id === pendingId || (chat.queuedMessages ?? []).some((q) => q.id === pendingId))
      return true;
    const began = (t: { message: { text: string }; startedAt?: string | undefined }) =>
      t.message.text === m.text && Date.parse(t.startedAt ?? "") >= m.at - 2000;
    return chat.turns.some(began) || (chat.activeTurn ? began(chat.activeTurn) : false);
  }

  /**
   * When the connection drops, a message sent just before may never have reached the host. When it is back,
   * each unanswered send is looked for in the chat: found, it went through (only its echo was lost) and is
   * forgotten; not found, it goes back into the box with a notice. Never both, never neither. The list is
   * emptied either way, because the next connection numbers its actions from 1 again.
   */
  private onInfoChanged(status: string) {
    if (status !== "open") {
      if (this.inflight.size) this.lost = true;
      return;
    }
    if (!this.lost) return;
    this.settleLost();
  }

  private settleLost() {
    const conv = this.conv;
    const chat = conv ? ahp().chat(conv.ahpChat) : undefined;
    // The chat is not loaded yet (a fresh start): settle when it arrives.
    if (!chat) return;
    this.lost = false;
    const unsent = [...this.inflight.values()].filter((m) => !this.holds(chat, m)); // in the order they were sent
    this.inflight.clear();
    if (unsent.length)
      this.restoreMessages(
        unsent,
        unsent.length === 1
          ? "Not sent: the connection was lost. Your message is back in the box."
          : `Not sent: the connection was lost. Your ${unsent.length} messages are back in the box, in the order you sent them.`,
      );
  }

  private onRejected = (r: Rejection) => {
    const conv = this.conv;
    if (!conv || (r.channel !== conv.ahpChat && r.channel !== conv.ahpSession)) return;
    const type = (r.action as unknown as { type: string }).type;
    const sent = this.inflight.get(r.clientSeq);
    this.inflight.delete(r.clientSeq);
    // The turn could not start because one is already running (say, from another tab): it is queued instead.
    if (type === ActionType.ChatTurnStarted && /already running/.test(r.reason) && sent) {
      void this.send({ text: sent.text, files: sent.files, intent: "queue" }).then((why) => {
        if (why) this.restoreMessage(sent, why);
      });
      return;
    }
    // A confirmation or question another device answered first is not an error: the card shows the outcome.
    if (
      (type === ActionType.ChatToolCallConfirmed || type === ActionType.ChatInputCompleted) &&
      /answered|not waiting|not open/.test(r.reason)
    )
      return;
    // A message the host refused goes back into the box, with its images, so nothing typed is lost.
    if (sent) {
      this.restoreMessage(sent, `The host didn't accept that: ${r.reason}`);
      return;
    }
    this.fail(`The host didn't accept that: ${r.reason}`);
  };

  private restoreMessage(sent: { text: string; files: File[] }, why: string) {
    this.restoreMessages([sent], why);
  }

  /** Gives messages back to the box in order, separated by blank lines, ahead of anything typed since. */
  private restoreMessages(sent: { text: string; files: File[] }[], why: string) {
    (
      this.renderRoot.querySelector("inc-conv-composer") as
        | (HTMLElement & { restore(text: string, files?: File[]): void })
        | null
    )?.restore(
      sent.map((m) => m.text).join("\n\n"),
      sent.flatMap((m) => m.files),
    );
    this.fail(why);
  }

  /** The composer's send. Returns a reason when it could not be sent (the text stays), or null. */
  private send = async (d: SendDetail): Promise<string | null> => {
    const conv = this.conv;
    const chat = conv ? ahp().chat(conv.ahpChat) : undefined;
    if (!conv || !chat) return "This conversation isn't loaded yet.";
    const tooBig = checkOutgoing(d.text, d.files);
    if (tooBig) return tooBig;
    let attachments: Record<string, unknown>[] = [];
    try {
      attachments = await Promise.all(d.files.map(attachmentOf));
    } catch {
      return "Couldn't read one of the files.";
    }
    const running = !!ahp().chat(conv.ahpChat)?.activeTurn;
    const id = newId();
    const asTurn = d.intent === "turn" && !running;
    const action = asTurn
      ? turnStarted(d.text, attachments, id)
      : pendingMessage(d.intent === "steer" ? "steering" : "queued", d.text, attachments, id);
    const sent = ahp().dispatch(conv.ahpChat, action);
    if (sent.ok)
      this.remember(sent.clientSeq, {
        text: d.text,
        files: d.files,
        at: Date.now(),
        ...(asTurn ? { turnId: id } : { pendingId: id }),
      });
    return sent.ok ? null : sent.error;
  };

  private dispatchChat(action: ReturnType<typeof turnStarted>) {
    const conv = this.conv;
    if (!conv) return;
    const sent = ahp().dispatch(conv.ahpChat, action);
    if (!sent.ok) this.fail(sent.error);
  }

  private onConfirm = (e: Event) => {
    const d = (e as CustomEvent<ConfirmDetail>).detail;
    e.stopPropagation();
    this.dispatchChat(confirmTool(d.turnId, d.toolCallId, d.option ?? { approve: d.approve === true }));
  };

  private onInput = (e: Event) => {
    const d = (e as CustomEvent<InputDetail>).detail;
    e.stopPropagation();
    this.dispatchChat(answerInput(d.requestId, d.response, d.answers));
  };

  private onRetry = (e: Event) => {
    const d = (e as CustomEvent<{ text: string }>).detail;
    e.stopPropagation();
    const conv = this.conv;
    const running = conv ? !!ahp().chat(conv.ahpChat)?.activeTurn : false;
    this.dispatchChat(running ? pendingMessage("queued", d.text) : turnStarted(d.text));
  };

  private onStop = () => {
    const turn = this.conv ? ahp().chat(this.conv.ahpChat)?.activeTurn : undefined;
    if (turn) this.dispatchChat(cancelTurn(turn.id, turn.startedAt));
  };

  private onConfig = (e: Event) => {
    const d = (e as CustomEvent<{ key: string; value: string }>).detail;
    const conv = this.conv;
    if (!conv) return;
    const sent = ahp().dispatch(conv.ahpSession, setConfig({ [d.key]: d.value }));
    if (!sent.ok) this.fail(sent.error);
    else if (d.key === "mode") {
      try {
        localStorage.setItem(modeKey(conv.employeeId), d.value);
      } catch {}
    }
  };

  private onUnqueue = (e: Event) => {
    const d = (e as CustomEvent<{ kind: "steering" | "queued"; id: string }>).detail;
    this.dispatchChat(removePending(d.kind, d.id));
  };

  // ───────────────────────────── the pending card ─────────────────────────────

  /** Brings the first thing waiting for the owner into view and focuses its first button. */
  /** The card (a permission or a question) with this id, if it is in the DOM. */
  private findCard(id: string, activeOnly = true): HTMLElement | undefined {
    const turns = this.renderRoot.querySelectorAll<HTMLElement>(
      activeOnly ? "inc-conv-turn[active]" : "inc-conv-turn",
    );
    for (const turn of turns) {
      const found = [
        ...(turn.shadowRoot?.querySelectorAll<HTMLElement>("inc-conv-tool, inc-conv-question") ?? []),
      ].find((el) => {
        const call = (el as unknown as { call?: { toolCallId: string } }).call;
        const req = (el as unknown as { request?: { id: string } }).request;
        return call?.toolCallId === id || req?.id === id;
      });
      if (found) return found;
    }
    return undefined;
  }

  /** The card (a permission or a question) waiting for the owner, if it is in the DOM. */
  private pendingCard(): HTMLElement | undefined {
    const conv = this.conv;
    const chat = conv ? ahp().chat(conv.ahpChat) : undefined;
    const p = firstPending(chat);
    return p ? this.findCard(p.id) : undefined;
  }

  /**
   * `?card=<id>` (a notification opened this address): bring that card into view, focus its first button and
   * mark it for a moment. If it was answered already, say so instead. Looks once per conversation and card,
   * and waits until the conversation is loaded and the connection is up, so it never judges stale state.
   */
  private openCard(): void {
    const conv = this.conv;
    const card = this.card;
    if (!conv || !card) return;
    const key = `${conv.id}|${card}`;
    if (this.cardDone === key) return;
    const chat = ahp().chat(conv.ahpChat);
    if (!chat || this.info.status !== "open") return;
    if (!isPending(chat, card)) {
      this.cardDone = key;
      // Only a card that was answered is "answered": one the turn left behind (stopped, restarted, or a link
      // to something that was never here) is just not waiting.
      const who = ahp().confirmation(conv.ahpChat, card) ?? ahp().inputAnswer(conv.ahpChat, card);
      this.cardNote = who?.byMe
        ? "You already answered this."
        : who || cardOutcome(chat, card) === "answered"
          ? "Already answered on another device"
          : "That request isn't waiting any more";
      clearTimeout(this.noteTimer);
      this.noteTimer = setTimeout(() => {
        this.cardNote = "";
      }, 10_000);
      return;
    }
    const el = this.findCard(card);
    if (!el) {
      // Waiting on the render: look again shortly, a few times.
      if (this.cardTries++ < 20) {
        clearTimeout(this.cardTimer);
        this.cardTimer = setTimeout(() => this.openCard(), 50);
      }
      return;
    }
    this.cardDone = key;
    this.cardNote = "";
    this.stick = false;
    const sc = this.scroller();
    if (sc) {
      const a = el.getBoundingClientRect();
      const b = sc.getBoundingClientRect();
      sc.scrollTop += a.top - b.top - Math.max(0, (b.height - a.height) / 2);
    }
    el.shadowRoot
      ?.querySelector<HTMLElement>("button[data-option], .cbtn, input")
      ?.focus({ preventScroll: true });
    // A moment's outline, so the eye finds it.
    el.style.outlineStyle = "solid";
    el.style.outlineWidth = "3px";
    el.style.outlineColor = "var(--reviewing-mark)";
    el.style.outlineOffset = "3px";
    el.style.borderRadius = "14px";
    clearTimeout(this.highlightTimer);
    this.highlightTimer = setTimeout(() => {
      el.style.outlineStyle = "";
      el.style.outlineWidth = "";
      el.style.outlineColor = "";
      el.style.outlineOffset = "";
      el.style.borderRadius = "";
    }, 2500);
  }

  /** Whether the pending card is on screen: then the "waiting for you" bar has nothing to add and steps aside. */
  private checkCardVisible() {
    const card = this.pendingCard();
    const sc = this.scroller();
    let visible = false;
    if (card && sc) {
      const a = card.getBoundingClientRect();
      const b = sc.getBoundingClientRect();
      visible = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 60;
    }
    if (visible !== this.cardVisible) {
      this.cardVisible = visible;
      this.requestUpdate();
    }
  }

  focusPending(): void {
    const tool = this.pendingCard();
    if (!tool) return;
    this.stick = false;
    const sc = this.scroller();
    if (sc) {
      // Centre it in the thread by hand: nothing in the app scrolls the page.
      const a = tool.getBoundingClientRect();
      const b = sc.getBoundingClientRect();
      sc.scrollTop += a.top - b.top - Math.max(0, (b.height - a.height) / 2);
    }
    tool.shadowRoot
      ?.querySelector<HTMLElement>("button[data-option], .cbtn, input")
      ?.focus({ preventScroll: true });
  }

  private focusPendingOnOpen() {
    const conv = this.conv;
    const chat = conv ? ahp().chat(conv.ahpChat) : undefined;
    if (!chat) return;
    this.focusedPending = true;
    if (this.card) return; // a notification's card is brought into view by openCard
    if (firstPending(chat))
      void this.updateComplete.then(() => requestAnimationFrame(() => this.focusPending()));
  }

  // ───────────────────────────── view ─────────────────────────────

  private visible(turns: readonly { id: string }[]): number {
    let idx = this.firstId ? turns.findIndex((t) => t.id === this.firstId) : -1;
    // The first turn on screen has slid out of what the host holds (a reconnect's window moved on as new turns
    // arrived): keep as many turns on screen as before, rather than falling back to the newest few.
    if (idx < 0)
      idx = Math.max(0, turns.length - (this.firstId ? Math.max(WINDOW, this.shownCount) : WINDOW));
    if (this.stick && turns.length - idx > WINDOW + 10) idx = turns.length - WINDOW;
    this.firstId = turns[idx]?.id;
    this.shownCount = turns.length - idx;
    return idx;
  }

  /** A conversation that does not exist yet: who it is with, an invitation, and a composer that creates it. */
  private renderDraft(d: { employee: string; project: string }) {
    const name = this.employee?.name ?? d.employee;
    return html`
      <div class="head">
        ${
          this.phone
            ? html`<button class="back" type="button" aria-label="Back to conversations" @click=${() => {
                location.hash = "#/conversations";
              }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button>`
            : nothing
        }
        ${this.employee ? avatar({ name: this.employee.name, tint: this.employee.tint ?? 0 }, 36) : nothing}
        <div class="who"><h2 class="title">New conversation</h2>
          <div class="meta"><span>${name}</span>${d.project ? projectBadge(d.project) : html`<span>No project</span>`}</div></div>
      </div>
      <div class="stage"><div class="scroller" tabindex="-1"><div class="inner">
        <div class="empty"><h2>Start a conversation with ${name}</h2>
          <p>${d.project ? `Ask ${name} about ${d.project}, or tell them what to change.` : `Ask ${name} anything, or tell them what to do.`} The conversation is created when you send your first message; leave this page and nothing is kept.</p>
          <p>Attach a screenshot or a text file by pasting or dropping it.</p>
          ${this.draftNote ? html`<p class="notice" role="status">${this.draftNote}</p>` : nothing}
          ${
            this.draftProjects.length
              ? html`<label class="pick">Project <select aria-label="Project for this conversation" @change=${(
                  e: Event,
                ) => {
                  location.hash = draftHash(d.employee, (e.target as HTMLSelectElement).value || null);
                }}><option value="" ?selected=${!d.project}>No project</option>${this.draftProjects.map(
                  (p) => html`<option value=${p} ?selected=${p === d.project}>${p}</option>`,
                )}</select></label>`
              : nothing
          }</div>
      </div></div></div>
      <div class="dock">
        <inc-conv-composer .conversationId=${`draft:${d.employee}:${d.project}`} .name=${name} .blocked=${/employee/.test(this.draftNote) ? "Pick an employee from the list first." : ""} .onSend=${this.onCreate}></inc-conv-composer>
      </div>`;
  }

  override render() {
    const conv = this.conv;
    if (!conv) return this.draft ? this.renderDraft(this.draft) : nothing;
    const c = ahp();
    const chat = c.chat(conv.ahpChat);
    const session = c.session(conv.ahpSession);
    const gone = c.isGone(conv.ahpChat) || c.isGone(conv.ahpSession);
    const name = this.employee?.name ?? conv.employeeId;
    const live = chat
      ? { running: !!chat.activeTurn, needs: !!firstPending(chat) }
      : { running: conv.running, needs: conv.needsYou };
    const status = live.needs
      ? "Needs you"
      : live.running
        ? "Running"
        : statusText({ ...conv, running: false, needsYou: false });
    const idx = chat ? this.visible(chat.turns) : 0;
    const turns = chat ? chat.turns.slice(idx) : [];
    const more = chat && (idx > 0 || !!chat.turnsNextCursor);
    const pending = firstPending(chat);
    const held = this.heldTicket(conv);
    const blocked =
      this.info.status !== "open"
        ? this.info.status === "failed"
          ? "Can't talk to the host."
          : "Reconnecting to the host… your message will wait here."
        : gone
          ? "This conversation is no longer on the host."
          : held
            ? `This work is now ticket #${held}. ${name} can't change the code until it is done. You can write to it again then.`
            : "";
    const empty = chat && !chat.turns.length && !chat.activeTurn;
    return html`
      <div class="head">
        ${
          this.phone
            ? html`<button class="back" type="button" aria-label="Back to conversations" @click=${() => {
                location.hash = "#/conversations";
              }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button>`
            : nothing
        }
        ${this.employee ? avatar({ name: this.employee.name, tint: this.employee.tint ?? 0 }, 36) : nothing}
        <div class="who">
          <h2 class="title" title=${visible(conv.title, true)}>${visible(chat?.title && chat.title !== "New conversation" ? chat.title : conv.title, true)}</h2>
          <div class="meta"><span>${name}</span>${conv.project ? projectBadge(conv.project) : html`<span>No project</span>`}
            ${conv.branch ? html`<code>${conv.branch}</code>` : nothing}
            <span class="status ${live.needs ? "needs" : live.running ? "run" : ""}">${status}</span></div>
        </div>
        ${this.shipControl(conv)}
        <button class="tool-btn" type="button" aria-label="Context panel" aria-pressed=${this.contextOpen ? "true" : "false"} title="Context: plan, files, usage"
          @click=${() => this.dispatchEvent(new CustomEvent("conv-toggle-context", { bubbles: true, composed: true }))}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg></button>
      </div>
      ${
        held
          ? html`<div class="held" role="status"><span>This work is now ticket #${held}${this.ship?.ticket?.live ? `: ${this.ship.ticket.live}` : ""}. ${name} is paused until it is done.</span>
              <a href="#/ticket/${held}">Open the ticket</a></div>`
          : nothing
      }
      ${
        this.info.status !== "open"
          ? html`<div class="banner" role="status">${this.info.status === "failed" ? this.info.error : this.info.everOpen ? "Reconnecting…" : "Connecting…"}
              ${this.info.attempt > 1 && this.info.error ? html`<span>${this.info.error}</span>` : nothing}
              <button class="cbtn" type="button" @click=${() => ahp().retryNow()}>Retry now</button></div>`
          : nothing
      }
      ${
        this.cardNote
          ? html`<div class="card-note" role="status"><span>${this.cardNote}</span><button class="link-btn" type="button" @click=${() => {
              this.cardNote = "";
            }}>Dismiss</button></div>`
          : nothing
      }
      <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">${this.announce}</div>
      <div class="stage">
      <div class="scroller" @scroll=${this.onScroll} tabindex="-1">
        <div class="inner" @conv-confirm=${this.onConfirm} @conv-input=${this.onInput} @conv-retry=${this.onRetry}>
          ${
            !chat
              ? gone
                ? html`<div class="empty"><h2>This conversation is gone</h2><p>It was removed from the host. Pick another from the list.</p></div>`
                : html`<div class="skeleton" aria-busy="true" aria-label="Loading the conversation"><i></i><i></i><i></i></div>`
              : html`
                ${more ? html`<div class="older"><button class="cbtn" type="button" ?disabled=${this.loadingOlder} @click=${() => void this.loadEarlier()}>${this.loadingOlder ? "Loading…" : "Show earlier messages"}</button></div>` : nothing}
                ${repeat(
                  turns,
                  (t) => t.id,
                  (t) =>
                    html`<inc-conv-turn .turn=${t} .employee=${name} .chat=${conv.ahpChat}></inc-conv-turn>`,
                )}
                ${chat.activeTurn ? html`<inc-conv-turn .turn=${chat.activeTurn} active .employee=${name} .chat=${conv.ahpChat}></inc-conv-turn>` : nothing}
                ${
                  empty
                    ? html`<div class="empty"><h2>Start a conversation with ${name}</h2>
                        <p>${conv.project ? `Ask ${name} about ${conv.project}, or tell them what to change.` : `Ask ${name} anything, or tell them what to do.`} They work on their own copy${conv.branch ? ` (${conv.branch})` : ""}, so nothing changes in your project until you say so.</p>
                        <p>Type <b>/</b> for ${name}'s commands. Attach a screenshot or a text file by pasting or dropping it.</p></div>`
                    : nothing
                }`
          }
        </div>
      </div>
      </div>
      <div class="dock" @conv-stop=${this.onStop} @conv-config=${this.onConfig} @conv-unqueue=${this.onUnqueue}>
        ${
          !this.stick && chat
            ? html`<div class="jump-row"><button class="jump" type="button" @click=${this.jump}>Jump to latest
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12l7 7 7-7"/></svg></button></div>`
            : nothing
        }
        ${pending && !this.cardVisible ? html`<div class="needs-bar"><span>${name} is waiting for you</span><button class="cbtn" type="button" @click=${() => this.focusPending()}>Review</button></div>` : nothing}
        ${
          this.notice
            ? html`<div class="notice" role="alert"><span>${this.notice}</span><button class="link-btn" type="button" @click=${() => {
                this.notice = null;
              }}>Dismiss</button></div>`
            : nothing
        }
        <inc-conv-composer .session=${session} .chat=${chat} .conversationId=${conv.id} .name=${name} .blocked=${blocked} .onSend=${this.send}></inc-conv-composer>
      </div>`;
  }
}

customElements.define("inc-conv-thread", IncConvThread);
