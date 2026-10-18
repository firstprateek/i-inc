// The board (spec §10): To do → In progress → Review → Done, across projects and Home.
import { css, html } from "lit";
import { api, refreshNow, type TicketEvent, type TicketView } from "../api.ts";
import { Loader } from "./loader.ts";
import "./new-ticket.ts";
import { LAYOUT_BREAKPOINTS, layoutStyles } from "./layout.ts";
import { protectedOk } from "./protected-card.ts";
import { avatar, base, projectBadge } from "./shared.ts";

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
  digest: DigestRow[];
}

const DIGEST_ROWS = 5;
const DIGEST_LOOKUPS = 8;

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

/** The last few finished tickets' reports, newest first. Looks at the most recent few only. */
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
  return rows
    .filter((r): r is DigestRow => r !== null)
    .sort((a, b) => b.at - a.at)
    .slice(0, DIGEST_ROWS);
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

export class IncBoard extends Loader<BoardData> {
  protected fetch = async () => {
    const tickets: BoardTicket[] = await api.board();
    return { tickets, digest: await loadDigest(tickets) };
  };

  static override properties = { ...Loader.properties, actionError: { state: true } };
  declare actionError: string | null;

  constructor() {
    super();
    this.actionError = null;
  }

  private async act(fn: () => Promise<unknown>) {
    try {
      await fn();
      this.actionError = null;
      refreshNow();
    } catch (e) {
      this.actionError = e instanceof Error ? e.message : String(e);
    }
  }

  static override styles = [
    base,
    layoutStyles,
    css`
      .top { display: flex; flex-direction: column; gap: var(--layout-section-gap, 20px); margin-bottom: var(--layout-section-gap, 20px); }
      .top h2 { font-size: 18px; }
      .ok-card { padding: 13px 15px; display: flex; flex-direction: column; gap: 10px; background: var(--needs-surface); border: 2px solid var(--needs-edge); }
      .ok-card .q { font-size: 16px; font-weight: 700; line-height: 1.3; overflow-wrap: anywhere; }
      .ok-card .head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 13px; color: var(--ink-2); }
      .ok-card .actions { display: flex; gap: 8px; }
      .ok-card .actions .btn:first-child { flex-grow: 1; }
      .digest { padding: 12px 14px; display: flex; flex-direction: column; gap: 4px; }
      .digest ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
      .digest a { display: flex; gap: 8px; align-items: center; min-height: 44px; text-decoration: none; padding: 4px 0; border-top: 1px solid var(--line); font-size: 14px; }
      .digest li:first-child a { border-top: 0; }
      .digest .title { flex: 1 1 0; min-width: 0; font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .digest .meta { color: var(--ink-2); font-size: 13px; white-space: nowrap; }
      .digest .chip { min-width: 62px; justify-content: center; }
      .err { background: var(--needs-bg); color: var(--needs-fg); border: 1px solid var(--alarm); border-radius: 10px; padding: 10px 12px; font-size: 14px; overflow-wrap: anywhere; }
      .by { font-size: 12px; font-weight: 700; display: inline-flex; align-items: center; gap: 4px; color: var(--reviewing-fg); background: var(--reviewing-bg); border-radius: 999px; padding: 2px 9px; }
      @media (max-width: 520px) {
        .digest a { display: grid; grid-template-columns: auto 1fr; column-gap: 10px; row-gap: 0; align-items: center; padding: 6px 0; }
        .digest .chip { grid-row: span 2; align-self: center; }
        .digest .title { white-space: normal; overflow: visible; }
        .digest .meta { grid-column: 2; }
      }
      .cols { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 18px; align-items: start; min-width: 0; }
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
      .live, .who { font-size: 13px; color: var(--ink-2); min-width: 0; }
      .who { display: flex; align-items: center; gap: 8px; }
      .empty { display: flex; align-items: center; justify-content: center; min-height: 64px; box-sizing: border-box; padding: 14px;
        border: 2px dashed var(--line-strong); border-radius: 14px; font-size: 14px; color: var(--ink-2); }
      @media (max-width: ${LAYOUT_BREAKPOINTS.phone}px) { .cols { grid-template-columns: minmax(0, 1fr); } }
    `,
  ];

  override render() {
    if (this.error) return html`<p role="alert">The daemon isn't answering: ${this.error}</p>`;
    if (!this.data) return html`<p class="muted">Loading the board…</p>`;
    const { tickets, digest } = this.data;
    const oks = tickets.filter((t) => t.needsYou?.kind === "protected-paths");
    return html`<div class="top layout-page-band">
      ${this.actionError ? html`<div class="err" role="alert">${this.actionError}</div>` : ""}
      ${oks.map((t) => this.okCard(t))}
      <inc-new-ticket></inc-new-ticket>
      ${digest.length ? this.digestList(digest) : ""}
    </div>
    <div class="cols">
      ${columns.map(([id, name, dotCls]) => {
        const list = tickets.filter((t) => t.column === id);
        return html`<section aria-label=${name}>
          <h2><span class="col-dot ${dotCls}" aria-hidden="true"></span>${name}<span>${list.length}</span></h2>
          ${list.length ? list.map((t) => this.card(t)) : html`<div class="empty">Nothing here</div>`}
        </section>`;
      })}
    </div>`;
  }

  private okCard(t: BoardTicket) {
    const a = t.needsYou;
    if (a?.kind !== "protected-paths") return "";
    return html`<div class="card ok-card" aria-label="Waiting for your OK">
      <div class="head"><span class="chip needs">Needs your OK</span>${projectBadge(t.project)}<span>#${t.id}</span>
        <a href="#/ticket/${t.id}" style="margin-left:auto;padding:12px 0">Open</a></div>
      ${protectedOk(t, a.paths, (fn) => void this.act(fn))}
    </div>`;
  }

  private digestList(rows: DigestRow[]) {
    return html`<div class="card digest"><h2>Recent reports</h2>
      <ul>${rows.map(
        (r) => html`<li><a href="#/ticket/${r.id}">
          <span class="chip ${r.outcome === "Failed" ? "alarm" : r.outcome === "Ready" ? "needs" : r.outcome === "Merged" || r.outcome === "Done" ? "done" : ""}">${r.outcome}</span>
          <span class="title">${r.title}</span>
          <span class="meta"><span class="note">${r.note}</span> · ${ago(r.at)}</span></a></li>`,
      )}</ul></div>`;
  }

  private card(t: BoardTicket) {
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
    return html`<a class="card t ${statusCls}" href="#/ticket/${t.id}">
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
      <div class="live">${t.waiting ? capital(t.waiting) : t.status === "queued" ? "Queued" : t.live}</div>
      ${t.assignee ? html`<div class="who">${avatar(t.assignee, 24)} ${t.assignee.name}</div>` : ""}
    </a>`;
  }
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

customElements.define("inc-board", IncBoard);
