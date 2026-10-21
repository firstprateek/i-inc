// Chat (spec §10): one thread per employee. Questions get answers; asks become draft tickets you put
// on the board with one tap (a PA's asks become errands at once); notes reach a working employee at
// the next stage boundary. A message about the current ticket can bring images, stored on it (#16).
import { css, html, LitElement } from "lit";
import { imageRules, refresh, refreshNow } from "../api.ts";
import { hasNewFromOthers, isNearBottom, newFromOthers } from "../chat-scroll.ts";
import { draftMemo } from "../drafts.ts";
import { showLogin } from "../login.ts";
import { forget, ImagePicker, imagePickerStyles, type Picked } from "./image-picker.ts";
import { LAYOUT_BREAKPOINTS, layoutStyles } from "./layout.ts";
import { avatar, base } from "./shared.ts";

export type SendStatus = "sending" | "sent" | "error";

export type Entry =
  | {
      id?: string | undefined;
      employeeId?: string | undefined;
      from: "owner";
      at: number;
      text: string;
      urgent?: boolean | undefined;
      /** Images sent with it, as their numbers on that ticket. */
      images?: { ticketId: string; ns: number[] } | undefined;
      /** Images on their way, kept in memory for Retry, and the ticket they're for. */
      picked?: Picked[] | undefined;
      ticket?: string | undefined;
      status?: SendStatus | undefined;
      error?: string | undefined;
    }
  | {
      id?: string | undefined;
      employeeId?: string | undefined;
      from: "employee";
      at: number;
      text: string;
      status?: SendStatus | undefined;
    }
  | {
      id?: string | undefined;
      employeeId?: string | undefined;
      from: "employee";
      at: number;
      kind: "draft";
      ticketId: string;
      title: string;
      confirmed: boolean;
      /** C12: where the draft will be filed, whether that came from the message, and the options. */
      project?: string | undefined;
      inferred?: boolean | undefined;
      ambiguous?: string[] | undefined;
      choices?: string[] | undefined;
      status?: SendStatus | undefined;
    }
  | {
      id?: string | undefined;
      employeeId?: string | undefined;
      from: "employee";
      at: number;
      kind: "errand";
      ticketId: string;
      title: string;
      status?: SendStatus | undefined;
    }
  | {
      id?: string | undefined;
      employeeId?: string | undefined;
      from: "system";
      at: number;
      text: string;
      status?: SendStatus | undefined;
    };

/** The ticket the employee is on now: where images in the composer go, and how many it has. */
export interface Current {
  id: string;
  title: string;
  images: number;
}

export interface Thread {
  id: string;
  name: string;
  tint: number;
  role: string;
  last: Entry | null;
}

/** A refused request, with what the daemon said about the current ticket, if anything. */
class Refused extends Error {
  constructor(
    message: string,
    readonly current: Current | null | undefined,
  ) {
    super(message);
  }
}

async function json<T>(
  method: string,
  url: string,
  body?: unknown,
  timeoutMs = 45_000,
  images: File[] = [],
): Promise<T> {
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  // With images, one multipart request: the message as a JSON field, and the header that lets the
  // daemon take a write that isn't JSON.
  const form = new FormData();
  if (images.length) {
    form.set("message", JSON.stringify(body ?? {}));
    for (const f of images) form.append("image", f, f.name);
  }
  const res = await fetch(url, {
    method,
    ...(signal ? { signal } : {}),
    ...(method === "GET"
      ? {}
      : images.length
        ? { headers: { "x-i-inc-upload": "1" }, body: form }
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }),
  });
  if (res.status === 401) showLogin();
  const data = (await res.json()) as T & { error?: string; current?: Current | null };
  if (!res.ok) throw new Refused(data.error ?? `${res.status}`, data.current);
  return data;
}

export function isTouchDevice(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  // Key off a coarse primary pointer with no hover (e.g. phones, pure touch devices without physical keyboard/mouse).
  // Touchscreen laptops and iPads with keyboards maintain Enter-to-send.
  return window.matchMedia("(pointer: coarse) and (hover: none)").matches;
}

export class IncChat extends LitElement {
  static override properties = {
    employeeId: {},
    threads: { state: true },
    entries: { state: true },
    draft: { state: true },
    urgent: { state: true },
    busy: { state: true },
    thinking: { state: true },
    error: { state: true },
    picks: { state: true },
    newBelow: { state: true },
    announcement: { state: true },
    current: { state: true },
  };
  declare employeeId: string;
  declare threads: Thread[];
  declare entries: Entry[];
  declare draft: string;
  declare urgent: boolean;
  declare busy: boolean;
  declare thinking: boolean;
  declare error: string | null;
  /** Projects the owner has picked for drafts not yet put on the board, by ticket. */
  declare picks: Record<string, string>;
  /** Something new arrived below while the reader was scrolled up: show "New messages". */
  declare newBelow: boolean;
  /** What the polite status region says: the newest message from someone else, never the whole list. */
  declare announcement: string;
  /** The ticket the employee is on now, or null: images can only go with a message about one. */
  declare current: Current | null;
  private readonly picker = new ImagePicker(this, {
    id: "chat",
    room: () => imageRules.perTicket - (this.current?.images ?? 0),
    full: (room) =>
      room
        ? `You can add ${room} more images now.`
        : `A ticket takes at most ${imageRules.perTicket} images.`,
  });

  // Scroll state. Only the message list scrolls, never the page (no scrollIntoView, no window.scrollTo).
  /** The reader is at (or near) the bottom of the list, so new content should keep it pinned there. */
  private stick = true;
  /** A thread was just opened: jump to its newest message once its entries arrive. */
  private jumpPending = true;
  /** The owner just sent or retried a message: scroll to it whatever the position. */
  private forceScroll = false;
  /** willUpdate decided the list must be pinned to the bottom after this render. */
  private pinAfterRender = false;
  private resizeObserver: ResizeObserver | null = null;

  // Track pending optimistic messages across employees to prevent cross-thread leaks
  private pendingEntries: (Entry & { from: "owner" })[] = [];
  private inFlightEmployees = new Set<string>();
  // Unsent text per employee, so a message typed to one is never sent to another. The Map is always
  // current for this page; localStorage only brings a draft back after a reload, when the Map is empty.
  private drafts = new Map<string, string>();

  private draftFor(employeeId: string): string {
    return this.drafts.get(employeeId) ?? draftMemo.get(employeeId) ?? "";
  }

  private keepDraft(employeeId: string, text: string): void {
    this.drafts.set(employeeId, text);
    draftMemo.set(employeeId, text);
  }

  constructor() {
    super();
    this.employeeId = "";
    this.threads = [];
    this.entries = [];
    this.draft = "";
    this.urgent = false;
    this.busy = false;
    this.thinking = false;
    this.error = null;
    this.picks = {};
    this.newBelow = false;
    this.announcement = "";
    this.current = null;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    refresh.addEventListener("refresh", this.onRefresh);
    void this.load();
  }

  override disconnectedCallback(): void {
    refresh.removeEventListener("refresh", this.onRefresh);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    super.disconnectedCallback();
  }

  override firstUpdated(): void {
    // The list's own size changes (window resize, a taller composer): stay pinned if the reader was.
    const msgs = this.msgsEl();
    if (msgs && typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.stick) this.scrollToBottom();
      });
      this.resizeObserver.observe(msgs);
    }
  }

  private msgsEl(): HTMLElement | null {
    return (this.renderRoot?.querySelector(".msgs") as HTMLElement | null) ?? null;
  }

  private onScroll = () => {
    const msgs = this.msgsEl();
    if (!msgs) return;
    this.stick = isNearBottom(msgs);
    if (this.stick && this.newBelow) this.newBelow = false;
  };

  private switched(changed: Map<string, unknown>): boolean {
    return changed.has("employeeId") && changed.get("employeeId") !== undefined;
  }

  override willUpdate(changed: Map<string, unknown>): void {
    if (this.switched(changed)) {
      // Drop the last employee's thread before this render, so it never shows under the new one.
      this.entries = [];
      this.error = null;
      const last = changed.get("employeeId") as string;
      // Memory only: onInput already stored it, and a sent draft stays stored until the send succeeds.
      if (last) this.drafts.set(last, this.draft);
      this.draft = this.draftFor(this.employeeId);
      this.thinking = this.inFlightEmployees.has(this.employeeId);
      // A new thread opens at its newest message, with nothing waiting below.
      this.jumpPending = true;
      this.stick = true;
      this.newBelow = false;
      this.announcement = "";
      // Images picked were for the last employee's ticket.
      this.current = null;
      this.picker.clear();
    } else if (changed.has("employeeId") && this.employeeId) {
      // First mount, or load() picking the first thread: bring back a draft from before a reload.
      this.draft = this.draftFor(this.employeeId);
    }
    this.planScroll(changed);
  }

  /**
   * Decides, before the DOM changes, whether the list follows what is about to be rendered. `stick`
   * is the reader's position as of the last scroll event, i.e. before the new content made it taller.
   */
  private planScroll(changed: Map<string, unknown>): void {
    this.pinAfterRender = false;
    if (changed.has("entries")) {
      // Screen readers hear a new message from someone else, once, in the status region. Opening a
      // thread (the whole list arriving) is silent: the list itself is aria-live="off".
      if (!(this.jumpPending && this.entries.length > 0)) {
        const fresh = newFromOthers((changed.get("entries") as Entry[] | undefined) ?? [], this.entries).at(
          -1,
        );
        if (fresh) this.announcement = this.spoken(fresh);
      }
      if (this.jumpPending && this.entries.length > 0) {
        // Opening a thread: jump (no animation) to the newest message.
        this.jumpPending = false;
        this.forceScroll = false;
        this.pinAfterRender = true;
      } else if (this.forceScroll) {
        this.forceScroll = false;
        this.pinAfterRender = true;
      } else if (this.stick) {
        this.pinAfterRender = true;
      } else if (hasNewFromOthers((changed.get("entries") as Entry[] | undefined) ?? [], this.entries)) {
        this.newBelow = true;
      }
    } else if (changed.has("thinking") || changed.has("error")) {
      if (this.forceScroll || this.stick) this.pinAfterRender = true;
    }
  }

  override updated(changed: Map<string, unknown>): void {
    if (this.switched(changed)) {
      this.autoResize();
      void this.load();
    } else if (changed.has("employeeId") && this.draft) {
      this.autoResize();
    }
    if (this.pinAfterRender) {
      this.pinAfterRender = false;
      this.scrollToBottom();
    }
  }

  private spoken(e: Entry): string {
    const who = (this.threads ?? []).find((t) => t.id === this.employeeId)?.name ?? "Employee";
    const clip = (t: string) => (t.length > 240 ? `${t.slice(0, 240)}…` : t);
    if ("kind" in e && e.kind === "draft") return `${who} drafted a ticket: ${e.title}`;
    if ("kind" in e && e.kind === "errand") return `${who} started an errand: ${e.title}`;
    const text = "text" in e ? (e.text ?? "") : "";
    return e.from === "system" ? clip(text) : `${who}: ${clip(text)}`;
  }

  /** Jumps the message list (and only it) to the newest message. */
  scrollToBottom(): void {
    const msgs = this.msgsEl();
    if (!msgs) return;
    msgs.scrollTop = msgs.scrollHeight;
    this.stick = true;
    if (this.newBelow) this.newBelow = false;
  }

  isTouch(): boolean {
    return isTouchDevice();
  }

  private async load() {
    const targetEmployeeId = this.employeeId;
    try {
      this.threads = (await json<{ threads: Thread[] }>("GET", "/api/chat")).threads;
      if (!this.employeeId && this.threads[0]) this.employeeId = this.threads[0].id;
      if (this.employeeId) {
        const empId = this.employeeId;
        const res = await json<{ entries: Entry[]; current?: Current | null }>("GET", `/api/chat/${empId}`);
        // Only update entries if employee hasn't switched during fetch
        if (this.employeeId === empId) {
          this.setCurrent(res.current);
          const myPending = this.pendingEntries.filter(
            (e) => e.employeeId === empId && (e.status === "sending" || e.status === "error"),
          );
          const combined = [...(res.entries ?? []), ...myPending];
          combined.sort((a, b) => a.at - b.at);
          this.entries = combined;
        }
      }
      if (this.employeeId === targetEmployeeId) {
        this.error = null;
      }
    } catch (e) {
      if (this.employeeId === targetEmployeeId) {
        this.error = e instanceof Error ? e.message : String(e);
      }
    }
  }

  // A live event or an action elsewhere: the employee may have started, finished or changed tickets,
  // so ask again where images would go. Any ticket's event can be the one they just started, so this
  // doesn't filter by scope.
  private onRefresh = () => void this.loadCurrent();

  private async loadCurrent(): Promise<void> {
    const empId = this.employeeId;
    if (!empId) return;
    try {
      const res = await json<{ current?: Current | null }>("GET", `/api/chat/${empId}`);
      if (this.employeeId === empId) this.setCurrent(res.current);
    } catch {
      // Keep what we have: the next refresh, or a send's 409, brings it up to date.
    }
  }

  /** A different ticket (or none) means the picked images no longer have a place to go. */
  private setCurrent(next: Current | null | undefined): void {
    if (next === undefined) return;
    if (next?.id !== this.current?.id) this.picker.clear();
    this.current = next;
  }

  private onInput = (e: Event) => {
    const target = e.target as HTMLTextAreaElement;
    this.draft = target.value;
    if (this.employeeId) this.keepDraft(this.employeeId, this.draft);
    this.autoResize(target);
  };

  private autoResize(target?: HTMLTextAreaElement | null) {
    const el = target ?? (this.renderRoot?.querySelector("textarea") as HTMLTextAreaElement | null);
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(46, el.scrollHeight)}px`;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      // IME composition guard: skip Enter when composing or during IME selection
      if (e.isComposing || e.keyCode === 229) {
        return;
      }
      if (e.shiftKey) {
        // Shift+Enter inserts a newline
        return;
      }
      if (this.isTouch()) {
        // On pure touch devices (coarse pointer, no hover) Return keeps a newline; user taps Send button
        return;
      }
      e.preventDefault();
      void this.send();
    }
  };

  async send(e?: Event) {
    e?.preventDefault();
    const text = this.draft.trim();
    const withImages = !!this.current && this.picker.images.length > 0;
    if ((!text && !withImages) || !this.employeeId) return;

    const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const urgent = this.urgent;
    const empId = this.employeeId;

    const optEntry: Entry & { from: "owner" } = {
      id: msgId,
      employeeId: empId,
      from: "owner",
      at: Date.now(),
      text,
      ...(urgent ? { urgent: true } : {}),
      ...(withImages && this.current ? { picked: this.picker.take(), ticket: this.current.id } : {}),
      status: "sending",
    };

    this.pendingEntries.push(optEntry);
    this.forceScroll = true;
    const combined = [...this.entries, optEntry];
    combined.sort((a, b) => a.at - b.at);
    this.entries = combined;

    // The box empties now and the bubble's Retry owns the text, but the stored draft stays until the
    // send succeeds, so a failed send and a reload don't lose it.
    this.draft = "";
    this.drafts.set(empId, "");
    this.urgent = false;
    this.error = null;

    const textarea = this.renderRoot?.querySelector("textarea") as HTMLTextAreaElement | null;
    if (textarea) {
      textarea.value = "";
      textarea.style.height = "";
      textarea.focus({ preventScroll: true });
    }

    void this.executeSend(optEntry);
  }

  private async executeSend(entry: Entry & { from: "owner" }) {
    const empId = entry.employeeId ?? this.employeeId;
    this.inFlightEmployees.add(empId);
    if (this.employeeId === empId) {
      this.thinking = true;
    }
    this.busy = true;

    await this.updateComplete;
    this.scrollToBottom();
    const textarea = this.renderRoot?.querySelector("textarea") as HTMLTextAreaElement | null;
    textarea?.focus({ preventScroll: true });

    try {
      const res = await json<{ entries: Entry[]; current?: Current | null }>(
        "POST",
        `/api/chat/${empId}`,
        {
          text: entry.text,
          ...(entry.urgent ? { urgent: true } : {}),
          ...(entry.picked?.length ? { ticket: entry.ticket } : {}),
        },
        undefined,
        entry.picked?.map((p) => p.file),
      );

      entry.status = "sent";
      entry.error = undefined;
      draftMemo.clearIfSent(empId, entry.text);
      // The daemon has the images now, and the thread shows its own copies.
      entry.picked?.forEach(forget);
      entry.picked = undefined;
      // Remove from pending entries once delivered
      this.pendingEntries = this.pendingEntries.filter((p) => p.id !== entry.id);

      // Only update this.entries if the user is still viewing this employee's thread!
      if (this.employeeId === empId) {
        this.setCurrent(res.current);
        if (res.entries && res.entries.length > 0) {
          const merged: Entry[] = res.entries.map((item) => ({ ...item }));
          for (let i = merged.length - 1; i >= 0; i--) {
            const item = merged[i];
            if (item && item.from === "owner" && item.text === entry.text && !item.status) {
              item.status = "sent";
              if (entry.id) item.id = entry.id;
              break;
            }
          }
          const otherPending = this.pendingEntries.filter(
            (e) =>
              e.employeeId === empId && e.id !== entry.id && (e.status === "sending" || e.status === "error"),
          );
          const combined = [...merged, ...otherPending];
          combined.sort((a, b) => a.at - b.at);
          this.entries = combined;
        }
      }
      refreshNow();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      entry.status = "error";
      entry.error = errMsg;
      if (this.employeeId === empId) {
        // The ticket may have moved on since the page loaded: show where images would go now.
        if (err instanceof Refused) this.setCurrent(err.current);
        this.error = errMsg;
        this.entries = [...this.entries];
      }
    } finally {
      this.inFlightEmployees.delete(empId);
      if (this.employeeId === empId) {
        this.thinking = false;
      }
      this.busy = this.inFlightEmployees.size > 0;
    }
  }

  async retry(entry: Entry) {
    if (entry.from !== "owner") return;
    entry.status = "sending";
    entry.error = undefined;
    this.error = null;
    this.forceScroll = true;
    this.entries = [...this.entries];
    await this.executeSend(entry as Entry & { from: "owner" });
  }

  private async confirm(ticketId: string, project?: string) {
    await json("POST", `/api/chat/${this.employeeId}/drafts/${ticketId}`, project ? { project } : undefined);
    await this.load();
    refreshNow();
  }

  static override styles = [
    base,
    layoutStyles,
    imagePickerStyles,
    css`
      /* The chat fills whatever room the app shell gives it (the shell is exactly the viewport below the
         header on this route), and each region scrolls by itself: the list, and the messages. */
      :host { display: block; height: 100%; min-height: 0; }
      nav { min-height: 0; padding: 10px; display: flex; flex-direction: column; gap: 2px; overflow-y: auto; overscroll-behavior: contain; }
      nav a { flex: none; display: flex; gap: 12px; align-items: center; padding: 10px; border-radius: 14px; text-decoration: none; min-height: 44px; box-sizing: border-box; }
      nav a[aria-current="true"] { background: var(--sunken); }
      nav a > span:not(.avatar) { min-width: 0; }
      nav small { display: block; font-size: 13px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 180px; }
      .thread { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
      .thread.layout-split-work { overflow: hidden; }
      .head { flex: none; padding: 16px 22px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 12px; }
      .head h2 { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .head .btn { flex: none; }
      /* The pane's one scrolling part. The "New messages" button floats over it, so it sits in a
         positioned wrapper that does not scroll. */
      .msgs-wrap { position: relative; flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; }
      .msgs { flex: 1 1 0; min-height: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain;
        scroll-behavior: auto; -webkit-overflow-scrolling: touch;
        /* Wide screens: a centred, readable column (about 760px) with the scrollbar at the pane's edge. */
        padding: 20px max(22px, calc((100% - 760px) / 2)); display: flex; flex-direction: column; gap: 12px; }
      .msgs > * { flex: none; }
      .msgs:focus-visible { outline: 2px solid var(--reviewing-mark); outline-offset: -2px; }
      /* A surface pill with an ink ring: legible over the page, a sunken reply bubble and an ink owner
         bubble alike, in both themes (the plain .btn is ink, the very colour of the owner's bubble). */
      .jump { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); z-index: 2;
        display: inline-flex; align-items: center; gap: 6px; padding: 0 18px; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.28);
        background: var(--surface); color: var(--ink); border: 2px solid var(--ink); }
      .sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
        clip-path: inset(50%); white-space: nowrap; border: 0; }
      .me, .them, .ticket { overflow-wrap: anywhere; }
      .msg-body { white-space: pre-wrap; }
      .me { align-self: flex-end; max-width: min(520px, 88%); padding: 11px 14px; border-radius: 18px 18px 4px 18px; background: var(--ink); color: var(--on-ink); }
      .them { align-self: flex-start; max-width: min(620px, 92%); padding: 11px 14px; border-radius: 18px 18px 18px 4px; background: var(--sunken); }
      .them.thinking { display: inline-flex; align-items: center; gap: 8px; color: var(--ink-2); font-style: normal; }
      .them.thinking .dots { display: inline-flex; align-items: center; gap: 3px; }
      .them.thinking .dots span { width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: 0.3; animation: chat-dot-pulse 1.4s infinite ease-in-out both; }
      .them.thinking .dots span:nth-child(1) { animation-delay: -0.32s; }
      .them.thinking .dots span:nth-child(2) { animation-delay: -0.16s; }
      @keyframes chat-dot-pulse {
        0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
        40% { opacity: 1; transform: scale(1.1); }
      }
      .me .meta { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 4px; font-size: 11px; opacity: 0.85; }
      .me .status { font-size: 11px; }
      .me .status.sending { font-style: italic; }
      .me .status.error { color: var(--alarm-fg, #f28b76); font-weight: 600; }
      .me .retry { font-size: 12px; font-weight: 600; padding: 4px 12px; min-height: 36px; min-width: 44px; border-radius: 8px; background: var(--surface); color: var(--ink); border: 1px solid var(--line-strong); cursor: pointer; touch-action: manipulation; }
      .error-msg { color: var(--alarm-fg, #8a2b17); background: var(--needs-bg, rgba(196, 69, 43, 0.1)); border: 1px solid var(--alarm, #c4452b); padding: 8px 12px; border-radius: 8px; font-size: 13px; margin: 0; align-self: flex-start; }
      .sys { align-self: center; font-size: 13px; color: var(--ink-2); }
      .ticket { align-self: flex-start; max-width: min(620px, 92%); border: 2px dashed var(--line-strong); border-radius: 16px; padding: 14px;
        display: flex; flex-direction: column; gap: 8px; background: var(--surface); }
      /* The composer is pinned under the list and never scrolls away. */
      .composer { flex: none; border-top: 1px solid var(--line); }
      form { padding: 12px max(16px, calc((100% - 760px) / 2)) 16px; display: flex; gap: 10px; align-items: flex-end; }
      /* Images picked for the current ticket, above the message field. */
      .attach { padding: 12px max(16px, calc((100% - 760px) / 2)) 0; display: flex; flex-direction: column; gap: 8px; font-size: 13px; color: var(--ink-2); }
      .attach .for b { color: var(--ink); }
      .attach .problem { margin: 0; color: var(--alarm-fg, #8a2b17); }
      .add-images { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; width: 44px; height: 44px; padding: 0; border-radius: 50%; }
      .add-images svg { width: 22px; height: 22px; display: block; }
      .add-images:disabled { opacity: 0.4; cursor: default; }
      .me .sent-images { list-style: none; margin: 0 0 6px; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
      .me .sent-images img { display: block; width: 88px; height: 88px; object-fit: cover; border-radius: 10px; background: var(--surface); }
      .me .sent-images a { display: block; border-radius: 10px; }
      textarea { flex-grow: 1; min-width: 0; font: 16px/1.4 var(--body); min-height: 46px; max-height: min(180px, 26vh); max-height: min(180px, 26dvh); padding: 11px 16px; border-radius: 20px;
        border: 1px solid var(--line-strong); background: var(--surface); color: var(--ink); resize: none; box-sizing: border-box; overflow-y: auto; }
      textarea:focus { outline: none; border-color: var(--ink); }
      .send { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
        min-width: 40px; min-height: 40px; width: 44px; height: 44px; padding: 0; border-radius: 50%;
        /* A transparent 2px ring keeps the drawn circle 40px inside a 44px tap target. */
        border: 2px solid transparent; background-clip: padding-box; }
      .send svg { width: 20px; height: 20px; display: block; }
      .send:disabled { opacity: 0.4; cursor: default; }
      .empty { color: var(--ink-2); }
      .project { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; font-size: 14px; }
      .project .tag { margin: 0; }
      .project label { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; color: var(--ink-2); }
      .project select { font: 16px/1.2 var(--body); min-height: 44px; max-width: 100%; padding: 0 12px; border-radius: 12px;
        border: 1px solid var(--line-strong); background: var(--surface); color: var(--ink); box-sizing: border-box; }
      .project select:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
      .ticket .btn:disabled { opacity: 0.4; cursor: default; }
      .project .hint { flex-basis: 100%; color: var(--ink-2); }
      .me .tag { display: inline-block; margin-bottom: 4px; }
      .urgent[aria-pressed="true"] { border: 2px solid var(--ink); padding: 0 17px; }
      .head > div { min-width: 0; }
      /* Phones (the app's own phone breakpoint): the list of people is a strip across the top, the
         conversation fills the rest down to the tab bar, and the composer sits right above it. */
      @media (max-width: ${LAYOUT_BREAKPOINTS.split - 1}px) {
        nav.card, .thread.card { border-radius: 0; border-left: 0; border-right: 0; box-shadow: none; }
        nav { flex-direction: row; gap: 4px; padding: 6px 8px; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain;
          scrollbar-width: none; border-top: 0; }
        nav::-webkit-scrollbar { display: none; }
        nav a { gap: 8px; padding: 6px 12px; }
        nav small { display: none; }
        .thread { border-bottom: 0; }
        .head { padding: 8px 16px; }
        .msgs { padding: 14px 16px; }
        form { flex-wrap: wrap; padding: 10px 16px 12px; }
        form textarea { flex: 1 1 100%; }
        form .urgent, form .add-images { flex: none; }
        form .send { margin-left: auto; }
        .me .retry { min-height: 44px; padding: 6px 14px; font-size: 13px; }
      }
      /* A short phone screen (landscape, or the keyboard up): the conversation and composer get all of
         it, so the people strip and the thread head step aside (switch threads by leaving the field,
         or turning the phone back). On a touch screen the same goes while the message field is focused. */
      @media (max-width: ${LAYOUT_BREAKPOINTS.phone}px) and (max-height: 520px) {
        nav.card, .head { display: none; }
        .wrap { grid-template-rows: minmax(0, 1fr); }
      }
      @media (max-width: ${LAYOUT_BREAKPOINTS.phone}px) and (pointer: coarse) {
        .wrap:has(textarea:focus) nav.card, .wrap:has(textarea:focus) .head { display: none; }
        .wrap:has(textarea:focus) { grid-template-rows: minmax(0, 1fr); }
      }
    `,
  ];

  override render() {
    const me = (this.threads ?? []).find((t) => t.id === this.employeeId);
    return html`<div class="wrap layout-split">
      <nav class="card layout-split-sidebar" aria-label="Conversations">
        ${(this.threads ?? []).map(
          (
            t,
          ) => html`<a href="#/conversations/${t.id}" aria-current=${t.id === this.employeeId ? "true" : "false"}>
            ${avatar(t, 40)}<span><b>${t.name}</b><small>${this.preview(t.last) ?? t.role}</small></span></a>`,
        )}
      </nav>
      <section class="card thread layout-split-work" aria-label="Conversation with ${me?.name ?? "the team"}">
        ${
          me
            ? html`<div class="head">${avatar(me, 44)}<div><h2>${me.name}</h2><span class="muted" style="font-size:13px">${me.role}</span></div>
          <span style="flex-grow:1"></span><a class="btn ghost" href="#/company/brain/${me.id}" style="display:inline-flex;align-items:center;text-decoration:none">Brain</a></div>`
            : ""
        }
        <div class="msgs-wrap">
        <div class="msgs" role="log" aria-live="off" tabindex="0" aria-label="Messages with ${me?.name ?? "the team"}" @scroll=${this.onScroll}>
          ${this.entries.length ? this.entries.map((e) => this.entry(e)) : html`<p class="empty">Ask ${me?.name ?? "them"} anything, or ask for something new.</p>`}
          ${
            this.thinking
              ? html`<div class="them thinking" role="status" aria-live="polite">
                  <span class="dots" aria-hidden="true"><span></span><span></span><span></span></span>
                  <span>${me?.name ?? "Employee"} is thinking…</span>
                </div>`
              : ""
          }
          ${this.error ? html`<p class="error-msg" role="alert">${this.error}</p>` : ""}
        </div>
        <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">${this.announcement}</div>
        ${
          this.newBelow
            ? html`<button class="btn jump" type="button" @click=${() => this.scrollToBottom()}>New messages <span aria-hidden="true">↓</span></button>`
            : ""
        }
        </div>
        <div class="composer">
        ${this.attachments()}
        <form @submit=${this.send} @paste=${this.current ? this.picker.paste : null}>
          <textarea enterkeyhint="send" autocomplete="off" autocapitalize="sentences" rows="1"
            aria-label="Message ${me?.name ?? ""}" placeholder="Message ${me?.name ?? ""}" .value=${this.draft}
            @input=${this.onInput}
            @keydown=${this.onKeyDown}></textarea>
          <button class="btn ghost urgent" type="button" aria-pressed=${this.urgent ? "true" : "false"}
            title=${me ? `Stop ${me.name}'s current session to read this now` : "Stop their current session to read this now"}
            @click=${() => {
              this.urgent = !this.urgent;
            }}>${this.urgent ? "✓ Urgent" : "Urgent"}</button>
          ${
            this.current
              ? html`${this.picker.input()}<button class="btn ghost add-images" type="button"
                  aria-label="Add images for #${this.current.id}" title="Add images for #${this.current.id} ${this.current.title}"
                  ?disabled=${this.picker.images.length >= this.picker.room} @click=${() => this.picker.open()}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/></svg>
                </button>`
              : ""
          }
          <button class="btn send" type="submit" aria-label="Send" ?disabled=${!this.draft.trim() && !(this.current && this.picker.images.length)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>
          </button>
        </form>
        </div>
      </section>
    </div>`;
  }

  /** The images picked for the current ticket, and why any weren't taken. */
  private attachments() {
    const c = this.current;
    if (!c || (!this.picker.images.length && !this.picker.problem)) return "";
    const name = (this.threads ?? []).find((t) => t.id === this.employeeId)?.name ?? "They";
    return html`<div class="attach" role="group" aria-label="Images for #${c.id}">
      <span class="for"><b>For #${c.id}</b> ${c.title} · ${name} sees them at their next session.</span>
      ${this.picker.thumbs({ compact: true })}
      ${this.picker.problem ? html`<p class="problem" role="alert">${this.picker.problem}</p>` : ""}
    </div>`;
  }

  private preview(e: Entry | null): string | null {
    if (!e) return null;
    if ("kind" in e && e.kind) return e.kind === "draft" ? `Drafted: ${e.title}` : `Errand: ${e.title}`;
    if (e.from === "owner" && !e.text && e.images) return images(e.images.ns.length);
    return "text" in e ? (e.text ?? null) : null;
  }

  /** The images on a message: the daemon's copies once sent, the local previews until then. */
  private sentImages(e: Entry & { from: "owner" }) {
    const sent = e.images;
    if (sent) {
      return html`<ul class="sent-images">${sent.ns.map((n) => {
        const url = `/api/tickets/${sent.ticketId}/attachments/${n}`;
        const name = `image ${n} on #${sent.ticketId}`;
        return html`<li><a href=${url} target="_blank" rel="noopener" aria-label="Open ${name}"><img src=${url} alt=${name} loading="lazy" /></a></li>`;
      })}</ul>`;
    }
    if (!e.picked?.length) return "";
    return html`<ul class="sent-images">${e.picked.map((p) => html`<li><img src=${p.url} alt=${p.file.name} /></li>`)}</ul>`;
  }

  /** C12: the project a draft will be filed under, with a way to change it before it goes on the board. */
  private projectRow(e: Extract<Entry, { kind: "draft" }>) {
    // An older daemon sends neither: show nothing new.
    if (e.inferred === undefined || !e.project) return "";
    const picked = this.picks[e.ticketId];
    const open = this.needsPick(e);
    const chosen = picked ?? (open ? "" : e.project);
    const options = e.choices?.includes(e.project) ? e.choices : [e.project, ...(e.choices ?? [])];
    const changed = picked !== undefined && picked !== e.project;
    return html`<div class="project">
      <span>Project: <b>${chosen || "not chosen yet"}</b></span>
      ${e.inferred && !changed && !e.confirmed ? html`<span class="tag">inferred</span>` : ""}
      ${
        !e.confirmed && (options.length > 1 || open)
          ? html`<label>${open ? "Choose" : "Change"}
              <select aria-label="Project for #${e.ticketId}" .value=${chosen}
                @change=${(ev: Event) => {
                  this.picks = { ...this.picks, [e.ticketId]: (ev.target as HTMLSelectElement).value };
                }}>
                ${open ? html`<option value="" ?selected=${chosen === ""} disabled>Choose a project…</option>` : ""}
                ${options.map((o) => html`<option value=${o} ?selected=${o === chosen}>${o}</option>`)}
              </select></label>`
          : ""
      }
      ${
        e.ambiguous?.length && !e.confirmed && open
          ? html`<span class="hint">${
              e.ambiguous.length > 1
                ? html`This names more than one project (${e.ambiguous.join(", ")}). Pick one.`
                : html`This names ${e.ambiguous.join(", ")}, which isn't one of this employee's projects. Pick one.`
            }</span>`
          : ""
      }
    </div>`;
  }

  /** A draft that named several projects waits for the owner to pick one before it goes on the board. */
  private needsPick(e: Extract<Entry, { kind: "draft" }>): boolean {
    return !e.confirmed && !!e.ambiguous?.length && !this.picks[e.ticketId];
  }

  private entry(e: Entry) {
    if (e.from === "owner") {
      const statusText =
        e.status === "sending"
          ? "sending…"
          : e.status === "sent"
            ? "sent"
            : e.status === "error"
              ? "failed"
              : null;
      return html`<div class="me ${e.status ?? ""}">${e.urgent ? html`<span class="tag">urgent</span><br>` : ""}${this.sentImages(e)}${e.text ? html`<div class="msg-body">${e.text}</div>` : ""}${
        statusText
          ? html`<div class="meta"><span class="status ${e.status}" aria-live="polite">${statusText}</span>${
              e.status === "error"
                ? html`<button class="btn retry" type="button" @click=${() => this.retry(e)}>Retry</button>`
                : ""
            }</div>`
          : ""
      }</div>`;
    }
    if (e.from === "system") return html`<div class="sys"><div class="msg-body">${e.text}</div></div>`;
    if ("kind" in e && e.kind === "draft") {
      return html`<div class="ticket">
        <span class="tag" style="align-self:flex-start">draft ticket</span>
        <b>${e.title}</b>
        ${this.projectRow(e)}
        ${
          e.confirmed
            ? html`<a href="#/ticket/${e.ticketId}">On the board as #${e.ticketId}</a>`
            : html`<div style="display:flex;flex-wrap:wrap;gap:8px"><button type="button" class="btn" ?disabled=${this.needsPick(e)} @click=${() => this.confirm(e.ticketId, this.picks[e.ticketId])}>Put on the board</button>
              <a class="btn ghost" href="#/ticket/${e.ticketId}" style="display:inline-flex;align-items:center;text-decoration:none">Open</a></div>`
        }
      </div>`;
    }
    if ("kind" in e && e.kind === "errand") {
      return html`<div class="ticket"><span class="tag" style="align-self:flex-start">errand</span><b>${e.title}</b>
        <a href="#/ticket/${e.ticketId}">On the Home lane as #${e.ticketId}</a></div>`;
    }
    return html`<div class="them"><div class="msg-body">${"text" in e ? e.text : ""}</div></div>`;
  }
}

const images = (n: number) => (n === 1 ? "1 image" : `${n} images`);

if (!customElements.get("inc-chat")) {
  customElements.define("inc-chat", IncChat);
}
