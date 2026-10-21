// "Proposed": follow-ups an agent suggested after the day's budget was used up (C20, v1-plan §6).
// The owner accepts one to file it as a ticket, or declines it. It is a compact band so it never
// pushes the board's columns out of sight: one header line (collapsed when there are more than a
// few), dense rows, five at a time. The board shows it above the columns and the inbox lists it;
// nothing is drawn while there are none.
import { css, html, LitElement, nothing, type PropertyValues } from "lit";
import { api, type ProposalView, refreshNow } from "../api.ts";
import { avatar, base, projectBadge } from "./shared.ts";

/** More than this many proposals start collapsed. */
export const COLLAPSE_ABOVE = 3;
/** Rows shown before "Show all". */
export const ROWS_SHOWN = 5;

export class IncProposals extends LitElement {
  static override properties = {
    proposals: { attribute: false },
    busy: { state: true },
    error: { state: true },
    /** The owner's choice for the band; null follows the count (collapsed above three). */
    expanded: { state: true },
    showAll: { state: true },
    details: { state: true },
    done: { state: true },
  };
  declare proposals: ProposalView[];
  declare busy: number | null;
  declare error: string | null;
  declare expanded: boolean | null;
  declare showAll: boolean;
  declare details: Set<number>;
  /** Set after the last proposal is decided, so there is somewhere for keyboard focus to land. */
  declare done: boolean;
  /** Where focus goes once the list has caught up with a decision. */
  private pendingFocus: { id: number; index: number } | null = null;
  private doneTimer = 0;

  constructor() {
    super();
    this.proposals = [];
    this.busy = null;
    this.error = null;
    this.expanded = null;
    this.showAll = false;
    this.details = new Set();
    this.done = false;
  }

  override disconnectedCallback(): void {
    clearTimeout(this.doneTimer);
    super.disconnectedCallback();
  }

  private get isOpen(): boolean {
    return this.expanded ?? this.proposals.length <= COLLAPSE_ABOVE;
  }

  private async decide(p: ProposalView, verb: "accept" | "decline") {
    if (this.busy !== null) return;
    this.busy = p.id;
    this.error = null;
    const index = this.proposals.findIndex((x) => x.id === p.id);
    const focusWasInside =
      this.shadowRoot?.activeElement !== null && this.shadowRoot?.activeElement !== undefined;
    try {
      await (verb === "accept" ? api.acceptProposal(p.id) : api.declineProposal(p.id));
    } catch (e) {
      // Another window may have decided it first; the refresh below shows how it stands.
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.busy = null;
    if (focusWasInside) this.pendingFocus = { id: p.id, index };
    refreshNow();
  }

  /** After a decision removes a row, keyboard focus moves to the next row, or to a short note. */
  protected override updated(changed: PropertyValues): void {
    const want = this.pendingFocus;
    if (!want || !changed.has("proposals")) return;
    if (this.proposals.some((p) => p.id === want.id)) return; // not refreshed yet, or the call failed
    this.pendingFocus = null;
    this.details.delete(want.id);
    if (!this.proposals.length) {
      this.done = true;
      clearTimeout(this.doneTimer);
      this.doneTimer = window.setTimeout(() => {
        this.done = false;
      }, 6000);
      void this.updateComplete.then(() => this.shadowRoot?.querySelector<HTMLElement>(".all-done")?.focus());
      return;
    }
    const next = this.proposals[Math.min(want.index, this.proposals.length - 1)];
    const open = this.isOpen;
    void this.updateComplete.then(() => {
      const root = this.shadowRoot;
      const target =
        (open && next && root?.querySelector<HTMLElement>(`[data-row="${next.id}"] .more`)) ||
        root?.querySelector<HTMLElement>(".head");
      target?.focus();
    });
  }

  private toggleDetails(id: number) {
    const next = new Set(this.details);
    if (!next.delete(id)) next.add(id);
    this.details = next;
  }

  static override styles = [
    base,
    css`
      :host { display: block; min-width: 0; }
      .proposed { background: var(--sunken); border-radius: 16px; padding: 6px 8px; display: flex; flex-direction: column; gap: 2px; min-width: 0; box-sizing: border-box; }
      h2 { margin: 0; font-size: 15px; }
      .head { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%; min-height: 36px; padding: 0 6px; border-radius: 10px;
        font: 600 14px var(--body); color: var(--ink-2); cursor: pointer; line-height: 1.3; touch-action: manipulation; }
      .head b { color: var(--ink); font: 700 15px var(--display); letter-spacing: -0.2px; white-space: nowrap; }
      .head:focus-visible, .more:focus-visible, .link:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 1px; }
      .chev { width: 7px; height: 7px; border-right: 2px solid var(--ink-2); border-bottom: 2px solid var(--ink-2); transform: rotate(-45deg); transition: transform 0.12s ease; flex-shrink: 0; margin: 0 4px 0 2px; }
      [aria-expanded="true"] > .chev { transform: rotate(45deg); }
      ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; min-width: 0; }
      li.row { padding: 8px 6px; border-top: 1px solid var(--line); display: grid; gap: 2px 10px; min-width: 0;
        grid-template-columns: auto minmax(0, 1fr) auto; grid-template-areas: "badge title actions" ". meta actions" ". body body"; align-items: center; }
      .badge { grid-area: badge; display: flex; min-width: 0; }
      .title { grid-area: title; font-size: 14px; font-weight: 700; line-height: 1.3; overflow-wrap: anywhere; min-width: 0; margin: 0; }
      .meta { grid-area: meta; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 13px; line-height: 1.35; color: var(--ink-2); min-width: 0; }
      .meta .name { display: inline-flex; align-items: center; gap: 6px; }
      .link { display: inline-flex; align-items: center; justify-content: center; min-height: 28px; min-width: 28px; box-sizing: border-box; font-weight: 700; }
      .more { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px; min-height: 28px; padding: 0 6px; border-radius: 8px; cursor: pointer;
        font: 600 13px var(--body); color: var(--ink); touch-action: manipulation; }
      .more .chev { margin: 0 2px 0 0; width: 6px; height: 6px; }
      .actions { grid-area: actions; display: flex; gap: 6px; align-self: center; }
      .actions .btn { font-size: 14px; min-height: 32px; min-width: 32px; padding: 0 14px; }
      .actions .btn.ghost { border-color: var(--ink-2); }
      .actions .btn:disabled { opacity: 0.6; }
      .body { grid-area: body; padding: 4px 0 2px; min-width: 0; }
      .why { margin: 0 0 6px; font-size: 14px; line-height: 1.45; overflow-wrap: anywhere; white-space: pre-wrap; }
      ul.criteria { display: block; list-style: disc; margin: 0; padding-left: 22px; font-size: 13px; line-height: 1.45; color: var(--ink-2); overflow-wrap: anywhere; }
      .foot { display: flex; padding: 0 6px 2px; }
      .foot .more { color: var(--ink); text-decoration: underline; }
      .err { background: var(--needs-bg); color: var(--needs-fg); border: 1px solid var(--alarm); border-radius: 10px; padding: 8px 12px; font-size: 14px; overflow-wrap: anywhere; margin: 2px 4px; }
      .all-done { margin: 0; padding: 8px 10px; font-size: 14px; color: var(--ink-2); background: var(--sunken); border-radius: 12px; }
      /* On a phone or with a finger: every control is 44px tall and the row stacks. */
      @media (max-width: 900px), (pointer: coarse) {
        .head { min-height: 44px; }
        .more { min-height: 44px; }
        .link { min-height: 44px; min-width: 44px; }
        .actions .btn { min-height: 44px; min-width: 44px; font-size: 16px; padding: 0 18px; }
        li.row { grid-template-columns: auto minmax(0, 1fr); grid-template-areas: "badge title" "meta meta" "actions actions" "body body"; padding: 10px 6px; }
        .actions { justify-content: flex-start; margin-top: 2px; }
        .all-done { min-height: 44px; display: flex; align-items: center; box-sizing: border-box; }
      }
    `,
  ];

  override render() {
    const list = this.proposals;
    if (!list.length) {
      return this.done
        ? html`<p class="all-done" role="status" tabindex="-1">All decided. Accepted ones are on the board.</p>`
        : nothing;
    }
    const open = this.isOpen;
    const shown = this.showAll ? list : list.slice(0, ROWS_SHOWN);
    return html`<section class="proposed" aria-label="Proposed follow-ups">
      <h2><button type="button" class="head" aria-expanded=${open ? "true" : "false"} aria-controls="proposed-list"
        @click=${() => {
          this.expanded = !open;
        }}><span class="chev" aria-hidden="true"></span><b>Proposed (${list.length})</b><span> — follow-ups waiting for you</span></button></h2>
      ${this.error ? html`<div class="err" role="alert">${this.error}</div>` : nothing}
      <div id="proposed-list" ?hidden=${!open}>
        <ul>${shown.map((p) => this.row(p))}</ul>
        ${
          list.length > ROWS_SHOWN
            ? html`<div class="foot"><button type="button" class="more" @click=${() => {
                this.showAll = !this.showAll;
              }}>${this.showAll ? "Show fewer" : `Show all (${list.length})`}</button></div>`
            : nothing
        }
      </div>
    </section>`;
  }

  private row(p: ProposalView) {
    const off = this.busy !== null;
    const label = (verb: string) => `${verb}: ${p.title}`;
    const hasMore = Boolean(p.body) || p.doneWhen.length > 0;
    const open = this.details.has(p.id);
    return html`<li class="row" data-row=${p.id}>
      <span class="badge">${projectBadge(p.project)}</span>
      <h3 class="title">${p.title}</h3>
      <div class="meta">
        <span class="name">${avatar(p.proposer, 20)}<span>by ${p.proposer.name}${p.sourceTicket ? html` after <a class="link" href="#/ticket/${p.sourceTicket}">#${p.sourceTicket}</a>` : nothing}</span></span>
        ${
          hasMore
            ? html`<button type="button" class="more" aria-expanded=${open ? "true" : "false"} aria-controls="body-${p.id}"
                aria-label=${`Why, and when it's done: ${p.title}`} @click=${() => this.toggleDetails(p.id)}><span class="chev" aria-hidden="true"></span>Why</button>`
            : nothing
        }
      </div>
      <div class="actions">
        <button type="button" class="btn" ?disabled=${off} aria-label=${label("Accept")} @click=${() => this.decide(p, "accept")}>Accept</button>
        <button type="button" class="btn ghost" ?disabled=${off} aria-label=${label("Decline")} @click=${() => this.decide(p, "decline")}>Decline</button>
      </div>
      ${
        hasMore
          ? html`<div class="body" id="body-${p.id}" ?hidden=${!open}>
              ${p.body ? html`<p class="why">${p.body}</p>` : nothing}
              ${p.doneWhen.length ? html`<ul class="criteria" aria-label="Done when">${p.doneWhen.map((d) => html`<li>${d}</li>`)}</ul>` : nothing}
            </div>`
          : nothing
      }
    </li>`;
  }
}

customElements.define("inc-proposals", IncProposals);
