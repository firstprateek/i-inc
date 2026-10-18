// Chat (spec §10): one thread per employee. Questions get answers; asks become draft tickets you put
// on the board with one tap (a PA's asks become errands at once); notes reach a working employee at
// the next stage boundary.
import { css, html, LitElement } from "lit";
import { refreshNow } from "../api.ts";
import { showLogin } from "../login.ts";
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

export interface Thread {
  id: string;
  name: string;
  tint: number;
  role: string;
  last: Entry | null;
}

async function json<T>(method: string, url: string, body?: unknown, timeoutMs = 45_000): Promise<T> {
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  const res = await fetch(url, {
    method,
    ...(signal ? { signal } : {}),
    ...(method === "GET"
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }),
  });
  if (res.status === 401) showLogin();
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
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
  };
  declare employeeId: string;
  declare threads: Thread[];
  declare entries: Entry[];
  declare draft: string;
  declare urgent: boolean;
  declare busy: boolean;
  declare thinking: boolean;
  declare error: string | null;

  // Track pending optimistic messages across employees to prevent cross-thread leaks
  private pendingEntries: (Entry & { from: "owner" })[] = [];
  private inFlightEmployees = new Set<string>();
  // Unsent text per employee, so a message typed to one is never sent to another
  private drafts = new Map<string, string>();

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
  }

  override connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  private switched(changed: Map<string, unknown>): boolean {
    return changed.has("employeeId") && changed.get("employeeId") !== undefined;
  }

  override willUpdate(changed: Map<string, unknown>): void {
    if (this.switched(changed)) {
      // Drop the last employee's thread before this render, so it never shows under the new one.
      this.entries = [];
      this.error = null;
      const last = changed.get("employeeId") as string;
      if (last) this.drafts.set(last, this.draft);
      this.draft = this.drafts.get(this.employeeId) ?? "";
      this.thinking = this.inFlightEmployees.has(this.employeeId);
    }
  }

  override updated(changed: Map<string, unknown>): void {
    if (this.switched(changed)) {
      this.autoResize();
      void this.load();
    }
    if (changed.has("entries") || changed.has("thinking")) {
      this.scrollToBottom();
    }
  }

  scrollToBottom(): void {
    const msgs = this.renderRoot?.querySelector(".msgs") as HTMLElement | null;
    if (msgs) {
      msgs.scrollTop = msgs.scrollHeight;
    }
    const last = msgs?.lastElementChild as HTMLElement | null;
    if (last && typeof last.scrollIntoView === "function") {
      last.scrollIntoView({ block: "end", inline: "nearest" });
    }
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
        const res = await json<{ entries: Entry[] }>("GET", `/api/chat/${empId}`);
        // Only update entries if employee hasn't switched during fetch
        if (this.employeeId === empId) {
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

  private onInput = (e: Event) => {
    const target = e.target as HTMLTextAreaElement;
    this.draft = target.value;
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
    if (!text || !this.employeeId) return;

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
      status: "sending",
    };

    this.pendingEntries.push(optEntry);
    const combined = [...this.entries, optEntry];
    combined.sort((a, b) => a.at - b.at);
    this.entries = combined;

    this.draft = "";
    this.urgent = false;
    this.error = null;

    const textarea = this.renderRoot?.querySelector("textarea") as HTMLTextAreaElement | null;
    if (textarea) {
      textarea.value = "";
      textarea.style.height = "";
      textarea.focus();
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
    textarea?.focus();

    try {
      const res = await json<{ entries: Entry[] }>("POST", `/api/chat/${empId}`, {
        text: entry.text,
        ...(entry.urgent ? { urgent: true } : {}),
      });

      entry.status = "sent";
      entry.error = undefined;
      // Remove from pending entries once delivered
      this.pendingEntries = this.pendingEntries.filter((p) => p.id !== entry.id);

      // Only update this.entries if the user is still viewing this employee's thread!
      if (this.employeeId === empId) {
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
    this.entries = [...this.entries];
    await this.executeSend(entry as Entry & { from: "owner" });
  }

  private async confirm(ticketId: string) {
    await json("POST", `/api/chat/${this.employeeId}/drafts/${ticketId}`);
    await this.load();
    refreshNow();
  }

  static override styles = [
    base,
    css`
      .wrap { display: flex; gap: 20px; align-items: stretch; min-height: 70vh; }
      nav { width: 280px; flex-shrink: 0; padding: 10px; display: flex; flex-direction: column; gap: 2px; }
      nav a { display: flex; gap: 12px; align-items: center; padding: 10px; border-radius: 14px; text-decoration: none; }
      nav a[aria-current="true"] { background: var(--sunken); }
      nav small { display: block; font-size: 13px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 180px; }
      .thread { flex-grow: 1; min-width: 0; display: flex; flex-direction: column; }
      .head { padding: 16px 22px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 12px; }
      .msgs { flex-grow: 1; padding: 20px 22px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
      .me, .them, .ticket { overflow-wrap: anywhere; }
      .msg-body { white-space: pre-wrap; }
      .me { align-self: flex-end; max-width: 520px; padding: 11px 14px; border-radius: 16px 4px 16px 16px; background: var(--ink); color: var(--on-ink); }
      .them { align-self: flex-start; max-width: 620px; padding: 11px 14px; border-radius: 4px 16px 16px 16px; background: var(--sunken); }
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
      .ticket { align-self: flex-start; max-width: 620px; border: 2px dashed var(--line-strong); border-radius: 16px; padding: 14px;
        display: flex; flex-direction: column; gap: 8px; background: var(--surface); }
      form { padding: 12px 16px 16px; border-top: 1px solid var(--line); display: flex; gap: 10px; align-items: flex-end; }
      textarea { flex-grow: 1; min-width: 0; font: 16px/1.4 var(--body); min-height: 46px; max-height: 180px; padding: 11px 16px; border-radius: 20px;
        border: 1px solid var(--line-strong); background: var(--surface); color: var(--ink); resize: none; box-sizing: border-box; overflow-y: auto; }
      textarea:focus { outline: none; border-color: var(--ink); }
      .empty { color: var(--ink-2); }
      .me .tag { display: inline-block; margin-bottom: 4px; }
      .urgent[aria-pressed="true"] { border: 2px solid var(--ink); padding: 0 17px; }
      .head > div { min-width: 0; }
      @media (max-width: 800px) {
        .wrap { flex-direction: column; min-height: 0; }
        nav { width: auto; flex-direction: row; overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none; }
        nav::-webkit-scrollbar { display: none; }
        nav a { flex-shrink: 0; min-height: 44px; box-sizing: border-box; }
        nav small { display: none; }
        .thread { min-height: 52vh; }
        .head { padding: 12px 16px; }
        .msgs { padding: 16px; }
        .me, .them, .ticket { max-width: 88%; }
        /* The composer stays above the tab bar while a long thread scrolls. */
        form { position: sticky; bottom: calc(66px + env(safe-area-inset-bottom)); z-index: 5; flex-wrap: wrap;
          background: var(--surface); border-radius: 0 0 var(--radius) var(--radius); }
        form textarea { flex: 1 1 100%; }
        form .btn { flex: 1 1 0; }
        .me .retry { min-height: 44px; padding: 6px 14px; font-size: 13px; }
      }
    `,
  ];

  override render() {
    const me = (this.threads ?? []).find((t) => t.id === this.employeeId);
    return html`<div class="wrap">
      <nav class="card" aria-label="Chats">
        ${(this.threads ?? []).map(
          (t) => html`<a href="#/chat/${t.id}" aria-current=${t.id === this.employeeId ? "true" : "false"}>
            ${avatar(t, 40)}<span><b>${t.name}</b><small>${this.preview(t.last) ?? t.role}</small></span></a>`,
        )}
      </nav>
      <section class="card thread" aria-label="Chat with ${me?.name ?? "the team"}">
        ${
          me
            ? html`<div class="head">${avatar(me, 44)}<div><h2>${me.name}</h2><span class="muted" style="font-size:13px">${me.role}</span></div>
          <span style="flex-grow:1"></span><a class="btn ghost" href="#/brain/${me.id}" style="display:inline-flex;align-items:center;text-decoration:none">Brain</a></div>`
            : ""
        }
        <div class="msgs">
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
        <form @submit=${this.send}>
          <textarea enterkeyhint="send" autocomplete="off" autocapitalize="sentences" rows="1"
            aria-label="Message ${me?.name ?? ""}" placeholder="Message ${me?.name ?? ""}" .value=${this.draft}
            @input=${this.onInput}
            @keydown=${this.onKeyDown}></textarea>
          <button class="btn ghost urgent" type="button" aria-pressed=${this.urgent ? "true" : "false"}
            title=${me ? `Stop ${me.name}'s current session to read this now` : "Stop their current session to read this now"}
            @click=${() => {
              this.urgent = !this.urgent;
            }}>${this.urgent ? "✓ Urgent" : "Urgent"}</button>
          <button class="btn" type="submit" ?disabled=${!this.draft.trim()}>Send</button>
        </form>
      </section>
    </div>`;
  }

  private preview(e: Entry | null): string | null {
    if (!e) return null;
    if ("kind" in e && e.kind) return e.kind === "draft" ? `Drafted: ${e.title}` : `Errand: ${e.title}`;
    return "text" in e ? (e.text ?? null) : null;
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
      return html`<div class="me ${e.status ?? ""}">${e.urgent ? html`<span class="tag">urgent</span><br>` : ""}<div class="msg-body">${e.text}</div>${
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
        ${
          e.confirmed
            ? html`<a href="#/ticket/${e.ticketId}">On the board as #${e.ticketId}</a>`
            : html`<div style="display:flex;flex-wrap:wrap;gap:8px"><button type="button" class="btn" @click=${() => this.confirm(e.ticketId)}>Put on the board</button>
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

if (!customElements.get("inc-chat")) {
  customElements.define("inc-chat", IncChat);
}
