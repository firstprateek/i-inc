// Company → Settings → Approvals (decided 2026-11-15): how often work waits for the owner. One level for the
// company, and an override for anyone who should ask more (or less). Lenient is the default.
import type { ApprovalLevel } from "@i-inc/core";
import { css, html, LitElement } from "lit";
import { live } from "lit/directives/live.js";
import { type ApprovalsView, api } from "../api.ts";
import { message, type Note, noteLine, setupStyles } from "../setup-shared.ts";
import { base } from "./shared.ts";

const levels: [ApprovalLevel, string, string][] = [
  ["lenient", "Lenient", "Ask only for what is costly or can't be undone."],
  ["careful", "Careful", "Also ask about plans, unconfirmed done-when items and open disagreements."],
];

export class IncSetupApprovals extends LitElement {
  static override properties = { view: { state: true }, busy: { state: true }, note: { state: true } };
  declare view: ApprovalsView | null;
  declare busy: boolean;
  declare note: Note | undefined;
  /** Which card the last save came from, so its note shows there. */
  private noteFor: "company" | "people" = "company";

  constructor() {
    super();
    this.view = null;
    this.busy = false;
    this.note = undefined;
  }

  static override styles = [
    base,
    setupStyles,
    css`
      p { margin: 0; line-height: 1.45; }
      ul.plain { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 6px; font-size: 14px; line-height: 1.4; }
      .person { display: grid; grid-template-columns: minmax(0, 1fr) minmax(150px, 220px); gap: 12px; align-items: center; }
      .person b { display: block; font-size: 16px; }
      .person span { font-size: 13px; color: var(--ink-2); }
      @media (max-width: 480px) { .person { grid-template-columns: minmax(0, 1fr); gap: 6px; } }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    void api
      .approvals()
      .then((v) => {
        this.view = v;
      })
      .catch((e) => {
        this.note = { ok: false, text: message(e) };
      });
  }

  private async save(patch: Parameters<typeof api.setApprovals>[0]) {
    if (this.busy) return;
    this.noteFor = patch.employees ? "people" : "company";
    this.busy = true;
    this.note = undefined;
    try {
      this.view = await api.setApprovals(patch);
      this.note = { ok: true, text: "Saved." };
    } catch (e) {
      this.note = { ok: false, text: message(e) };
      // A select keeps what was picked; `live` puts the saved level back on this render.
      if (this.view) this.view = { ...this.view };
    } finally {
      this.busy = false;
    }
  }

  override render() {
    const v = this.view;
    if (!v) return this.note ? noteLine(this.note) : html`<p class="muted">Loading…</p>`;
    const name = (l: ApprovalLevel) => levels.find(([id]) => id === l)?.[1] ?? l;
    return html`<div class="stack layout-stack layout-page-band">
      <section class="card" aria-labelledby="company-level">
        <div class="head"><h3 id="company-level">For the company</h3></div>
        <p class="sub">How often employees stop to ask you before going on.</p>
        <div class="seg" role="group" aria-label="Company approval level">
          ${levels.map(
            ([id, label]) =>
              html`<button type="button" aria-pressed=${v.company === id ? "true" : "false"} ?disabled=${this.busy}
                @click=${() => v.company !== id && this.save({ company: id })}>${label}</button>`,
          )}
        </div>
        <p class="sub">${levels.find(([id]) => id === v.company)?.[2]}</p>
        ${this.noteFor === "company" ? noteLine(this.note) : ""}
      </section>

      <section class="card" aria-labelledby="people-level">
        <div class="head"><h3 id="people-level">For each employee</h3></div>
        <p class="sub">Anyone set to the company's level follows it when it changes.</p>
        ${v.employees.map(
          (e) => html`<div class="person">
            <div><b id="who-${e.id}">${e.name}</b><span>${e.role}</span></div>
            <select aria-labelledby="who-${e.id}" ?disabled=${this.busy} .value=${live(e.approvals ?? "company")}
              @change=${(ev: Event) => {
                const value = (ev.target as HTMLSelectElement).value;
                void this.save({
                  employees: { [e.id]: value === "company" ? null : (value as ApprovalLevel) },
                });
              }}>
              <option value="company" ?selected=${e.approvals === null}>Company's (${name(v.company)})</option>
              ${levels.map(([id, label]) => html`<option value=${id} ?selected=${e.approvals === id}>${label}</option>`)}
            </select>
          </div>`,
        )}
        ${this.noteFor === "people" ? noteLine(this.note) : ""}
      </section>

      <section class="card" aria-labelledby="always-asks">
        <div class="head"><h3 id="always-asks">Always asks</h3></div>
        <p class="sub">At any level, these wait for you.</p>
        <ul class="plain">${v.alwaysAsks.map((t) => html`<li>${t}</li>`)}</ul>
      </section>

      <section class="card" aria-labelledby="lenient-skips">
        <div class="head"><h3 id="lenient-skips">What lenient doesn't ask about</h3></div>
        <ul class="plain">${v.lenientSkips.map((t) => html`<li>${t}</li>`)}</ul>
      </section>
    </div>`;
  }
}

customElements.define("inc-setup-approvals", IncSetupApprovals);
