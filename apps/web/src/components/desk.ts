// My desk (spec §10): the bottleneck, this month's spend, and what shipped.
import { css, html } from "lit";
import { api, type DeskView } from "../api.ts";
import { Loader } from "./loader.ts";
import { base } from "./shared.ts";

const reasons: Record<string, (h: string, n: number) => string> = {
  tokens: (h, n) => `Tickets waited ${h} for tokens (${n} ${n === 1 ? "ticket" : "tickets"})`,
  helper: (h, n) => `Tickets waited ${h} for a free reviewer (${n} ${n === 1 ? "ticket" : "tickets"})`,
  "owner-answer": (h, n) => `Questions waited ${h} for your answer (${n} ${n === 1 ? "ticket" : "tickets"})`,
  "owner-decision": (h, n) =>
    `Ready work waited ${h} for your decision (${n} ${n === 1 ? "ticket" : "tickets"})`,
};

const waitNames: Record<string, string> = {
  tokens: "Tokens",
  helper: "Reviewers",
  "owner-answer": "Your answers",
  "owner-decision": "Your decisions",
};

const hours = (h: number) => (h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(1)} h`);
const money = (n: number) => `$${n.toFixed(n < 10 ? 2 : 0)}`;

export class IncDesk extends Loader<DeskView> {
  protected fetch = () => api.desk();

  static override styles = [
    base,
    css`
      .grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 16px; align-items: start; }
      .hero { grid-column: span 6; background: var(--ink); color: var(--on-ink); border-radius: 20px; padding: 20px 24px;
        display: flex; flex-direction: column; gap: 8px; }
      .hero small { font-weight: 700; opacity: 0.8; }
      .hero h1 { font-size: 26px; }
      .tile { grid-column: span 3; padding: 18px 20px; display: flex; flex-direction: column; gap: 6px; }
      .tile b { font-family: var(--display); font-size: 36px; }
      .tile small, .note { font-size: 13px; color: var(--ink-2); }
      .panel { grid-column: span 6; padding: 18px 20px; display: flex; flex-direction: column; gap: 12px; }
      .bars { display: grid; grid-template-columns: 150px minmax(0, 1fr) 64px; gap: 10px; align-items: center; font-size: 13px; }
      .bar { height: 12px; border-radius: 0 4px 4px 0; background: var(--bar); min-width: 2px; }
      .num { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
      @media (max-width: 900px) { .grid > * { grid-column: 1 / -1 !important; } }
    `,
  ];

  override render() {
    if (this.error) return html`<p role="alert">The daemon isn't answering: ${this.error}</p>`;
    if (!this.data) return html`<p class="muted">Opening your desk…</p>`;
    const d = this.data;
    const b = d.bottleneck;
    const max = Math.max(...d.spend.lines.map((l) => l.amount), 0.01);
    return html`<div class="grid">
      <section class="hero">
        <small>The bottleneck</small>
        <h1>${b ? (reasons[b.reason]?.(hours(b.hours), b.tickets) ?? b.reason) : "Nothing has waited yet"}</h1>
        <span>${d.waits
          .slice(1)
          .map((w) => reasons[w.reason]?.(hours(w.hours), w.tickets))
          .join(" · ")}</span>
      </section>
      <section class="card tile"><small>Spent this month</small><b>${money(d.spend.total)}</b><small>so far</small></section>
      <section class="card tile"><small>Merged PRs</small><b>${d.merged}</b>
        <small>${d.spend.perMergedPR === null ? "none yet" : `${money(d.spend.perMergedPR)} each`}</small></section>
      <section class="card panel">
        <h2>Spend</h2>
        <div class="bars">
          ${d.spend.lines.map(
            (l) => html`<span>${l.name} <span class="muted">${l.kind}</span></span>
              <div class="bar" style="width:${Math.round((l.amount / max) * 100)}%" title=${l.basis}></div>
              <span class="num">${money(l.amount)}</span>`,
          )}
        </div>
        <span class="note">Hardware is its price over 36 months. Electricity is idle and busy watts × hours × your rate.</span>
      </section>
      <section class="card panel">
        <h2>Where work waited</h2>
        ${
          d.waits.length
            ? html`<div class="bars">${d.waits.map((w) => {
                const top = Math.max(...d.waits.map((x) => x.hours), 0.01);
                return html`<span>${waitNames[w.reason] ?? w.reason}</span>
                <div class="bar" style="width:${Math.round((w.hours / top) * 100)}%"></div><span class="num">${hours(w.hours)}</span>`;
              })}</div>`
            : html`<span class="note">No waits this month.</span>`
        }
      </section>
    </div>`;
  }
}

customElements.define("inc-desk", IncDesk);
