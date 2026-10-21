// The conversation list: "Needs you", "Running" and "Recent", with a row menu (rename, archive) and the
// New conversation form (an employee, a project or none). Rows are buttons that open the conversation.
import type { Employee } from "@i-inc/core";
import { css, html, LitElement, nothing } from "lit";
import type { Conversation } from "../api.ts";
import {
  GROUP_LABEL,
  groupConversations,
  relativeTime,
  statusText,
  visible,
} from "../conversations/model.ts";
import { cardStyles } from "../conversations/styles.ts";
import { avatar, base, projectBadge, selectField } from "./shared.ts";

export interface CreateDetail {
  employeeId: string;
  project: string | null;
}

export class IncConvList extends LitElement {
  static override properties = {
    items: { attribute: false },
    employees: { attribute: false },
    projects: { attribute: false },
    selected: { type: String },
    now: { type: Number },
    loading: { type: Boolean },
    error: { type: String },
    showArchived: { type: Boolean },
    preset: { attribute: false },
    ready: { type: Boolean },
    presetNote: { state: true },
    form: { state: true },
    menu: { state: true },
    rove: { state: true },
    renaming: { state: true },
    filter: { state: true },
    pickEmployee: { state: true },
    pickProject: { state: true },
  };
  declare items: Conversation[];
  declare employees: Employee[];
  declare projects: string[];
  declare selected: string;
  declare now: number;
  declare loading: boolean;
  declare error: string;
  declare showArchived: boolean;
  /** Opens the form with this employee and project chosen (from `#/conversations?new=1&project=<id>`). */
  declare preset: { employee: string; project: string } | undefined;
  /** The employees and projects have arrived, so a preset can be checked against them. */
  declare ready: boolean;
  declare presetNote: string;
  declare form: boolean;
  declare menu: string | null;
  /** The row that is the list's one tab stop; arrow keys move between rows. */
  declare rove: string;
  declare renaming: string | null;
  declare filter: string;
  declare pickEmployee: string;
  declare pickProject: string;

  constructor() {
    super();
    this.items = [];
    this.employees = [];
    this.projects = [];
    this.selected = "";
    this.now = Date.now();
    this.loading = false;
    this.error = "";
    this.showArchived = false;
    this.preset = undefined;
    this.ready = false;
    this.presetNote = "";
    this.form = false;
    this.menu = null;
    this.rove = "";
    this.renaming = null;
    this.filter = "";
    this.pickEmployee = "";
    this.pickProject = "";
  }

  static override styles = [
    base,
    cardStyles,
    selectField,
    css`
      :host { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; }
      .top { flex: none; display: flex; flex-direction: column; gap: 10px; padding: 0 2px 10px; }
      .new { width: 100%; }
      input[type="search"], input.rename, select { font-size: 16px; }
      input[type="search"], input.rename { font-family: var(--body); min-height: 44px; box-sizing: border-box; width: 100%; padding: 0 12px; border-radius: 12px;
        border: 1px solid var(--control-edge); background: var(--surface); color: var(--ink); }
      input:focus-visible, select:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 1px; }
      form.create { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid var(--line-strong); border-radius: 14px; background: var(--surface); }
      form.create label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; font-weight: 700; color: var(--ink-2); }
      form.create .btns { display: flex; gap: 8px; flex-wrap: wrap; }
      .groups { flex: 1 1 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 0 2px 8px; }
      h3 { font: 800 12px var(--body); text-transform: uppercase; letter-spacing: 0.5px; color: var(--ink-2); margin: 12px 4px 6px; display: flex; align-items: center; gap: 8px; }
      h3 .n { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--neutral-bg); color: var(--neutral-fg); }
      h3.g-needs { color: var(--needs-fg); } h3.g-needs .n { background: var(--needs-bg); border: 1px solid var(--needs-edge); color: var(--needs-fg); }
      ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
      li.row { position: relative; display: flex; align-items: stretch; border-radius: 14px; border: 1px solid transparent; }
      li.row:hover { background: var(--sunken); }
      li.row.sel { background: var(--surface); border-color: var(--line-strong); box-shadow: var(--shadow-card); }
      li.row.needs { border-color: var(--needs-edge); background: var(--needs-surface); }
      .open { all: unset; box-sizing: border-box; flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 10px; padding: 8px 4px 8px 10px; min-height: 60px; cursor: pointer; border-radius: 14px; }
      .open:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: -2px; }
      .main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
      .title { font-weight: 700; font-size: 14.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .sub { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--ink-2); min-width: 0; overflow: hidden; white-space: nowrap; }
      .sub .proj-badge { flex: 0 1 auto; min-width: 0; }
      .side { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; font-size: 12px; color: var(--ink-2); }
      .chip { font-size: 11px; padding: 1px 8px; }
      .dots { flex: none; width: 44px; border: 0; background: transparent; color: var(--ink-2); border-radius: 12px; cursor: pointer; display: grid; place-items: center; }
      .dots:hover { background: var(--sunken); color: var(--ink); }
      .dots:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: -2px; }
      .dots svg { width: 18px; height: 18px; fill: currentColor; }
      .menu { position: absolute; right: 6px; top: 52px; z-index: 20; min-width: 170px; padding: 6px; border-radius: 14px; background: var(--surface); border: 1px solid var(--line);
        box-shadow: 0 12px 32px rgba(0,0,0,0.16); display: flex; flex-direction: column; }
      .menu button { all: unset; box-sizing: border-box; min-height: 44px; padding: 0 14px; display: flex; align-items: center; border-radius: 10px; font: 600 15px var(--body); cursor: pointer; }
      .menu button:hover { background: var(--sunken); }
      .menu button:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: -3px; }
      .renamer { flex: 1 1 auto; padding: 8px 6px 8px 10px; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
      .foot { flex: none; display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 2px 0; border-top: 1px solid var(--line); margin-top: 4px; }
      .foot a { color: var(--ink-2); font-size: 13px; font-weight: 600; min-height: 44px; display: inline-flex; align-items: center; }
      .empty { padding: 28px 12px; text-align: center; display: flex; flex-direction: column; gap: 10px; align-items: center; }
      .empty h2 { font-size: 20px; } .empty p { margin: 0; color: var(--ink-2); line-height: 1.5; font-size: 14.5px; }
      .skel { height: 60px; border-radius: 14px; background: var(--sunken); margin: 4px 0; animation: pulse 1.4s ease-in-out infinite; }
      @keyframes pulse { 50% { opacity: 0.5; } }
      .problem { color: var(--alarm-fg); font-weight: 600; font-size: 14px; margin: 0; }
    `,
  ];

  private emit<T>(name: string, detail?: T) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private open(id: string) {
    location.hash = `#/conversations/${id}`;
  }

  private who(id: string): Employee | undefined {
    return this.employees.find((e) => e.id === id);
  }

  private onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.menu) {
      this.menu = null;
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const buttons = [...this.renderRoot.querySelectorAll<HTMLElement>(".open")];
    const at = buttons.indexOf((e.composedPath()[0] as HTMLElement) ?? null);
    if (at < 0) return;
    e.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };

  override willUpdate(changed: Map<string, unknown>): void {
    const preset = this.preset;
    if (changed.has("preset") && preset) this.form = true;
    if (changed.has("employees") && this.employees[0] && !this.pickEmployee)
      this.pickEmployee = this.employees[0].id;
    if (preset && !this.ready && changed.has("preset")) {
      // Until the employees and projects arrive, show what the address asked for.
      this.pickProject = preset.project;
      if (preset.employee) this.pickEmployee = preset.employee;
    }
    if (
      preset &&
      this.ready &&
      (changed.has("preset") || changed.has("ready") || changed.has("employees") || changed.has("projects"))
    ) {
      const known = this.employees.some((e) => e.id === preset.employee);
      const project = preset.project && this.projects.includes(preset.project) ? preset.project : "";
      // An unknown project or employee is said so, and the form falls back to No project and the first employee.
      this.presetNote = [
        preset.employee && !known ? "That employee isn't available." : "",
        preset.project && !project ? "That project isn't available." : "",
      ]
        .filter(Boolean)
        .join(" ");
      if (known) this.pickEmployee = preset.employee;
      else if (project) {
        const e = this.employees.find((x) => !x.projects?.length || x.projects.includes(project));
        if (e) this.pickEmployee = e.id;
      }
      this.pickProject = project;
    }
  }

  private projectChoices(): string[] {
    const e = this.who(this.pickEmployee);
    return e?.projects?.length ? e.projects : this.projects;
  }

  private submitCreate = (ev: Event) => {
    ev.preventDefault();
    if (!this.pickEmployee) return;
    this.emit<CreateDetail>("conv-create", {
      employeeId: this.pickEmployee,
      project: this.pickProject || null,
    });
  };

  /** The row a Tab lands on: the one last focused, else the open one, else the first. */
  private tabStop(): string {
    const ids = this.items.map((c) => c.id);
    return ids.includes(this.rove) ? this.rove : ids.includes(this.selected) ? this.selected : (ids[0] ?? "");
  }

  private row(c: Conversation) {
    const e = this.who(c.employeeId);
    const sel = c.id === this.selected;
    const needs = c.needsYou || (c.status & 24) === 24;
    const status = statusText(c);
    if (this.renaming === c.id) {
      return html`<li class="row sel"><form class="renamer" @submit=${(ev: Event) => {
        ev.preventDefault();
        const v = (this.renderRoot.querySelector<HTMLInputElement>("input.rename")?.value ?? "").trim();
        this.renaming = null;
        if (v && v !== c.title) this.emit("conv-rename", { id: c.id, title: v });
      }} @keydown=${(ev: KeyboardEvent) => {
        if (ev.key === "Escape") {
          ev.stopPropagation();
          this.renaming = null;
        }
      }}><input class="rename" type="text" .value=${c.title} maxlength="200" aria-label="Rename conversation" />
        <span class="sub">Enter to save · Escape to cancel</span></form></li>`;
    }
    const stop = this.tabStop() === c.id ? 0 : -1;
    return html`<li class="row ${sel ? "sel" : ""} ${needs ? "needs" : ""}" @focusin=${() => {
      this.rove = c.id;
    }}>
      <button class="open" type="button" tabindex=${stop} aria-current=${sel ? "true" : "false"} @click=${() => this.open(c.id)}>
        ${e ? avatar({ name: e.name, tint: e.tint ?? 0 }, 34) : nothing}
        <span class="main"><span class="title" title=${visible(c.title, true)}>${visible(c.title, true)}</span>
          <span class="sub"><span>${e?.name ?? c.employeeId}</span>${c.project ? projectBadge(c.project) : html`<span>no project</span>`}</span></span>
        <span class="side"><span>${relativeTime(c.modifiedAt, this.now)}</span>
          <span class="chip ${needs ? "needs" : status === "Running" ? "working" : ""}">${status}</span></span>
      </button>
      <button class="dots" type="button" tabindex=${stop} aria-label="Actions for ${visible(c.title, true)}" aria-haspopup="menu" aria-expanded=${this.menu === c.id ? "true" : "false"}
        @click=${(ev: Event) => {
          ev.stopPropagation();
          this.menu = this.menu === c.id ? null : c.id;
        }}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg></button>
      ${
        this.menu === c.id
          ? html`<div class="menu" role="menu" aria-label="Actions"><button type="button" role="menuitem" @click=${() => {
              this.menu = null;
              this.renaming = c.id;
              void this.updateComplete.then(() =>
                this.renderRoot.querySelector<HTMLInputElement>("input.rename")?.select(),
              );
            }}>Rename</button>
            <button type="button" role="menuitem" @click=${() => {
              this.menu = null;
              this.emit("conv-archive", { id: c.id, archived: !c.archivedAt });
            }}>${c.archivedAt ? "Unarchive" : "Archive"}</button></div>`
          : nothing
      }
    </li>`;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("click", this.closeMenu);
  }
  override disconnectedCallback(): void {
    document.removeEventListener("click", this.closeMenu);
    super.disconnectedCallback();
  }
  private closeMenu = () => {
    if (this.menu) this.menu = null;
  };

  override render() {
    const q = this.filter.trim().toLowerCase();
    const items = q
      ? this.items.filter((c) =>
          `${c.title} ${this.who(c.employeeId)?.name ?? c.employeeId} ${c.project ?? ""}`
            .toLowerCase()
            .includes(q),
        )
      : this.items;
    const groups = groupConversations(items);
    const projects = this.projectChoices();
    return html`
      <div class="top">
        <button class="btn new" type="button" aria-expanded=${this.form ? "true" : "false"} @click=${() => {
          this.form = !this.form;
        }}>New conversation</button>
        ${
          this.form
            ? html`<form class="create" @submit=${this.submitCreate} aria-label="New conversation">
                ${this.presetNote ? html`<p class="problem" role="status">${this.presetNote} Pick one below.</p>` : nothing}
                <label>Employee<select .value=${this.pickEmployee} @change=${(e: Event) => {
                  this.pickEmployee = (e.target as HTMLSelectElement).value;
                  this.pickProject = "";
                }}>${this.employees.map((e) => html`<option value=${e.id} ?selected=${e.id === this.pickEmployee}>${e.name} · ${e.role}</option>`)}</select></label>
                <label>Project<select .value=${this.pickProject} @change=${(e: Event) => {
                  this.pickProject = (e.target as HTMLSelectElement).value;
                }}><option value="" ?selected=${!this.pickProject}>No project</option>${projects.map((p) => html`<option value=${p} ?selected=${p === this.pickProject}>${p}</option>`)}</select></label>
                <div class="btns"><button class="btn" type="submit" ?disabled=${!this.pickEmployee}>Start</button>
                  <button class="btn ghost" type="button" @click=${() => {
                    this.form = false;
                  }}>Cancel</button></div>
                <span class="sub">Nothing is created until you send the first message.</span>
              </form>`
            : nothing
        }
        ${
          this.items.length > 5
            ? html`<input type="search" placeholder="Search conversations" aria-label="Search conversations" .value=${this.filter}
                @input=${(e: Event) => {
                  this.filter = (e.target as HTMLInputElement).value;
                }} />`
            : nothing
        }
      </div>
      <div class="groups" @keydown=${this.onKeydown}>
        ${
          this.error
            ? html`<p class="problem" role="alert">${this.error}</p><button class="btn ghost" type="button" @click=${() => this.emit("conv-reload")}>Try again</button>`
            : this.loading && !this.items.length
              ? html`<div aria-busy="true" aria-label="Loading conversations"><div class="skel"></div><div class="skel"></div><div class="skel"></div></div>`
              : !groups.length
                ? html`<div class="empty"><h2>${q ? "Nothing matches" : this.showArchived ? "No archived conversations" : "No conversations yet"}</h2>
                    <p>${q ? "Try a different word." : "Start a conversation with an employee about a project. They can read the code, make changes on their own copy, and ask you before anything risky."}</p></div>`
                : groups.map(
                    (
                      g,
                    ) => html`<h3 class="g-${g.group}" id="g-${g.group}">${GROUP_LABEL[g.group]} <span class="n">${g.items.length}</span></h3>
                      <ul aria-labelledby="g-${g.group}">${g.items.map((c) => this.row(c))}</ul>`,
                  )
        }
      </div>
      <div class="foot">
        <button class="link-btn" type="button" aria-pressed=${this.showArchived ? "true" : "false"} @click=${() => this.emit("conv-toggle-archived")}>${this.showArchived ? "Hide archived" : "Show archived"}</button>
        <a href="#/conversations/old">Old chat</a>
      </div>`;
  }
}

customElements.define("inc-conv-list", IncConvList);
