// The quick new-ticket form on the board: a title, optional details, a project and an effort,
// posted to the ticket-creation API. Built to be used one-handed on a phone.
import { css, html, LitElement } from "lit";
import { api, type NewTicketBody, refreshNow } from "../api.ts";
import { base } from "./shared.ts";

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
  };
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

  constructor() {
    super();
    this.open = false;
    this.projects = [];
    this.project = memo.get("project") ?? "";
    this.kind = (kinds.find(([k]) => k === memo.get("kind"))?.[0] ?? "feat") as Kind;
    this.effort = (efforts.find(([e]) => e === memo.get("effort"))?.[0] ?? "medium") as Effort;
    this.title = "";
    this.details = "";
    this.busy = false;
    this.error = null;
    this.filed = null;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    api
      .projects()
      .then((ps) => {
        this.projects = ps.map((p) => p.id);
        // Default to the last project used, else the first one.
        if (!this.projects.includes(this.project)) this.project = this.projects[0] ?? "";
      })
      .catch((e) => {
        this.error = e instanceof Error ? e.message : String(e);
      });
  }

  static override styles = [
    base,
    css`
      :host { display: block; }
      .box { padding: 12px 14px; display: flex; flex-direction: column; gap: 12px; }
      .head { display: flex; align-items: center; gap: 10px; justify-content: space-between; }
      h2 { font-size: 18px; }
      form { display: flex; flex-direction: column; gap: 12px; }
      label, fieldset { display: flex; flex-direction: column; gap: 4px; font-size: 13px; font-weight: 700; color: var(--ink-2); border: 0; padding: 0; margin: 0; min-width: 0; }
      input, select, textarea {
        font: 16px var(--body); color: var(--ink); background: var(--surface); box-sizing: border-box; width: 100%;
        min-height: 44px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--line-strong);
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
    this.filed = null;
    try {
      const doneWhen = this.details
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const { ticket } = await api.createTicket({
        title,
        project: this.project,
        type: this.kind,
        effort: this.effort,
        doneWhen,
      });
      memo.set("project", this.project);
      memo.set("kind", this.kind);
      memo.set("effort", this.effort);
      this.filed = { id: ticket.id, title };
      this.title = "";
      this.details = "";
      refreshNow();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy = false;
    }
  }

  override render() {
    if (!this.open) {
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
        }}>Close</button>
      </div>
      <form @submit=${this.submit} novalidate>
        <label>Title
          <input name="title" type="text" autocomplete="off" autocapitalize="sentences" enterkeyhint="next"
            placeholder="What should the team do?" .value=${this.title}
            @input=${(e: InputEvent) => {
              this.title = (e.target as HTMLInputElement).value;
            }} />
        </label>
        <label>Details (optional, one done-when per line)
          <textarea name="details" rows="3" autocapitalize="sentences" .value=${this.details}
            @input=${(e: InputEvent) => {
              this.details = (e.target as HTMLTextAreaElement).value;
            }}></textarea>
        </label>
        <div class="pair">
          <label>Project
            <select name="project" .value=${this.project} @change=${(e: Event) => {
              this.project = (e.target as HTMLSelectElement).value;
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
        ${this.error ? html`<div class="note bad" role="alert">${this.error}</div>` : ""}
        ${this.filed ? this.success() : ""}
        <div class="actions">
          <button class="btn" type="submit" ?disabled=${this.busy}>${this.busy ? "Filing…" : "File ticket"}</button>
        </div>
      </form>
    </div>`;
  }

  private success() {
    const f = this.filed;
    if (!f) return "";
    return html`<div class="note ok" role="status">Filed <a href="#/ticket/${f.id}">#${f.id}</a>: ${f.title}</div>`;
  }
}

customElements.define("inc-new-ticket", IncNewTicket);
