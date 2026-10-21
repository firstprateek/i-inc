// "Proposed": follow-ups an agent suggested after the day's budget was used up (C20, v1-plan §6).
// The owner accepts one to file it as a ticket, or declines it. The board shows it above the
// columns and the inbox counts it; nothing is drawn while there are none.
import { css, html, LitElement, nothing } from "lit";
import { api, type ProposalView, refreshNow } from "../api.ts";
import { avatar, base, projectBadge } from "./shared.ts";

export class IncProposals extends LitElement {
  static override properties = {
    proposals: { attribute: false },
    busy: { state: true },
    error: { state: true },
  };
  declare proposals: ProposalView[];
  declare busy: number | null;
  declare error: string | null;

  constructor() {
    super();
    this.proposals = [];
    this.busy = null;
    this.error = null;
  }

  private async decide(p: ProposalView, verb: "accept" | "decline") {
    if (this.busy !== null) return;
    this.busy = p.id;
    this.error = null;
    try {
      await (verb === "accept" ? api.acceptProposal(p.id) : api.declineProposal(p.id));
    } catch (e) {
      // Another window may have decided it first; the refresh below shows how it stands.
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.busy = null;
    refreshNow();
  }

  static override styles = [
    base,
    css`
      :host { display: block; min-width: 0; }
      .proposed { background: var(--sunken); border-radius: 22px; padding: 14px; display: flex; flex-direction: column; gap: 10px; min-width: 0; box-sizing: border-box; }
      h2 { font-size: 18px; padding: 2px 4px; display: flex; gap: 8px; align-items: baseline; min-width: 0; }
      h2 .n { font-size: 14px; color: var(--ink-2); font-family: var(--body); font-weight: 600; }
      .hint { margin: 0; padding: 0 4px; font-size: 14px; line-height: 1.4; color: var(--ink-2); }
      ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
      li.card { padding: 14px; display: flex; flex-direction: column; gap: 4px; min-width: 0; box-sizing: border-box; }
      .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; min-width: 0; }
      .title { font-size: 16px; font-weight: 700; line-height: 1.3; overflow-wrap: anywhere; min-width: 0; margin: 0; }
      .by { display: flex; align-items: center; gap: 8px; font-size: 13px; line-height: 1.35; color: var(--ink-2); min-width: 0; flex-wrap: wrap; }
      .by a { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; min-width: 44px; box-sizing: border-box; font-weight: 700; }
      details { min-width: 0; }
      summary { display: flex; align-items: center; gap: 8px; list-style: none; min-height: 44px; box-sizing: border-box; font-size: 14px; font-weight: 600; color: var(--ink); }
      summary::-webkit-details-marker { display: none; }
      summary::before { content: ""; width: 7px; height: 7px; border-right: 2px solid var(--ink-2); border-bottom: 2px solid var(--ink-2); transform: rotate(-45deg); transition: transform 0.12s ease; flex-shrink: 0; margin: 0 4px 0 2px; }
      details[open] > summary::before { transform: rotate(45deg); }
      summary:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 2px; border-radius: 8px; }
      .why { margin: 0 0 6px; font-size: 15px; line-height: 1.45; overflow-wrap: anywhere; white-space: pre-wrap; }
      ul.criteria { display: block; list-style: disc; margin: 0 0 6px; padding-left: 22px; font-size: 14px; line-height: 1.45; color: var(--ink-2); overflow-wrap: anywhere; }
      .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
      .actions .btn { font-size: 16px; min-height: 44px; min-width: 44px; flex: 1 1 120px; }
      .actions .btn.ghost { border-color: var(--control-edge); }
      .actions .btn:disabled { opacity: 0.6; }
      .err { background: var(--needs-bg); color: var(--needs-fg); border: 1px solid var(--alarm); border-radius: 10px; padding: 10px 12px; font-size: 14px; overflow-wrap: anywhere; }
    `,
  ];

  override render() {
    if (!this.proposals.length) return nothing;
    return html`<section class="proposed" aria-labelledby="proposed-h">
      <h2 id="proposed-h">Proposed<span class="n">${this.proposals.length}</span></h2>
      <p class="hint">Follow-ups your team suggested after today's limit was reached. Accept to file one as a ticket.</p>
      ${this.error ? html`<div class="err" role="alert">${this.error}</div>` : nothing}
      <ul>${this.proposals.map((p) => this.card(p))}</ul>
    </section>`;
  }

  private card(p: ProposalView) {
    const off = this.busy !== null;
    const label = (verb: string) => `${verb}: ${p.title}`;
    return html`<li class="card">
      <div class="row">${projectBadge(p.project)}<span class="tag">${p.type}</span></div>
      <h3 class="title">${p.title}</h3>
      <div class="by">${avatar(p.proposer, 24)}
        <span>Proposed by ${p.proposer.name}${p.sourceTicket ? html` after <a href="#/ticket/${p.sourceTicket}">#${p.sourceTicket}</a>` : nothing}</span></div>
      ${
        p.body || p.doneWhen.length
          ? html`<details><summary>Why, and when it's done</summary>
              ${p.body ? html`<p class="why">${p.body}</p>` : nothing}
              ${p.doneWhen.length ? html`<ul class="criteria" aria-label="Done when">${p.doneWhen.map((d) => html`<li>${d}</li>`)}</ul>` : nothing}
            </details>`
          : nothing
      }
      <div class="actions">
        <button type="button" class="btn" ?disabled=${off} aria-label=${label("Accept")} @click=${() => this.decide(p, "accept")}>Accept</button>
        <button type="button" class="btn ghost" ?disabled=${off} aria-label=${label("Decline")} @click=${() => this.decide(p, "decline")}>Decline</button>
      </div>
    </li>`;
  }
}

customElements.define("inc-proposals", IncProposals);
