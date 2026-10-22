// The New conversation screen, like Claude's chat: one centred composer with the pickers for who it is with,
// which project, and the permission mode. It is also the view when no conversation is selected. Nothing is
// created until the first message is sent. The first-run checklist sits below the composer, so it can appear
// after it has loaded without moving anything above it.
import type { Employee } from "@i-inc/core";
import { css, html, LitElement, nothing } from "lit";
import {
  draftModePicker,
  type LastUsed,
  lastUsed,
  rememberLastUsed,
  rememberMode,
} from "../conversations/prefs.ts";
import { cardStyles } from "../conversations/styles.ts";
import type { SendDetail } from "./conv-composer.ts";
import { base, selectField } from "./shared.ts";
import "./conv-composer.ts";
import "./getting-started.ts";

export interface DraftPick {
  employee: string;
  project: string;
}

/** What the screen is showing: who, which project, and what to tell the owner about an address it could not honour. */
export interface DraftChoice extends DraftPick {
  note: string;
}

const NO_EMPLOYEE = "That employee isn't available.";
const NO_PROJECT =
  "That project isn't available — starting without a project. Pick one below if you want one.";

/** The projects an employee works on (all of them when the employee has no list). */
export const projectChoices = (employees: Employee[], projects: string[], employee: string): string[] => {
  const e = employees.find((x) => x.id === employee);
  return e?.projects?.length ? e.projects : projects;
};

/**
 * The employee and project a new conversation starts with. An address that names them wins (and is told so
 * when it names one that is not there); otherwise the ones used last; otherwise the first employee and no
 * project. Until the employees and projects have arrived the address is shown as it is.
 */
export function resolveDraft(
  preset: DraftPick,
  employees: Employee[],
  projects: string[],
  last: LastUsed,
  ready: boolean,
): DraftChoice {
  if (!ready) return { employee: preset.employee, project: preset.project, note: "" };
  const notes: string[] = [];
  const known = (id: string) => employees.some((e) => e.id === id);
  let employee = "";
  if (preset.employee) {
    if (known(preset.employee)) employee = preset.employee;
    else notes.push(NO_EMPLOYEE);
  }
  if (!employee && preset.project && projects.includes(preset.project)) {
    // An employee who works on the project the address names.
    employee = employees.find((e) => !e.projects?.length || e.projects.includes(preset.project))?.id ?? "";
  }
  if (!employee) employee = known(last.employee) ? last.employee : (employees[0]?.id ?? "");
  const choices = projectChoices(employees, projects, employee);
  // An address that names an employee or a project says which project; one that names neither takes the last used.
  const named = !!(preset.employee || preset.project);
  const want = named ? preset.project : last.project;
  const project = want && choices.includes(want) ? want : "";
  if (named && preset.project && !project) notes.push(NO_PROJECT);
  return { employee, project, note: notes.join(" ") };
}

export class IncConvDraft extends LitElement {
  static override properties = {
    employees: { attribute: false },
    projects: { attribute: false },
    preset: { attribute: false },
    ready: { type: Boolean },
    phone: { type: Boolean },
    back: { type: Boolean },
    onCreate: { attribute: false },
    pickEmployee: { state: true },
    pickProject: { state: true },
    pickMode: { state: true },
    note: { state: true },
  };
  declare employees: Employee[];
  declare projects: string[];
  /** What the address asked for; empty fields mean "the last used". */
  declare preset: DraftPick | undefined;
  /** The employees and projects have arrived, so the address can be checked against them. */
  declare ready: boolean;
  declare phone: boolean;
  /** Show a Back button (a phone with conversations to go back to). */
  declare back: boolean;
  /** Creates the conversation and sends its first message; resolves to why not, or null. */
  declare onCreate: ((d: SendDetail, pick: DraftPick) => Promise<string | null>) | undefined;
  declare pickEmployee: string;
  declare pickProject: string;
  declare pickMode: string;
  declare note: string;
  private touched = false;
  private seen = "";

  constructor() {
    super();
    this.employees = [];
    this.projects = [];
    this.ready = false;
    this.phone = false;
    this.back = false;
    this.pickEmployee = "";
    this.pickProject = "";
    this.pickMode = "";
    this.note = "";
  }

  static override styles = [
    base,
    cardStyles,
    selectField,
    css`
      :host { display: block; height: 100%; min-height: 0; min-width: 0; overflow-y: auto; overscroll-behavior: contain; }
      /* Top-aligned at a fixed place: what loads later (the checklist) goes below the composer and moves nothing. */
      .draft { width: min(720px, 100%); margin: 0 auto; box-sizing: border-box; padding: clamp(12px, 11vh, 110px) 2px 24px;
        display: flex; flex-direction: column; gap: 16px; min-width: 0; }
      .back { align-self: flex-start; min-height: 44px; display: inline-flex; align-items: center; gap: 4px; padding: 0 12px 0 6px; border: 0;
        background: transparent; color: var(--ink); font: 600 15px var(--body); border-radius: 12px; cursor: pointer; margin-bottom: -8px; }
      .back svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
      .back:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 1px; }
      h2 { font-size: 28px; line-height: 1.2; }
      .lead { margin: -8px 0 0; color: var(--ink-2); font-size: 15.5px; line-height: 1.5; }
      .picks { display: flex; flex-wrap: wrap; gap: 8px 12px; }
      .picks label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; font-weight: 700; color: var(--ink-2); flex: 1 1 200px; min-width: 0; }
      .notice { margin: 0; padding: 8px 12px; border-radius: 12px; border: 1px solid var(--needs-edge); background: var(--banner-bg); color: var(--banner-fg); font-weight: 600; font-size: 14px; }
      .sub { margin: 0; font-size: 13px; color: var(--ink-2); }
      inc-getting-started { margin-top: 8px; }
      @media (max-width: 767px) { .draft { padding-top: 8px; } h2 { font-size: 24px; } }
    `,
  ];

  override willUpdate(changed: Map<string, unknown>): void {
    if (
      changed.has("preset") ||
      changed.has("ready") ||
      changed.has("employees") ||
      changed.has("projects")
    ) {
      // A different address starts over; the same one, once its data arrives, is only resolved.
      const key = `${this.preset?.employee ?? ""}|${this.preset?.project ?? ""}`;
      if (key !== this.seen) {
        this.seen = key;
        this.touched = false;
      }
      if (!this.touched) {
        const r = resolveDraft(
          this.preset ?? { employee: "", project: "" },
          this.employees,
          this.projects,
          lastUsed(),
          this.ready,
        );
        this.pickEmployee = r.employee;
        this.pickProject = r.project;
        this.note = r.note;
      }
    }
  }

  /** The options exist now: put each select on what the state says (a select set before its options is ignored). */
  override updated(): void {
    const [who, project] = [...this.renderRoot.querySelectorAll<HTMLSelectElement>(".picks select")];
    if (who && who.value !== this.pickEmployee && this.pickEmployee) who.value = this.pickEmployee;
    if (project && project.value !== this.pickProject) project.value = this.pickProject;
  }

  focusComposer(): void {
    (
      this.renderRoot.querySelector("inc-conv-composer") as (HTMLElement & { focusInput(): void }) | null
    )?.focusInput();
  }

  private send = async (d: SendDetail): Promise<string | null> => {
    // A message sent in the first moments, before the employees have arrived, waits for them.
    for (let i = 0; i < 100 && !this.ready; i++) await new Promise((r) => setTimeout(r, 50));
    await this.updateComplete;
    const pick = { employee: this.pickEmployee, project: this.pickProject };
    if (!pick.employee) return "Pick an employee first.";
    const why = await this.onCreate?.(d, pick);
    if (!why) rememberLastUsed(pick);
    return why ?? null;
  };

  private onConfig = (e: Event) => {
    const d = (e as CustomEvent<{ key: string; value: string }>).detail;
    if (d.key !== "mode") return;
    this.pickMode = d.value;
    if (d.value && this.pickEmployee) rememberMode(this.pickEmployee, d.value);
  };

  override render() {
    const employee = this.employees.find((e) => e.id === this.pickEmployee);
    const name = employee?.name ?? "";
    const choices = projectChoices(this.employees, this.projects, this.pickEmployee);
    const project = this.pickProject;
    const lead = project
      ? `Ask ${name || "an employee"} about ${project}, or tell them what to change.`
      : `Ask ${name || "an employee"} anything, or tell them what to do.`;
    return html`<div class="draft">
      ${
        this.back
          ? html`<button class="back" type="button" @click=${() => {
              location.hash = "#/conversations";
            }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>Conversations</button>`
          : nothing
      }
      <h2>Start a conversation</h2>
      <p class="lead">${lead}</p>
      ${this.note ? html`<p class="notice" role="status">${this.note}</p>` : nothing}
      <div class="picks">
        <label>With<select aria-label="Employee for this conversation" .value=${this.pickEmployee} @change=${(
          e: Event,
        ) => {
          this.touched = true;
          this.pickEmployee = (e.target as HTMLSelectElement).value;
          this.pickMode = "";
          if (!projectChoices(this.employees, this.projects, this.pickEmployee).includes(this.pickProject))
            this.pickProject = "";
          this.note = "";
        }}>${
          this.employees.length
            ? this.employees.map(
                (e) =>
                  html`<option value=${e.id} ?selected=${e.id === this.pickEmployee}>${e.name} · ${e.role}</option>`,
              )
            : html`<option value="">${this.ready ? "Nobody to talk to yet" : "Loading…"}</option>`
        }</select></label>
        <label>Project<select aria-label="Project for this conversation" .value=${project} @change=${(
          e: Event,
        ) => {
          this.touched = true;
          this.pickProject = (e.target as HTMLSelectElement).value;
          this.note = "";
        }}><option value="" ?selected=${!project}>No project</option>${choices.map(
          (p) => html`<option value=${p} ?selected=${p === project}>${p}</option>`,
        )}</select></label>
      </div>
      <div @conv-config=${this.onConfig}>
        <inc-conv-composer .conversationId=${"draft:new"} .name=${name}
          .modes=${this.pickEmployee ? draftModePicker(this.pickEmployee, this.pickMode) : undefined}
          .blocked=${this.ready && !this.pickEmployee ? "Hire an employee first, then start a conversation." : ""}
          .onSend=${this.send}></inc-conv-composer>
      </div>
      <p class="sub">The conversation is created when you send your first message. Paste or drop a screenshot or a text file to attach it.</p>
      <inc-getting-started></inc-getting-started>
    </div>`;
  }
}

customElements.define("inc-conv-draft", IncConvDraft);
