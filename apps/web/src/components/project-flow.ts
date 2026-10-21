// Add a repo as a project, or start a new one (T62, v1-plan §4).
//   #/company/projects/add[?repo=owner/name]  pick a repo, i.inc detects its checks, you confirm the recipe and the mode.
//   #/company/projects/new                    name, template, private or public. The bot creates the repo only where
//                                             GitHub allows it (an organization, with Administration: write);
//                                             otherwise it sends you to GitHub to create an EMPTY repo, notices it, and
//                                             fills it. The steps are derived from GitHub and a draft kept in this
//                                             browser, so a reload carries on.
import type { Employee } from "@i-inc/core";
import { css, html, LitElement, type PropertyValues } from "lit";
import { api, refreshNow } from "../api.ts";
import {
  ADD_PROJECT_HREF,
  ApiProblem,
  conversationHref,
  draftStore,
  type GitHubRepoSummary,
  type GitHubStatus,
  type NewProjectDraft,
  newRepoLink,
  projectHref,
  projectIdFromRepo,
  projectIdProblem,
  projectsApi,
  repoNameProblem,
  TEMPLATES,
  type TemplateId,
} from "../github-projects.ts";
import { type MergeMode, policyDefaults, setupApi } from "../setup-api.ts";
import { listEditor } from "../setup-shared.ts";
import { modePicker, problemBox, projectStyles } from "./project-parts.ts";
import { base } from "./shared.ts";

/** How often a waiting page looks for the repo the owner is creating, while the page is visible. */
const POLL_MS = 15_000;

type AddPhase = "loading" | "pick" | "missing" | "already" | "inspecting" | "form" | "saving" | "done";

const detectedWords = (d: string, empty: boolean) =>
  empty
    ? "This repo is empty, so there is nothing to detect. i.inc suggests a recipe; change it, or start from a template with New project."
    : ((
        {
          node: "Found a Node project.",
          bun: "Found a Bun project.",
          python: "Found a Python project.",
          rust: "Found a Rust project.",
          go: "Found a Go project.",
        } as Record<string, string>
      )[d] ?? "i.inc couldn't recognise this kind of project, so it suggests a simple recipe. Check it.");

export class IncProjectFlow extends LitElement {
  static override properties = {
    flow: { type: String },
    repo: { type: String },
    pollMs: { type: Number },
    // shared
    status: { state: true },
    repos: { state: true },
    reposProblem: { state: true },
    existing: { state: true },
    employees: { state: true },
    // add
    phase: { state: true },
    id: { state: true },
    checks: { state: true },
    mode: { state: true },
    protectedPaths: { state: true },
    assigned: { state: true },
    defaultBranch: { state: true },
    detected: { state: true },
    problem: { state: true },
    added: { state: true },
    // new
    draft: { state: true },
    name: { state: true },
    visibility: { state: true },
    template: { state: true },
    description: { state: true },
    formError: { state: true },
    busy: { state: true },
    stepProblem: { state: true },
    checkedAt: { state: true },
    checking: { state: true },
    finished: { state: true },
    notice: { state: true },
  };
  declare flow: "add" | "new";
  declare repo: string;
  declare pollMs: number;
  declare status: GitHubStatus | null;
  declare repos: GitHubRepoSummary[] | null;
  declare reposProblem: unknown;
  declare existing: { id: string; repo: string }[];
  declare employees: Employee[];
  declare phase: AddPhase;
  declare id: string;
  declare checks: string[];
  declare mode: MergeMode;
  declare protectedPaths: string[];
  declare assigned: string[];
  declare defaultBranch: string;
  declare detected: string;
  declare problem: unknown;
  declare added: { id: string } | null;
  declare draft: NewProjectDraft | null;
  declare name: string;
  declare visibility: "private" | "public";
  declare template: TemplateId;
  declare description: string;
  declare formError: string | null;
  declare busy: string | null;
  declare stepProblem: unknown;
  declare checkedAt: number | null;
  declare checking: boolean;
  declare finished: { id: string; repo: string } | null;
  declare notice: string | null;

  private timer: ReturnType<typeof setInterval> | undefined;
  private loadedFor = "";
  private working = false;
  /** Bumped by every load so a slow answer for an old address is ignored. */
  private token = 0;

  constructor() {
    super();
    this.flow = "add";
    this.repo = "";
    this.pollMs = POLL_MS;
    this.status = null;
    this.repos = null;
    this.reposProblem = null;
    this.existing = [];
    this.employees = [];
    this.phase = "loading";
    this.id = "";
    this.checks = [];
    this.mode = "owner-merges";
    this.protectedPaths = [];
    this.assigned = [];
    this.defaultBranch = "";
    this.detected = "";
    this.problem = null;
    this.added = null;
    this.draft = null;
    this.name = "";
    this.visibility = "private";
    this.template = "ts-node";
    this.description = "";
    this.formError = null;
    this.busy = null;
    this.stepProblem = null;
    this.checkedAt = null;
    this.checking = false;
    this.finished = null;
    this.notice = null;
  }

  static override styles = [
    base,
    projectStyles,
    css`
      .stack { max-width: 100%; }
      .found { display: flex; flex-direction: column; gap: 2px; }
      .found .name { font-family: var(--mono); font-size: 15px; font-weight: 700; overflow-wrap: anywhere; }
      details { border: 1px solid var(--line-strong); border-radius: 12px; background: var(--surface); }
      summary { min-height: 44px; display: flex; align-items: center; padding: 0 14px; font-weight: 600; font-size: 15px; }
      summary:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 2px; border-radius: 12px; }
      details > .inner { padding: 4px 14px 14px; display: flex; flex-direction: column; gap: 14px; }
      .employee-grid { display: flex; flex-wrap: wrap; gap: 8px; }
      .employee-chip { flex-direction: row; align-items: center; gap: 8px; min-height: 44px; padding: 0 12px; border-radius: 10px;
        background: var(--sunken); color: var(--ink); font-size: 15px; font-weight: 400; cursor: pointer; }
      .employee-chip input { width: 22px; height: 22px; margin: 0; accent-color: var(--ink); }
      ol.steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
      ol.steps > li { border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; background: var(--surface);
        display: flex; flex-direction: column; gap: 8px; min-width: 0; }
      ol.steps > li.now { border-color: var(--ink); }
      .step-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-height: 28px; }
      .step-head .n { width: 28px; height: 28px; border-radius: 50%; border: 1px solid var(--line-strong); display: inline-flex;
        align-items: center; justify-content: center; font-size: 14px; font-weight: 700; flex: none; }
      li.done .n { background: var(--ink); color: var(--on-ink); border-color: var(--ink); }
      .step-head b { font-size: 16px; }
      .step-head .state { margin-left: auto; font-size: 13px; font-weight: 700; color: var(--ink-2); }
      ol.how { margin: 0; padding-left: 22px; display: flex; flex-direction: column; gap: 8px; font-size: 15px; line-height: 1.45; }
      .summary { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 14px; margin: 0; font-size: 15px; }
      .summary dt { color: var(--ink-2); font-weight: 600; }
      .summary dd { margin: 0; overflow-wrap: anywhere; }
      @media (max-width: 560px) {
        .summary { grid-template-columns: minmax(0, 1fr); gap: 0; }
        .summary dd { margin-bottom: 6px; }
      }
    `,
  ];

  // ---- lifecycle ----

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.onVisible);
    void this.load();
  }

  override disconnectedCallback(): void {
    document.removeEventListener("visibilitychange", this.onVisible);
    this.stopPoll();
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues): void {
    if ((changed.has("repo") || changed.has("flow")) && this.isConnected && this.loadedFor !== this.key()) {
      void this.load();
    }
  }

  private key() {
    return `${this.flow}:${this.repo}`;
  }

  private onVisible = () => {
    if (document.visibilityState === "visible" && this.waiting()) void this.poll();
  };

  private stopPoll() {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private startPoll() {
    if (this.timer !== undefined || this.pollMs <= 0) return;
    this.timer = setInterval(() => {
      if (document.visibilityState === "visible") void this.poll();
    }, this.pollMs);
  }

  // ---- loading ----

  private async load() {
    this.loadedFor = this.key();
    const token = ++this.token;
    this.stopPoll();
    this.problem = null;
    this.stepProblem = null;
    this.added = null;
    this.finished = null;
    this.phase = "loading";
    const [status, repos, overview, employees] = await Promise.all([
      projectsApi.status().catch(() => null),
      projectsApi.repos().then(
        (r) => ({ r }),
        (e: unknown) => ({ e }),
      ),
      projectsApi.overview().catch(() => []),
      api.employees().catch(() => [] as Employee[]),
    ]);
    if (token !== this.token) return;
    this.status = status;
    this.repos = "r" in repos ? repos.r.repos : null;
    this.reposProblem = "e" in repos ? repos.e : null;
    this.existing = overview.map((p) => ({ id: p.id, repo: p.repo }));
    this.employees = Array.isArray(employees) ? employees : [];
    if (this.flow === "new") return this.loadNew();
    return this.loadAdd(token);
  }

  // ---- add a repo ----

  private async loadAdd(token: number) {
    if (!this.repo) {
      this.phase = "pick";
      return;
    }
    const found = this.repos?.find((r) => r.fullName.toLowerCase() === this.repo.toLowerCase());
    if (!found) {
      this.phase = this.reposProblem ? "pick" : "missing";
      return;
    }
    if (found.alreadyRegistered) {
      this.phase = "already";
      return;
    }
    this.id = projectIdFromRepo(found.name);
    this.defaultBranch = found.defaultBranch;
    this.mode = "owner-merges";
    this.assigned = [];
    this.protectedPaths = [".github/"];
    this.checks = ["pnpm install", "pnpm test"];
    this.detected = "";
    this.phase = "inspecting";
    try {
      const r = await setupApi.inspectRepo(found.owner, found.name);
      if (token !== this.token) return;
      this.checks = r.checks.length ? r.checks : this.checks;
      this.protectedPaths = r.protectedPaths.length ? r.protectedPaths : this.protectedPaths;
      if (r.defaultBranch) this.defaultBranch = r.defaultBranch;
      this.detected = detectedWords(r.detected, r.empty);
      this.problem = null;
    } catch (e) {
      if (token !== this.token) return;
      this.problem = e;
      this.detected = "";
    }
    this.phase = "form";
  }

  private async saveAdd() {
    const found = this.repos?.find((r) => r.fullName.toLowerCase() === this.repo.toLowerCase());
    const id = this.id.trim();
    const checks = this.checks.map((c) => c.trim()).filter(Boolean);
    const bad = projectIdProblem(
      id,
      this.existing.map((p) => p.id),
    );
    if (bad) {
      this.formError = bad;
      return;
    }
    if (!found) return;
    if (!checks.length) {
      this.formError = "The recipe needs at least one command.";
      return;
    }
    this.formError = null;
    this.problem = null;
    this.phase = "saving";
    try {
      await setupApi.bootstrapProject(id, {
        repo: found.fullName,
        mode: this.mode,
        checks,
        protectedPaths: this.protectedPaths.map((p) => p.trim()).filter(Boolean),
        defaultBranch: this.defaultBranch || found.defaultBranch,
        ...(this.assigned.length ? { employees: this.assigned } : {}),
      });
      this.added = { id };
      this.phase = "done";
      refreshNow();
    } catch (e) {
      this.problem = e;
      this.phase = "form";
    }
  }

  private pickList() {
    const open = (this.repos ?? []).filter((r) => !r.alreadyRegistered);
    return html`<section class="card" aria-label="Pick a repo">
      <h2>Which repo?</h2>
      ${
        this.reposProblem
          ? problemBox(
              this.reposProblem,
              html`<div class="row"><button class="btn ghost" type="button" @click=${() => this.load()}>Try again</button></div>`,
            )
          : open.length === 0
            ? html`<p class="muted">The i.inc bot can't see a repo that isn't a project yet. Give it access to one on GitHub, then press Refresh.</p>`
            : html`<ul class="list" style="gap:0">
                ${open.map(
                  (r) => html`<li style="border-top:1px solid var(--line);padding:6px 0;flex-wrap:wrap">
                    <span class="mono" style="flex:1 1 200px;min-width:0">${r.fullName}</span>
                    <a class="btn ghost" href="${ADD_PROJECT_HREF}?repo=${encodeURIComponent(r.fullName)}" aria-label="Add ${r.fullName}">Add</a>
                  </li>`,
                )}
              </ul>`
      }
      <div class="row">
        <a class="link" href=${this.status?.links.manage ?? "https://github.com/settings/installations"} target="_blank" rel="noopener noreferrer">Give i.inc access to more repos<span aria-hidden="true">&nbsp;↗</span></a>
        <button class="btn ghost" type="button" ?disabled=${this.checking} @click=${() => this.refreshList()}>${this.checking ? "Checking GitHub…" : "Refresh"}</button>
      </div>
    </section>`;
  }

  private async refreshList() {
    this.checking = true;
    try {
      const list = await projectsApi.repos(true);
      this.repos = list.repos;
      this.reposProblem = null;
      if (this.flow === "add" && this.repo && this.phase === "missing") await this.load();
    } catch (e) {
      this.reposProblem = e;
    } finally {
      this.checking = false;
    }
  }

  private addView() {
    const repo = this.repo;
    const found = this.repos?.find((r) => r.fullName.toLowerCase() === repo.toLowerCase());
    switch (this.phase) {
      case "loading":
        return html`<p class="muted" role="status">Loading…</p>`;
      case "pick":
        return this.pickList();
      case "missing":
        return html`<section class="card" aria-label="Repo not visible">
          <h2>i.inc can't see ${repo}</h2>
          <p>The bot only sees the repos you give it. Add this one on GitHub, then come back and press Refresh.</p>
          <div class="row">
            <a class="btn" href=${this.status?.links.manage ?? "https://github.com/settings/installations"} target="_blank" rel="noopener noreferrer">Give i.inc access<span class="sr"> (opens GitHub)</span></a>
            <button class="btn ghost" type="button" ?disabled=${this.checking} @click=${() => this.refreshList()}>${this.checking ? "Checking GitHub…" : "Refresh"}</button>
            <a class="link" href=${ADD_PROJECT_HREF}>Pick another repo</a>
          </div>
          ${this.reposProblem ? problemBox(this.reposProblem) : ""}
        </section>`;
      case "already": {
        const p = this.existing.find((x) => x.repo.toLowerCase() === repo.toLowerCase());
        return html`<section class="card"><h2>${repo} is a project already</h2>
          <div class="row">${p ? html`<a class="btn" href=${projectHref(p.id)}>Open ${p.id}</a>` : ""}<a class="link" href="#/company/projects">Back to projects</a></div></section>`;
      }
      case "inspecting":
        return html`<section class="card" role="status" aria-live="polite"><h2>Looking at ${repo}…</h2>
          <p class="muted">i.inc is reading the repo to find out how it is built and tested.</p></section>`;
      case "done":
        return this.doneCard(this.added?.id ?? this.id, repo, "Added");
      default:
        return this.addForm(found);
    }
  }

  private addForm(found: GitHubRepoSummary | undefined) {
    const busy = this.phase === "saving";
    const idProblem = this.id.trim()
      ? projectIdProblem(
          this.id.trim(),
          this.existing.map((p) => p.id),
        )
      : null;
    const inspectFailed = this.problem instanceof ApiProblem && this.detected === "";
    return html`<form class="stack" @submit=${(e: Event) => {
      e.preventDefault();
      void this.saveAdd();
    }} novalidate>
      <section class="card" aria-label="The repo">
        <div class="found">
          <span class="muted small">Adding</span>
          <span class="name">${found?.fullName ?? this.repo}</span>
          <span class="small muted">${found ? `${found.private ? "Private" : "Public"}${found.language ? ` · ${found.language}` : ""}${found.empty ? " · empty" : ""}` : ""}</span>
        </div>
        ${this.detected ? html`<p class="callout" role="status">${this.detected}</p>` : ""}
        ${
          inspectFailed
            ? problemBox(
                this.problem,
                html`<p class="hint">You can still add it: i.inc suggests a recipe below. Check it, or try again.</p>
                  <div class="row"><button class="btn ghost" type="button" @click=${() => this.load()}>Try again</button></div>`,
              )
            : ""
        }
      </section>
      <section class="card" aria-label="Settings">
        <label>Project name
          <input type="text" class="mono" .value=${this.id} autocomplete="off" autocapitalize="off" spellcheck="false" ?disabled=${busy}
            aria-invalid=${idProblem ? "true" : "false"}
            @input=${(e: InputEvent) => {
              this.id = (e.target as HTMLInputElement).value;
            }} />
          ${idProblem ? html`<span class="error-line" role="alert">${idProblem}</span>` : html`<span class="hint">What tickets and conversations call this project.</span>`}
        </label>
        ${listEditor({
          label: "Checks, in order",
          noun: "command",
          items: this.checks,
          ordered: true,
          mono: true,
          placeholder: "pnpm test",
          onChange: (checks) => {
            this.checks = checks;
          },
        })}
        <p class="hint" style="margin-top:-6px">Every change must pass these before it counts as done.</p>
        ${modePicker("mode", this.mode, (m) => {
          this.mode = m;
        })}
        <details>
          <summary>More settings</summary>
          <div class="inner">
            ${listEditor({
              label: "Protected paths",
              noun: "path",
              items: this.protectedPaths,
              mono: true,
              placeholder: ".github/",
              onChange: (protectedPaths) => {
                this.protectedPaths = protectedPaths;
              },
            })}
            <p class="hint" style="margin-top:-8px">Changes under these paths wait for your OK before they reach main.</p>
            ${
              this.employees.length
                ? html`<fieldset class="field"><legend>Who works on it (optional)</legend>
                    <div class="employee-grid">
                      ${this.employees.map(
                        (emp) => html`<label class="employee-chip">
                          <input type="checkbox" .checked=${this.assigned.includes(emp.id)}
                            @change=${(e: Event) => {
                              const on = (e.target as HTMLInputElement).checked;
                              this.assigned = on
                                ? [...this.assigned, emp.id]
                                : this.assigned.filter((x) => x !== emp.id);
                            }} />
                          <span>${emp.name} (${emp.role})</span>
                        </label>`,
                      )}
                    </div></fieldset>`
                : ""
            }
          </div>
        </details>
      </section>
      ${this.problem && !inspectFailed ? problemBox(this.problem) : ""}
      ${this.formError ? html`<p class="error-line" role="alert">${this.formError}</p>` : ""}
      <div class="actions">
        <button class="btn" type="submit" ?disabled=${busy}>${busy ? `Adding ${this.id.trim() || "project"}…` : "Add project"}</button>
        <a class="link" href=${ADD_PROJECT_HREF}>Pick another repo</a>
      </div>
      ${busy ? html`<p class="muted" role="status" aria-live="polite">Adding the project and checking the bot can reach the repo…</p>` : ""}
    </form>`;
  }

  private doneCard(id: string, repo: string, verb: string) {
    return html`<section class="card" aria-label="Done" role="status">
      <h2>${verb} ${id}</h2>
      <p>${repo} is a project now. Employees can work on it, and its checks are set.</p>
      <div class="actions">
        <a class="btn" href=${conversationHref(id)}>Start a conversation</a>
        <a class="btn ghost" href=${projectHref(id)}>Open the project</a>
        <a class="link" href="#/company/projects">All projects</a>
      </div>
    </section>`;
  }

  // ---- new project ----

  private async loadNew() {
    this.draft = draftStore.read();
    if (this.draft) {
      const d = this.draft;
      this.name = d.name;
      this.visibility = d.visibility;
      this.template = d.template;
      this.mode = d.mode;
      this.description = d.description;
    }
    this.phase = "form";
    await this.advance();
  }

  private account(): string | null {
    return this.status?.installation?.account ?? null;
  }

  /** The repo the draft is about, if the bot can see it. */
  private foundRepo(): GitHubRepoSummary | undefined {
    const d = this.draft;
    if (!d || !this.repos) return undefined;
    const account = this.account()?.toLowerCase();
    return this.repos.find(
      (r) => r.name.toLowerCase() === d.name.toLowerCase() && (!account || r.owner.toLowerCase() === account),
    );
  }

  private waiting(): boolean {
    return (
      this.flow === "new" &&
      !!this.draft &&
      !this.finished &&
      !this.foundRepo() &&
      this.draft.via === "manual"
    );
  }

  private persist(patch: Partial<NewProjectDraft>) {
    if (!this.draft) return;
    this.draft = { ...this.draft, ...patch };
    draftStore.write(this.draft);
  }

  /** Looks at where things stand and does the next step, if it is ours to do. */
  private async advance() {
    const d = this.draft;
    if (this.flow !== "new" || !d || this.working || this.finished) return;
    const found = this.foundRepo();
    const id = projectIdFromRepo(d.name);
    const registered =
      found && this.existing.some((p) => p.repo.toLowerCase() === found.fullName.toLowerCase());
    if (registered && found) {
      draftStore.clear();
      this.finished = {
        id: this.existing.find((p) => p.repo.toLowerCase() === found.fullName.toLowerCase())?.id ?? id,
        repo: found.fullName,
      };
      this.draft = null;
      this.stopPoll();
      return;
    }
    // A step that failed waits for the owner's "Try again": it never repeats by itself.
    if (this.stepProblem) return;
    if (!found) {
      if (d.via === "bot" && !d.createAsked) await this.createRepo();
      else if (d.via === "manual") this.startPoll();
      return;
    }
    this.stopPoll();
    if (found.empty) await this.fill(false);
  }

  private async createRepo() {
    const d = this.draft;
    if (!d || this.working) return;
    this.working = true;
    this.busy = "create";
    this.stepProblem = null;
    this.persist({ createAsked: true });
    try {
      await projectsApi.createRepo({
        name: d.name,
        visibility: d.visibility,
        ...(d.description ? { description: d.description } : {}),
      });
      const list = await projectsApi.repos(true);
      this.repos = list.repos;
    } catch (e) {
      if (e instanceof ApiProblem && e.code === "cannot-create") {
        // GitHub won't let the bot create here: the owner does it, and i.inc notices.
        this.persist({ via: "manual", createAsked: false });
        this.notice = e.message;
      } else {
        this.persist({ createAsked: false });
        this.stepProblem = e;
      }
    } finally {
      this.busy = null;
      this.working = false;
    }
    await this.advance();
  }

  private async fill(force: boolean) {
    const d = this.draft;
    const found = this.foundRepo();
    if (!d || !found || this.working) return;
    this.working = true;
    this.busy = "fill";
    this.stepProblem = null;
    this.persist({ fillStarted: true });
    const template = TEMPLATES.find((t) => t.id === d.template) ?? TEMPLATES[0];
    const id = projectIdFromRepo(d.name);
    try {
      await setupApi.bootstrapProject(id, {
        repo: found.fullName,
        mode: d.mode,
        template: d.template,
        checks: [...template.checks],
        protectedPaths: [".github/"],
        defaultBranch: found.defaultBranch,
        ...(d.description ? { description: d.description } : {}),
        ...(force ? { force: true } : {}),
      });
      draftStore.clear();
      this.draft = null;
      this.finished = { id, repo: found.fullName };
      this.stopPoll();
      refreshNow();
    } catch (e) {
      // The project may exist already (a reload after the last step): that is done, not a failure.
      const again = await projectsApi.overview().catch(() => []);
      this.existing = again.map((p) => ({ id: p.id, repo: p.repo }));
      if (again.some((p) => p.repo.toLowerCase() === found.fullName.toLowerCase())) {
        draftStore.clear();
        this.draft = null;
        this.finished = { id, repo: found.fullName };
      } else {
        this.stepProblem = e;
      }
    } finally {
      this.busy = null;
      this.working = false;
    }
  }

  /** Asks GitHub for the repo list again (Refresh, and the polite poll), then moves on. */
  private async poll() {
    if (this.checking || this.working || !this.draft) return;
    this.checking = true;
    try {
      const list = await projectsApi.repos(true);
      this.repos = list.repos;
      this.reposProblem = null;
      this.checkedAt = Date.now();
      const again = await projectsApi.overview().catch(() => null);
      if (again) this.existing = again.map((p) => ({ id: p.id, repo: p.repo }));
    } catch (e) {
      this.reposProblem = e;
      // Asked to wait: look again only after that.
      const wait = e instanceof ApiProblem ? e.extra.retryAfter : undefined;
      if (wait && this.timer !== undefined) {
        this.stopPoll();
        setTimeout(() => this.startPoll(), wait * 1000);
      }
    } finally {
      this.checking = false;
    }
    await this.advance();
  }

  private start() {
    const name = this.name.trim();
    const bad =
      repoNameProblem(name) ??
      projectIdProblem(
        projectIdFromRepo(name),
        this.existing.map((p) => p.id),
      );
    if (bad) {
      this.formError = bad;
      return;
    }
    this.formError = null;
    const taken = this.repos?.some(
      (r) =>
        r.name.toLowerCase() === name.toLowerCase() &&
        (!this.account() || r.owner.toLowerCase() === this.account()?.toLowerCase()),
    );
    if (taken) {
      this.formError = `${this.account() ?? "That account"} already has a repo called ${name}. Pick another name, or add that repo from Add a repo.`;
      return;
    }
    this.draft = {
      name,
      visibility: this.visibility,
      template: this.template,
      mode: this.mode,
      description: this.description.trim(),
      via: this.status?.create.possible ? "bot" : "manual",
    };
    draftStore.write(this.draft);
    void this.advance();
  }

  private cancel() {
    draftStore.clear();
    this.stopPoll();
    this.draft = null;
    this.stepProblem = null;
    this.notice = null;
  }

  private newForm() {
    const s = this.status;
    const bot = s?.create.possible === true;
    const bad = this.name.trim()
      ? (repoNameProblem(this.name.trim()) ??
        projectIdProblem(
          projectIdFromRepo(this.name.trim()),
          this.existing.map((p) => p.id),
        ))
      : null;
    return html`<form class="stack" @submit=${(e: Event) => {
      e.preventDefault();
      this.start();
    }} novalidate>
      <section class="card" aria-label="The project">
        <label>Name
          <input type="text" class="mono" name="name" .value=${this.name} autocomplete="off" autocapitalize="off" spellcheck="false"
            aria-invalid=${bad ? "true" : "false"} placeholder="my-new-project"
            @input=${(e: InputEvent) => {
              this.name = (e.target as HTMLInputElement).value;
              this.formError = null;
            }} />
          ${bad ? html`<span class="error-line" role="alert">${bad}</span>` : html`<span class="hint">Becomes the repository name on GitHub${this.account() ? html`, under <b>${this.account()}</b>` : ""}.</span>`}
        </label>
        <fieldset class="field">
          <legend>Start from</legend>
          <div class="choices cols">
            ${TEMPLATES.map(
              (t) => html`<label class="choice">
                <input type="radio" name="template" value=${t.id} .checked=${this.template === t.id}
                  @change=${() => {
                    this.template = t.id;
                  }} />
                <span class="choice-text"><b>${t.title}</b><span>${t.blurb}</span></span>
              </label>`,
            )}
          </div>
        </fieldset>
        <fieldset class="field">
          <legend>Who can see the repo on GitHub</legend>
          <div class="seg">
            ${(["private", "public"] as const).map(
              (
                v,
              ) => html`<label><input type="radio" name="visibility" value=${v} .checked=${this.visibility === v}
                @change=${() => {
                  this.visibility = v;
                }} /><span>${v === "private" ? "Private" : "Public"}</span></label>`,
            )}
          </div>
        </fieldset>
        <label>Description (optional)
          <input type="text" .value=${this.description} maxlength="350" autocomplete="off"
            @input=${(e: InputEvent) => {
              this.description = (e.target as HTMLInputElement).value;
            }} />
        </label>
        ${modePicker("mode", this.mode, (m) => {
          this.mode = m;
        })}
      </section>
      ${
        s === null
          ? ""
          : html`<p class="callout ${bot ? "" : "needs"}" role="status">${
              !s.configured
                ? s.create.detail
                : bot
                  ? s.create.detail
                  : html`<b>You create the repo; i.inc fills it.</b> <span>${s.create.detail}</span>`
            }</p>`
      }
      ${this.formError ? html`<p class="error-line" role="alert">${this.formError}</p>` : ""}
      <div class="actions">
        <button class="btn" type="submit" ?disabled=${!this.name.trim() || (s !== null && !s.configured)}>${bot ? "Create and fill" : "Next: create it on GitHub"}</button>
        <a class="link" href="#/company/projects">Cancel</a>
      </div>
    </form>`;
  }

  private newSteps() {
    const d = this.draft as NewProjectDraft;
    const found = this.foundRepo();
    const account = this.account();
    const fullName = found?.fullName ?? `${account ?? "<your account>"}/${d.name}`;
    const manual = d.via === "manual";
    const fillBusy = this.busy === "fill";
    const createBusy = this.busy === "create";
    const partial = !!found && !found.empty && !!d.fillStarted;
    const foreign = !!found && !found.empty && !d.fillStarted;
    const state = (n: 1 | 2 | 3): { cls: string; label: string } => {
      if (n === 1)
        return found
          ? { cls: "done", label: "Done" }
          : createBusy
            ? { cls: "now", label: "Working…" }
            : manual
              ? { cls: "now", label: "Waiting for you" }
              : { cls: "now", label: this.stepProblem ? "Needs a retry" : "Next" };
      if (n === 2)
        return !found
          ? { cls: "", label: "Next" }
          : fillBusy
            ? { cls: "now", label: "Working…" }
            : partial || foreign || this.stepProblem
              ? { cls: "now", label: "Needs you" }
              : { cls: "now", label: "Next" };
      return { cls: "", label: "Next" };
    };
    const li = (n: 1 | 2 | 3, title: unknown, body: unknown) => {
      const s = state(n);
      return html`<li class=${s.cls} aria-label="Step ${n}: ${s.label}">
        <div class="step-head"><span class="n" aria-hidden="true">${s.cls === "done" ? "✓" : n}</span><b>${title}</b><span class="state">${s.label}</span></div>
        ${body}
      </li>`;
    };
    return html`<div class="stack">
      <dl class="summary card" aria-label="This project">
        <dt>Repository</dt><dd class="mono">${fullName}</dd>
        <dt>Starter</dt><dd>${TEMPLATES.find((t) => t.id === d.template)?.title ?? d.template}</dd>
        <dt>Visibility</dt><dd>${d.visibility === "private" ? "Private" : "Public"}</dd>
        <dt>Mode</dt><dd>${d.mode === "direct" ? "Direct" : "Owner merges"}</dd>
      </dl>
      ${this.notice ? html`<p class="callout needs" role="status">${this.notice}</p>` : ""}
      <ol class="steps" aria-label="Steps">
        ${li(
          1,
          manual ? "Create the empty repo on GitHub and give i.inc access" : "Create the repository",
          found
            ? html`<p class="hint">${found.fullName} is there, and the bot can see it.</p>`
            : manual
              ? html`<ol class="how">
                  <li>Open GitHub's new-repository page. The name and visibility are filled in${account ? html`; choose <b>${account}</b> as the owner` : ""}.
                    <div style="margin-top:8px"><a class="btn" href=${newRepoLink(d.name, d.visibility)} target="_blank" rel="noopener noreferrer">Open GitHub to create ${d.name}<span class="sr"> (opens GitHub)</span></a></div></li>
                  <li><b>Create it empty:</b> leave “Add a README”, “.gitignore” and “licence” switched off, so i.inc can fill it.</li>
                  <li>Make sure the i.inc bot can see it: ${
                    this.status?.installation?.repositorySelection === "all"
                      ? "the bot can see all repos on this account, so there is nothing more to do."
                      : html`add it on <a href=${this.status?.links.manage ?? "https://github.com/settings/installations"} target="_blank" rel="noopener noreferrer">the bot's GitHub settings</a>.`
                  }</li>
                  <li>Come back here. i.inc looks for it every ${Math.round(this.pollMs / 1000)} seconds while this page is open.</li>
                </ol>
                <div class="row">
                  <button class="btn ghost" type="button" ?disabled=${this.checking} @click=${() => this.poll()}>${this.checking ? "Checking GitHub…" : "Refresh now"}</button>
                  <span class="hint" role="status">${this.checkedAt ? `Last checked ${new Date(this.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}. Not there yet.` : "Waiting for the repo."}</span>
                </div>
                ${this.reposProblem ? problemBox(this.reposProblem) : ""}`
              : html`<p class="hint">${createBusy ? `i.inc is creating ${fullName}…` : "i.inc creates it through the bot."}</p>
                ${this.stepProblem ? problemBox(this.stepProblem, html`<div class="row"><button class="btn" type="button" @click=${() => this.createRepo()}>Try again</button></div>`) : ""}`,
        )}
        ${li(
          2,
          "Fill it with the starter files",
          foreign
            ? html`<p class="callout needs" role="alert"><span><b>${found?.fullName} already has files.</b> i.inc won't write a starter over them.</span>
                <span>If it is yours, add it as it is.</span>
                <span class="row"><a class="btn" href="${ADD_PROJECT_HREF}?repo=${encodeURIComponent(found?.fullName ?? "")}">Add it as an existing repo</a>
                <button class="btn ghost" type="button" @click=${() => this.cancel()}>Start over</button></span></p>`
            : partial
              ? html`<p class="callout needs" role="status"><span>Some starter files are in the repo already, from an earlier try. Carrying on writes the rest, and replaces any of those files.</span>
                  <span class="row"><button class="btn" type="button" ?disabled=${fillBusy} @click=${() => this.fill(true)}>${fillBusy ? "Writing the starter…" : "Carry on filling it"}</button></span></p>
                  ${this.stepProblem ? problemBox(this.stepProblem) : ""}`
              : found
                ? html`<p class="hint" role="status">${fillBusy ? "Writing the starter files and adding the project…" : "i.inc is about to write the starter."}</p>
                    ${this.stepProblem ? problemBox(this.stepProblem, html`<div class="row"><button class="btn" type="button" @click=${() => this.fill((this.stepProblem as ApiProblem)?.extra?.resumable === true)}>Try again</button></div>`) : ""}`
                : html`<p class="hint">Once the repo is there.</p>`,
        )}
        ${li(3, "Add it as a project", html`<p class="hint">${this.mode === "direct" ? "Direct" : "Owner merges"}: checks come from the starter.</p>`)}
      </ol>
      <div class="actions">
        <button class="btn ghost" type="button" @click=${() => this.cancel()}>Cancel and start over</button>
        <span class="hint">A repo you already created on GitHub stays there.</span>
      </div>
    </div>`;
  }

  private newView() {
    if (this.phase === "loading") return html`<p class="muted" role="status">Loading…</p>`;
    if (this.finished) return this.doneCard(this.finished.id, this.finished.repo, "Started");
    return this.draft ? this.newSteps() : this.newForm();
  }

  override render() {
    return html`<div class="stack">${this.flow === "new" ? this.newView() : this.addView()}</div>`;
  }
}

customElements.define("inc-project-flow", IncProjectFlow);

export { policyDefaults };
