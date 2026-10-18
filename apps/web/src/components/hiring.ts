// Hiring (spec §5): who, which engines, role instructions & prompt, and for a PA what may leave the house.

import type { Duty, Effort, Employee, OutboundAction, OutboundRule, OutboundSetting } from "@i-inc/core";
import { css, html, LitElement } from "lit";
import { api, refreshNow } from "../api.ts";
import {
  type AccountCost,
  type Engine,
  engineIsLocal,
  engineLabel,
  type Harness,
  harnessOptions,
  setupApi,
} from "../setup-api.ts";
import { LAYOUT_BREAKPOINTS } from "./layout.ts";
import { base } from "./shared.ts";

export const standardRoles = [
  "CEO",
  "Senior Engineer",
  "Staff Engineer",
  "Product Manager",
  "UX Designer",
  "QA",
  "Personal Assistant",
] as const;

export const defaultDuties: Record<string, Duty[]> = {
  CEO: ["plan", "review"],
  "Senior Engineer": ["build", "review", "verify"],
  "Staff Engineer": ["plan", "review"],
  "Product Manager": ["plan"],
  "UX Designer": ["build", "review"],
  QA: ["verify"],
  "Personal Assistant": ["build"],
};

export const defaultPrompts: Record<string, string> = {
  CEO: `You are the Chief Executive Officer at i.inc. You drive technical vision, strategic product direction, and organizational momentum. You synthesize complex business and technical requirements into crisp priorities, ensure architectural coherence across systems, delegate with clarity, and make decisive calls on technical and product trade-offs.`,
  "Senior Engineer": `You are a Senior Engineer at i.inc. You write clean, robust, and well-tested code. You keep diffs focused, maintain backward compatibility, handle edge cases and errors gracefully, and ensure all checks and tests pass with high standards.`,
  "Staff Engineer": `You are a Staff Engineer at i.inc. You focus on system architecture, technical leverage, cross-team design patterns, and high-leverage refactors. You spot structural problems early, define clear contracts, and guide engineering quality.`,
  "Product Manager": `You are a Product Manager at i.inc. You champion the user experience and business outcomes. You turn ambiguity into actionable tickets with clear acceptance criteria (Done when), manage scope ruthlessly, and validate that finished work solves the actual user need.`,
  "UX Designer": `You are a UX Designer at i.inc. You design intuitive, accessible, and responsive user experiences. You enforce high contrast, touch targets (≥44px), keyboard navigation, calm visual hierarchy, and delightful design details across desktop and mobile.`,
  QA: `You are a QA Engineer at i.inc. You find failure modes before users do. You write rigorous automated test suites, verify edge cases, simulate network/token failures, and ensure regression-proof reliability.`,
  "Personal Assistant": `You are a Personal Assistant at i.inc. You manage calendar holds, email drafting, and daily errands with extreme privacy and precision. You never execute external commitments without explicit confirmation, and you keep communications courteous, concise, and helpful.`,
};

export const dutyDescriptions: Record<Duty, { title: string; desc: string }> = {
  plan: { title: "Plan", desc: "System design, step-by-step breakdown & architecture" },
  build: { title: "Build", desc: "Write & edit code in the walled sandbox" },
  verify: { title: "Verify", desc: "Run checks, test suites & proof verification" },
  review: { title: "Review", desc: "Fresh-context code review for correctness & security" },
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

export class IncHiring extends LitElement {
  static override properties = {
    employeeId: { type: String },
    team: { state: true },
    perDuty: { state: true },
    extraFallbacks: { state: true },
    engines: { state: true },
    accounts: { state: true },
    name: { state: true },
    role: { state: true },
    rolePreset: { state: true },
    customRole: { state: true },
    prompt: { state: true },
    effort: { state: true },
    dutiesSet: { state: true },
    engine: { state: true },
    fallback: { state: true },
    nights: { state: true },
    outbound: { state: true },
    showNewEngineForm: { state: true },
    newHarness: { state: true },
    newModel: { state: true },
    newAccountId: { state: true },
    error: { state: true },
    busy: { state: true },
  };

  /** When set, the form edits this employee's configuration instead of hiring someone new. */
  declare employeeId: string | undefined;
  declare team: Employee[];
  declare editing: Employee | null;
  declare perDuty: Partial<Record<Duty, string>>;
  declare extraFallbacks: string[];
  declare engines: Engine[];
  declare accounts: AccountCost[];
  declare name: string;
  declare role: string;
  declare rolePreset: string;
  declare customRole: string;
  declare prompt: string;
  declare effort: Effort;
  declare dutiesSet: Set<Duty>;
  declare engine: string;
  declare fallback: string;
  declare nights: boolean;
  declare outbound: Record<string, Mode>;
  declare showNewEngineForm: boolean;
  declare newHarness: Harness;
  declare newModel: string;
  declare newAccountId: string;
  declare error: string | null;
  declare busy: boolean;

  constructor() {
    super();
    this.engines = [];
    this.accounts = [];
    this.team = [];
    this.editing = null;
    this.perDuty = {};
    this.extraFallbacks = [];
    this.name = "";
    this.rolePreset = "Senior Engineer";
    this.role = "Senior Engineer";
    this.customRole = "";
    this.prompt = defaultPrompts["Senior Engineer"] ?? "";
    this.effort = "medium";
    this.dutiesSet = new Set(defaultDuties["Senior Engineer"] ?? ["build"]);
    this.engine = "";
    this.fallback = "";
    this.nights = false;
    this.outbound = { "send-email": "ask", "calendar-hold": "ask", "accept-invite": "ask" };
    this.showNewEngineForm = false;
    this.newHarness = "claude-code";
    this.newModel = "";
    this.newAccountId = "";
    this.error = null;
    this.busy = false;
  }

  override async connectedCallback(): Promise<void> {
    super.connectedCallback();
    try {
      const [engines, team, accs] = await Promise.all([
        api.engines().catch(() => [] as Engine[]),
        api.employees().catch(() => [] as Employee[]),
        setupApi
          .accounts()
          .then((a) => (Array.isArray(a) ? a : []))
          .catch(() => [] as AccountCost[]),
      ]);
      this.engines = Array.isArray(engines) ? engines : [];
      this.team = Array.isArray(team) ? team : [];
      this.accounts = Array.isArray(accs) ? accs : [];
      if (this.accounts.length && !this.newAccountId) {
        this.newAccountId = this.accounts[0]?.id ?? "";
      }
    } catch {
      // Keep defaults
    }
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
      this.rolePreset = "Senior Engineer";
      this.role = "Senior Engineer";
      this.customRole = "";
      this.prompt = defaultPrompts["Senior Engineer"] ?? "";
      this.effort = "medium";
      this.dutiesSet = new Set(defaultDuties["Senior Engineer"] ?? ["build"]);
      this.engine = "";
      this.fallback = "";
      this.perDuty = {};
      this.extraFallbacks = [];
      return;
    }
    this.name = e.name;
    this.role = e.role;
    const isStandard = standardRoles.includes(e.role as (typeof standardRoles)[number]);
    this.rolePreset = isStandard ? e.role : "custom";
    this.customRole = isStandard ? "" : e.role;
    this.prompt = e.prompt ?? defaultPrompts[e.role] ?? "";
    this.effort = e.effort ?? "medium";
    this.dutiesSet = new Set(e.duties?.length ? e.duties : (defaultDuties[e.role] ?? ["build"]));
    this.engine = e.engines.default;
    this.perDuty = { ...e.engines.perDuty };
    this.fallback = e.engines.fallbacks[0] ?? "";
    this.extraFallbacks = e.engines.fallbacks.slice(1);
  }

  private get pa() {
    return this.role === "Personal Assistant";
  }

  private get roleDuties(): Duty[] {
    const arr = Array.from(this.dutiesSet);
    return (arr.length ? arr : (defaultDuties[this.role] ?? ["build"])) as Duty[];
  }

  private selectRole(r: string) {
    this.rolePreset = r;
    this.engine = "";
    this.fallback = "";
    this.perDuty = {};
    if (r === "custom") {
      this.role = this.customRole.trim() || "Custom Role";
      this.dutiesSet = new Set(["plan", "build", "verify", "review"]);
      if (!this.prompt || Object.values(defaultPrompts).includes(this.prompt)) {
        this.prompt = `You are ${this.role} at i.inc. Define your principles, goals, and execution standards.`;
      }
    } else {
      this.role = r;
      this.dutiesSet = new Set(defaultDuties[r] ?? ["build"]);
      if (!this.prompt || Object.values(defaultPrompts).includes(this.prompt)) {
        this.prompt = defaultPrompts[r] ?? "";
      }
    }
  }

  private onCustomRoleInput(val: string) {
    this.customRole = val;
    this.role = val.trim() || "Custom Role";
  }

  private toggleDuty(d: Duty) {
    const next = new Set(this.dutiesSet);
    if (next.has(d)) {
      if (next.size > 1) next.delete(d); // require at least one duty
    } else {
      next.add(d);
    }
    this.dutiesSet = next;
  }

  private resetPrompt() {
    this.prompt = defaultPrompts[this.role] ?? `You are ${this.role} at i.inc.`;
  }

  private chips(id: string) {
    const e = this.engines.find((x) => x.id === id);
    if (!e) return "";
    return html`<span class="chips"><span class="chip" title="Harness">${e.harness}</span>${
      e.local && e.harness !== "codex"
        ? html`<span class="chip working" title="Runs on this machine">local</span>`
        : ""
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

  private async createCustomEngine() {
    const model = this.newModel.trim();
    if (!model) return;
    this.busy = true;
    this.error = null;
    const harness = this.newHarness;
    const accountId = this.newAccountId || (this.accounts[0]?.id ?? "local");
    const local = engineIsLocal(harness, accountId);
    const id = model
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    try {
      await setupApi.saveEngine({ id, harness, model, accountId, local });
      const updatedEngines = await api.engines().catch(() => [] as Engine[]);
      this.engines = updatedEngines;
      this.engine = id;
      this.showNewEngineForm = false;
      this.newModel = "";
      refreshNow();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy = false;
    }
  }

  private async save(e: Event) {
    if (!this.editing) return this.hire(e);
    e.preventDefault();
    this.busy = true;
    this.error = null;
    try {
      const payload: Partial<Employee> = { engines: this.engineSet() };
      if (this.name && this.name !== this.editing.name) payload.name = this.name;
      if (this.role && this.role !== this.editing.role) payload.role = this.role;
      if (this.prompt && this.prompt !== (this.editing.prompt ?? defaultPrompts[this.editing.role] ?? "")) {
        payload.prompt = this.prompt;
      }
      if (this.effort && this.effort !== (this.editing.effort ?? "medium")) {
        payload.effort = this.effort;
      }
      const currentDuties = this.editing.duties ?? defaultDuties[this.editing.role] ?? ["build"];
      if (this.roleDuties.slice().sort().join(",") !== currentDuties.slice().sort().join(",")) {
        payload.duties = this.roleDuties;
      }
      await api.updateEmployee(this.editing.id, payload);
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
    return this.pa ? this.engines.filter((e) => e.local && e.harness !== "codex") : this.engines;
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
        prompt: this.prompt,
        effort: this.effort,
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
      form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; align-items: start; max-width: 1100px; width: 100%; box-sizing: border-box; }
      .card { padding: 20px 22px; display: flex; flex-direction: column; gap: 14px; min-width: 0; box-sizing: border-box; }
      .wide { grid-column: 1 / -1; }
      label { font-size: 13px; font-weight: 600; color: var(--ink-2); display: flex; flex-direction: column; gap: 6px; min-width: 0; width: 100%; box-sizing: border-box; }
      input[type="text"], select, textarea {
        font: 15px var(--body); min-height: 44px; padding: 10px 12px; border-radius: 10px;
        border: 1px solid var(--line-strong); background: var(--surface); color: var(--ink); box-sizing: border-box;
        width: 100%; max-width: 100%; min-width: 0;
      }
      textarea { font-family: inherit; line-height: 1.5; resize: vertical; min-height: 100px; }
      .pills { display: flex; flex-wrap: wrap; gap: 6px; }
      .pill {
        font: 600 13px var(--body); min-height: 38px; padding: 0 14px; border-radius: 999px; cursor: pointer;
        border: 1px solid var(--line-strong); background: transparent; color: var(--ink); display: inline-flex;
        align-items: center; justify-content: center; transition: all 0.15s ease;
      }
      .pill[aria-pressed="true"], .pill[aria-checked="true"] { background: var(--ink); color: var(--on-ink); border-color: var(--ink); }
      .duties-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 4px; }
      .duty-card {
        display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border: 1px solid var(--line);
        border-radius: 10px; background: var(--surface); cursor: pointer; user-select: none;
      }
      .duty-card input[type="checkbox"] { width: 18px; height: 18px; margin-top: 2px; accent-color: var(--ink); }
      .duty-info { display: flex; flex-direction: column; gap: 2px; }
      .duty-title { font-size: 13px; font-weight: 700; color: var(--ink); }
      .duty-desc { font-size: 11px; color: var(--ink-2); line-height: 1.3; }
      .chips { display: inline-flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
      .duties { min-width: 0; border: 1px solid var(--line); border-radius: 12px; margin: 0; padding: 14px; display: flex; flex-direction: column; gap: 14px; }
      .duties legend { font-size: 13px; font-weight: 700; color: var(--ink-2); padding: 0 6px; }
      .duty-explainer {
        font-size: 12px; color: var(--ink-2); line-height: 1.5; background: var(--sunken);
        padding: 10px 12px; border-radius: 8px; border-left: 3px solid var(--line-strong);
      }
      .duty-explainer p { margin: 0 0 4px 0; }
      .duty-explainer p:last-child { margin: 0; }
      .engine-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
      .engine-header .btn { flex-shrink: 0; }
      .custom-engine-box {
        padding: 14px; border: 1px dashed var(--line-strong); border-radius: 10px; background: var(--sunken);
        display: flex; flex-direction: column; gap: 12px; margin-top: 8px;
        box-sizing: border-box; width: 100%; max-width: 100%; min-width: 0;
      }
      .custom-engine-box h4 { margin: 0; font-size: 14px; color: var(--ink); }
      /* Fields share a row only when each gets 220px; a card narrower than that stacks them. */
      .custom-engine-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 10px; width: 100%; min-width: 0; box-sizing: border-box; }
      .custom-engine-grid > * { min-width: 0; }
      .custom-engine-grid label { width: 100%; min-width: 0; box-sizing: border-box; }
      .custom-engine-grid input, .custom-engine-grid select { width: 100%; max-width: 100%; min-width: 0; }
      .custom-engine-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 4px; }
      .note-link { display: inline-flex; align-items: center; }
      .team { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
      .team li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0; border-top: 1px solid var(--line); }
      .team li:first-child { border-top: none; }
      .team a.btn { text-decoration: none; display: inline-flex; align-items: center; min-height: 44px; padding: 0 16px; font-size: 14px; }
      .submit a.btn { text-decoration: none; display: inline-flex; align-items: center; min-height: 44px; padding: 0 20px; }
      .note { font-size: 13px; color: var(--ink-2); background: var(--sunken); border-radius: 12px; padding: 10px 12px; }
      .rows { display: grid; grid-template-columns: 200px auto minmax(0, 1fr); gap: 8px 16px; align-items: center; font-size: 14px; }
      .seg { display: flex; border: 1px solid var(--line-strong); border-radius: 999px; overflow: hidden; }
      .seg button { font: 600 13px var(--body); min-height: 36px; padding: 0 14px; border: none; background: transparent; color: var(--ink); cursor: pointer; }
      .seg button[aria-pressed="true"] { background: var(--ink); color: var(--on-ink); }
      .check { flex-direction: row; align-items: center; gap: 8px; font-size: 15px; color: var(--ink); min-height: 44px; }
      .check input { width: 20px; height: 20px; }
      .submit { display: flex; align-items: center; gap: 16px; margin-top: 8px; }
      .btn.small { min-height: 32px; padding: 0 10px; font-size: 12px; }
      .err { color: var(--bar-crit, #d32f2f); font-size: 13px; }
      .switching-explainer { font-size: 12px; color: var(--ink-2); line-height: 1.4; }
      @media (max-width: 800px) {
        form { grid-template-columns: minmax(0, 1fr); }
        .rows { grid-template-columns: 1fr; }
        .card { padding: 18px; }
        .pill { min-height: 44px; padding: 0 16px; }
        .seg { width: 100%; }
        .seg button { flex: 1; min-height: 44px; }
        .duties-grid { grid-template-columns: 1fr; }
        .rows .muted { margin-bottom: 8px; }
        .submit { flex-wrap: wrap; }
        .submit .btn { flex: 1 1 auto; }
      }
      /* Phone: every control in the engine creator and prompt block is a 44px target (docs/layout.md). */
      @media (max-width: ${LAYOUT_BREAKPOINTS.phone}px) {
        .btn.small { min-height: 44px; padding: 0 16px; font-size: 14px; }
        .note-link { display: flex; min-height: 44px; padding: 0; }
        .engine-header { flex-wrap: wrap; gap: 8px; }
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
      <section class="card">
        <h2>${editing ? `Edit ${editing.name}` : "Who & Role"}</h2>
        <label>Name <input type="text" required autocomplete="off" autocapitalize="words" enterkeyhint="done" .value=${this.name}
          @input=${(e: InputEvent) => {
            this.name = (e.target as HTMLInputElement).value;
          }}></label>

        <div>
          <span style="font-size:13px;font-weight:600;color:var(--ink-2);display:block;margin-bottom:6px">Role</span>
          <div class="pills" role="group" aria-label="Role">
            ${standardRoles.map(
              (
                r,
              ) => html`<button type="button" class="pill" aria-pressed=${r === this.rolePreset ? "true" : "false"}
                @click=${() => this.selectRole(r)}>${r}</button>`,
            )}
            <button type="button" class="pill" aria-pressed=${this.rolePreset === "custom" ? "true" : "false"}
              @click=${() => this.selectRole("custom")}>+ Custom Role</button>
          </div>
        </div>

        ${
          this.rolePreset === "custom"
            ? html`<label>Custom Role Title
                <input type="text" placeholder="e.g. Chief Executive Officer, Security Lead" .value=${this.customRole}
                  @input=${(e: Event) => this.onCustomRoleInput((e.target as HTMLInputElement).value)} />
              </label>`
            : ""
        }

        <label>
          <span>System prompt & role instructions</span>
          <span class="muted" style="font-size:12px;font-weight:normal">
            Defines how this agent reasons, makes decisions, and prioritizes work in chat, planning, and task execution.
          </span>
          <textarea rows="5" .value=${this.prompt} @input=${(e: Event) => {
            this.prompt = (e.target as HTMLTextAreaElement).value;
          }}></textarea>
        </label>
        <div style="display:flex;justify-content:flex-end">
          <button type="button" class="btn ghost small" @click=${() => this.resetPrompt()}>Reset prompt to role default</button>
        </div>

        <div>
          <span style="font-size:13px;font-weight:600;color:var(--ink-2);display:block">Pipeline Duties</span>
          <span class="muted" style="font-size:12px;font-weight:normal;display:block;margin-bottom:6px">
            Which stages of the company's development loop this employee can perform.
          </span>
          <div class="duties-grid">
            ${(["plan", "build", "verify", "review"] as Duty[]).map(
              (d) => html`<div class="duty-card" @click=${() => this.toggleDuty(d)}>
                <input type="checkbox" .checked=${this.dutiesSet.has(d)} @click=${(e: Event) => e.stopPropagation()} @change=${() => this.toggleDuty(d)} />
                <div class="duty-info">
                  <span class="duty-title">${dutyDescriptions[d].title}</span>
                  <span class="duty-desc">${dutyDescriptions[d].desc}</span>
                </div>
              </div>`,
            )}
          </div>
        </div>
      </section>

      <section class="card">
        <h2>Engines & Execution</h2>
        <div class="engine-header">
          <span style="font-weight:600;font-size:13px;color:var(--ink-2)">
            ${this.roleDuties.length > 1 ? "Default engine" : "Engine"}
          </span>
          <button type="button" class="btn ghost small" @click=${() => {
            this.showNewEngineForm = !this.showNewEngineForm;
          }}>
            ${this.showNewEngineForm ? "✕ Close" : "+ Configure new engine / model"}
          </button>
        </div>

        ${
          this.showNewEngineForm
            ? html`<div class="custom-engine-box">
                <h4>Configure new model or engine</h4>
                <div class="custom-engine-grid">
                  <label>Harness
                    <select .value=${this.newHarness} @change=${(e: Event) => {
                      this.newHarness = (e.target as HTMLSelectElement).value as Harness;
                    }}>
                      ${harnessOptions.map(({ value, label }) => html`<option value=${value}>${label}</option>`)}
                    </select>
                  </label>
                  <label>Model ID
                    <input type="text" placeholder="Enter a model ID supported by this provider" .value=${this.newModel}
                      @input=${(e: Event) => {
                        this.newModel = (e.target as HTMLInputElement).value;
                      }} />
                  </label>
                  <label>Account
                    <select .value=${this.newAccountId} @change=${(e: Event) => {
                      this.newAccountId = (e.target as HTMLSelectElement).value;
                    }}>
                      ${
                        this.accounts.length
                          ? this.accounts.map((a) => html`<option value=${a.id}>${a.name || a.id}</option>`)
                          : html`<option value="default">Default account</option>`
                      }
                    </select>
                  </label>
                </div>
                ${this.newHarness === "codex" ? html`<p class="note">Codex signs in on each team sandbox using a host helper. i.inc never asks for a Codex token. <a class="note-link" href="https://github.com/firstprateek/i-inc/blob/main/docs/codex.md" target="_blank" rel="noreferrer">Owner sign-in instructions</a></p>` : ""}
                <div class="custom-engine-actions">
                  <button type="button" class="btn small" ?disabled=${!this.newModel.trim() || this.busy} @click=${() => this.createCustomEngine()}>
                    ${this.busy ? "Saving…" : "Save & select engine"}
                  </button>
                  <button type="button" class="btn ghost small" @click=${() => {
                    this.showNewEngineForm = false;
                  }}>
                    Cancel
                  </button>
                </div>
              </div>`
            : ""
        }

        ${this.picker(
          this.roleDuties.length > 1 ? "Default engine" : "Engine",
          this.engine,
          (id) => {
            this.engine = id;
          },
          "Choose an engine",
        )}

        <div>
          <span style="font-size:13px;font-weight:600;color:var(--ink-2);display:block">Default effort level</span>
          <span class="muted" style="font-size:12px;font-weight:normal;display:block;margin-bottom:6px">Sets reasoning depth and gating rules for assigned tickets.</span>
          <div class="pills" role="radiogroup" aria-label="Default effort level">
            ${(["low", "medium", "high"] as const).map(
              (eff) => html`<button type="button" class="pill" role="radio"
                aria-checked=${this.effort === eff ? "true" : "false"}
                aria-pressed=${this.effort === eff ? "true" : "false"}
                @click=${() => {
                  this.effort = eff;
                }}>
                <b>${eff.charAt(0).toUpperCase() + eff.slice(1)}</b>
                <span class="muted" style="font-size:11px;margin-left:4px">
                  ${eff === "low" ? "(fast / chore)" : eff === "medium" ? "(balanced)" : "(deep / gated)"}
                </span>
              </button>`,
            )}
          </div>
        </div>

        ${
          this.roleDuties.length > 1 || Object.keys(this.perDuty).length
            ? html`<fieldset class="duties">
              <legend>Engine per duty</legend>
              <div class="duty-explainer">
                <p><strong>How pipeline duties work:</strong> Tickets in i.inc flow through four stages: <strong>Plan → Build → Verify → Review</strong>.</p>
                <p class="muted">By default, your employee uses the primary engine for all stages. You can optionally assign specialized engines per stage below (e.g. Claude Opus or Gemini Pro for planning, and a faster engine for verification).</p>
              </div>
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

        <div class="switching-explainer">
          <span><b>Model Switching Rules:</b> When out of tokens or stuck on checks, i.inc automatically pauses or cascades to the fallback engine. You can also specify fine-grained model-switching guidelines in the system prompt above.</span>
        </div>

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
