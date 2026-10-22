// The quick new-ticket form on the board: a title, optional details, a project and an effort,
// posted to the ticket-creation API, with any images: picked (the camera or the photo library on a
// phone) or pasted as a screenshot. Built to be used one-handed on a phone.
import type { Employee } from "@i-inc/core";
import { css, html, LitElement } from "lit";
import { api, imageRules, type NewTicketBody, type RecentWork, refreshNow } from "../api.ts";
import { assignees, NOBODY_LABEL, optionLabel } from "../assign.ts";
import { draftMemo } from "../drafts.ts";
import { ImagePicker, imagePickerStyles } from "./image-picker.ts";
import { NEW_TICKET_EVENT } from "./new-ticket-event.ts";
import { base, selectField } from "./shared.ts";

export { NEW_TICKET_EVENT };
/** Sent by the form in a dialog: it was filed (`detail` is the ticket), or closed without filing. */
export const TICKET_FILED = "ticket-filed";
export const TICKET_FORM_CLOSE = "ticket-form-close";

type Effort = NewTicketBody["effort"];
type Kind = NewTicketBody["type"];

const efforts: [Effort, string][] = [
  ["low", "Small"],
  ["medium", "Medium"],
  ["high", "Large"],
];
const kinds: [Kind, string][] = [
  ["feat", "Feature"],
  ["fix", "Fix"],
  ["chore", "Chore"],
  ["errand", "Errand"],
];

/** Keys of the new-ticket form's unsent text in the draft store (drafts.ts forgets them at sign-out). */
const DRAFT_TITLE = "new-ticket:title";
const DRAFT_DETAILS = "new-ticket:details";

const memo = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`inc.new-ticket.${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`inc.new-ticket.${key}`, value);
    } catch {
      // Private mode or blocked storage: the form just won't remember.
    }
  },
};

export class IncNewTicket extends LitElement {
  static override properties = {
    open: { state: true },
    projects: { state: true },
    project: { state: true },
    kind: { state: true },
    effort: { state: true },
    title: { state: true },
    details: { state: true },
    busy: { state: true },
    error: { state: true },
    filed: { state: true },
    employees: { state: true },
    recent: { state: true },
    assignee: { state: true },
    assigneeChosen: { state: true },
    /** A project page presets the project and opens the form (T62). */
    presetProject: { type: String },
    startOpen: { type: Boolean },
    /** In a dialog (the board): always the form, a Close button that asks the dialog to close, and no inline "Filed". */
    modal: { type: Boolean, reflect: true },
  };
  declare modal: boolean;
  declare presetProject: string;
  declare startOpen: boolean;
  declare open: boolean;
  declare projects: string[];
  declare project: string;
  declare kind: Kind;
  declare effort: Effort;
  declare title: string;
  declare details: string;
  declare busy: boolean;
  declare error: string | null;
  declare filed: { id: string; title: string } | null;
  declare employees: Employee[];
  declare recent: RecentWork[];
  /** The employee picked, or "" for nobody yet. Follows the project until the owner chooses. */
  declare assignee: string;
  declare assigneeChosen: boolean;
  private readonly picker = new ImagePicker(this, { id: "images" });

  constructor() {
    super();
    this.open = false;
    this.projects = [];
    this.project = memo.get("project") ?? "";
    this.kind = (kinds.find(([k]) => k === memo.get("kind"))?.[0] ?? "feat") as Kind;
    this.effort = (efforts.find(([e]) => e === memo.get("effort"))?.[0] ?? "medium") as Effort;
    // A half-written ticket survives a reload, like a chat draft (and goes with sign-out).
    this.title = draftMemo.get(DRAFT_TITLE) ?? "";
    this.details = draftMemo.get(DRAFT_DETAILS) ?? "";
    this.busy = false;
    this.error = null;
    this.filed = null;
    this.employees = [];
    this.recent = [];
    this.assignee = "";
    this.assigneeChosen = false;
    this.presetProject = "";
    this.startOpen = false;
    this.modal = false;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.startOpen) this.open = true;
    api
      .projects()
      .then((ps) => {
        this.projects = ps.map((p) => p.id);
        // The project page's project wins; otherwise the last project used, else the first one.
        if (this.presetProject && this.projects.includes(this.presetProject))
          this.project = this.presetProject;
        else if (!this.projects.includes(this.project)) this.project = this.projects[0] ?? "";
        this.followProject();
      })
      .catch((e) => {
        this.error = e instanceof Error ? e.message : String(e);
      });
    // Who can take it is a nicety: the form still files a ticket if these don't load.
    void Promise.all([api.employees().catch(() => []), api.recentWork().catch(() => [])]).then(([e, t]) => {
      this.employees = Array.isArray(e) ? e : [];
      this.recent = Array.isArray(t) ? t : [];
      this.followProject();
    });
  }

  /** The people offered for the chosen project, the usual one first. */
  private get choices(): Employee[] {
    return assignees(this.employees, this.project, this.recent);
  }

  /** Default to the project's usual employee, unless the owner picked someone who still fits. */
  private followProject(): void {
    const options = this.choices;
    if (this.assigneeChosen && (this.assignee === "" || options.some((e) => e.id === this.assignee))) return;
    this.assigneeChosen = false;
    this.assignee = options[0]?.id ?? "";
  }

  static override styles = [
    base,
    selectField,
    imagePickerStyles,
    css`
      :host { display: block; }
      .box { padding: 12px 14px; display: flex; flex-direction: column; gap: 12px; }
      :host([modal]) .box { border: 0; box-shadow: none; background: transparent; padding: 0; }
      .head { display: flex; align-items: center; gap: 10px; justify-content: space-between; }
      h2 { font-size: 18px; }
      form { display: flex; flex-direction: column; gap: 12px; }
      label, fieldset { display: flex; flex-direction: column; gap: 4px; font-size: 13px; font-weight: 700; color: var(--ink-2); border: 0; padding: 0; margin: 0; min-width: 0; }
      input, textarea {
        font: 16px var(--body); color: var(--ink); background: var(--surface); box-sizing: border-box; width: 100%;
        min-height: 44px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--control-edge);
      }
      textarea { padding: 10px 12px; min-height: 76px; resize: vertical; line-height: 1.35; }
      input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 1px; }
      .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .seg { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
      .seg label { position: relative; font-size: 15px; color: var(--ink); }
      .seg input { position: absolute; opacity: 0; inset: 0; width: 100%; height: 100%; min-height: 44px; margin: 0; cursor: pointer; }
      .seg span { display: flex; align-items: center; justify-content: center; min-height: 44px; border-radius: 999px;
        border: 1px solid var(--line-strong); font-weight: 600; }
      .seg input:checked + span { background: var(--ink); color: var(--on-ink); border-color: var(--ink); }
      .seg input:focus-visible + span { outline: 3px solid var(--reviewing-mark); outline-offset: 2px; }
      .actions { display: flex; gap: 8px; }
      .actions .btn:first-child { flex-grow: 1; }
      .note { font-size: 14px; line-height: 1.35; border-radius: 10px; padding: 10px 12px; overflow-wrap: anywhere; }
      .ok { background: var(--working-bg); color: var(--working-fg); }
      .ok a { font-weight: 700; }
      .bad { background: var(--needs-bg); color: var(--needs-fg); border: 1px solid var(--alarm); }
      .btn:disabled { opacity: 0.6; cursor: default; }
      @media (max-width: 420px) { .pair { grid-template-columns: 1fr; } }
    `,
  ];

  private async submit(e: Event) {
    e.preventDefault();
    const title = this.title.trim();
    if (!title) {
      this.error = "Give the ticket a title.";
      return;
    }
    if (!this.project) {
      this.error = "Pick a project.";
      return;
    }
    this.busy = true;
    this.error = null;
    this.picker.problem = null;
    this.filed = null;
    try {
      const doneWhen = this.details
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const { ticket } = await api.createTicket(
        {
          title,
          project: this.project,
          type: this.kind,
          effort: this.effort,
          doneWhen,
          ...(this.assignee ? { assignee: this.assignee } : {}),
        },
        this.picker.files,
      );
      memo.set("project", this.project);
      memo.set("kind", this.kind);
      memo.set("effort", this.effort);
      this.filed = { id: ticket.id, title };
      if (this.modal)
        this.dispatchEvent(
          new CustomEvent(TICKET_FILED, { bubbles: true, composed: true, detail: { id: ticket.id, title } }),
        );
      this.title = "";
      this.details = "";
      draftMemo.set(DRAFT_TITLE, "");
      draftMemo.set(DRAFT_DETAILS, "");
      this.picker.clear();
      refreshNow();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy = false;
    }
  }

  override render() {
    if (!this.open && !this.modal) {
      return html`<div class="card box">
        <div class="head">
          <h2>New ticket</h2>
          <button class="btn" aria-expanded="false" @click=${() => {
            this.open = true;
          }}>Write one</button>
        </div>
        ${this.filed ? this.success() : ""}
      </div>`;
    }
    return html`<div class="card box">
      <div class="head">
        <h2>New ticket</h2>
        <button type="button" class="btn ghost" aria-expanded="true" @click=${() => {
          this.open = false;
          this.filed = null;
          this.dispatchEvent(new CustomEvent(TICKET_FORM_CLOSE, { bubbles: true, composed: true }));
        }}>Close</button>
      </div>
      <form @submit=${this.submit} @paste=${this.picker.paste} novalidate>
        <label>Title
          <input name="title" type="text" autocomplete="off" autocapitalize="sentences" enterkeyhint="next"
            placeholder="What should the team do?" .value=${this.title}
            @input=${(e: InputEvent) => {
              this.title = (e.target as HTMLInputElement).value;
              draftMemo.set(DRAFT_TITLE, this.title);
            }} />
        </label>
        <label>Details (optional, one done-when per line)
          <textarea name="details" rows="3" autocapitalize="sentences" .value=${this.details}
            @input=${(e: InputEvent) => {
              this.details = (e.target as HTMLTextAreaElement).value;
              draftMemo.set(DRAFT_DETAILS, this.details);
            }}></textarea>
        </label>
        <div class="pair">
          <label>
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span>Project</span>
              <a href="#/company/projects" style="font-size: 12px; font-weight: 600; text-decoration: none; color: var(--reviewing-fg);">+ Add project</a>
            </div>
            <select name="project" .value=${this.project} @change=${(e: Event) => {
              this.project = (e.target as HTMLSelectElement).value;
              this.followProject();
            }}>
              ${this.projects.map((p) => html`<option value=${p} ?selected=${p === this.project}>${p}</option>`)}
            </select>
          </label>
          <label>Kind
            <select name="type" .value=${this.kind} @change=${(e: Event) => {
              this.kind = (e.target as HTMLSelectElement).value as Kind;
            }}>
              ${kinds.map(([k, name]) => html`<option value=${k} ?selected=${k === this.kind}>${name}</option>`)}
            </select>
          </label>
        </div>
        <label>Assign to
          <select name="assignee" @change=${(e: Event) => {
            this.assignee = (e.target as HTMLSelectElement).value;
            this.assigneeChosen = true;
          }}>
            ${this.choices.map((e) => html`<option value=${e.id} .selected=${e.id === this.assignee}>${optionLabel(e)}</option>`)}
            <option value="" .selected=${this.assignee === ""}>${NOBODY_LABEL}</option>
          </select>
        </label>
        <fieldset>
          <legend>Effort</legend>
          <div class="seg">
            ${efforts.map(
              ([
                e,
                name,
              ]) => html`<label><input type="radio" name="effort" value=${e} .checked=${this.effort === e}
                @change=${() => {
                  this.effort = e;
                }} /><span>${name}</span></label>`,
            )}
          </div>
        </fieldset>
        ${this.picker.render({
          label: "Images (optional)",
          hint: `Screenshots or photos, up to ${imageRules.count}, 10 MB each. You can paste a screenshot too.`,
        })}
        ${this.problem() ? html`<div class="note bad" role="alert">${this.problem()}</div>` : ""}
        ${this.filed && !this.modal ? this.success() : ""}
        <div class="actions">
          <button class="btn" type="submit" ?disabled=${this.busy}>${this.busy ? "Filing…" : "File ticket"}</button>
        </div>
      </form>
    </div>`;
  }

  /** A problem with the form, or with the images just picked. */
  private problem(): string | null {
    return [this.error, this.picker.problem].filter(Boolean).join(" ") || null;
  }

  private success() {
    const f = this.filed;
    if (!f) return "";
    return html`<div class="note ok" role="status">Filed <a href="#/ticket/${f.id}">#${f.id}</a>: ${f.title}</div>`;
  }
}

customElements.define("inc-new-ticket", IncNewTicket);
