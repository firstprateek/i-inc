// The Conversations screen (T60): the list on the left, the thread in the middle and the context panel on
// the right, each scrolling on its own. On a phone it is one column: the list is its own screen, the thread
// has a back button, and the context panel is a bottom sheet. It holds the one AHP connection open while it
// is on screen (the lease is released when it leaves, so nothing is left running behind a closed view).
import type { Employee } from "@i-inc/core";
import { css, html, LitElement, nothing } from "lit";
import { ahp, useAhp } from "../ahp/hub.ts";
import { type AccountRateLimit, api, type Conversation, refresh } from "../api.ts";
import { cardStyles } from "../conversations/styles.ts";
import { notifyNeedsYou } from "../needs-you.ts";
import type { CreateDetail } from "./conv-list.ts";
import { base } from "./shared.ts";
import "./conv-context.ts";
import "./conv-list.ts";
import "./conv-thread.ts";

const CONTEXT_KEY = "i-inc-conv-context";
const PHONE = "(max-width: 767px)";
const WIDE = "(min-width: 1200px)";

export class IncConversations extends LitElement {
  static override properties = {
    selectedId: { type: String },
    list: { state: true },
    loading: { state: true },
    listError: { state: true },
    employees: { state: true },
    projects: { state: true },
    showArchived: { state: true },
    creating: { state: true },
    createError: { state: true },
    phone: { state: true },
    wide: { state: true },
    ctx: { state: true },
    now: { state: true },
    info: { state: true },
    limit: { state: true },
    accountName: { state: true },
    lost: { state: true },
    kb: { state: true },
    sheet: { state: true },
  };
  declare selectedId: string;
  declare list: Conversation[];
  declare loading: boolean;
  declare listError: string;
  declare employees: Employee[];
  declare projects: string[];
  declare showArchived: boolean;
  declare creating: boolean;
  declare createError: string;
  declare phone: boolean;
  declare wide: boolean;
  declare ctx: "open" | "closed" | null;
  declare now: number;
  declare lost: string;
  declare kb: number;
  declare sheet: boolean;
  declare limit: AccountRateLimit | undefined;
  declare accountName: string;
  declare info: ReturnType<typeof ahp>["info"];

  private release: (() => void) | undefined;
  private offs: (() => void)[] = [];
  private queries: [MediaQueryList, () => void][] = [];
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private clock: ReturnType<typeof setInterval> | undefined;
  private loadToken = 0;
  private fetched = new Set<string>();

  constructor() {
    super();
    this.selectedId = "";
    this.list = [];
    this.loading = true;
    this.listError = "";
    this.employees = [];
    this.projects = [];
    this.showArchived = false;
    this.creating = false;
    this.createError = "";
    this.phone = false;
    this.wide = false;
    this.ctx = null;
    this.now = Date.now();
    this.lost = "";
    this.kb = 0;
    this.sheet = false;
    this.accountName = "";
    this.info = ahp().info;
  }

  static override styles = [
    base,
    cardStyles,
    css`
      :host { display: block; height: 100%; min-height: 0; min-width: 0; }
      .screen { display: grid; grid-template-columns: minmax(260px, 300px) minmax(0, 1fr); gap: 16px; height: 100%; min-height: 0; min-width: 0; position: relative;
        padding-bottom: var(--kb, 0px); box-sizing: border-box; }
      .screen.ctx.wide { grid-template-columns: minmax(260px, 300px) minmax(0, 1fr) minmax(280px, 340px); }
      .pane { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
      .list-pane { border-right: 1px solid var(--line); padding-right: 12px; }
      .ctx-pane { border-left: 1px solid var(--line); padding-left: 12px; }
      .none { margin: auto; max-width: 44ch; text-align: center; display: flex; flex-direction: column; gap: 10px; align-items: center; padding: 0 16px; }
      .none h2 { font-size: 24px; } .none p { margin: 0; color: var(--ink-2); line-height: 1.5; }
      .drawer { position: absolute; top: 0; bottom: 0; right: 0; width: min(360px, 92%); z-index: 15; background: var(--ground); border-left: 1px solid var(--line-strong);
        padding: 0 12px; box-shadow: -12px 0 32px rgba(0,0,0,0.16); display: flex; flex-direction: column; }
      .backdrop { position: fixed; inset: 0; z-index: 90; background: rgba(0,0,0,0.4); }
      .sheet { position: fixed; left: 0; right: 0; bottom: 0; z-index: 91; height: 72dvh; background: var(--ground); border-radius: 22px 22px 0 0; border: 1px solid var(--line-strong);
        padding: 8px 14px max(14px, env(safe-area-inset-bottom)); display: flex; flex-direction: column; box-shadow: 0 -12px 40px rgba(0,0,0,0.25); }
      .sheet .grab { align-self: center; width: 40px; height: 4px; border-radius: 2px; background: var(--line-strong); margin: 2px 0 6px; }
      .lost { margin: 0 0 8px; padding: 8px 12px; border-radius: 12px; border: 1px solid var(--needs-edge); background: var(--banner-bg); color: var(--banner-fg); font-weight: 600; }
      /* A phone: one column. The list is a screen of its own, and so is the thread. */
      .screen.phone { display: block; }
      .screen.phone .list-pane { border: 0; padding: 0; height: 100%; }
      .screen.phone .thread-pane { height: 100%; }
      .screen.phone .list-pane[hidden], .screen.phone .thread-pane[hidden] { display: none; }
    `,
  ];

  // ───────────────────────────── lifecycle ─────────────────────────────

  override connectedCallback(): void {
    super.connectedCallback();
    this.release = useAhp();
    const c = ahp();
    this.info = c.info;
    this.offs = [
      c.onInfo((i) => {
        const was = this.info.status;
        this.info = i;
        // Root notifications are not replayed, so a reconnect re-lists.
        if (i.status === "open" && was !== "open") this.scheduleReload(0);
      }),
      c.onRoster(() => this.scheduleReload(500)),
    ];
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
    this.clock = setInterval(() => {
      this.now = Date.now();
    }, 30_000);
    window.visualViewport?.addEventListener("resize", this.onViewport);
    void this.loadList();
    void this.loadSide();
  }

  override disconnectedCallback(): void {
    this.release?.();
    this.release = undefined;
    for (const off of this.offs) off();
    this.offs = [];
    for (const [mq, fn] of this.queries) mq.removeEventListener?.("change", fn);
    this.queries = [];
    refresh.removeEventListener("refresh", this.onRefresh);
    window.visualViewport?.removeEventListener("resize", this.onViewport);
    document.removeEventListener("keydown", this.sheetKey, true);
    clearTimeout(this.reloadTimer);
    clearInterval(this.clock);
    super.disconnectedCallback();
  }

  private layout() {
    this.phone = matchMedia(PHONE).matches;
    this.wide = matchMedia(WIDE).matches;
  }

  /** On a phone whose keyboard covers the layout (iOS), lift the composer by the keyboard's height. */
  private onViewport = () => {
    const vv = window.visualViewport;
    if (!vv || !this.phone) {
      this.kb = 0;
      return;
    }
    const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    this.kb = inset > 80 ? inset : 0;
  };

  private onRefresh = () => this.scheduleReload(0);

  private scheduleReload(ms: number) {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      void this.loadList();
      notifyNeedsYou();
    }, ms);
  }

  override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("selectedId") && this.selectedId) this.lost = "";
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("kb")) this.style.setProperty("--kb", `${this.kb}px`);
    if (changed.has("sheet")) {
      if (this.sheet) {
        document.addEventListener("keydown", this.sheetKey, true);
        // Into the sheet: the close button takes focus, and Escape closes it.
        const ctx = this.renderRoot.querySelector<HTMLElement>(".sheet inc-conv-context");
        void (ctx as (HTMLElement & { updateComplete?: Promise<unknown> }) | null)?.updateComplete?.then(() =>
          ctx?.shadowRoot?.querySelector<HTMLElement>(".x")?.focus(),
        );
      } else if (changed.get("sheet") === true) {
        document.removeEventListener("keydown", this.sheetKey, true);
        // Back to the button that opened it.
        this.renderRoot
          .querySelector("inc-conv-thread")
          ?.shadowRoot?.querySelector<HTMLElement>(".tool-btn")
          ?.focus();
      }
    }
    if (changed.has("selectedId") || changed.has("list")) void this.ensureSelected();
  }

  // ───────────────────────────── data ─────────────────────────────

  private async loadList(): Promise<void> {
    const token = ++this.loadToken;
    try {
      const rows = await api.conversations(this.showArchived ? "all" : undefined);
      if (token !== this.loadToken) return;
      this.list = rows;
      this.listError = "";
    } catch (e) {
      if (token !== this.loadToken) return;
      this.listError = e instanceof Error ? e.message : String(e);
    } finally {
      if (token === this.loadToken) this.loading = false;
    }
  }

  private async loadSide(): Promise<void> {
    const [employees, projects, engines, office] = await Promise.all([
      api.employees().catch(() => [] as Employee[]),
      api.projects().catch(() => [] as { id: string }[]),
      api.engines().catch(() => []),
      api.office().catch(() => undefined),
    ]);
    this.employees = employees;
    this.projects = projects.map((p) => p.id);
    this.sideData = { engines, office };
    this.pickLimit();
  }

  private sideData:
    | {
        engines: { id: string; accountId: string }[];
        office: Awaited<ReturnType<typeof api.office>> | undefined;
      }
    | undefined;

  private pickLimit() {
    const conv = this.selected();
    const engine = this.sideData?.engines.find((e) => e.id === conv?.engineId);
    const account = this.sideData?.office?.accounts?.find((a) => a.id === engine?.accountId);
    this.limit = engine ? this.sideData?.office?.rateLimits?.[engine.accountId] : undefined;
    this.accountName = account?.name ?? "";
  }

  private selected(): Conversation | undefined {
    return this.list.find((c) => c.id === this.selectedId);
  }

  /** A link to a conversation the list does not hold (archived, or a stale link): fetch that one. */
  private async ensureSelected(): Promise<void> {
    const id = this.selectedId;
    if (!id || this.loading || this.selected() || this.fetched.has(id)) {
      if (id && this.selected()) this.pickLimit();
      return;
    }
    this.fetched.add(id);
    try {
      const c = await api.conversation(id);
      this.list = [c, ...this.list.filter((x) => x.id !== c.id)];
    } catch {
      this.lost = "That conversation wasn't found. It may have been removed.";
    }
  }

  // ───────────────────────────── actions ─────────────────────────────

  private async create(d: CreateDetail) {
    this.creating = true;
    this.createError = "";
    try {
      const c = await api.createConversation({
        employeeId: d.employeeId,
        ...(d.project ? { project: d.project } : {}),
      });
      this.list = [c, ...this.list.filter((x) => x.id !== c.id)];
      location.hash = `#/conversations/${c.id}`;
      const form = this.renderRoot.querySelector("inc-conv-list") as (HTMLElement & { form: boolean }) | null;
      if (form) form.form = false;
      void this.updateComplete.then(() => requestAnimationFrame(() => this.focusComposer()));
    } catch (e) {
      this.createError = e instanceof Error ? e.message : String(e);
    } finally {
      this.creating = false;
    }
  }

  private focusComposer() {
    const thread = this.renderRoot.querySelector("inc-conv-thread");
    (
      thread?.shadowRoot?.querySelector("inc-conv-composer") as (HTMLElement & { focusInput(): void }) | null
    )?.focusInput();
  }

  private async patch(id: string, body: { title?: string; archived?: boolean }) {
    try {
      const c = await api.patchConversation(id, body);
      this.list = this.list.map((x) => (x.id === id ? c : x));
      if (body.archived !== undefined) {
        if (body.archived && !this.showArchived) {
          this.list = this.list.filter((x) => x.id !== id);
          if (id === this.selectedId) location.hash = "#/conversations";
        }
        void this.loadList();
      }
    } catch (e) {
      this.listError = e instanceof Error ? e.message : String(e);
    }
  }

  private toggleContext = () => {
    const open = this.ctxOpen();
    this.ctx = open ? "closed" : "open";
    try {
      // Remembered for a laptop; on a phone the sheet is opened on demand and not remembered.
      if (!this.phone) localStorage.setItem(CONTEXT_KEY, this.ctx);
    } catch {}
    if (this.phone) this.sheet = !this.sheet;
  };

  private ctxOpen(): boolean {
    if (this.phone) return this.sheet;
    return this.ctx ? this.ctx === "open" : this.wide;
  }

  /** What a Tab can reach inside the open sheet. */
  private sheetFocusables(): HTMLElement[] {
    const ctx = this.renderRoot.querySelector<HTMLElement>(".sheet inc-conv-context");
    return [
      ...(ctx?.shadowRoot?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]') ??
        []),
    ];
  }

  /**
   * The open sheet is modal: Tab loops inside it, and Escape closes it from wherever focus is. This listens on
   * the document, in the capture phase, so it holds even if focus has strayed out of the sheet.
   */
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
    // Always steer focus ourselves: the browser's next stop could be behind the sheet.
    e.preventDefault();
    items[to]?.focus();
  };

  // ───────────────────────────── view ─────────────────────────────

  override render() {
    const conv = this.selected();
    const employee = conv ? this.employees.find((e) => e.id === conv.employeeId) : undefined;
    const phone = this.phone;
    const open = this.ctxOpen() && !!conv;
    const inline = open && this.wide && !phone;
    const drawer = open && !this.wide && !phone;
    // While the phone's sheet is open, everything behind it is out of reach (of Tab and of a screen reader).
    const modal = phone && this.sheet && !!conv;
    const list = html`<inc-conv-list class="pane list-pane" ?inert=${modal} ?hidden=${phone && !!this.selectedId} .items=${this.list} .employees=${this.employees}
      .projects=${this.projects} .selected=${this.selectedId} .now=${this.now} .loading=${this.loading} .error=${this.listError}
      .showArchived=${this.showArchived} .creating=${this.creating} .createError=${this.createError}
      @conv-create=${(e: CustomEvent<CreateDetail>) => void this.create(e.detail)}
      @conv-rename=${(e: CustomEvent<{ id: string; title: string }>) => void this.patch(e.detail.id, { title: e.detail.title })}
      @conv-archive=${(e: CustomEvent<{ id: string; archived: boolean }>) => void this.patch(e.detail.id, { archived: e.detail.archived })}
      @conv-toggle-archived=${() => {
        this.showArchived = !this.showArchived;
        void this.loadList();
      }}
      @conv-reload=${() => {
        this.loading = true;
        void this.loadList();
      }}></inc-conv-list>`;
    const thread = html`<section class="pane thread-pane" ?inert=${modal} ?hidden=${phone && !this.selectedId} aria-label="Conversation">
      ${this.lost ? html`<p class="lost" role="alert">${this.lost}</p>` : nothing}
      ${
        conv
          ? html`<inc-conv-thread .conv=${conv} .employee=${employee} .phone=${phone} .contextOpen=${open}
              @conv-toggle-context=${this.toggleContext}></inc-conv-thread>`
          : this.selectedId && this.loading
            ? html`<div class="none" aria-busy="true"><p>Loading…</p></div>`
            : html`<div class="none"><h2>${this.list.length ? "Pick a conversation" : "Start a conversation"}</h2>
                <p>${this.list.length ? "Choose one from the list, or start a new one." : "Start a conversation with an employee about a project. Ask a question, or tell them what to change, and watch them work."}</p></div>`
      }
    </section>`;
    const context = conv
      ? html`<inc-conv-context .conv=${conv} .employee=${employee} .limit=${this.limit} .accountName=${this.accountName} .closable=${!inline}
          @conv-toggle-context=${this.toggleContext}></inc-conv-context>`
      : nothing;
    return html`<div class="screen ${phone ? "phone" : ""} ${inline ? "ctx wide" : ""}">
      ${list}${thread}
      ${inline ? html`<aside class="pane ctx-pane" aria-label="Context">${context}</aside>` : nothing}
      ${drawer ? html`<aside class="drawer" aria-label="Context">${context}</aside>` : nothing}
      ${
        phone && this.sheet && conv
          ? html`<div class="backdrop" @click=${() => {
              this.sheet = false;
            }}></div>
            <div class="sheet" role="dialog" aria-modal="true" aria-label="Conversation context" ><span class="grab" aria-hidden="true"></span>${context}</div>`
          : nothing
      }
    </div>`;
  }
}

customElements.define("inc-conversations", IncConversations);
