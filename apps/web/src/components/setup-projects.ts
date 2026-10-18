// Setup > Projects: how each project's work reaches main, and the checks it must pass.
import type { Employee } from "@i-inc/core";
import { css, html } from "lit";
import { api, refreshNow } from "../api.ts";
import {
  type BootstrapProjectBody,
  type GitHubInspectResult,
  type GitHubRepoSummary,
  type MergeMode,
  type Project,
  policyDefaults,
  setupApi,
} from "../setup-api.ts";
import { listEditor, message, type Note, noteLine, setupStyles } from "../setup-shared.ts";
import { Loader } from "./loader.ts";
import { base } from "./shared.ts";

interface Draft {
  repo: string;
  mode: MergeMode;
  protectedPaths: string[];
  followUpsPerDay: string;
  checks: string[];
  autoRelease: boolean;
}

const fromProject = (p: Project): Draft => ({
  repo: p.repo,
  mode: p.mode ?? policyDefaults.mode,
  protectedPaths: [...(p.protectedPaths ?? policyDefaults.protectedPaths)],
  followUpsPerDay: String(p.followUpsPerDay ?? policyDefaults.followUpsPerDay),
  checks: [...p.checks],
  autoRelease: p.autoRelease ?? policyDefaults.autoRelease,
});

export class IncSetupProjects extends Loader<Project[]> {
  static override properties = {
    ...Loader.properties,
    drafts: { state: true },
    notes: { state: true },
    busy: { state: true },
    open: { state: true },
    showAdd: { state: true },
    addTab: { state: true },
    githubRepos: { state: true },
    loadingRepos: { state: true },
    reposError: { state: true },
    repoFilter: { state: true },
    inspecting: { state: true },
    inspectError: { state: true },
    detectedInfo: { state: true },
    newProjectId: { state: true },
    newProjectRepo: { state: true },
    newProjectMode: { state: true },
    newProjectTemplate: { state: true },
    newProjectDesc: { state: true },
    newProjectChecks: { state: true },
    newProjectEmployees: { state: true },
    addNote: { state: true },
    allEmployees: { state: true },
  };
  declare drafts: Record<string, Draft>;
  declare notes: Record<string, Note>;
  declare busy: string | null;
  /** The one project whose editor is open; undefined until the first load decides. */
  declare open: string | null | undefined;
  declare showAdd: boolean;
  declare addTab: "import" | "bootstrap";
  declare githubRepos: GitHubRepoSummary[] | null;
  declare loadingRepos: boolean;
  declare reposError: string | null;
  declare repoFilter: string;
  declare inspecting: boolean;
  declare inspectError: string | null;
  declare detectedInfo: string | null;
  declare newProjectId: string;
  declare newProjectRepo: string;
  declare newProjectMode: MergeMode;
  declare newProjectTemplate: "ts-node" | "web" | "python" | "minimal";
  declare newProjectDesc: string;
  declare newProjectChecks: string[];
  declare newProjectEmployees: string[];
  declare addNote: Note | undefined;
  declare allEmployees: Employee[];

  constructor() {
    super();
    this.drafts = {};
    this.notes = {};
    this.busy = null;
    this.open = undefined;
    this.showAdd = false;
    this.addTab = "import";
    this.githubRepos = null;
    this.loadingRepos = false;
    this.reposError = null;
    this.repoFilter = "";
    this.inspecting = false;
    this.inspectError = null;
    this.detectedInfo = null;
    this.newProjectId = "";
    this.newProjectRepo = "";
    this.newProjectMode = "direct";
    this.newProjectTemplate = "ts-node";
    this.newProjectDesc = "";
    this.newProjectChecks = ["pnpm install --frozen-lockfile", "pnpm check", "pnpm test"];
    this.newProjectEmployees = [];
    this.addNote = undefined;
    this.allEmployees = [];
  }

  protected fetch = async () => {
    const [projects, employees] = await Promise.all([setupApi.projects(), api.employees().catch(() => [])]);
    this.allEmployees = employees;
    // On a wide screen the first project starts open; on a phone every row starts closed.
    if (this.open === undefined) {
      this.open = matchMedia("(min-width: 901px)").matches ? (projects[0]?.id ?? null) : null;
    }
    return projects;
  };

  static override styles = [
    base,
    setupStyles,
    css`
      .top-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
      .card.row { padding: 0; gap: 0; }
      .toggle { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 10px; width: 100%; min-height: 64px;
        padding: 10px 20px; cursor: pointer; }
      .toggle:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: -3px; border-radius: var(--radius); }
      .toggle .text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
      .toggle b { font-family: var(--display); font-size: 20px; overflow-wrap: anywhere; }
      .toggle .sub { font-family: var(--mono); font-size: 13px; }
      .toggle .caret { width: 10px; height: 10px; border-right: 2px solid var(--ink-2); border-bottom: 2px solid var(--ink-2);
        transform: rotate(45deg); flex-shrink: 0; margin: 0 4px 4px 0; }
      .toggle[aria-expanded="true"] .caret { transform: rotate(-135deg); margin: 4px 4px 0 0; }
      .editor { display: flex; flex-direction: column; gap: 14px; padding: 4px 20px 18px; border-top: 1px solid var(--line); padding-top: 16px; }
      .add-card { border: 2px solid var(--reviewing-mark); padding: 18px 20px; border-radius: var(--radius); background: var(--surface); display: flex; flex-direction: column; gap: 14px; margin-bottom: 16px; }
      .add-header { display: flex; justify-content: space-between; align-items: center; }
      .add-header h2 { margin: 0; font-size: 18px; }
      .repo-list { max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--line); border-radius: 8px; padding: 6px; background: var(--ground); }
      .repo-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-radius: 6px; background: var(--surface); }
      .repo-item.selected { border: 2px solid var(--reviewing-mark); }
      .repo-name { font-weight: 700; font-size: 13px; font-family: var(--mono); overflow-wrap: anywhere; }
      .repo-meta { display: flex; gap: 6px; align-items: center; font-size: 11px; flex-wrap: wrap; }
      .add-card input[type="search"] { min-height: 44px; font-size: 16px; }
      .template-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; }
      .template-btn { border: 1px solid var(--line); border-radius: 8px; padding: 8px; background: var(--surface); cursor: pointer; text-align: left; display: flex; flex-direction: column; gap: 2px; }
      .template-btn[aria-pressed="true"] { border-color: var(--reviewing-mark); background: var(--reviewing-bg); color: var(--reviewing-fg); }
      .template-title { font-weight: 700; font-size: 13px; }
      .template-desc { font-size: 11px; color: var(--ink-2); }
      .employee-grid { display: flex; flex-wrap: wrap; gap: 8px; }
      .employee-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; padding: 4px 10px; border-radius: 6px; background: var(--sunken); cursor: pointer; }
      .btn.danger { color: var(--alarm-fg); border-color: var(--alarm-fg); }
      @media (max-width: 560px) {
        .toggle { padding: 10px 16px; }
        .editor { padding: 16px 16px 16px; }
        .add-card { padding: 14px; }
      }
    `,
  ];

  private draft(p: Project): Draft {
    return this.drafts[p.id] ?? fromProject(p);
  }

  private dirty(p: Project): boolean {
    const d = this.drafts[p.id];
    return !!d && JSON.stringify(d) !== JSON.stringify(fromProject(p));
  }

  private edit(p: Project, patch: Partial<Draft>) {
    this.drafts = { ...this.drafts, [p.id]: { ...this.draft(p), ...patch } };
    const { [p.id]: _gone, ...rest } = this.notes;
    this.notes = rest;
  }

  private async toggleAdd() {
    this.showAdd = !this.showAdd;
    if (this.showAdd && this.githubRepos === null) {
      this.loadingRepos = true;
      this.reposError = null;
      try {
        this.githubRepos = await setupApi.githubRepos();
      } catch (e) {
        this.reposError = message(e);
        this.githubRepos = [];
      } finally {
        this.loadingRepos = false;
      }
    }
  }

  private async selectGithubRepo(r: GitHubRepoSummary) {
    this.newProjectRepo = r.fullName;
    this.newProjectId = r.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    this.inspecting = true;
    this.inspectError = null;
    try {
      const inspect: GitHubInspectResult = await setupApi.inspectRepo(r.owner, r.name);
      this.newProjectChecks = inspect.checks;
      this.detectedInfo = `Detected: ${inspect.detected}${inspect.empty ? " (empty repo)" : ""}`;
    } catch (e) {
      this.inspectError = message(e);
      this.newProjectChecks = ["pnpm install --frozen-lockfile", "pnpm check", "pnpm test"];
    } finally {
      this.inspecting = false;
    }
  }

  private async submitAddProject() {
    const id = this.newProjectId.trim();
    const repo = this.newProjectRepo.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(id)) {
      this.addNote = {
        ok: false,
        text: "A project is named by up to 40 letters, digits, spaces, dots and dashes.",
      };
      return;
    }
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      this.addNote = { ok: false, text: "The repo must be owner/name on GitHub." };
      return;
    }

    this.busy = "add";
    try {
      if (this.addTab === "import") {
        await setupApi.saveProject(id, {
          repo,
          checks: this.newProjectChecks.filter((c) => c.trim()),
          mode: this.newProjectMode,
          protectedPaths: [".github/"],
          followUpsPerDay: 3,
          autoRelease: false,
        });
        if (this.newProjectEmployees.length) {
          for (const emp of this.allEmployees) {
            if (this.newProjectEmployees.includes(emp.id)) {
              const current = emp.projects ?? [];
              if (!current.includes(id)) {
                await api.updateEmployee(emp.id, { projects: [...current, id] });
              }
            }
          }
        }
      } else {
        if (
          !confirm(
            `Initialize starter files for template "${this.newProjectTemplate}" into repository "${repo}"?`,
          )
        ) {
          this.busy = null;
          return;
        }
        let force = false;
        if (this.detectedInfo && !this.detectedInfo.includes("empty repo")) {
          if (!confirm(`Repository "${repo}" is not empty. Overwrite and commit starter template anyway?`)) {
            this.busy = null;
            return;
          }
          force = true;
        }

        const body: BootstrapProjectBody = {
          repo,
          mode: this.newProjectMode,
          template: this.newProjectTemplate,
          ...(force ? { force: true } : {}),
          ...(this.newProjectDesc.trim() ? { description: this.newProjectDesc.trim() } : {}),
          ...(this.newProjectEmployees.length ? { employees: this.newProjectEmployees } : {}),
          checks: this.newProjectChecks,
          protectedPaths: [".github/"],
        };

        try {
          await setupApi.bootstrapProject(id, body);
        } catch (e) {
          const msg = message(e);
          if (msg.includes("not empty") && !force) {
            if (confirm(`Repository "${repo}" is not empty. Overwrite and commit starter template anyway?`)) {
              await setupApi.bootstrapProject(id, { ...body, force: true });
            } else {
              this.addNote = { ok: false, text: msg };
              return;
            }
          } else {
            throw e;
          }
        }
      }

      this.showAdd = false;
      this.open = id;
      this.addNote = undefined;
      await this.reload();
      refreshNow();
    } catch (e) {
      this.addNote = { ok: false, text: message(e) };
    } finally {
      this.busy = null;
    }
  }

  private async deleteProject(id: string) {
    if (!confirm(`Are you sure you want to delete project ${id}?`)) return;
    this.busy = id;
    try {
      await setupApi.deleteProject(id);
      if (this.open === id) this.open = null;
      await this.reload();
      refreshNow();
    } catch (e) {
      this.notes = { ...this.notes, [id]: { ok: false, text: message(e) } };
    } finally {
      this.busy = null;
    }
  }

  private async save(p: Project) {
    const d = this.draft(p);
    const checks = d.checks.map((c) => c.trim()).filter(Boolean);
    const perDay = Number(d.followUpsPerDay);
    const fail = (text: string) => {
      this.notes = { ...this.notes, [p.id]: { ok: false, text } };
    };
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(d.repo.trim()))
      return fail("The repo is owner/name on GitHub.");
    if (!checks.length) return fail("The recipe needs at least one command.");
    if (!Number.isInteger(perDay) || perDay < 0) return fail("Follow-ups per day is a whole number.");
    this.busy = p.id;
    try {
      await setupApi.saveProject(p.id, {
        repo: d.repo.trim(),
        checks,
        mode: d.mode,
        protectedPaths: d.protectedPaths.map((x) => x.trim()).filter(Boolean),
        followUpsPerDay: perDay,
        autoRelease: d.autoRelease,
      });
      const { [p.id]: _gone, ...rest } = this.drafts;
      this.drafts = rest;
      this.notes = { ...this.notes, [p.id]: { ok: true, text: "Saved" } };
      await this.reload();
      refreshNow();
    } catch (e) {
      fail(message(e));
    } finally {
      this.busy = null;
    }
  }

  private card(p: Project) {
    const d = this.draft(p);
    const modeBtn = (m: MergeMode, label: string) =>
      html`<button type="button" aria-pressed=${d.mode === m ? "true" : "false"} @click=${() => this.edit(p, { mode: m })}>${label}</button>`;
    const open = this.open === p.id;
    const modeName = d.mode === "direct" ? "Direct" : "Owner merges";
    return html`<section class="card row" aria-label=${p.id}>
      <button class="toggle" type="button" aria-expanded=${open ? "true" : "false"} aria-controls="editor-${p.id}"
        @click=${() => {
          this.open = open ? null : p.id;
        }}>
        <span class="text"><b>${p.id}</b><span class="sub">${d.repo}</span></span>
        ${this.dirty(p) ? html`<span class="tag">Unsaved</span>` : ""}
        <span class="chip ${d.mode === "direct" ? "" : "reviewing"}">${modeName}</span>
        <span class="caret" aria-hidden="true"></span>
      </button>
      ${open ? this.editor(p, d, modeBtn) : ""}
    </section>`;
  }

  private editor(p: Project, d: Draft, modeBtn: (m: MergeMode, label: string) => unknown) {
    return html`<div class="editor" id="editor-${p.id}">
      <label>Repo
        <input type="text" class="mono" .value=${d.repo} autocomplete="off" autocapitalize="off" spellcheck="false"
          @input=${(e: InputEvent) => this.edit(p, { repo: (e.target as HTMLInputElement).value })} />
      </label>
      <div class="field">
        <span>How work reaches main</span>
        <div class="seg" role="group" aria-label="Mode">
          ${modeBtn("direct", "Direct")}${modeBtn("owner-merges", "Owner merges")}
        </div>
        <p class="note">${
          d.mode === "direct"
            ? "After a fresh-context review, finished work is pushed straight to main."
            : "Finished work becomes a pull request that you review and merge."
        }</p>
      </div>
      ${listEditor({
        label: "Protected paths",
        noun: "path",
        items: d.protectedPaths,
        mono: true,
        placeholder: ".github/",
        onChange: (protectedPaths) => this.edit(p, { protectedPaths }),
      })}
      <p class="note" style="margin-top:-8px">Changes under these paths wait for your OK before they reach main.</p>
      <label>Follow-ups per day
        <input type="number" inputmode="numeric" min="0" step="1" .value=${d.followUpsPerDay}
          @input=${(e: InputEvent) => this.edit(p, { followUpsPerDay: (e.target as HTMLInputElement).value })} />
      </label>
      ${listEditor({
        label: "Check recipe, in order",
        noun: "command",
        items: d.checks,
        ordered: true,
        mono: true,
        placeholder: "pnpm test",
        onChange: (checks) => this.edit(p, { checks }),
      })}
      <label class="check"><input type="checkbox" .checked=${d.autoRelease}
        @change=${(e: Event) => this.edit(p, { autoRelease: (e.target as HTMLInputElement).checked })} /> Cut releases automatically</label>
      <div class="actions">
        <button class="btn" type="button" ?disabled=${!this.dirty(p) || this.busy === p.id} @click=${() => this.save(p)}>
          ${this.busy === p.id ? "Saving…" : "Save"}</button>
        <button class="btn ghost danger" type="button" ?disabled=${this.busy === p.id} @click=${() => this.deleteProject(p.id)}>
          Delete project</button>
        ${noteLine(this.notes[p.id])}
      </div>
    </div>`;
  }

  private renderAddCard() {
    const repos = (this.githubRepos ?? []).filter((r) =>
      this.repoFilter ? r.fullName.toLowerCase().includes(this.repoFilter.toLowerCase()) : true,
    );

    return html`<div class="add-card" role="region" aria-label="Add project">
      <div class="add-header">
        <h2>Add a project</h2>
        <button type="button" class="btn ghost" @click=${() => {
          this.showAdd = false;
        }}>Close</button>
      </div>
      <div class="seg" role="group" aria-label="Add Mode">
        <button type="button" aria-pressed=${this.addTab === "import" ? "true" : "false"}
          @click=${() => {
            this.addTab = "import";
          }}>Import from GitHub</button>
        <button type="button" aria-pressed=${this.addTab === "bootstrap" ? "true" : "false"}
          @click=${() => {
            this.addTab = "bootstrap";
          }}>Start new project</button>
      </div>

      ${
        this.addTab === "import"
          ? html`
            <label>Search GitHub repositories
              <input type="search" placeholder="Filter by repository name…" .value=${this.repoFilter}
                @input=${(e: InputEvent) => {
                  this.repoFilter = (e.target as HTMLInputElement).value;
                }} />
            </label>
            ${
              this.reposError
                ? html`<p class="note warn" role="alert" style="margin-top:6px">Unable to load GitHub repositories: ${this.reposError}</p>`
                : ""
            }
            ${
              this.loadingRepos
                ? html`<p class="muted">Scanning GitHub App repositories…</p>`
                : repos.length === 0
                  ? html`<p class="muted">${this.githubRepos?.length ? "No matching repositories." : "No repositories accessible via GitHub App."}</p>`
                  : html`<div class="repo-list" role="list">
                      ${repos.map((r) => {
                        const selected = this.newProjectRepo === r.fullName;
                        return html`<div class="repo-item ${selected ? "selected" : ""}" role="listitem">
                          <div style="display:flex;flex-direction:column;gap:2px;min-width:0;">
                            <span class="repo-name">${r.fullName}</span>
                            <div class="repo-meta">
                              ${r.language ? html`<span class="tag">${r.language}</span>` : ""}
                              <span class="tag">${r.private ? "Private" : "Public"}</span>
                              ${r.empty ? html`<span class="tag">Empty</span>` : ""}
                              ${r.description ? html`<span class="muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px;">${r.description}</span>` : ""}
                            </div>
                          </div>
                          ${
                            r.alreadyRegistered
                              ? html`<span class="chip done">Added</span>`
                              : html`<button type="button" class="btn ghost" @click=${() => this.selectGithubRepo(r)}>Select</button>`
                          }
                        </div>`;
                      })}
                    </div>`
            }
          `
          : html`
            <div class="field">
              <span>Choose starter template</span>
              <div class="template-grid" role="radiogroup">
                ${(
                  [
                    ["ts-node", "TypeScript + Node", "TypeScript 5 + Vitest test suite"],
                    ["web", "Web App", "Vite + TypeScript web starter"],
                    ["python", "Python", "pyproject.toml + pytest suite"],
                    ["minimal", "Minimal", "README and gitignore only"],
                  ] as const
                ).map(
                  ([id, title, desc]) => html`<button type="button" class="template-btn" role="radio"
                    aria-pressed=${this.newProjectTemplate === id ? "true" : "false"}
                    @click=${() => {
                      this.newProjectTemplate = id;
                      if (id === "python") this.newProjectChecks = ["pytest"];
                      else if (id === "minimal") this.newProjectChecks = ["echo ok"];
                      else
                        this.newProjectChecks = ["pnpm install --frozen-lockfile", "pnpm check", "pnpm test"];
                    }}>
                    <span class="template-title">${title}</span>
                    <span class="template-desc">${desc}</span>
                  </button>`,
                )}
              </div>
            </div>
            <label>Description (optional)
              <input type="text" placeholder="Short description of this project…" .value=${this.newProjectDesc}
                @input=${(e: InputEvent) => {
                  this.newProjectDesc = (e.target as HTMLInputElement).value;
                }} />
            </label>
          `
      }

      <div class="pair">
        <label>Project ID
          <input type="text" placeholder="e.g. duet, i-inc" class="mono" .value=${this.newProjectId}
            @input=${(e: InputEvent) => {
              this.newProjectId = (e.target as HTMLInputElement).value;
            }} />
        </label>
        <label>GitHub repository
          <input type="text" placeholder="owner/repo" class="mono" .value=${this.newProjectRepo}
            @input=${(e: InputEvent) => {
              this.newProjectRepo = (e.target as HTMLInputElement).value;
            }} />
        </label>
      </div>

      ${
        this.inspecting
          ? html`<p class="muted">Inspecting repository structure and recipe…</p>`
          : this.detectedInfo
            ? html`<div class="note ok">${this.detectedInfo}</div>`
            : this.inspectError
              ? html`<div class="note bad">${this.inspectError}</div>`
              : ""
      }

      <div class="field">
        <span>How work reaches main</span>
        <div class="seg" role="group" aria-label="Mode">
          <button type="button" aria-pressed=${this.newProjectMode === "direct" ? "true" : "false"}
            @click=${() => {
              this.newProjectMode = "direct";
            }}>Direct</button>
          <button type="button" aria-pressed=${this.newProjectMode === "owner-merges" ? "true" : "false"}
            @click=${() => {
              this.newProjectMode = "owner-merges";
            }}>Owner merges</button>
        </div>
      </div>

      ${listEditor({
        label: "Check recipe, in order",
        noun: "command",
        items: this.newProjectChecks,
        ordered: true,
        mono: true,
        placeholder: "pnpm test",
        onChange: (checks) => {
          this.newProjectChecks = checks;
        },
      })}

      ${
        this.allEmployees?.length
          ? html`<div class="field">
            <span>Assign employees to this project</span>
            <div class="employee-grid">
              ${this.allEmployees.map((emp) => {
                const assigned = this.newProjectEmployees.includes(emp.id);
                return html`<label class="employee-chip">
                  <input type="checkbox" .checked=${assigned}
                    @change=${(e: Event) => {
                      const checked = (e.target as HTMLInputElement).checked;
                      this.newProjectEmployees = checked
                        ? [...this.newProjectEmployees, emp.id]
                        : this.newProjectEmployees.filter((id) => id !== emp.id);
                    }} />
                  <span>${emp.name} (${emp.role})</span>
                </label>`;
              })}
            </div>
          </div>`
          : ""
      }

      <div class="actions">
        <button class="btn" type="button" ?disabled=${this.busy === "add" || !this.newProjectId.trim() || !this.newProjectRepo.trim()}
          @click=${() => this.submitAddProject()}>
          ${this.busy === "add" ? (this.addTab === "bootstrap" ? "Scaffolding…" : "Adding…") : this.addTab === "bootstrap" ? "Start project & scaffold" : "Add project"}
        </button>
        ${noteLine(this.addNote)}
      </div>
    </div>`;
  }

  override render() {
    if (this.error) return html`<p role="alert">The daemon isn't answering: ${this.error}</p>`;
    if (!this.data) return html`<p class="muted">Loading projects…</p>`;

    return html`
      <div class="top-bar">
        <h1>Projects</h1>
        ${
          !this.showAdd
            ? html`<button type="button" class="btn" @click=${() => this.toggleAdd()}>+ Add a project</button>`
            : ""
        }
      </div>
      ${this.showAdd ? this.renderAddCard() : ""}
      ${
        this.data.length === 0
          ? html`<p class="muted">No projects yet. Add one above to start assigning work.</p>`
          : html`<div class="stack">${this.data.map((p) => this.card(p))}</div>`
      }
    `;
  }
}

customElements.define("inc-setup-projects", IncSetupProjects);
