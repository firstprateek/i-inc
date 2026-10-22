// "Open the session" (T69): one ticket stage's agent session, watched live or replayed, in the same thread view as
// a conversation, read-only. The host keeps every stage as a read-only AHP chat (contract C22), so this is the
// Conversations thread with no composer and a context panel beside it: the plan, the files changed and the usage.
// On a laptop the panel sits beside the thread (or over it on a narrow window); on a phone it is a bottom sheet.
import type { Employee } from "@i-inc/core";
import { css, html, LitElement, nothing } from "lit";
import { useAhp } from "../ahp/hub.ts";
import { ApiError, api, type Conversation, refresh, type TicketSession, type TicketView } from "../api.ts";
import { base } from "./shared.ts";
import "./conv-context.ts";
import "./conv-thread.ts";

const CONTEXT_KEY = "i-inc-conv-context";
const PHONE = "(max-width: 767px)";
const WIDE = "(min-width: 1200px)";

type Found =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "no-ticket" }
  | { kind: "no-session" }
  /** The transcript is there; the live view was let go of. */
  | { kind: "cleared"; session: TicketSession }
  | { kind: "ready"; session: TicketSession; channel: { session: string; chat: string } };

export class IncTicketSession extends LitElement {
  static override properties = {
    ticketId: {},
    sessionId: {},
    found: { state: true },
    ticket: { state: true },
    employees: { state: true },
    phone: { state: true },
    wide: { state: true },
    ctx: { state: true },
    sheet: { state: true },
  };
  declare ticketId: string;
  declare sessionId: string;
  declare found: Found;
  declare ticket: TicketView | null;
  declare employees: Employee[];
  declare phone: boolean;
  declare wide: boolean;
  declare ctx: "open" | "closed" | null;
  declare sheet: boolean;

  private release: (() => void) | undefined;
  private queries: [MediaQueryList, () => void][] = [];
  private loadToken = 0;

  constructor() {
    super();
    this.ticketId = "";
    this.sessionId = "";
    this.found = { kind: "loading" };
    this.ticket = null;
    this.employees = [];
    this.phone = false;
    this.wide = false;
    this.ctx = null;
    this.sheet = false;
  }

  static override styles = [
    base,
    css`
      :host { display: block; height: 100%; min-height: 0; min-width: 0; }
      .screen { display: grid; grid-template-columns: minmax(0, 1fr); height: 100%; min-height: 0; min-width: 0; position: relative; box-sizing: border-box; }
      .screen.ctx.wide { grid-template-columns: minmax(0, 1fr) minmax(280px, 340px); gap: 16px; }
      .pane { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
      .ctx-pane { border-left: 1px solid var(--line); padding-left: 12px; }
      .none { margin: auto; max-width: 46ch; text-align: center; display: flex; flex-direction: column; gap: 10px; align-items: center; padding: 0 16px; }
      .none h2 { font-size: 22px; } .none p { margin: 0; color: var(--ink-2); line-height: 1.5; }
      .none a.btn { display: inline-flex; align-items: center; min-height: 44px; }
      .drawer { position: absolute; top: 0; bottom: 0; right: 0; width: min(360px, 92%); z-index: 15; background: var(--ground); border-left: 1px solid var(--line-strong);
        padding: 0 12px; box-shadow: -12px 0 32px rgba(0,0,0,0.16); display: flex; flex-direction: column; }
      .backdrop { position: fixed; inset: 0; z-index: 90; background: rgba(0,0,0,0.4); }
      .sheet { position: fixed; left: 0; right: 0; bottom: 0; z-index: 91; height: 72dvh; background: var(--ground); border-radius: 22px 22px 0 0; border: 1px solid var(--line-strong);
        padding: 8px 14px max(14px, env(safe-area-inset-bottom)); display: flex; flex-direction: column; box-shadow: 0 -12px 40px rgba(0,0,0,0.25); }
      .sheet .grab { align-self: center; width: 40px; height: 4px; border-radius: 2px; background: var(--line-strong); margin: 2px 0 6px; }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    this.release = useAhp();
    refresh.addEventListener("refresh", this.onRefresh);
    for (const q of [PHONE, WIDE]) {
      const mq = matchMedia(q);
      const fn = () => this.layout();
      mq.addEventListener?.("change", fn);
      this.queries.push([mq, fn]);
    }
    this.layout();
    try {
      const v = localStorage.getItem(CONTEXT_KEY);
      this.ctx = v === "open" || v === "closed" ? v : null;
    } catch {}
    void this.load();
  }

  override disconnectedCallback(): void {
    this.release?.();
    this.release = undefined;
    refresh.removeEventListener("refresh", this.onRefresh);
    for (const [mq, fn] of this.queries) mq.removeEventListener?.("change", fn);
    this.queries = [];
    document.removeEventListener("keydown", this.sheetKey, true);
    this.loadToken++;
    super.disconnectedCallback();
  }

  override willUpdate(changed: Map<string, unknown>): void {
    if ((changed.has("ticketId") || changed.has("sessionId")) && this.hasUpdated) {
      this.found = { kind: "loading" };
      this.ticket = null;
      this.sheet = false;
      void this.load();
    }
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("sheet")) {
      if (this.sheet) {
        document.addEventListener("keydown", this.sheetKey, true);
        const ctx = this.renderRoot.querySelector<HTMLElement>(".sheet inc-conv-context");
        void (ctx as (HTMLElement & { updateComplete?: Promise<unknown> }) | null)?.updateComplete?.then(() =>
          ctx?.shadowRoot?.querySelector<HTMLElement>(".x")?.focus(),
        );
      } else if (changed.get("sheet") === true) {
        document.removeEventListener("keydown", this.sheetKey, true);
        this.renderRoot
          .querySelector("inc-conv-thread")
          ?.shadowRoot?.querySelector<HTMLElement>(".tool-btn[aria-label='Context panel']")
          ?.focus();
      }
    }
  }

  private onRefresh = () => void this.load();

  private layout() {
    this.phone = matchMedia(PHONE).matches;
    this.wide = matchMedia(WIDE).matches;
  }

  private async load(): Promise<void> {
    const token = ++this.loadToken;
    const id = this.ticketId;
    const want = Number(this.sessionId);
    try {
      const [ticket, sessions, employees] = await Promise.all([
        api.ticket(id).then((r) => r.ticket),
        api.sessions(id),
        this.employees.length
          ? Promise.resolve(this.employees)
          : api.employees().catch(() => [] as Employee[]),
      ]);
      if (token !== this.loadToken) return;
      this.ticket = ticket;
      this.employees = Array.isArray(employees) ? employees : [];
      const session = (sessions ?? []).find((s) => s.id === want);
      this.found = !session
        ? { kind: "no-session" }
        : session.channel
          ? { kind: "ready", session, channel: session.channel }
          : { kind: "cleared", session };
    } catch (e) {
      if (token !== this.loadToken) return;
      // Whatever is on screen stays; only a first load that failed says so.
      if (this.found.kind === "loading") {
        this.found =
          e instanceof ApiError && e.status === 404
            ? { kind: "no-ticket" }
            : { kind: "error", message: e instanceof Error ? e.message : String(e) };
      }
    }
  }

  private toggleContext = () => {
    const open = this.ctxOpen();
    this.ctx = open ? "closed" : "open";
    try {
      if (!this.phone) localStorage.setItem(CONTEXT_KEY, this.ctx);
    } catch {}
    if (this.phone) this.sheet = !this.sheet;
  };

  private ctxOpen(): boolean {
    if (this.phone) return this.sheet;
    return this.ctx ? this.ctx === "open" : this.wide;
  }

  private sheetFocusables(): HTMLElement[] {
    const ctx = this.renderRoot.querySelector<HTMLElement>(".sheet inc-conv-context");
    return [
      ...(ctx?.shadowRoot?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]') ??
        []),
    ];
  }

  /** The open sheet is modal: Tab loops inside it and Escape closes it, from wherever focus is. */
  private sheetKey = (e: KeyboardEvent) => {
    if (!this.sheet) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.sheet = false;
      return;
    }
    if (e.key !== "Tab") return;
    const items = this.sheetFocusables();
    if (!items.length) {
      e.preventDefault();
      return;
    }
    let active: Element | null = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    const at = active ? items.indexOf(active as HTMLElement) : -1;
    const to = at < 0 ? 0 : (at + (e.shiftKey ? -1 : 1) + items.length) % items.length;
    e.preventDefault();
    items[to]?.focus();
  };

  /** The session as the thread and the panel know a conversation: the same shape, with the ticket's words. */
  private asConversation(s: TicketSession, channel: { session: string; chat: string }): Conversation {
    const t = this.ticket;
    const title = `#${this.ticketId} ${t?.title ?? ""} · ${s.stage}`.trim();
    return {
      id: `ticket-${this.ticketId}-${s.id ?? ""}`,
      employeeId: s.employeeId,
      project: t?.project ?? null,
      branch: null,
      title,
      mode: null,
      engineId: s.engineId,
      createdAt: s.startedAt,
      archivedAt: null,
      ahpSession: channel.session,
      ahpChat: channel.chat,
      status: s.endedAt === null ? 8 : 1,
      needsYou: false,
      running: s.endedAt === null,
      modifiedAt: s.endedAt ?? s.startedAt,
    };
  }

  private notFound(title: string, text: string) {
    return html`<div class="none"><h2>${title}</h2><p>${text}</p>
      <a class="btn" href="#/ticket/${this.ticketId}">Back to ticket #${this.ticketId}</a></div>`;
  }

  override render() {
    const f = this.found;
    if (f.kind === "loading")
      return html`<div class="none" aria-busy="true"><p>Loading the session…</p></div>`;
    if (f.kind === "error")
      return html`<div class="none"><h2>Couldn't load the session</h2><p>${f.message}</p>
        <button class="btn ghost" type="button" @click=${() => void this.load()}>Try again</button></div>`;
    if (f.kind === "no-ticket")
      return this.notFound(
        "No such ticket",
        `Ticket #${this.ticketId} isn't there. It may have been removed.`,
      );
    if (f.kind === "no-session")
      return this.notFound(
        "No such session",
        `Ticket #${this.ticketId} has no session by that number. Its sessions are listed on the ticket.`,
      );
    if (f.kind === "cleared")
      return this.notFound(
        "The live view of this session is gone",
        `It was let go of to save space, a while after the session ended. The ticket page still has its transcript: ${f.session.stage}, ${f.session.items.length} step${f.session.items.length === 1 ? "" : "s"}.`,
      );
    const conv = this.asConversation(f.session, f.channel);
    const employee = this.employees.find((e) => e.id === f.session.employeeId);
    const watch = { ticket: this.ticketId, stage: f.session.stage, back: `#/ticket/${this.ticketId}` };
    const phone = this.phone;
    const open = this.ctxOpen();
    const inline = open && this.wide && !phone;
    const drawer = open && !this.wide && !phone;
    const modal = phone && this.sheet;
    const context = html`<inc-conv-context .conv=${conv} .watch=${watch} .employee=${employee} .closable=${!inline}
      @conv-toggle-context=${this.toggleContext}></inc-conv-context>`;
    return html`<div class="screen ${inline ? "ctx wide" : ""}">
      <section class="pane" ?inert=${modal} aria-label="Session">
        <inc-conv-thread .conv=${conv} .watch=${watch} .employee=${employee} .phone=${phone} .contextOpen=${open}
          @conv-toggle-context=${this.toggleContext}></inc-conv-thread>
      </section>
      ${inline ? html`<aside class="pane ctx-pane" aria-label="Context">${context}</aside>` : nothing}
      ${drawer ? html`<aside class="drawer" aria-label="Context">${context}</aside>` : nothing}
      ${
        phone && this.sheet
          ? html`<div class="backdrop" @click=${() => {
              this.sheet = false;
            }}></div>
            <div class="sheet" role="dialog" aria-modal="true" aria-label="Session context"><span class="grab" aria-hidden="true"></span>${context}</div>`
          : nothing
      }
    </div>`;
  }
}

customElements.define("inc-ticket-session", IncTicketSession);
