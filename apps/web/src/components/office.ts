// The office (spec §10): a floor with a desk for each employee. The monitor shows the live line.
import { css, html } from "lit";
import { api, type DeskEntry, type TicketView } from "../api.ts";
import { Loader } from "./loader.ts";
import { avatar, base, stateLabel } from "./shared.ts";

interface Data {
  employees: DeskEntry[];
  tickets: TicketView[];
}

export class IncOffice extends Loader<Data> {
  protected async fetch(): Promise<Data> {
    const [employees, tickets] = await Promise.all([api.office(), api.board()]);
    return { employees, tickets };
  }

  static override styles = [
    base,
    css`
      .wrap { display: flex; gap: 24px; align-items: flex-start; }
      .floor { flex-grow: 1; min-width: 0; background: var(--floor); border-radius: 28px; padding: 20px 22px;
        display: flex; flex-direction: column; gap: 16px; }
      .desks { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 16px; }
      .desk { padding: 16px; display: flex; flex-direction: column; gap: 8px; text-decoration: none; }
      .desk.waiting { background: var(--needs-surface); border: 2px solid var(--needs-edge); padding: 15px; }
      .scene { position: relative; height: 150px; }
      .scene .avatar { position: absolute; left: 0; top: 24px; border: 3px solid var(--surface); }
      .top { position: absolute; left: 0; right: 0; bottom: 0; height: 54px; background: var(--desk);
        border-radius: 12px; border-bottom: 6px solid var(--desk-edge); }
      .screen { position: absolute; right: 0; bottom: 38px; width: 128px; height: 78px; box-sizing: border-box;
        background: var(--screen); border: 3px solid var(--screen-edge); border-radius: 9px; padding: 8px 9px;
        color: var(--screen-text); font-size: 12px; line-height: 1.35; overflow: hidden; }
      .screen.off { background: var(--screen-edge); }
      .row { display: flex; align-items: center; gap: 6px; }
      .name { font-weight: 700; font-size: 18px; }
      .grow { flex-grow: 1; }
      .ticket { font-size: 14px; font-weight: 600; }
      .meta { font-size: 13px; color: var(--ink-2); }
      aside { width: 340px; flex-shrink: 0; display: flex; flex-direction: column; gap: 16px; }
      aside .card { padding: 18px 20px; display: flex; flex-direction: column; gap: 12px; }
      aside a { display: flex; flex-direction: column; gap: 2px; text-decoration: none; }
      aside a b { font-size: 14px; }
      .empty { font-size: 14px; color: var(--ink-2); }
      @media (max-width: 1100px) { .wrap { flex-direction: column; } aside { width: 100%; } }
    `,
  ];

  override render() {
    if (this.error) return html`<p role="alert">The daemon isn't answering: ${this.error}</p>`;
    if (!this.data) return html`<p class="muted">Opening the office…</p>`;
    const { employees, tickets } = this.data;
    const needs = tickets.filter((t) => t.status === "needs-you");
    const ready = tickets.filter((t) => t.status === "ready");
    return html`<div class="wrap">
      <section class="floor" aria-label="The floor">
        <h1>The floor</h1>
        <div class="desks">${employees.map((e) => this.desk(e))}</div>
      </section>
      <aside>
        <div class="card">
          <h2>Needs you ${needs.length ? html`<span class="chip needs">${needs.length}</span>` : ""}</h2>
          ${needs.length ? needs.map((t) => this.link(t)) : html`<span class="empty">Nothing waits for you.</span>`}
        </div>
        <div class="card">
          <h2>Ready for you</h2>
          ${ready.length ? ready.map((t) => this.link(t)) : html`<span class="empty">No reports yet.</span>`}
        </div>
      </aside>
    </div>`;
  }

  private desk(e: DeskEntry) {
    const [label, tone] = stateLabel[e.state] ?? ["Idle", ""];
    const needs = e.state === "needs-you";
    const off = e.state === "off" || e.state === "idle";
    const href = e.ticket ? `#/ticket/${e.ticket.id}` : "#/board";
    return html`<a class="card desk ${needs ? "waiting" : ""}" href=${href} aria-label="${e.name}: ${label}">
      <div class="scene" aria-hidden="true">
        ${e.state === "off" ? "" : avatar(e, 52)}
        <div class="top"></div>
        <div class="screen ${off ? "off" : ""}">${off ? "" : (e.ticket?.live ?? "")}</div>
      </div>
      <div class="row"><span class="name">${e.name}</span><span class="grow"></span><span class="chip ${tone}">${label}</span></div>
      <div class="ticket">${e.ticket ? `#${e.ticket.id} ${e.ticket.title} · ${e.ticket.project}` : "No ticket"}</div>
      <div class="meta">${e.role} · ${e.engine}</div>
    </a>`;
  }

  private link(t: TicketView) {
    return html`<a href="#/ticket/${t.id}"><b>${t.title}</b><span class="muted">${t.assignee?.name ?? "Unassigned"} · ${t.project}</span></a>`;
  }
}

customElements.define("inc-office", IncOffice);
