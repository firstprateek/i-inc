// Hiring (spec §5): who, which engines, and for a PA what may leave the house. Nothing is preset.

import type { Duty, Employee, Engine, OutboundAction, OutboundRule, OutboundSetting } from "@i-inc/core";
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

const dutyNames: Record<Duty, string> = { plan: "Plan", build: "Build", verify: "Verify", review: "Review" };

/** "qwen3 · opencode · local": what a native option can show; the chips under the picker are the visual. */
const engineLabel = (e: Engine) => `${e.model} · ${e.harness}${e.local ? " · local" : ""}`;

export class IncHiring extends LitElement {
  static override properties = {
    employeeId: { type: String },
    team: { state: true },
    perDuty: { state: true },
    extraFallbacks: { state: true },
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
  /** When set, the form edits this employee's engines instead of hiring someone new. */
  declare employeeId: string | undefined;
  declare team: Employee[];
  declare editing: Employee | null;
  declare perDuty: Partial<Record<Duty, string>>;
  declare extraFallbacks: string[];
  declare engines: Engine[];
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
    this.team = [];
    this.editing = null;
    this.perDuty = {};
    this.extraFallbacks = [];
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
    const [engines, team] = await Promise.all([
      api.engines().catch(() => [] as Engine[]),
      api.employees().catch(() => [] as Employee[]),
    ]);
    this.engines = engines;
    this.team = team;
    this.load();
  }

  override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("employeeId")) this.load();
  }

  /** Fills the form from the employee being edited. */
  private load() {
    const e = this.employeeId ? this.team.find((x) => x.id === this.employeeId) : undefined;
    if (e === (this.editing ?? undefined)) return;
    this.editing = e ?? null;
    if (!e) {
      // Back from an edit to a blank hire.
      this.name = "";
      this.engine = "";
      this.fallback = "";
      this.perDuty = {};
      this.extraFallbacks = [];
      return;
    }
    this.name = e.name;
    this.role = e.role;
    this.engine = e.engines.default;
    this.perDuty = { ...e.engines.perDuty };
    this.fallback = e.engines.fallbacks[0] ?? "";
    this.extraFallbacks = e.engines.fallbacks.slice(1);
  }

  private get pa() {
    return this.role === "Personal Assistant";
  }

  private get roleDuties(): Duty[] {
    return (this.editing?.duties ?? duties[this.role] ?? ["build"]) as Duty[];
  }

  private chips(id: string) {
    const e = this.engines.find((x) => x.id === id);
    if (!e) return "";
    return html`<span class="chips"><span class="chip" title="Harness">${e.harness}</span>${
      e.local ? html`<span class="chip working" title="Runs on this machine">local</span>` : ""
    }</span>`;
  }

  /** A select's value can't be bound in the template (its options are children), so `updated` sets it. */
  override updated(): void {
    for (const s of this.renderRoot.querySelectorAll<HTMLSelectElement>("select[data-value]")) {
      s.value = s.dataset.value ?? "";
    }
  }

  /** The per-duty engines worth sending: only duties this employee has, and only where one was picked. */
  private engineSet() {
    const perDuty: Partial<Record<Duty, string>> = {};
    for (const d of this.roleDuties) {
      const id = this.perDuty[d];
      if (id) perDuty[d] = id;
    }
    return {
      default: this.engine,
      ...(Object.keys(perDuty).length ? { perDuty } : {}),
      fallbacks: [...(this.fallback ? [this.fallback] : []), ...this.extraFallbacks],
    };
  }

  private async save(e: Event) {
    if (!this.editing) return this.hire(e);
    e.preventDefault();
    this.busy = true;
    this.error = null;
    try {
      await api.updateEmployee(this.editing.id, { engines: this.engineSet() });
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.busy = false;
      return;
    }
    this.busy = false;
    refreshNow();
    location.hash = "#/office";
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
        duties: this.roleDuties,
        engines: this.engineSet(),
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
      label, select { min-width: 0; max-width: 100%; box-sizing: border-box; }
      .chips { display: inline-flex; gap: 6px; flex-wrap: wrap; }
      .duties { min-width: 0; border: 1px solid var(--line); border-radius: 12px; margin: 0; padding: 12px 14px; display: flex; flex-direction: column; gap: 12px; }
      .duties legend { font-size: 13px; font-weight: 700; color: var(--ink-2); padding: 0 6px; }
      .team { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
      .team li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 0; border-top: 1px solid var(--line); }
      .team li:first-child { border-top: none; }
      .team a.btn { text-decoration: none; display: inline-flex; align-items: center; min-height: 44px; padding: 0 16px; font-size: 14px; }
      .submit a.btn { text-decoration: none; display: inline-flex; align-items: center; min-height: 44px; padding: 0 20px; }
      .note { font-size: 13px; color: var(--ink-2); background: var(--sunken); border-radius: 12px; padding: 10px 12px; }
      .rows { display: grid; grid-template-columns: 200px auto minmax(0, 1fr); gap: 8px 16px; align-items: center; font-size: 14px; }
      .seg { display: flex; border: 1px solid var(--line-strong); border-radius: 999px; overflow: hidden; }
      .seg button { font: 600 13px var(--body); min-height: 36px; padding: 0 14px; border: none; background: transparent; color: var(--ink); cursor: pointer; }
      .seg button[aria-pressed="true"] { background: var(--ink); color: var(--on-ink); }
      .check { flex-direction: row; align-items: center; gap: 8px; font-size: 15px; color: var(--ink); }
      .check input { width: 20px; height: 20px; }
      .submit { display: flex; align-items: center; gap: 16px; }
      .check { min-height: 44px; }
      @media (max-width: 800px) {
        form { grid-template-columns: minmax(0, 1fr); }
        .rows { grid-template-columns: 1fr; }
        .card { padding: 18px; }
        .pill { min-height: 44px; padding: 0 16px; }
        .seg { width: 100%; }
        .seg button { flex: 1; min-height: 44px; }
        .rows .muted { margin-bottom: 8px; }
        .submit { flex-wrap: wrap; }
        .submit .btn { flex: 1 1 auto; }
      }
    `,
  ];

  private teamCard() {
    if (this.editing || !this.team?.length) return "";
    return html`<section class="card wide" aria-label="Your team">
      <h2>Your team</h2>
      <ul class="team">
        ${(this.team ?? []).map(
          (m) => html`<li><span><b>${m.name}</b> <span class="muted">${m.role}</span></span>
            <a class="btn ghost" href="#/hiring/${m.id}" aria-label="Edit ${m.name}'s engines">Edit engines</a></li>`,
        )}
      </ul>
    </section>`;
  }

  private picker(label: string, value: string, onPick: (id: string) => void, blank: string, skip?: string) {
    return html`<label><span>${label}</span>
      <select data-value=${value} ?required=${!blank.length} @change=${(e: Event) => onPick((e.target as HTMLSelectElement).value)}>
        ${blank ? html`<option value="">${blank}</option>` : ""}
        ${(this.choices ?? []).filter((e) => e.id !== skip).map((e) => html`<option value=${e.id}>${engineLabel(e)}</option>`)}
      </select>
      ${this.chips(value)}
    </label>`;
  }

  override render() {
    const editing = this.editing;
    const fallbackEngines = this.extraFallbacks.map(
      (id) => this.engines.find((e) => e.id === id)?.model ?? id,
    );
    return html`<form @submit=${this.save} aria-label=${editing ? `Edit ${editing.name}` : "Hire someone"}>
      ${
        editing
          ? html`<section class="card wide">
              <h2>${editing.name}</h2>
              <span class="muted" style="font-size:14px">${editing.role} · ${editing.duties.join(", ")}</span>
            </section>`
          : html`<section class="card">
        <h2>Who</h2>
        <label>Name <input type="text" required autocomplete="off" autocapitalize="words" enterkeyhint="done" .value=${this.name}
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
                this.perDuty = {};
              }}>${r}</button>`,
          )}
        </div>
        <span class="muted" style="font-size:13px">Duties: ${duties[this.role]?.join(", ")}</span>
      </section>`
      }

      <section class="card ${editing ? "wide" : ""}">
        <h2>Engines</h2>
        ${this.picker(
          this.roleDuties.length > 1 ? "Default engine" : "Engine",
          this.engine,
          (id) => {
            this.engine = id;
          },
          "Choose an engine",
        )}
        ${
          this.roleDuties.length > 1 || Object.keys(this.perDuty).length
            ? html`<fieldset class="duties">
              <legend>Engine per duty</legend>
              <span class="muted" style="font-size:13px">Pick a different engine for a duty, or leave it on the default.</span>
              ${this.roleDuties.map((d) =>
                this.picker(
                  dutyNames[d],
                  this.perDuty[d] ?? "",
                  (id) => {
                    const next = { ...this.perDuty };
                    if (id) next[d] = id;
                    else delete next[d];
                    this.perDuty = next;
                  },
                  "Same as default",
                ),
              )}
            </fieldset>`
            : ""
        }
        ${this.picker(
          "If it's out of tokens or stuck",
          this.fallback,
          (id) => {
            this.fallback = id;
          },
          "Wait",
          this.engine,
        )}
        ${fallbackEngines.length ? html`<span class="muted" style="font-size:13px">Then: ${fallbackEngines.join(", ")}</span>` : ""}
        ${this.pa ? html`<p class="note">Home data only goes to local engines, so only local engines are offered.</p>` : ""}
        ${
          editing
            ? ""
            : html`<label class="check"><input type="checkbox" .checked=${this.nights}
          @change=${(e: Event) => {
            this.nights = (e.target as HTMLInputElement).checked;
          }}> Nights only (10 pm to 7 am)</label>`
        }
      </section>

      ${
        this.pa && !editing
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
        <button class="btn" type="submit" ?disabled=${this.busy || !this.name.trim() || !this.engine}>${
          editing ? "Save engines" : `Hire ${this.name.trim() || "them"}`
        }</button>
        ${editing ? html`<a class="btn ghost" href="#/hiring">Cancel</a>` : ""}
        ${this.error ? html`<span role="alert">${this.error}</span>` : ""}
      </div>

      ${this.teamCard()}
    </form>`;
  }
}

customElements.define("inc-hiring", IncHiring);
