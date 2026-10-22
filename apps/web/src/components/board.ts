// The board (spec §10): To do → In progress → Review → Done, across projects and Home.
import { css, html } from "lit";
import { api, type TicketEvent, type TicketView } from "../api.ts";
import { liveText, waitingLine, waitsForAssignee } from "../assign.ts";
import { LAYOUT_BREAKPOINTS, layoutStyles } from "./layout.ts";
import { Loader } from "./loader.ts";
import { NEW_TICKET_EVENT } from "./new-ticket.ts";
import { avatar, base, projectBadge } from "./shared.ts";
import "./new-ticket.ts";

/** A board ticket. `createdBy` is the agent that filed it, when the daemon says so (owner tickets have none). */
export type BoardTicket = TicketView & { createdBy?: NonNullable<TicketView["assignee"]> | null };

/** One line of the digest: a finished ticket and how it ended. */
export interface DigestRow {
  id: string;
  title: string;
  outcome: "Merged" | "Done" | "Rejected" | "Failed" | "Ready";
  /** "pushed" when the work reached main, "failed" when it didn't, else where it stands. */
  note: string;
  at: number;
}

interface BoardData {
  tickets: BoardTicket[];
  /** The last report of each recently finished ticket, by ticket id; the card in the Done column shows it. */
  digest: DigestRow[];
}

const DIGEST_LOOKUPS = 12;

/** The ticket's last report, from its event log. Null while it has none. */
export function digestRow(t: TicketView, events: TicketEvent[]): DigestRow | null {
  const failed = t.status === "failed";
  const finished = events.filter(
    (e) => e.type === "closed" || e.type === "failed" || e.type === "report-ready",
  );
  const last = finished.at(-1);
  if (!last) return null;
  const pushed = events.some((e) => e.type === "pushed");
  const opened = events.some((e) => e.type === "pr-opened");
  const closed = events.findLast((e) => e.type === "closed");
  const outcome: DigestRow["outcome"] = failed
    ? "Failed"
    : closed?.type === "closed"
      ? closed.outcome === "merged"
        ? "Merged"
        : closed.outcome === "rejected"
          ? "Rejected"
          : "Done"
      : "Ready";
  return {
    id: t.id,
    title: t.title,
    outcome,
    note: failed
      ? "failed"
      : pushed
        ? "pushed"
        : outcome === "Ready"
          ? "awaits you"
          : opened
            ? "PR opened"
            : "not pushed",
    at: last.at,
  };
}

/** The reports of the most recently finished tickets, newest first. Looks at the most recent few only. */
export async function loadDigest(tickets: TicketView[]): Promise<DigestRow[]> {
  const finished = tickets
    .filter((t) => t.column === "done" || t.status === "failed" || t.status === "ready")
    .sort((a, b) => Number(b.id) - Number(a.id))
    .slice(0, DIGEST_LOOKUPS);
  const rows = await Promise.all(
    finished.map((t) =>
      api
        .ticket(t.id)
        .then((r) => digestRow(r.ticket, r.events))
        .catch(() => null),
    ),
  );
  return rows.filter((r): r is DigestRow => r !== null).sort((a, b) => b.at - a.at);
}

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
    /** The ticket just filed from the dialog, until it is dismissed. */
    filed: { state: true },
  };
  declare creating: boolean;
  declare filed: { id: string; title: string } | null;

  constructor() {
    super();
    this.creating = false;
    this.filed = null;
  }

  protected fetch = async () => {
    const tickets: BoardTicket[] = await api.board();
    return { tickets, digest: await loadDigest(tickets) };
  };

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

  override render() {
    if (this.error) return this.failure("the board");
    if (!this.data) return html`<p class="muted">Loading the board…</p>`;
    const { tickets, digest } = this.data;
    const reports = new Map(digest.map((r) => [r.id, r]));
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
        const list = tickets.filter((t) => t.column === id);
        return html`<section aria-label=${name}>
          <h2><span class="col-dot ${dotCls}" aria-hidden="true"></span>${name}<span>${list.length}</span></h2>
          ${list.length ? list.map((t) => this.card(t, id === "done" ? reports.get(t.id) : undefined)) : html`<div class="empty">${emptyColumn[id]}</div>`}
        </section>`;
      })}
    </div>
    <dialog class="new-ticket" aria-label="New ticket" @cancel=${() => {
      this.creating = false;
    }} @close=${() => {
      this.creating = false;
    }} @ticket-filed=${this.onFiled} @ticket-form-close=${this.closeForm}>
      <inc-new-ticket modal></inc-new-ticket>
    </dialog>`;
  }

  /** How a finished ticket ended: "Merged · pushed · 2 h ago". */
  private reportLine(r: DigestRow) {
    return html`<div class="report"><span class="chip ${r.outcome === "Failed" ? "alarm" : r.outcome === "Ready" ? "needs" : r.outcome === "Merged" || r.outcome === "Done" ? "done" : ""}">${r.outcome}</span>
      <span><span class="note">${r.note}</span> · ${ago(r.at)}</span></div>`;
  }

  private card(t: BoardTicket, report?: DigestRow) {
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
    const card = html`<a class="card t ${statusCls} ${assign ? "has-assign" : ""}" href="#/ticket/${t.id}">
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
                    title=${s.id}></i>`,
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
