// Hiring (spec §5, design case 7): a name, a role, an engine, the projects and the working hours; the rest
// is folded under "More settings". For a PA, also what may leave the house.

import type { Duty, Effort, Employee, OutboundAction, OutboundRule, OutboundSetting } from "@i-inc/core";
import { css, html, LitElement } from "lit";
import { api, refreshNow } from "../api.ts";
import { type Engine, engineLabel, setupApi, type Team } from "../setup-api.ts";
import { LAYOUT_BREAKPOINTS } from "./layout.ts";
import { base } from "./shared.ts";

/** The spec's roles (§5 "What you set when hiring"), Senior Engineer first as the default. */
export const standardRoles = [
  "Senior Engineer",
  "Staff Engineer",
  "Principal Engineer",
  "Product Manager",
  "UX Designer",
  "QA",
  "Personal Assistant",
] as const;

/** Each role's default duties (spec §5 "Roles and duties"). */
export const defaultDuties: Record<string, Duty[]> = {
  "Senior Engineer": ["build", "review", "verify"],
  "Staff Engineer": ["plan", "review"],
  "Principal Engineer": ["plan", "review"],
  "Product Manager": ["plan"],
  "UX Designer": ["build", "review"],
  QA: ["verify"],
  "Personal Assistant": ["build"],
};

export const defaultPrompts: Record<string, string> = {
  "Senior Engineer": `You are a Senior Engineer at i.inc. You write clean, robust, and well-tested code. You keep diffs focused, maintain backward compatibility, handle edge cases and errors gracefully, and ensure all checks and tests pass with high standards.`,
  "Staff Engineer": `You are a Staff Engineer at i.inc. You focus on system architecture, technical leverage, cross-team design patterns, and high-leverage refactors. You spot structural problems early, define clear contracts, and guide engineering quality.`,
  "Principal Engineer": `You are a Principal Engineer at i.inc. You own the architecture across projects. You review plans and risky changes for long-term cost, write design docs that settle hard trade-offs, and keep the system simple enough to change.`,
  "Product Manager": `You are a Product Manager at i.inc. You champion the user experience and business outcomes. You turn ambiguity into actionable tickets with clear acceptance criteria (Done when), manage scope ruthlessly, and validate that finished work solves the actual user need.`,
  "UX Designer": `You are a UX Designer at i.inc. You design intuitive, accessible, and responsive user experiences. You enforce high contrast, touch targets (≥44px), keyboard navigation, calm visual hierarchy, and delightful design details across desktop and mobile.`,
  QA: `You are a QA Engineer at i.inc. You find failure modes before users do. You write rigorous automated test suites, verify edge cases, simulate network/token failures, and ensure regression-proof reliability.`,
  "Personal Assistant": `You are a Personal Assistant at i.inc. You manage calendar holds, email drafting, and daily errands with extreme privacy and precision. You never execute external commitments without explicit confirmation, and you keep communications courteous, concise, and helpful.`,
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

/** The duties, in the order the form lists them. */
const dutyList: Duty[] = ["plan", "build", "verify", "review", "librarian"];

/** A duty's name in the form: the stage's name, so `verify` reads Prove (spec §6). The id stays. */
export const dutyNames: Record<Duty, string> = {
  plan: "Plan",
  build: "Build",
  verify: "Prove",
  review: "Review",
  librarian: "Librarian",
};

/** A model that runs on a local pool (Codex runs in the machine but signs in to an account). */
const localModel = (e: Engine) => e.local && e.harness !== "codex";

export class IncHiring extends LitElement {
  static override properties = {
    employeeId: { type: String },
    team: { state: true },
    teams: { state: true },
    selectedTeamId: { state: true },
    perDuty: { state: true },
    extraFallbacks: { state: true },
    engines: { state: true },
    projects: { state: true },
    picked: { state: true },
    name: { state: true },
    role: { state: true },
    rolePreset: { state: true },
    customRole: { state: true },
    prompt: { state: true },
    effort: { state: true },
    dutiesSet: { state: true },
    dutyNote: { state: true },
    engine: { state: true },
    fallback: { state: true },
    nights: { state: true },
    outbound: { state: true },
    error: { state: true },
    busy: { state: true },
  };

  /** When set, the form edits this employee's configuration instead of hiring someone new. */
  declare employeeId: string | undefined;
  declare team: Employee[];
  declare teams: Team[];
  declare selectedTeamId: string;
  declare editing: Employee | null;
  declare perDuty: Partial<Record<Duty, string>>;
  declare extraFallbacks: string[];
  declare engines: Engine[];
  /** The company's projects, in the order `GET /api/projects` lists them. */
  declare projects: string[];
  /** The projects ticked. None means every project (`Employee.projects` absent). */
  declare picked: Set<string>;
  declare name: string;
  declare role: string;
  declare rolePreset: string;
  declare customRole: string;
  declare prompt: string;
  declare effort: Effort;
  declare dutiesSet: Set<Duty>;
  /** Why the last duty could not be unchecked; empty otherwise. Read out as a status. */
  declare dutyNote: string;
  declare engine: string;
  declare fallback: string;
  declare nights: boolean;
  declare outbound: Record<string, Mode>;
  declare error: string | null;
  declare busy: boolean;

  constructor() {
    super();
    this.engines = [];
    this.projects = [];
    this.picked = new Set();
    this.team = [];
    this.teams = [];
    this.selectedTeamId = "";
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
    this.dutyNote = "";
    this.engine = "";
    this.fallback = "";
    this.nights = false;
    this.outbound = { "send-email": "ask", "calendar-hold": "ask", "accept-invite": "ask" };
    this.error = null;
    this.busy = false;
  }

  override async connectedCallback(): Promise<void> {
    super.connectedCallback();
    try {
      const [engines, team, teams, projects] = await Promise.all([
        api.engines().catch(() => [] as Engine[]),
        api.employees().catch(() => [] as Employee[]),
        setupApi.teams().catch(() => [] as Team[]),
        api.projects().catch(() => [] as { id: string }[]),
      ]);
      this.engines = Array.isArray(engines) ? engines : [];
      this.team = Array.isArray(team) ? team : [];
      this.teams = Array.isArray(teams) ? teams : [];
      this.projects = Array.isArray(projects) ? projects.map((p) => p.id) : [];
      if (this.openTeams.length === 1) this.selectedTeamId = this.openTeams[0]?.id ?? "";
    } catch {
      // Keep defaults
    }
    this.load();
    // A new hire starts on an engine, so a name is all Hire waits for.
    if (!this.editing && !this.engine) this.engine = this.firstEngine();
  }

  override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("employeeId")) this.load();
  }

  /** Fills the form from the employee being edited. */
  private load() {
    const e = this.employeeId ? this.team.find((x) => x.id === this.employeeId) : undefined;
    if (e === (this.editing ?? undefined)) return;
    this.editing = e ?? null;
    this.selectedTeamId =
      this.teams.find((team) => e && team.members.includes(e.id))?.id ??
      (this.openTeams.length === 1 ? (this.openTeams[0]?.id ?? "") : "");
    if (!e) {
      // Back from an edit to a blank hire.
      this.name = "";
      this.rolePreset = "Senior Engineer";
      this.role = "Senior Engineer";
      this.customRole = "";
      this.prompt = defaultPrompts["Senior Engineer"] ?? "";
      this.effort = "medium";
      this.dutiesSet = new Set(defaultDuties["Senior Engineer"] ?? ["build"]);
      this.engine = this.firstEngine();
      this.fallback = "";
      this.perDuty = {};
      this.extraFallbacks = [];
      this.picked = new Set();
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
    this.picked = new Set(e.projects ?? []);
  }

  private get pa() {
    return this.role === "Personal Assistant";
  }

  /** The engine a new hire starts on: the first that isn't a local model, or for a PA the first local one. */
  private firstEngine(): string {
    const choices = this.choices;
    return (this.pa ? choices[0] : (choices.find((e) => !localModel(e)) ?? choices[0]))?.id ?? "";
  }

  private get roleDuties(): Duty[] {
    const arr = Array.from(this.dutiesSet);
    return (arr.length ? arr : (defaultDuties[this.role] ?? ["build"])) as Duty[];
  }

  private selectRole(r: string) {
    this.rolePreset = r;
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
    // The engine stays if the new role may use it; a PA may only use local ones (spec §7).
    if (!this.choices.some((e) => e.id === this.engine)) this.engine = this.firstEngine();
  }

  private onCustomRoleInput(val: string) {
    this.customRole = val;
    this.role = val.trim() || "Custom Role";
  }

  private toggleDuty(d: Duty): boolean {
    const next = new Set(this.dutiesSet);
    if (next.has(d)) {
      // An employee needs at least one duty: the last one stays, and the form says why.
      if (next.size <= 1) {
        this.dutyNote = `${dutyNames[d]} stays on: an employee needs at least one duty.`;
        return false;
      }
      next.delete(d);
    } else {
      next.add(d);
    }
    this.dutyNote = "";
    this.dutiesSet = next;
    return true;
  }

  /** A duty checkbox changed. A refused change puts the box back, since the browser already flipped it. */
  private onDutyChange(d: Duty, e: Event): void {
    this.toggleDuty(d);
    (e.target as HTMLInputElement).checked = this.dutiesSet.has(d);
  }

  private onProjectChange(id: string, e: Event): void {
    const next = new Set(this.picked);
    if ((e.target as HTMLInputElement).checked) next.add(id);
    else next.delete(id);
    this.picked = next;
  }

  /** The ticked projects in the company's order, plus any the employee has that the list no longer shows. */
  private pickedProjects(): string[] {
    return [
      ...this.projects.filter((p) => this.picked.has(p)),
      ...[...this.picked].filter((p) => !this.projects.includes(p)),
    ];
  }

  private resetPrompt() {
    this.prompt = defaultPrompts[this.role] ?? `You are ${this.role} at i.inc.`;
  }

  private chips(id: string) {
    const e = this.engines.find((x) => x.id === id);
    if (!e) return "";
    return html`<span class="chips"><span class="chip" title="Harness">${e.harness}</span>${
      localModel(e) ? html`<span class="chip working" title="Runs on this machine">local</span>` : ""
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
      const payload: Partial<Employee> & { teamId?: string } = { engines: this.engineSet() };
      // A PA works alone in a sandbox of its own: the daemon keeps or makes its team, so none is sent.
      if (this.selectedTeamId && !this.pa) payload.teamId = this.selectedTeamId;
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
      // Projects go only when some are ticked and they changed: none ticked can't be sent as "every project".
      const projects = this.pickedProjects();
      const had = this.editing.projects ?? [];
      if (!this.pa && projects.length && projects.slice().sort().join(",") !== had.slice().sort().join(",")) {
        payload.projects = projects;
      }
      await api.updateEmployee(this.editing.id, payload);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.busy = false;
      return;
    }
    this.busy = false;
    refreshNow();
    location.hash = "#/company/team";
  }

  /** The teams a person can be put in: a PA's home team is its own, nobody else's. */
  private get openTeams(): Team[] {
    const pas = new Set(this.team.filter((e) => e.role === "Personal Assistant").map((e) => e.id));
    return this.teams.filter((t) => !t.members.some((m) => pas.has(m)));
  }

  /** A PA works on home data, so only local engines are offered (spec §7). */
  private get choices() {
    return this.pa ? this.engines.filter(localModel) : this.engines;
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
    // None ticked means every project, which is `projects` left out. A PA works on Home.
    const projects = this.pa ? [] : this.pickedProjects();
    try {
      await api.hire({
        name: this.name,
        role: this.role,
        duties: this.roleDuties,
        prompt: this.prompt,
        effort: this.effort,
        engines: this.engineSet(),
        ...(projects.length ? { projects } : {}),
        ...(this.selectedTeamId && !this.pa ? { teamId: this.selectedTeamId } : {}),
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
    location.hash = "#/company/team";
  }

  static override styles = [
    base,
    css`
      form { display: flex; flex-direction: column; gap: 18px; max-width: var(--page-width, 840px); width: 100%; box-sizing: border-box; }
      .card { padding: 20px 22px; display: flex; flex-direction: column; gap: 18px; min-width: 0; box-sizing: border-box; }
      label { font-size: 13px; font-weight: 600; color: var(--ink-2); display: flex; flex-direction: column; gap: 6px; min-width: 0; width: 100%; box-sizing: border-box; }
      input[type="text"], select, textarea {
        font: 16px var(--body); min-height: 44px; padding: 10px 12px; border-radius: 10px;
        border: 1px solid var(--control-edge); background: var(--surface); color: var(--ink); box-sizing: border-box;
        width: 100%; max-width: 100%; min-width: 0;
      }
      textarea { font-family: inherit; line-height: 1.5; resize: vertical; min-height: 100px; }
      /* A group of controls under one name. Browsers give a fieldset a margin and a min-width of its
         content; both are undone so its controls stay inside the card. */
      fieldset { border: 0; margin: 0; padding: 0; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
      legend, .field-name { padding: 0; margin: 0 0 6px; font-size: 13px; font-weight: 600; color: var(--ink-2); }
      .pills { display: flex; flex-wrap: wrap; gap: 6px; }
      .pill {
        font: 600 13px var(--body); min-height: 44px; padding: 0 14px; border-radius: 999px; cursor: pointer;
        border: 1px solid var(--line-strong); background: transparent; color: var(--ink); display: inline-flex;
        align-items: center; justify-content: center; transition: all 0.15s ease;
      }
      .pill[aria-pressed="true"], .pill[aria-checked="true"] { background: var(--ink); color: var(--on-ink); border-color: var(--ink); }
      .boxes { display: flex; flex-wrap: wrap; gap: 8px; }
      /* A checkbox row: the whole label is the 44px target. It undoes the form's label layout. */
      .box {
        flex-direction: row; align-items: center; gap: 10px; min-height: 44px; padding: 0 14px 0 12px; width: auto; max-width: 100%;
        border: 1px solid var(--line); border-radius: 10px; background: var(--surface);
        font-size: 14px; font-weight: 600; color: var(--ink); cursor: pointer; user-select: none;
      }
      .box:has(input:focus-visible) { outline: 3px solid var(--reviewing-mark); outline-offset: 2px; }
      .box input[type="checkbox"] { width: 20px; height: 20px; margin: 0; flex: none; accent-color: var(--ink); }
      .box span { min-width: 0; overflow-wrap: anywhere; }
      .hint { margin: 0; font-size: 13px; color: var(--ink-2); }
      .duty-note { margin: 0; font-size: 13px; color: var(--ink-2); }
      .duty-note:empty { display: none; }
      .chips { display: inline-flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
      .engine-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
      .field-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
      .field-head .field-name { margin: 0; }
      .engine-link { font-size: 13px; font-weight: 600; color: var(--ink); }
      .engine-field .chips { margin-top: 0; }
      .card.more { padding: 0; display: block; }
      .more > summary {
        min-height: 44px; display: flex; align-items: center; gap: 8px; padding: 0 22px; cursor: pointer;
        font: 600 15px var(--body); color: var(--ink); list-style: none;
      }
      .more > summary::-webkit-details-marker { display: none; }
      .more > summary::before { content: "›"; display: inline-block; transition: transform 0.15s ease; }
      .more[open] > summary::before { transform: rotate(90deg); }
      .more-body { padding: 4px 22px 22px; display: flex; flex-direction: column; gap: 18px; }
      .per-duty { gap: 12px; }
      .reset { align-self: flex-end; }
      .note { font-size: 13px; color: var(--ink-2); background: var(--sunken); border-radius: 12px; padding: 10px 12px; margin: 0; }
      .rows { display: grid; grid-template-columns: 200px auto minmax(0, 1fr); gap: 8px 16px; align-items: center; font-size: 14px; }
      .seg { display: flex; border: 1px solid var(--line-strong); border-radius: 999px; overflow: hidden; }
      .seg button { font: 600 13px var(--body); min-height: 36px; padding: 0 14px; border: none; background: transparent; color: var(--ink); cursor: pointer; }
      .seg button[aria-pressed="true"] { background: var(--ink); color: var(--on-ink); }
      .submit { display: flex; align-items: center; gap: 16px; }
      .submit a.btn { text-decoration: none; display: inline-flex; align-items: center; min-height: 44px; padding: 0 20px; }
      .btn.small { min-height: 32px; padding: 0 10px; font-size: 12px; }
      @media (max-width: 800px) {
        .rows { grid-template-columns: 1fr; }
        .card { padding: 18px; gap: 16px; }
        .more > summary { padding: 0 18px; }
        .more-body { padding: 4px 18px 18px; }
        .pill { min-height: 44px; padding: 0 16px; }
        .seg { width: 100%; }
        .seg button { flex: 1; min-height: 44px; }
        .rows .muted { margin-bottom: 8px; }
        .submit { flex-wrap: wrap; }
        .submit .btn { flex: 1 1 auto; }
      }
      /* Phone: every control is a 44px target (docs/layout.md). */
      @media (max-width: ${LAYOUT_BREAKPOINTS.phone}px) {
        .btn.small { min-height: 44px; padding: 0 16px; font-size: 14px; }
        .engine-link { display: inline-flex; align-items: center; min-height: 44px; }
      }
    `,
  ];

  private picker(label: string, value: string, onPick: (id: string) => void, blank: string, skip?: string) {
    return html`<label><span>${label}</span>
      <select data-value=${value} ?required=${!blank.length} @change=${(e: Event) => onPick((e.target as HTMLSelectElement).value)}>
        ${blank ? html`<option value="">${blank}</option>` : ""}
        ${(this.choices ?? []).filter((e) => e.id !== skip).map((e) => html`<option value=${e.id}>${engineLabel(e)}</option>`)}
      </select>
      ${this.chips(value)}
    </label>`;
  }

  private projectsField() {
    if (this.pa) {
      return html`<div><span class="field-name">Projects</span><p class="hint">Home</p></div>`;
    }
    return html`<fieldset>
      <legend>Projects</legend>
      ${
        this.projects.length
          ? html`<div class="boxes">
              ${this.projects.map(
                (p) => html`<label class="box">
                  <input type="checkbox" name="project" value=${p} .checked=${this.picked.has(p)}
                    @change=${(e: Event) => this.onProjectChange(p, e)} />
                  <span>${p}</span>
                </label>`,
              )}
            </div>`
          : ""
      }
      ${this.picked.size ? "" : html`<p class="hint">None ticked: every project.</p>`}
    </fieldset>`;
  }

  /** Everything past the three choices: closed for a new hire, open when editing (it holds the engines). */
  private moreSettings(editing: Employee | null) {
    const fallbackEngines = this.extraFallbacks.map(
      (id) => this.engines.find((e) => e.id === id)?.model ?? id,
    );
    return html`<details class="card more" ?open=${!!editing}>
      <summary>More settings</summary>
      <div class="more-body">
        <fieldset class="duty-set">
          <legend>Duties</legend>
          <div class="boxes">
            ${dutyList.map(
              (d) => html`<label class="box duty-card">
                <input type="checkbox" name="duty-${d}" .checked=${this.dutiesSet.has(d)} @change=${(e: Event) => this.onDutyChange(d, e)} />
                <span class="duty-title">${dutyNames[d]}</span>
              </label>`,
            )}
          </div>
          <p class="duty-note" role="status">${this.dutyNote}</p>
        </fieldset>

        ${
          this.roleDuties.length > 1 || Object.keys(this.perDuty).length
            ? html`<fieldset class="duties per-duty">
              <legend>Engine per duty</legend>
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
                  "Same as the engine",
                ),
              )}
            </fieldset>`
            : ""
        }

        ${this.picker(
          "If it runs out of tokens or gets stuck",
          this.fallback,
          (id) => {
            this.fallback = id;
          },
          "Wait",
          this.engine,
        )}
        ${fallbackEngines.length ? html`<span class="hint">Then: ${fallbackEngines.join(", ")}</span>` : ""}

        <div>
          <span class="field-name" id="effort-name">Default effort</span>
          <div class="pills" role="radiogroup" aria-labelledby="effort-name">
            ${(["low", "medium", "high"] as const).map(
              (eff) => html`<button type="button" class="pill" role="radio"
                aria-checked=${this.effort === eff ? "true" : "false"}
                @click=${() => {
                  this.effort = eff;
                }}>${eff.charAt(0).toUpperCase() + eff.slice(1)}</button>`,
            )}
          </div>
        </div>

        <label>
          <span>Role prompt</span>
          <textarea rows="5" .value=${this.prompt} @input=${(e: Event) => {
            this.prompt = (e.target as HTMLTextAreaElement).value;
          }}></textarea>
        </label>
        <button type="button" class="btn ghost small reset" @click=${() => this.resetPrompt()}>Reset to the role's default</button>
      </div>
    </details>`;
  }

  override render() {
    const editing = this.editing;
    const choices = this.choices ?? [];
    const known = choices.some((e) => e.id === this.engine);

    return html`<form @submit=${this.save} aria-label=${editing ? `Edit ${editing.name}` : "Hire someone"}>
      <section class="card">
        <h2>${editing ? `Edit ${editing.name}` : "Hire someone"}</h2>
        <label>Name <input type="text" required autocomplete="off" autocapitalize="words" enterkeyhint="done" .value=${this.name}
          @input=${(e: InputEvent) => {
            this.name = (e.target as HTMLInputElement).value;
          }}></label>

        <div>
          <span class="field-name" id="role-name">Role</span>
          <div class="pills" role="group" aria-labelledby="role-name">
            ${standardRoles.map(
              (
                r,
              ) => html`<button type="button" class="pill" aria-pressed=${r === this.rolePreset ? "true" : "false"}
                @click=${() => this.selectRole(r)}>${r}</button>`,
            )}
            <button type="button" class="pill" aria-pressed=${this.rolePreset === "custom" ? "true" : "false"}
              @click=${() => this.selectRole("custom")}>Write a role…</button>
          </div>
        </div>

        ${
          this.rolePreset === "custom"
            ? html`<label>Role name
                <input type="text" class="custom-role" placeholder="e.g. Security Lead" .value=${this.customRole}
                  @input=${(e: Event) => this.onCustomRoleInput((e.target as HTMLInputElement).value)} />
              </label>`
            : ""
        }

        <div class="engine-field">
          <div class="field-head">
            <span class="field-name" id="engine-name">Engine</span>
            <a class="engine-link" href="#/company/settings/engines">Add an engine in Settings</a>
          </div>
          <select aria-labelledby="engine-name" data-value=${this.engine} ?required=${!known} @change=${(
            e: Event,
          ) => {
            this.engine = (e.target as HTMLSelectElement).value;
          }}>
            ${known ? "" : html`<option value="">Choose an engine</option>`}
            ${choices.map((e) => html`<option value=${e.id}>${engineLabel(e)}</option>`)}
          </select>
          ${this.chips(this.engine)}
        </div>
        ${
          this.pa
            ? html`<p class="note">Home data only goes to local engines, and a personal assistant's sandbox has no internet, so only local engines are offered.${
                choices.length === 0
                  ? " No local engine is set up yet: add one in Settings (OpenCode on Ollama) first."
                  : ""
              }</p>`
            : ""
        }

        ${this.projectsField()}

        ${
          editing
            ? ""
            : html`<div>
                <span class="field-name" id="hours-name">Working hours</span>
                <div class="pills" role="group" aria-labelledby="hours-name">
                  <button type="button" class="pill" aria-pressed=${this.nights ? "false" : "true"} @click=${() => {
                    this.nights = false;
                  }}>Any time</button>
                  <button type="button" class="pill" aria-pressed=${this.nights ? "true" : "false"} @click=${() => {
                    this.nights = true;
                  }}>Nights only (10 pm to 7 am)</button>
                </div>
              </div>`
        }

        ${
          this.pa
            ? html`<p class="note">A personal assistant works in a sandbox of its own, because it handles home data. i.inc sets one up.</p>`
            : this.openTeams.length > 1
              ? html`<label>Team
          <select aria-label="Team" data-value=${this.selectedTeamId}
            @change=${(e: Event) => {
              this.selectedTeamId = (e.target as HTMLSelectElement).value;
            }}>
            <option value="">Choose a team</option>
            ${this.openTeams.map((team) => html`<option value=${team.id}>${team.name}</option>`)}
          </select>
        </label>`
              : ""
        }
      </section>

      ${
        this.pa && !editing
          ? html`<section class="card">
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

      ${this.moreSettings(editing)}

      <div class="submit">
        <button class="btn" type="submit" ?disabled=${this.busy || !this.name.trim() || !this.engine || (!this.pa && this.openTeams.length > 1 && !this.selectedTeamId)}>${
          editing ? "Save engines" : `Hire ${this.name.trim() || "them"}`
        }</button>
        ${editing ? html`<a class="btn ghost" href="#/company/team/hiring">Cancel</a>` : ""}
        ${this.error ? html`<span role="alert">${this.error}</span>` : ""}
      </div>
    </form>`;
  }
}

customElements.define("inc-hiring", IncHiring);
