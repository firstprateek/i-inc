// The board (spec §10): To do → In progress → Review → Done, across projects and Home.

import { type DigestRow, stageLabel } from "@i-inc/core";
import { css, html } from "lit";
import { api, type RefreshScope, type TicketView } from "../api.ts";
import { liveText, waitingLine, waitsForAssignee } from "../assign.ts";
import {
  appendPage,
  applyCards,
  type BoardData,
  type BoardTicket,
  type Column,
  fromSummary,
  loadedLimits,
  PAGE,
} from "./board-model.ts";
import { LAYOUT_BREAKPOINTS, layoutStyles } from "./layout.ts";
import { Loader } from "./loader.ts";
import { NEW_TICKET_EVENT } from "./new-ticket.ts";
import { avatar, base, projectBadge } from "./shared.ts";
import "./new-ticket.ts";

export type { DigestRow } from "@i-inc/core";
export { digestRow } from "@i-inc/core";
export type { BoardTicket } from "./board-model.ts";

/** "5 min ago", "3 h ago", "2 d ago". */
export function ago(at: number, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - at) / 60000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 60 * 48) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} d ago`;
}

const columns: [TicketView["column"], string, string][] = [
  ["todo", "To do", "col-dot-todo"],
  ["in-progress", "In progress", "col-dot-progress"],
  ["review", "Review", "col-dot-review"],
  ["done", "Done", "col-dot-done"],
];

/** An empty column says what to do next, in one sentence. */
const emptyColumn: Record<string, string> = {
  todo: "No tickets waiting. Add one with New ticket.",
  "in-progress": "Nothing running. Tickets land here once an employee starts.",
  review: "Nothing to review. Finished work waits here for your OK.",
  done: "Nothing shipped yet. Approved tickets land here.",
};

export class IncBoard extends Loader<BoardData> {
  static override properties = {
    ...Loader.properties,
    /** The new-ticket dialog is open. */
    creating: { state: true },
    /** The form was opened before the board loaded: it is mounted from then on (it is mounted when the board has data anyway). */
    formMounted: { state: true },
    /** The ticket just filed from the dialog, until it is dismissed. */
    filed: { state: true },
  };
  declare creating: boolean;
  declare formMounted: boolean;
  declare filed: { id: string; title: string } | null;

  constructor() {
    super();
    this.creating = false;
    this.formMounted = false;
    this.filed = null;
  }

  /** One request: each column's first cards and total, with the reports of the Done cards (no request per card). */
  protected fetch = async (): Promise<BoardData> =>
    fromSummary(await api.boardSummary(loadedLimits(this.data)));

  /**
   * A live event named some tickets: fetch just their cards and update those in place, instead of the whole
   * board. A board that can't place a card (one it never loaded that isn't new) reloads.
   */
  protected override async applyScope(scope: RefreshScope): Promise<boolean> {
    if (!this.data) return false;
    if (scope.tickets.size === 0) return true; // an employee event: nothing on the board changes
    if (scope.tickets.size > 20) return false;
    const cards = await api.boardCards([...scope.tickets]);
    // The board may have moved on (a reload, a Show more) while the cards were coming.
    const next = this.data && applyCards(this.data, cards as Parameters<typeof applyCards>[1]);
    if (!next) return false;
    this.data = next;
    return true;
  }

  /** "Show more": the next page of one column. */
  private async more(column: Column): Promise<void> {
    const data = this.data;
    if (!data) return;
    await this.press(async () => {
      const page = await api.boardColumn(column, data.columns[column].tickets.length, PAGE);
      if (this.data) this.data = appendPage(this.data, column, page as Parameters<typeof appendPage>[2]);
      return false; // no refetch: the page is what was asked for
    });
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // The header's New ticket button.
    window.addEventListener(NEW_TICKET_EVENT, this.openForm);
  }

  override disconnectedCallback(): void {
    window.removeEventListener(NEW_TICKET_EVENT, this.openForm);
    super.disconnectedCallback();
  }

  private dialog(): HTMLDialogElement | null {
    return this.renderRoot?.querySelector<HTMLDialogElement>("dialog.new-ticket") ?? null;
  }

  private openForm = () => {
    const d = this.dialog();
    if (!d || d.open) return;
    this.filed = null;
    this.creating = true;
    this.formMounted = true;
    if (typeof d.showModal === "function") d.showModal();
    else d.setAttribute("open", "");
    // The first field takes focus.
    void this.updateComplete.then(() => {
      const form = d.querySelector("inc-new-ticket") as
        | (HTMLElement & { updateComplete?: Promise<unknown> })
        | null;
      void form?.updateComplete?.then(() =>
        form.shadowRoot?.querySelector<HTMLInputElement>("input[name=title]")?.focus(),
      );
    });
  };

  private closeForm = () => {
    const d = this.dialog();
    if (d?.open) {
      if (typeof d.close === "function") d.close();
      else d.removeAttribute("open");
    }
    this.creating = false;
  };

  private onFiled = (e: Event) => {
    this.filed = (e as CustomEvent<{ id: string; title: string }>).detail;
    this.closeForm();
  };

  static override styles = [
    base,
    layoutStyles,
    css`
      .err { background: var(--needs-bg); color: var(--needs-fg); border: 1px solid var(--alarm); border-radius: 10px; padding: 10px 12px; font-size: 14px; overflow-wrap: anywhere; }
      .by { font-size: 12px; font-weight: 700; display: inline-flex; align-items: center; gap: 4px; color: var(--reviewing-fg); background: var(--reviewing-bg); border-radius: 999px; padding: 2px 9px; }
      .filed { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; padding: 8px 8px 8px 14px; border-radius: 12px;
        background: var(--working-bg); color: var(--working-fg); font-size: 14px; }
      .filed a { font-weight: 700; }
      .filed .btn { flex: none; min-width: 44px; }
      .more { width: 100%; min-height: 44px; justify-content: center; }
      .cols { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 18px; align-items: start; min-width: 0; }
      /* The report of a finished ticket, on its card in the Done column (and on any card that has one). */
      .report { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 13px; color: var(--ink-2); }
      /* The new-ticket form is a dialog: centred on a laptop, a sheet on a phone. */
      dialog.new-ticket { border: 1px solid var(--line-strong); border-radius: 22px; background: var(--ground); color: var(--ink); padding: 16px 18px 18px;
        width: min(560px, calc(100vw - 32px)); max-height: min(90dvh, 820px); overflow-y: auto; overscroll-behavior: contain; box-sizing: border-box;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3); }
      dialog.new-ticket::backdrop { background: rgba(0, 0, 0, 0.45); }
      @media (max-width: 600px) {
        dialog.new-ticket { width: 100%; max-width: 100%; margin: auto 0 0; border-radius: 22px 22px 0 0; max-height: 92dvh; padding-bottom: max(18px, env(safe-area-inset-bottom)); }
      }
      section { background: var(--sunken); border-radius: 22px; padding: 14px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
      h2 { font-size: 20px; padding: 2px 4px; display: flex; gap: 8px; align-items: center; min-width: 0; }
      h2 span { font-size: 14px; color: var(--ink-2); font-family: var(--body); font-weight: 600; }
      .col-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
      .col-dot-todo { background: var(--ink-2); }
      .col-dot-progress { background: var(--working-fg); }
      .col-dot-review { background: var(--reviewing-mark); }
      .col-dot-done { background: var(--ink); }
      .t { padding: 14px; display: flex; flex-direction: column; gap: 8px; text-decoration: none; min-width: 0; box-sizing: border-box; }
      .t.in-progress { border-left: 3px solid var(--working-fg); }
      .t.review { border-left: 3px solid var(--reviewing-mark); }
      .t.paused { border-left: 3px solid var(--bar-warn); }
      .t.waiting { background: var(--needs-surface); border: 2px solid var(--needs-edge); padding: 13px; }
      .row { display: flex; gap: 6px; align-items: center; min-width: 0; flex-wrap: wrap; }
      .grow { flex-grow: 1; }
      .title { font-size: 15px; font-weight: 700; line-height: 1.3; overflow-wrap: anywhere; min-width: 0; }
      .strip { display: flex; gap: 3px; min-width: 0; }
      .strip i { flex-grow: 1; height: 6px; border-radius: 3px; background: var(--line); }
      .strip i.done { background: var(--ink); }
      .strip i.cur { background: var(--working-fg); }
      .strip i.cur.needs-you { background: var(--needs-edge); }
      .strip i.cur.paused { background: var(--bar); }
      .strip i.cur.failed { background: var(--alarm); }
      .strip i.cur.review { background: var(--reviewing-mark); }
      .slot { position: relative; min-width: 0; }
      .t.has-assign { padding-bottom: 70px; }
      .assign { position: absolute; left: 14px; bottom: 14px; display: inline-flex; align-items: center; justify-content: center;
        min-width: 44px; box-sizing: border-box; text-decoration: none; }
      .waits { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; line-height: 1.4; color: var(--ink-2); min-width: 0; overflow-wrap: anywhere; }
      .waits i { width: 8px; height: 8px; border-radius: 50%; background: var(--needs-fg); flex-shrink: 0; margin-top: 5px; }
      .live, .who { font-size: 13px; color: var(--ink-2); min-width: 0; }
      .who { display: flex; align-items: center; gap: 8px; }
      .empty { display: flex; align-items: center; justify-content: center; text-align: center; min-height: 64px; box-sizing: border-box; padding: 14px;
        border: 2px dashed var(--line-strong); border-radius: 14px; font-size: 14px; color: var(--ink-2); }
      @media (max-width: ${LAYOUT_BREAKPOINTS.phone}px) { .cols { grid-template-columns: minmax(0, 1fr); } }
    `,
  ];

  /** The header's New ticket button works in every state: while the board loads, and after it failed to. */
  override render() {
    return html`${this.content()}<dialog class="new-ticket" aria-label="New ticket" @cancel=${() => {
      this.creating = false;
    }} @close=${() => {
      this.creating = false;
    }} @ticket-filed=${this.onFiled} @ticket-form-close=${this.closeForm}>
      ${this.formMounted || this.data ? html`<inc-new-ticket modal></inc-new-ticket>` : ""}
    </dialog>`;
  }

  private content() {
    if (this.error) return this.failure("the board");
    if (!this.data) return html`<p class="muted">Loading the board…</p>`;
    const { columns: cols, reports } = this.data;
    return html`
      ${this.actionError ? html`<div class="err" role="alert">${this.actionError}</div>` : ""}
      ${
        this.filed
          ? html`<div class="filed" role="status"><span>Filed <a href="#/ticket/${this.filed.id}">#${this.filed.id}</a>: ${this.filed.title}</span>
              <button type="button" class="btn ghost" @click=${() => {
                this.filed = null;
              }}>Dismiss</button></div>`
          : ""
      }
    <div class="cols">
      ${columns.map(([id, name, dotCls]) => {
        const list = cols[id].tickets;
        const hidden = cols[id].total - list.length;
        return html`<section aria-label=${name} @keydown=${this.onCardKey} @focusin=${(e: FocusEvent) => this.rove(id, e)}>
          <h2><span class="col-dot ${dotCls}" aria-hidden="true"></span>${name}<span>${cols[id].total}</span></h2>
          ${list.length ? list.map((t, i) => this.card(t, id === "done" ? reports[t.id] : undefined, this.stop(id, t, i))) : html`<div class="empty">${emptyColumn[id]}</div>`}
          ${
            hidden > 0
              ? html`<button type="button" class="btn ghost more" ?disabled=${this.pressing}
                  aria-label="Show ${Math.min(PAGE, hidden)} more in ${name}, ${hidden} not shown"
                  @click=${() => void this.more(id)}>Show ${Math.min(PAGE, hidden)} more <span class="muted">(${hidden} not shown)</span></button>`
              : ""
          }
        </section>`;
      })}
    </div>`;
  }

  /** How a finished ticket ended: "Merged · pushed · 2 h ago". */
  private reportLine(r: DigestRow) {
    return html`<div class="report"><span class="chip ${r.outcome === "Failed" ? "alarm" : r.outcome === "Ready" ? "needs" : r.outcome === "Merged" || r.outcome === "Done" ? "done" : ""}">${r.outcome}</span>
      <span><span class="note">${r.note}</span> · ${ago(r.at)}</span></div>`;
  }

  /** The card each column keeps as its one tab stop (the one last focused, else the first). */
  private roving: Partial<Record<TicketView["column"], string>> = {};

  private stop(column: TicketView["column"], t: BoardTicket, index: number): 0 | -1 {
    const list = this.data?.columns[column].tickets ?? [];
    const keep = this.roving[column];
    const at = keep && list.some((x) => x.id === keep) ? keep : list[0]?.id;
    return (keep ? t.id === at : index === 0) ? 0 : -1;
  }

  /** Remembers which card of a column has the focus, so Tab returns to it. */
  private rove(column: TicketView["column"], e: FocusEvent): void {
    const card = e
      .composedPath()
      .find((n): n is HTMLAnchorElement => n instanceof HTMLAnchorElement && n.classList.contains("t"));
    const id = card?.getAttribute("href")?.replace("#/ticket/", "");
    if (!id || this.roving[column] === id) return;
    this.roving[column] = id;
    this.requestUpdate();
  }

  /** Up and Down, Home and End move between a column's cards; Tab leaves the column (a board is not 1,000 tab stops). */
  private onCardKey = (e: KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const section = e.currentTarget as HTMLElement;
    const cards = [...section.querySelectorAll<HTMLAnchorElement>("a.card.t")];
    const at = cards.findIndex((c) => c === e.composedPath()[0] || c.contains(e.composedPath()[0] as Node));
    if (at < 0) return;
    e.preventDefault();
    const to =
      e.key === "Home" ? 0 : e.key === "End" ? cards.length - 1 : at + (e.key === "ArrowDown" ? 1 : -1);
    cards[Math.max(0, Math.min(cards.length - 1, to))]?.focus();
  };

  private card(t: BoardTicket, report?: DigestRow, tab: 0 | -1 = 0) {
    const needs = t.status === "needs-you";
    const statusCls = needs
      ? "waiting"
      : t.status === "paused" || t.waiting
        ? "paused"
        : t.column === "in-progress"
          ? "in-progress"
          : t.column === "review"
            ? "review"
            : "";
    const assign = waitsForAssignee(t);
    const card = html`<a class="card t ${statusCls} ${assign ? "has-assign" : ""}" href="#/ticket/${t.id}" tabindex=${tab}>
      <div class="row">
        <span class="tag">${t.type}</span>${projectBadge(t.project)}<span class="grow"></span>
        ${needs ? html`<span class="chip needs">Needs you</span>` : ""}${t.held ? html`<span class="chip">On hold</span>` : ""}<span class="muted" style="font-size:12px;font-weight:700">#${t.id}</span>
      </div>
      <div class="title">${t.title}</div>
      ${t.createdBy ? html`<div class="row"><span class="by" title="An agent filed this follow-up">Filed by ${t.createdBy.name}</span></div>` : ""}
      ${
        t.status === "queued"
          ? ""
          : html`<div class="strip" aria-label="Stages">
              ${t.stages.map(
                (s) =>
                  html`<i class="${s.state === "done" ? "done" : s.state === "current" ? `cur ${t.status} ${s.id}` : ""}"
                    title=${stageLabel(s.id)}></i>`,
              )}
            </div>`
      }
      ${
        t.waiting
          ? html`<div class="waits"><i aria-hidden="true"></i><span>${waitingLine(t.waiting, t.waitingUntil)}</span></div>`
          : report
            ? "" // the report line below says how it ended
            : html`<div class="live">${liveText(t)}</div>`
      }
      ${t.assignee ? html`<div class="who">${avatar(t.assignee, 24)} ${t.assignee.name}</div>` : ""}
      ${report ? this.reportLine(report) : ""}
    </a>`;
    // The Assign… link sits beside the card link (a link can't hold another): it opens the ticket's
    // "Who should do this?" card.
    return assign
      ? html`<div class="slot">${card}<a class="btn assign" href="#/ticket/${t.id}/assign" aria-label="Assign ticket #${t.id}: ${t.title}">Assign…</a></div>`
      : card;
  }
}

customElements.define("inc-board", IncBoard);
