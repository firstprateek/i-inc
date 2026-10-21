// The thread: one conversation's turns, streaming live from the AHP host, and the composer under them. It
// follows the stream only while you are at the bottom ("Jump to latest" appears when you scroll up), pages
// older turns in when you scroll to the top, and renders at most a window of turns so a long chat stays fast.
import type { Employee } from "@i-inc/core";
import { css, html, LitElement, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { ConnectionInfo, Rejection } from "../ahp/connection.ts";
import { ahp } from "../ahp/hub.ts";
import { ActionType } from "../ahp/wire.ts";
import type { Conversation } from "../api.ts";
import { isNearBottom } from "../chat-scroll.ts";
import {
  answerInput,
  attachmentOf,
  cancelTurn,
  checkOutgoing,
  confirmTool,
  pendingMessage,
  removePending,
  setConfig,
  turnStarted,
} from "../conversations/actions.ts";
import { firstPending, modePicker, statusText } from "../conversations/model.ts";
import { cardStyles } from "../conversations/styles.ts";
import { avatar, base, projectBadge } from "./shared.ts";
import "./conv-composer.ts";
import "./conv-turn.ts";
import type { SendDetail } from "./conv-composer.ts";
import type { InputDetail } from "./conv-question.ts";
import type { ConfirmDetail } from "./conv-tool.ts";

const WINDOW = 30;
const PAGE = 20;

/** The per-employee default mode, remembered when the owner changes it. */
export const modeKey = (employeeId: string) => `i-inc-conv-mode:${employeeId}`;

export class IncConvThread extends LitElement {
  static override properties = {
    conv: { attribute: false },
    employee: { attribute: false },
    phone: { type: Boolean },
    contextOpen: { type: Boolean },
    info: { state: true },
    stick: { state: true },
    notice: { state: true },
    announce: { state: true },
    loadingOlder: { state: true },
  };
  declare conv: Conversation | undefined;
  declare employee: Employee | undefined;
  declare phone: boolean;
  declare contextOpen: boolean;
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
  private modeApplied = false;

  constructor() {
    super();
    this.phone = false;
    this.contextOpen = false;
    this.info = ahp().info;
    this.stick = true;
    this.notice = null;
    this.announce = "";
    this.loadingOlder = false;
  }

  static override styles = [
    base,
    cardStyles,
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
      .banner { flex: none; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px; padding: 8px 12px; border-radius: 12px; background: var(--banner-bg);
        color: var(--banner-fg); font-weight: 600; font-size: 14px; border: 1px solid var(--needs-edge); }
      .banner button { margin-left: auto; }
      .stage { position: relative; flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; }
      .scroller { flex: 1 1 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 0 6px; scrollbar-gutter: stable; }
      .inner { max-width: 820px; margin: 0 auto; padding-bottom: 12px; min-width: 0; }
      .older { display: flex; justify-content: center; padding: 12px 0 4px; }
      .empty { max-width: 46ch; margin: 12vh auto 0; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 0 16px; }
      .empty h2 { font-size: 22px; } .empty p { margin: 0; color: var(--ink-2); line-height: 1.5; }
      .skeleton { display: flex; flex-direction: column; gap: 12px; padding: 24px 0; }
      .skeleton i { display: block; height: 16px; border-radius: 8px; background: var(--sunken); animation: pulse 1.4s ease-in-out infinite; }
      .skeleton i:nth-child(2) { width: 80%; } .skeleton i:nth-child(3) { width: 60%; }
      @keyframes pulse { 50% { opacity: 0.45; } }
      .jump { position: absolute; left: 50%; transform: translateX(-50%); bottom: 12px; z-index: 5; min-height: 44px; padding: 0 16px; border-radius: 999px;
        border: 1px solid var(--line-strong); background: var(--surface); color: var(--ink); font: 700 14px var(--body); cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,0.18);
        display: inline-flex; align-items: center; gap: 8px; }
      .jump:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 2px; }
      .jump svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
      .dock { flex: none; max-width: 820px; width: 100%; margin: 0 auto; box-sizing: border-box; padding: 6px 6px max(8px, env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 8px; }
      .needs-bar { display: flex; align-items: center; gap: 10px; padding: 6px 6px 6px 14px; border-radius: 14px; background: var(--needs-bg); color: var(--needs-fg);
        border: 1px solid var(--needs-edge); font-weight: 700; font-size: 14px; }
      .needs-bar button { margin-left: auto; }
      .notice { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 12px; border: 1px solid var(--alarm); color: var(--alarm-fg); font-size: 14px; font-weight: 600; }
      .notice button { margin-left: auto; }
      @media (max-width: 767px) {
        .title { font-size: 17px; }
        .meta code { display: none; }
        .scroller { padding: 0 2px; }
        .dock { padding-left: 2px; padding-right: 2px; }
      }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    const c = ahp();
    this.info = c.info;
    this.offs = [
      c.onChange((uris) => {
        const conv = this.conv;
        if (conv && (uris.has(conv.ahpChat) || uris.has(conv.ahpSession))) {
          this.noteTransitions();
          this.requestUpdate();
        }
      }),
      c.onInfo((i) => {
        this.info = i;
      }),
      c.onRejected(this.onRejected),
      c.onAccepted((seq) => this.inflight.delete(seq)),
    ];
    if (typeof ResizeObserver === "function") {
      this.resizer = new ResizeObserver(() => {
        if (this.stick) this.scrollToBottom();
      });
    }
  }

  override disconnectedCallback(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.unwatch();
    this.resizer?.disconnect();
    clearTimeout(this.announceTimer);
    super.disconnectedCallback();
  }

  private unwatch() {
    for (const r of this.releases) r();
    this.releases = [];
    this.wired = "";
  }

  override willUpdate(changed: Map<string, unknown>): void {
    const conv = this.conv;
    const key = conv ? `${conv.id}|${conv.ahpSession}|${conv.ahpChat}` : "";
    if (changed.has("conv") && key !== this.wired) {
      this.unwatch();
      this.wired = key;
      this.firstId = undefined;
      this.lastFirstId = undefined;
      this.stick = true;
      this.focusedPending = false;
      this.baselined = false;
      this.modeApplied = false;
      this.prevActive = undefined;
      this.prevPending = new Set();
      this.notice = null;
      if (conv) {
        const c = ahp();
        this.releases = [c.watch(conv.ahpSession), c.watch(conv.ahpChat, { turns: WINDOW })];
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
    if (changed.has("conv")) {
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
    this.applyRememberedMode();
    if (!this.baselined) this.noteTransitions();
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
  private inflight = new Map<number, { text: string; files: File[] }>();

  private remember(clientSeq: number, text: string, files: File[]) {
    this.inflight.set(clientSeq, { text, files });
    if (this.inflight.size > 30) {
      const oldest = this.inflight.keys().next().value;
      if (oldest !== undefined) this.inflight.delete(oldest);
    }
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
    (
      this.renderRoot.querySelector("inc-conv-composer") as
        | (HTMLElement & { restore(text: string, files?: File[]): void })
        | null
    )?.restore(sent.text, sent.files);
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
      return "Couldn't read one of the images.";
    }
    const running = !!ahp().chat(conv.ahpChat)?.activeTurn;
    const action =
      d.intent === "turn" && !running
        ? turnStarted(d.text, attachments)
        : pendingMessage(d.intent === "steer" ? "steering" : "queued", d.text, attachments);
    const sent = ahp().dispatch(conv.ahpChat, action);
    if (sent.ok) this.remember(sent.clientSeq, d.text, d.files);
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
  focusPending(): void {
    const conv = this.conv;
    const chat = conv ? ahp().chat(conv.ahpChat) : undefined;
    const p = firstPending(chat);
    if (!p) return;
    const turn = this.renderRoot.querySelector<HTMLElement>("inc-conv-turn[active]");
    const tool = [
      ...(turn?.shadowRoot?.querySelectorAll<HTMLElement>("inc-conv-tool, inc-conv-question") ?? []),
    ].find((el) => {
      const call = (el as unknown as { call?: { toolCallId: string }; request?: { id: string } }).call;
      const req = (el as unknown as { request?: { id: string } }).request;
      return call?.toolCallId === p.id || req?.id === p.id;
    });
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
    if (firstPending(chat))
      void this.updateComplete.then(() => requestAnimationFrame(() => this.focusPending()));
  }

  // ───────────────────────────── view ─────────────────────────────

  private visible(turns: readonly { id: string }[]): number {
    let idx = this.firstId ? turns.findIndex((t) => t.id === this.firstId) : -1;
    if (idx < 0) idx = Math.max(0, turns.length - WINDOW);
    if (this.stick && turns.length - idx > WINDOW + 10) idx = turns.length - WINDOW;
    this.firstId = turns[idx]?.id;
    return idx;
  }

  override render() {
    const conv = this.conv;
    if (!conv) return nothing;
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
    const blocked =
      this.info.status !== "open"
        ? this.info.status === "failed"
          ? "Can't talk to the host."
          : "Reconnecting to the host… your message will wait here."
        : gone
          ? "This conversation is no longer on the host."
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
          <h2 class="title" title=${conv.title}>${chat?.title && chat.title !== "New conversation" ? chat.title : conv.title}</h2>
          <div class="meta"><span>${name}</span>${conv.project ? projectBadge(conv.project) : html`<span>No project</span>`}
            ${conv.branch ? html`<code>${conv.branch}</code>` : nothing}
            <span class="status ${live.needs ? "needs" : live.running ? "run" : ""}">${status}</span></div>
        </div>
        <button class="tool-btn" type="button" aria-label="Context panel" aria-pressed=${this.contextOpen ? "true" : "false"} title="Context: plan, files, usage"
          @click=${() => this.dispatchEvent(new CustomEvent("conv-toggle-context", { bubbles: true, composed: true }))}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg></button>
      </div>
      ${
        this.info.status !== "open"
          ? html`<div class="banner" role="status">${this.info.status === "failed" ? this.info.error : this.info.everOpen ? "Reconnecting…" : "Connecting…"}
              ${this.info.attempt > 1 && this.info.error ? html`<span>${this.info.error}</span>` : nothing}
              <button class="cbtn" type="button" @click=${() => ahp().retryNow()}>Retry now</button></div>`
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
                  (t) => html`<inc-conv-turn .turn=${t} .employee=${name}></inc-conv-turn>`,
                )}
                ${chat.activeTurn ? html`<inc-conv-turn .turn=${chat.activeTurn} active .employee=${name}></inc-conv-turn>` : nothing}
                ${
                  empty
                    ? html`<div class="empty"><h2>Start a conversation with ${name}</h2>
                        <p>${conv.project ? `Ask ${name} about ${conv.project}, or tell them what to change.` : `Ask ${name} anything, or tell them what to do.`} They work on their own copy${conv.branch ? ` (${conv.branch})` : ""}, so nothing changes in your project until you say so.</p>
                        <p>Type <b>/</b> for ${name}'s commands. Attach a screenshot by pasting or dropping it.</p></div>`
                    : nothing
                }`
          }
        </div>
      </div>
      ${
        !this.stick && chat
          ? html`<button class="jump" type="button" @click=${this.jump}>Jump to latest
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12l7 7 7-7"/></svg></button>`
          : nothing
      }
      </div>
      <div class="dock" @conv-stop=${this.onStop} @conv-config=${this.onConfig} @conv-unqueue=${this.onUnqueue}>
        ${pending ? html`<div class="needs-bar"><span>${name} is waiting for you</span><button class="cbtn" type="button" @click=${() => this.focusPending()}>Review</button></div>` : nothing}
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
