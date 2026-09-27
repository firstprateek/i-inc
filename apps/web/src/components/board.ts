// The board (spec §10): To do → In progress → Review → Done, across projects and Home.
import { css, html } from "lit";
import { api, type TicketView } from "../api.ts";
import { Loader } from "./loader.ts";
import { avatar, base } from "./shared.ts";

const columns: [TicketView["column"], string][] = [
  ["todo", "To do"],
  ["in-progress", "In progress"],
  ["review", "Review"],
  ["done", "Done"],
];

export class IncBoard extends Loader<TicketView[]> {
  protected fetch = () => api.board();

  static override styles = [
    base,
    css`
      .cols { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 18px; align-items: start; }
      section { background: var(--sunken); border-radius: 22px; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
      h2 { font-size: 20px; padding: 2px 4px; display: flex; gap: 8px; align-items: baseline; }
      h2 span { font-size: 14px; color: var(--ink-2); font-family: var(--body); }
      .t { padding: 14px; display: flex; flex-direction: column; gap: 8px; text-decoration: none; }
      .t.waiting { background: var(--needs-surface); border: 2px solid var(--needs-edge); padding: 13px; }
      .row { display: flex; gap: 6px; align-items: center; }
      .grow { flex-grow: 1; }
      .title { font-size: 15px; font-weight: 700; line-height: 1.3; }
      .strip { display: flex; gap: 3px; }
      .strip i { flex-grow: 1; height: 6px; border-radius: 3px; background: var(--line); }
      .strip i.done { background: var(--ink); }
      .strip i.cur { background: var(--working-fg); }
      .strip i.cur.needs-you { background: var(--needs-edge); }
      .strip i.cur.paused { background: var(--bar); }
      .strip i.cur.failed { background: var(--alarm); }
      .strip i.cur.review { background: var(--reviewing-mark); }
      .live, .who { font-size: 13px; color: var(--ink-2); }
      .who { display: flex; align-items: center; gap: 8px; }
      .empty { font-size: 14px; color: var(--ink-2); padding: 4px; }
      @media (max-width: 900px) { .cols { grid-template-columns: 1fr; } }
    `,
  ];

  override render() {
    if (this.error) return html`<p role="alert">The daemon isn't answering: ${this.error}</p>`;
    if (!this.data) return html`<p class="muted">Loading the board…</p>`;
    const tickets = this.data;
    return html`<div class="cols">
      ${columns.map(([id, name]) => {
        const list = tickets.filter((t) => t.column === id);
        return html`<section aria-label=${name}>
          <h2>${name}<span>${list.length}</span></h2>
          ${list.length ? list.map((t) => this.card(t)) : html`<span class="empty">Nothing here.</span>`}
        </section>`;
      })}
    </div>`;
  }

  private card(t: TicketView) {
    const needs = t.status === "needs-you";
    return html`<a class="card t ${needs ? "waiting" : ""}" href="#/ticket/${t.id}">
      <div class="row">
        <span class="tag">${t.type}</span><span class="tag">${t.project}</span><span class="grow"></span>
        ${needs ? html`<span class="chip needs">Needs you</span>` : ""}${t.held ? html`<span class="chip">On hold</span>` : ""}<span class="muted" style="font-size:12px;font-weight:700">#${t.id}</span>
      </div>
      <div class="title">${t.title}</div>
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
      <div class="live">${t.status === "queued" ? (t.waiting ?? "Queued") : t.live}</div>
      ${t.assignee ? html`<div class="who">${avatar(t.assignee.id, t.assignee.name, 24)} ${t.assignee.name}</div>` : ""}
    </a>`;
  }
}

customElements.define("inc-board", IncBoard);
