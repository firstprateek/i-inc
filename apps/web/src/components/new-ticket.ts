// The quick new-ticket form on the board: a title, optional details, a project and an effort,
// posted to the ticket-creation API, with any images: picked (the camera or the photo library on a
// phone) or pasted as a screenshot. Built to be used one-handed on a phone.
import type { Employee } from "@i-inc/core";
import { css, html, LitElement } from "lit";
import { api, imageRules, type NewTicketBody, refreshNow, type TicketView } from "../api.ts";
import { assignees, NOBODY_LABEL, optionLabel } from "../assign.ts";
import { base, selectField } from "./shared.ts";

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

/** A picked image and its preview URL, revoked when it's removed. */
interface Picked {
  file: File;
  url: string;
}

const preview = (f: File) => (typeof URL.createObjectURL === "function" ? URL.createObjectURL(f) : "");
const forget = (p: Picked) => {
  if (p.url && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(p.url);
};

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
    images: { state: true },
    employees: { state: true },
    recent: { state: true },
    assignee: { state: true },
    assigneeChosen: { state: true },
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
  declare images: Picked[];
  declare employees: Employee[];
  declare recent: TicketView[];
  /** The employee picked, or "" for nobody yet. Follows the project until the owner chooses. */
  declare assignee: string;
  declare assigneeChosen: boolean;

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
    this.employees = [];
    this.recent = [];
    this.assignee = "";
    this.assigneeChosen = false;
    this.images = [];
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.images.forEach(forget);
    this.images = [];
  }

  /** Adds what fits the rules, and says why anything else was left out. */
  private addImages(files: File[]) {
    const problems: string[] = [];
    const next = [...this.images];
    for (const f of files) {
      const label = f.name || "The pasted image";
      if (!imageRules.types.includes(f.type)) problems.push(`${label} isn't a PNG, JPEG, WebP or GIF.`);
      else if (f.size > imageRules.bytes) problems.push(`${label} is over 10 MB.`);
      else if (next.length >= imageRules.count)
        problems.push(`A ticket takes at most ${imageRules.count} images.`);
      else next.push({ file: f, url: preview(f) });
    }
    this.images = next;
    this.error = problems.length ? [...new Set(problems)].join(" ") : null;
  }

  private removeImage(p: Picked) {
    forget(p);
    this.images = this.images.filter((x) => x !== p);
  }

  private paste(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return; // text pastes as usual
    e.preventDefault();
    // A pasted screenshot is often called image.png: number them so each has its own name.
    this.addImages(
      files.map((f, i) =>
        f.name && f.name !== "image.png"
          ? f
          : new File([f], `screenshot-${this.images.length + i + 1}.${f.type.split("/")[1] ?? "png"}`, {
              type: f.type,
            }),
      ),
    );
  }

  override connectedCallback(): void {
    super.connectedCallback();
    api
      .projects()
      .then((ps) => {
        this.projects = ps.map((p) => p.id);
        // Default to the last project used, else the first one.
        if (!this.projects.includes(this.project)) this.project = this.projects[0] ?? "";
        this.followProject();
      })
      .catch((e) => {
        this.error = e instanceof Error ? e.message : String(e);
      });
    // Who can take it is a nicety: the form still files a ticket if these don't load.
    void Promise.all([api.employees().catch(() => []), api.board().catch(() => [])]).then(([e, t]) => {
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
    css`
      :host { display: block; }
      .box { padding: 12px 14px; display: flex; flex-direction: column; gap: 12px; }
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
      .images { display: flex; flex-direction: column; gap: 8px; font-size: 13px; font-weight: 700; color: var(--ink-2); }
      .images .hint { font-weight: 400; }
      .pick { align-self: flex-start; }
      .thumbs { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 10px; }
      .thumbs li { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
      .thumbs img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 10px; border: 1px solid var(--line); background: var(--surface); }
      .thumbs .btn { min-height: 44px; width: 100%; }
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
      const { ticket } = await api.createTicket(
        {
          title,
          project: this.project,
          type: this.kind,
          effort: this.effort,
          doneWhen,
          ...(this.assignee ? { assignee: this.assignee } : {}),
        },
        this.images.map((p) => p.file),
      );
      memo.set("project", this.project);
      memo.set("kind", this.kind);
      memo.set("effort", this.effort);
      this.filed = { id: ticket.id, title };
      this.title = "";
      this.details = "";
      this.images.forEach(forget);
      this.images = [];
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
      <form @submit=${this.submit} @paste=${this.paste} novalidate>
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
          <label>
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span>Project</span>
              <a href="#/setup/projects" style="font-size: 12px; font-weight: 600; text-decoration: none; color: var(--reviewing-fg);">+ Add project</a>
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
        ${this.picker()}
        ${this.error ? html`<div class="note bad" role="alert">${this.error}</div>` : ""}
        ${this.filed ? this.success() : ""}
        <div class="actions">
          <button class="btn" type="submit" ?disabled=${this.busy}>${this.busy ? "Filing…" : "File ticket"}</button>
        </div>
      </form>
    </div>`;
  }

  private picker() {
    const full = this.images.length >= imageRules.count;
    return html`<div class="images" role="group" aria-labelledby="images-label">
      <span id="images-label">Images (optional)</span>
      <span class="hint">Screenshots or photos, up to ${imageRules.count}, 10 MB each. You can paste a screenshot too.</span>
      <input id="image-input" type="file" name="images" accept=${imageRules.types.join(",")} multiple hidden
        @change=${(e: Event) => {
          const input = e.target as HTMLInputElement;
          this.addImages([...(input.files ?? [])]);
          input.value = ""; // so picking the same file again still fires
        }} />
      ${
        this.images.length
          ? html`<ul class="thumbs">
            ${this.images.map(
              (p) => html`<li>
                <img src=${p.url} alt=${p.file.name} />
                <button type="button" class="btn ghost" aria-label="Remove ${p.file.name}"
                  @click=${() => this.removeImage(p)}>Remove</button>
              </li>`,
            )}
          </ul>`
          : ""
      }
      <button type="button" class="btn ghost pick" ?disabled=${full}
        @click=${() => this.renderRoot.querySelector<HTMLInputElement>("#image-input")?.click()}>
        ${full ? `${imageRules.count} images added` : this.images.length ? "Add more images" : "Add images"}
      </button>
    </div>`;
  }

  private success() {
    const f = this.filed;
    if (!f) return "";
    return html`<div class="note ok" role="status">Filed <a href="#/ticket/${f.id}">#${f.id}</a>: ${f.title}</div>`;
  }
}

customElements.define("inc-new-ticket", IncNewTicket);
