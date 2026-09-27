// Hiring (spec §5): who, which engines, and for a PA what may leave the house. Nothing is preset.

import type { Employee, OutboundAction, OutboundRule, OutboundSetting } from "@i-inc/core";
import { css, html, LitElement } from "lit";
import { api, refreshNow } from "../api.ts";
import { base } from "./shared.ts";

const roles = [
  "Senior Engineer",
  "Staff Engineer",
  "Product Manager",
  "UX Designer",
  "QA",
  "Personal Assistant",
];
const duties: Record<string, string[]> = {
  "Senior Engineer": ["build", "review", "verify"],
  "Staff Engineer": ["plan", "review"],
  "Product Manager": ["plan"],
  "UX Designer": ["build", "review"],
  QA: ["verify"],
  "Personal Assistant": ["build"],
};
type Mode = "ask" | "rule" | "off";
const outboundRows: { action: OutboundAction; label: string; rule: OutboundRule; ruleText: string }[] = [
  {
    action: "send-email",
    label: "Send email",
    rule: { onlyToContacts: true },
    ruleText: "Only to people in my contacts",
  },
  {
    action: "calendar-hold",
    label: "Add holds to my calendar",
    rule: { noInvitees: true },
    ruleText: "Only when nobody else is invited",
  },
  {
    action: "accept-invite",
    label: "Accept invites",
    rule: { onlyToContacts: true },
    ruleText: "Only from my contacts",
  },
];

interface EngineInfo {
  id: string;
  model: string;
  accountId: string;
  local: boolean;
}

export class IncHiring extends LitElement {
  static override properties = {
    engines: { state: true },
    name: { state: true },
    role: { state: true },
    engine: { state: true },
    fallback: { state: true },
    nights: { state: true },
    outbound: { state: true },
    error: { state: true },
    busy: { state: true },
  };
  declare engines: EngineInfo[];
  declare name: string;
  declare role: string;
  declare engine: string;
  declare fallback: string;
  declare nights: boolean;
  declare outbound: Record<string, Mode>;
  declare error: string | null;
  declare busy: boolean;

  constructor() {
    super();
    this.engines = [];
    this.name = "";
    this.role = "Senior Engineer";
    this.engine = "";
    this.fallback = "";
    this.nights = false;
    this.outbound = { "send-email": "ask", "calendar-hold": "ask", "accept-invite": "ask" };
    this.error = null;
    this.busy = false;
  }

  override async connectedCallback(): Promise<void> {
    super.connectedCallback();
    this.engines = await api.engines();
  }

  private get pa() {
    return this.role === "Personal Assistant";
  }

  /** A PA works on home data, so only local engines are offered (spec §7). */
  private get choices() {
    return this.pa ? this.engines.filter((e) => e.local) : this.engines;
  }

  private async hire(e: Event) {
    e.preventDefault();
    this.busy = true;
    this.error = null;
    const outbound: Partial<Record<OutboundAction, OutboundSetting>> | undefined = this.pa
      ? Object.fromEntries(
          outboundRows.map((r): [OutboundAction, OutboundSetting] => {
            const mode = this.outbound[r.action] ?? "ask";
            return [r.action, mode === "rule" ? { mode, rule: r.rule } : { mode }];
          }),
        )
      : undefined;
    try {
      await api.hire({
        name: this.name,
        role: this.role,
        duties: (duties[this.role] ?? ["build"]) as Employee["duties"],
        engines: { default: this.engine, fallbacks: this.fallback ? [this.fallback] : [] },
        ...(this.nights ? { workingHours: { from: 22, to: 7 } } : {}),
        ...(outbound ? { outbound } : {}),
      });
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.busy = false;
      return;
    }
    this.busy = false;
    refreshNow();
    location.hash = "#/office";
  }

  static override styles = [
    base,
    css`
      form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; align-items: start; max-width: 1100px; }
      .card { padding: 20px 22px; display: flex; flex-direction: column; gap: 12px; }
      .wide { grid-column: 1 / -1; }
      label { font-size: 13px; font-weight: 600; color: var(--ink-2); display: flex; flex-direction: column; gap: 4px; }
      input[type="text"], select { font: 16px var(--body); min-height: 44px; padding: 0 12px; border-radius: 10px;
        border: 1px solid var(--line-strong); background: var(--surface); color: var(--ink); }
      .pills { display: flex; flex-wrap: wrap; gap: 6px; }
      .pill { font: 600 13px var(--body); min-height: 36px; padding: 0 12px; border-radius: 999px; cursor: pointer;
        border: 1px solid var(--line-strong); background: transparent; color: var(--ink); }
      .pill[aria-pressed="true"] { background: var(--ink); color: var(--on-ink); border-color: var(--ink); }
      .note { font-size: 13px; color: var(--ink-2); background: var(--sunken); border-radius: 12px; padding: 10px 12px; }
      .rows { display: grid; grid-template-columns: 200px auto minmax(0, 1fr); gap: 8px 16px; align-items: center; font-size: 14px; }
      .seg { display: flex; border: 1px solid var(--line-strong); border-radius: 999px; overflow: hidden; }
      .seg button { font: 600 13px var(--body); min-height: 36px; padding: 0 14px; border: none; background: transparent; color: var(--ink); cursor: pointer; }
      .seg button[aria-pressed="true"] { background: var(--ink); color: var(--on-ink); }
      .check { flex-direction: row; align-items: center; gap: 8px; font-size: 15px; color: var(--ink); }
      .check input { width: 20px; height: 20px; }
      .submit { display: flex; align-items: center; gap: 16px; }
      @media (max-width: 800px) { form { grid-template-columns: 1fr; } .rows { grid-template-columns: 1fr; } }
    `,
  ];

  override render() {
    return html`<form @submit=${this.hire} aria-label="Hire someone">
      <section class="card">
        <h2>Who</h2>
        <label>Name <input type="text" required .value=${this.name}
          @input=${(e: InputEvent) => {
            this.name = (e.target as HTMLInputElement).value;
          }}></label>
        <div class="pills" role="group" aria-label="Role">
          ${roles.map(
            (r) => html`<button type="button" class="pill" aria-pressed=${r === this.role ? "true" : "false"}
              @click=${() => {
                this.role = r;
                this.engine = "";
                this.fallback = "";
              }}>${r}</button>`,
          )}
        </div>
        <span class="muted" style="font-size:13px">Duties: ${duties[this.role]?.join(", ")}</span>
      </section>

      <section class="card">
        <h2>Engines</h2>
        <label>Engine
          <select required .value=${this.engine} @change=${(e: Event) => {
            this.engine = (e.target as HTMLSelectElement).value;
          }}>
            <option value="">Choose an engine</option>
            ${this.choices.map((e) => html`<option value=${e.id}>${e.model} · ${e.accountId}</option>`)}
          </select></label>
        <label>If it's out of tokens or stuck
          <select .value=${this.fallback} @change=${(e: Event) => {
            this.fallback = (e.target as HTMLSelectElement).value;
          }}>
            <option value="">Wait</option>
            ${this.choices.filter((e) => e.id !== this.engine).map((e) => html`<option value=${e.id}>Move to ${e.model}</option>`)}
          </select></label>
        ${this.pa ? html`<p class="note">Home data only goes to local engines, so only local engines are offered.</p>` : ""}
        <label class="check"><input type="checkbox" .checked=${this.nights}
          @change=${(e: Event) => {
            this.nights = (e.target as HTMLInputElement).checked;
          }}> Nights only (10 pm to 7 am)</label>
      </section>

      ${
        this.pa
          ? html`<section class="card wide">
              <h2>What leaves the house</h2>
              <span class="muted" style="font-size:14px">Everything starts as Ask. Loosen only what you're sure of.</span>
              <div class="rows">
                ${outboundRows.map(
                  (r) => html`<b>${r.label}</b>
                    <div class="seg" role="group" aria-label=${r.label}>
                      ${(["ask", "rule", "off"] as Mode[]).map(
                        (
                          m,
                        ) => html`<button type="button" aria-pressed=${this.outbound[r.action] === m ? "true" : "false"}
                          @click=${() => {
                            this.outbound = { ...this.outbound, [r.action]: m };
                          }}>${m === "ask" ? "Ask" : m === "rule" ? "By rule" : "Off"}</button>`,
                      )}
                    </div>
                    <span class="muted">${this.outbound[r.action] === "rule" ? r.ruleText : this.outbound[r.action] === "off" ? "Can't even propose it" : "Waits for your tap"}</span>`,
                )}
              </div>
              <p class="note">Always ask, whatever you set: booking, paying, deleting, forwarding, sharing files, account settings, and sending to anyone not in your contacts.</p>
            </section>`
          : ""
      }

      <div class="submit wide">
        <button class="btn" type="submit" ?disabled=${this.busy || !this.name.trim() || !this.engine}>Hire ${this.name.trim() || "them"}</button>
        ${this.error ? html`<span role="alert">${this.error}</span>` : ""}
      </div>
    </form>`;
  }
}

customElements.define("inc-hiring", IncHiring);
