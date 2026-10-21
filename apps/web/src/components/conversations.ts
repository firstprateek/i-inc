// The Conversations screen (T60): the list on the left, the thread in the middle and the context panel on
// the right, each scrolling on its own. On a phone it is one column: the list is its own screen, the thread
// has a back button, and the context panel is a bottom sheet. It holds the one AHP connection open while it
// is on screen (the lease is released when it leaves, so nothing is left running behind a closed view).
import type { Employee } from "@i-inc/core";
import { css, html, LitElement, nothing } from "lit";
import { ahp, useAhp } from "../ahp/hub.ts";
import { type AccountRateLimit, api, type Conversation, refresh, type ShipView } from "../api.ts";
import { friendlyError } from "../conversations/actions.ts";
import { cardStyles } from "../conversations/styles.ts";
import { live } from "../live.ts";
import { notifyNeedsYou } from "../needs-you.ts";
import { draftHash } from "../routes.ts";
import type { SendDetail } from "./conv-composer.ts";
import type { CreateDetail } from "./conv-list.ts";
import type { ShipDone, ShipKind } from "./conv-ship.ts";
import { base } from "./shared.ts";
import "./conv-context.ts";
import "./conv-list.ts";
import "./conv-ship.ts";
import "./conv-thread.ts";

const CONTEXT_KEY = "i-inc-conv-context";
const PHONE = "(max-width: 767px)";
const WIDE = "(min-width: 1200px)";

export class IncConversations extends LitElement {
  static override properties = {
    selectedId: { type: String },
    card: { type: String },
    draft: { attribute: false },
    form: { attribute: false },
    first: { state: true },
    list: { state: true },
    loading: { state: true },
    listError: { state: true },
    employees: { state: true },
    projects: { state: true },
    showArchived: { state: true },
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
    ready: { state: true },
    ship: { state: true },
    dialog: { state: true },
  };
  declare selectedId: string;
  /** `?card=<id>`: the card a notification opened; the thread brings it into view. */
  declare card: string;
  /** `#/conversations/new/<employee>[/<project>]`: a conversation the first message will create. */
  declare draft: { employee: string; project: string } | undefined;
  /** `#/conversations?new=1&...`: the New conversation form, open and preset. */
  declare form: { employee: string; project: string } | undefined;
  /** The first message of a conversation just created, until its thread has sent it. */
  declare first: { id: string; text: string; files: File[]; intent: "turn" } | undefined;
  declare list: Conversation[];
  declare loading: boolean;
  declare listError: string;
  declare employees: Employee[];
  declare projects: string[];
  declare showArchived: boolean;
  declare phone: boolean;
  declare wide: boolean;
  declare ctx: "open" | "closed" | null;
  declare now: number;
  declare lost: string;
  declare kb: number;
  declare sheet: boolean;
  declare ready: boolean;
  /** Shipping (C22b) for the selected conversation: its ticket and PR, and what can be pressed. */
  declare ship: ShipView | undefined;
  /** The ship dialog, while it is open. */
  declare dialog: { kind: ShipKind } | null;
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
  private shipToken = 0;
  private shipFor = "";
  private shipTimer: ReturnType<typeof setTimeout> | undefined;
  private shipPoll: ReturnType<typeof setInterval> | undefined;
  private opener: HTMLElement | null = null;

  constructor() {
    super();
    this.selectedId = "";
    this.card = "";
    this.list = [];
    this.loading = true;
    this.listError = "";
    this.employees = [];
    this.projects = [];
    this.showArchived = false;
    this.phone = false;
    this.wide = false;
    this.ctx = null;
    this.now = Date.now();
    this.lost = "";
    this.kb = 0;
    this.sheet = false;
    this.ready = false;
    this.ship = undefined;
    this.dialog = null;
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
    // A ticket changed: if it is this conversation's, its stage and status are news.
    this.offs.push(
      live.subscribe("ticket", () => {
        clearTimeout(this.shipTimer);
        this.shipTimer = setTimeout(() => {
          if (this.ship?.ticket || this.ship?.pr || this.selected()?.ship) {
            void this.loadShip();
            void this.loadList();
          }
        }, 400);
      }),
    );
    this.shipPoll = setInterval(() => {
      const s = this.ship;
      if (s?.ticket?.held || s?.pr?.checks?.state === "pending" || s?.pr?.checks?.state === "none")
        void this.loadShip();
    }, 30_000);
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
    clearTimeout(this.shipTimer);
    clearInterval(this.shipPoll);
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
    if (changed.has("selectedId") || changed.has("list")) this.syncShip();
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
    this.ready = true;
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

  /** The selected conversation changed: look at what shipping says about it (a project's only). */
  private syncShip() {
    const conv = this.selected();
    const id = conv?.project ? conv.id : "";
    if (id === this.shipFor) return;
    this.shipFor = id;
    this.ship = undefined;
    if (id) void this.loadShip();
  }

  private async loadShip(): Promise<void> {
    const id = this.shipFor;
    if (!id) return;
    const token = ++this.shipToken;
    try {
      const ship = await api.ship(id);
      if (token === this.shipToken && id === this.shipFor) this.ship = ship;
    } catch {
      // The panel works without it: the buttons ask again when pressed, and the dialog says what is wrong.
    }
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

  /** The draft's first message: it makes the conversation, then the new thread sends the message. */
  private createFromDraft = async (d: SendDetail): Promise<string | null> => {
    const draft = this.draftView()?.draft;
    if (!draft) return "There is no conversation to start.";
    try {
      const c = await api.createConversation({
        employeeId: draft.employee,
        ...(draft.project ? { project: draft.project } : {}),
      });
      this.first = { id: c.id, text: d.text, files: d.files, intent: "turn" };
      this.list = [c, ...this.list.filter((x) => x.id !== c.id)];
      location.hash = `#/conversations/${c.id}`;
      return null;
    } catch (e) {
      return friendlyError(e instanceof Error ? e.message : String(e));
    }
  };

  /** The projects the draft's employee works on (all of them when the employee has no list). */
  private draftProjectChoices(): string[] {
    const e = this.employees.find((x) => x.id === this.draft?.employee);
    return e?.projects?.length ? e.projects : this.projects;
  }

  /** The draft as the screen can honour it: an unknown project becomes "no project", and the owner is told. */
  private draftView(): { draft: { employee: string; project: string }; note: string } | undefined {
    const d = this.draft;
    if (!d) return undefined;
    if (!this.ready) return { draft: d, note: "" };
    const employee = this.employees.find((e) => e.id === d.employee);
    const knownProject = !d.project || this.projects.includes(d.project);
    const note = [
      employee ? "" : "That employee isn't available.",
      knownProject
        ? ""
        : "That project isn't available — starting without a project. Pick one below if you want one.",
    ]
      .filter(Boolean)
      .join(" ");
    return { draft: { employee: d.employee, project: knownProject ? d.project : "" }, note };
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

  private openShip = (e: CustomEvent<{ kind: ShipKind }>) => {
    const from = (e.composedPath()[0] ?? null) as HTMLElement | null;
    this.opener = from;
    this.dialog = { kind: e.detail.kind };
  };

  private closeShip = () => {
    this.dialog = null;
    const opener = this.opener;
    this.opener = null;
    void this.updateComplete.then(() => {
      // Back to the button that opened it: the header's, or the one in the panel.
      if (opener?.isConnected) opener.focus();
      else
        this.renderRoot
          .querySelector("inc-conv-thread")
          ?.shadowRoot?.querySelector<HTMLElement>(".ship-btn")
          ?.focus();
    });
  };

  private shipped = (_e: CustomEvent<ShipDone>) => {
    void this.loadShip();
    void this.loadList();
  };

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
    if (!this.sheet || this.dialog) return;
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
    const modal = (phone && this.sheet && !!conv) || !!this.dialog;
    const list = html`<inc-conv-list class="pane list-pane" ?inert=${modal} ?hidden=${phone && (!!this.selectedId || !!this.draft)} .items=${this.list} .employees=${this.employees}
      .projects=${this.projects} .selected=${this.selectedId} .now=${this.now} .loading=${this.loading} .error=${this.listError}
      .showArchived=${this.showArchived} .preset=${this.form} .ready=${this.ready}
      @conv-create=${(e: CustomEvent<CreateDetail>) => {
        location.hash = draftHash(e.detail.employeeId, e.detail.project);
      }}
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
    const thread = html`<section class="pane thread-pane" ?inert=${modal} ?hidden=${phone && !this.selectedId && !this.draft} aria-label="Conversation">
      ${this.lost ? html`<p class="lost" role="alert">${this.lost}</p>` : nothing}
      ${
        conv
          ? html`<inc-conv-thread .conv=${conv} .employee=${employee} .phone=${phone} .contextOpen=${open} .card=${this.card} .ship=${this.ship}
              .first=${this.first?.id === conv.id ? this.first : undefined}
              @conv-first-sent=${() => {
                this.first = undefined;
                void this.updateComplete.then(() => requestAnimationFrame(() => this.focusComposer()));
              }}
              @conv-toggle-context=${this.toggleContext}></inc-conv-thread>`
          : this.draft
            ? html`<inc-conv-thread .draft=${this.draftView()?.draft} .draftNote=${this.draftView()?.note ?? ""} .draftProjects=${this.draftProjectChoices()}
                .employee=${this.employees.find((e) => e.id === this.draft?.employee)}
                .phone=${phone} .onCreate=${this.createFromDraft}></inc-conv-thread>`
            : this.selectedId && this.loading
              ? html`<div class="none" aria-busy="true"><p>Loading…</p></div>`
              : html`<div class="none"><h2>${this.list.length ? "Pick a conversation" : "Start a conversation"}</h2>
                <p>${this.list.length ? "Choose one from the list, or start a new one." : "Start a conversation with an employee about a project. Ask a question, or tell them what to change, and watch them work."}</p></div>`
      }
    </section>`;
    const context = conv
      ? html`<inc-conv-context .conv=${conv} .employee=${employee} .ship=${this.ship} .limit=${this.limit} .accountName=${this.accountName} .closable=${!inline}
          @conv-toggle-context=${this.toggleContext}></inc-conv-context>`
      : nothing;
    return html`<div class="screen ${phone ? "phone" : ""} ${inline ? "ctx wide" : ""}" @conv-ship=${this.openShip}>
      ${list}${thread}
      ${inline ? html`<aside class="pane ctx-pane" aria-label="Context">${context}</aside>` : nothing}
      ${drawer ? html`<aside class="drawer" aria-label="Context">${context}</aside>` : nothing}
      ${
        phone && this.sheet && conv
          ? html`<div class="backdrop" @click=${() => {
              this.sheet = false;
            }}></div>
            <div class="sheet" role="dialog" aria-modal="true" aria-label="Conversation context" ?inert=${!!this.dialog}><span class="grab" aria-hidden="true"></span>${context}</div>`
          : nothing
      }
      ${
        this.dialog && conv
          ? html`<inc-conv-ship .conv=${conv} .employee=${employee} .kind=${this.dialog.kind}
              @conv-ship-close=${this.closeShip} @conv-ship-done=${this.shipped}></inc-conv-ship>`
          : nothing
      }
    </div>`;
  }
}

customElements.define("inc-conversations", IncConversations);
